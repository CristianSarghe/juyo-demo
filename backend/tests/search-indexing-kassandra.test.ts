import assert from 'node:assert/strict';
import test from 'node:test';
import { handleKassandra, type KassandraEnvironment } from '../src/kassandra-worker.js';
import { SEARCH_ROBOTS_POLICY } from '../src/search-indexing.js';

const base = 'https://assistant.example.invalid';
const origin = 'http://127.0.0.1:4201';
const token = 'a'.repeat(64);
const conversationId = '10000000-0000-4000-8000-000000000001';
const env: KassandraEnvironment = {
  JUYO_API_URL: 'https://hotel.example.invalid/api/v1',
  MCP_PUBLIC_URL: `${base}/mcp`,
  OPENAI_API_KEY: 'unit-test-key',
};
const headers = {
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  Origin: origin,
};
const mcp = (body: unknown = { jsonrpc: '2.0', id: 1, method: 'tools/list' }) =>
  new Request(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
const chat = () =>
  new Request(`${base}/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ conversationId, content: 'Explain booked revenue.' }),
  });

function excluded(response: Response, status: number): void {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('X-Robots-Tag'), SEARCH_ROBOTS_POLICY);
}

test('Kassandra robots is public, allows noindex discovery and never reaches authentication or inference', async () => {
  const original = globalThis.fetch;
  let upstreamCalls = 0;
  try {
    globalThis.fetch = (async () => {
      upstreamCalls++;
      throw new Error('Public robots must not fetch upstream data.');
    }) as typeof fetch;
    const robots = await handleKassandra(new Request(`${base}/robots.txt`), env);
    excluded(robots, 200);
    assert.equal(robots.headers.get('Content-Type'), 'text/plain; charset=utf-8');
    assert.equal(robots.headers.get('Cache-Control'), 'no-store');
    const text = await robots.text();
    assert.match(text, /User-agent: \*/);
    assert.match(text, /Disallow:\s*\n/);
    assert.doesNotMatch(text, /Disallow:\s*\//);

    const head = await handleKassandra(new Request(`${base}/robots.txt`, { method: 'HEAD' }), env);
    excluded(head, 200);
    assert.equal(head.headers.get('Content-Type'), 'text/plain; charset=utf-8');
    assert.equal(await head.text(), '');
    assert.equal(upstreamCalls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('public routes, preflights and early failures all opt out while preserving status and CORS', async () => {
  const original = globalThis.fetch;
  let upstreamCalls = 0;
  try {
    globalThis.fetch = (async () => {
      upstreamCalls++;
      throw new Error('Early responses must not fetch upstream data.');
    }) as typeof fetch;
    for (const [request, status] of [
      [new Request(`${base}/health`, { headers: { Origin: origin } }), 200],
      [new Request(`${base}/chat`, { method: 'OPTIONS', headers: { Origin: origin } }), 204],
      [new Request(`${base}/missing`, { headers: { Origin: origin } }), 404],
      [new Request(`${base}/robots.txt/missing`, { headers: { Origin: origin } }), 404],
      [new Request(`${base}/chat`, { headers: { Origin: origin } }), 405],
      [new Request(`${base}/mcp`, { method: 'POST', headers: { Origin: origin } }), 401],
      [new Request(`${base}/chat`, { method: 'POST', headers: { Origin: origin } }), 401],
    ] as const) {
      const response = await handleKassandra(request, env);
      excluded(response, status);
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
      if (status === 405) assert.equal(response.headers.get('Allow'), 'POST');
      if (status === 204) assert.equal(await response.text(), '');
    }
    const blocked = await handleKassandra(
      new Request(`${base}/chat`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://untrusted.example.invalid' },
      }),
      env,
    );
    excluded(blocked, 403);
    assert.equal(blocked.headers.has('Access-Control-Allow-Origin'), false);
    assert.equal((await blocked.json()).code, 'ORIGIN_NOT_ALLOWED');
    assert.equal(upstreamCalls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('authenticated MCP results, notifications and protocol failures retain their bodies and headers', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async (input) => {
      assert.equal(String(input), 'https://hotel.example.invalid/api/v1/sessions/current');
      return Response.json({ user: { email: 'indexing-mcp@example.invalid' } });
    }) as typeof fetch;
    const listed = await handleKassandra(mcp(), env);
    excluded(listed, 200);
    assert.equal(listed.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(listed.headers.get('Content-Type'), 'application/json');
    assert(
      (await listed.json()).result.tools.some(
        (tool: { name: string }) => tool.name === 'get_hotel_repair_context',
      ),
    );

    const notification = await handleKassandra(
      mcp({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      env,
    );
    excluded(notification, 202);
    assert.equal(await notification.text(), '');

    const unsupported = await handleKassandra(new Request(`${base}/mcp`, { headers }), env);
    excluded(unsupported, 405);
    assert.equal(unsupported.headers.get('Allow'), 'POST');

    const malformed = await handleKassandra(
      new Request(`${base}/mcp`, {
        method: 'POST',
        headers,
        body: '{invalid json',
      }),
      env,
    );
    excluded(malformed, 400);
    assert.equal((await malformed.json()).error.code, -32700);
  } finally {
    globalThis.fetch = original;
  }
});

function upstream(inferenceStatus = 200): typeof fetch {
  return (async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.openai.com')
      return Response.json(
        inferenceStatus === 200
          ? {
              status: 'completed',
              output: [
                {
                  type: 'message',
                  content: [
                    { type: 'output_text', text: 'Booked revenue reflects existing reservations.' },
                  ],
                },
              ],
            }
          : { error: { code: 'insufficient_quota' } },
        { status: inferenceStatus },
      );
    assert.equal(url.hostname, 'hotel.example.invalid');
    if (url.pathname === '/api/v1/sessions/current')
      return Response.json({ user: { email: 'indexing-chat@example.invalid' } });
    if (url.pathname === `/api/v1/conversations/${conversationId}`)
      return Response.json({
        id: conversationId,
        title: 'Revenue',
        messages: [],
        month: '2026-11',
      });
    assert.equal(url.pathname, '/api/v1/reference-data');
    return Response.json({
      hotels: [],
      bookingSnapshot: { asOf: '2026-11-14' },
      reportingPeriods: [{ key: '2026-11', startDate: '2026-11-01', endDate: '2026-11-30' }],
      meta: { reportingPeriod: { startDate: '2026-10-01', endDate: '2026-12-31' } },
    });
  }) as typeof fetch;
}

test('chat success and structured inference failures carry the same exclusion policy', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = upstream();
    const answer = await handleKassandra(chat(), env);
    excluded(answer, 200);
    assert.equal(answer.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal((await answer.json()).content, 'Booked revenue reflects existing reservations.');

    globalThis.fetch = upstream(429);
    const unavailable = await handleKassandra(chat(), env);
    excluded(unavailable, 429);
    assert.equal((await unavailable.json()).code, 'OPENAI_QUOTA_EXCEEDED');

    const notConfigured = await handleKassandra(chat(), { ...env, OPENAI_API_KEY: '' });
    excluded(notConfigured, 503);
    assert.equal((await notConfigured.json()).code, 'CHAT_NOT_CONFIGURED');
  } finally {
    globalThis.fetch = original;
  }
});

test('expired authentication keeps its structured error and search exclusion', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () => Response.json({}, { status: 401 })) as typeof fetch;
    const response = await handleKassandra(mcp(), env);
    excluded(response, 401);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal((await response.json()).code, 'SESSION_EXPIRED');
  } finally {
    globalThis.fetch = original;
  }
});
