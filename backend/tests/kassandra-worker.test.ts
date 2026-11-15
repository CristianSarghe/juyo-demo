import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { handleKassandra, type KassandraEnvironment } from '../src/kassandra-worker.js';
import type { HotelNetwork } from '../src/domain/network.models.js';

const fixture = JSON.parse(
  readFileSync(new URL('../../public/data/hotel-network.json', import.meta.url), 'utf8'),
) as HotelNetwork;
const reference = {
  meta: fixture.meta,
  hotels: fixture.hotels,
  bookingSnapshot: fixture.bookingSnapshot,
  reportingPeriods: fixture.reportingPeriods,
  dates: [],
};
const conversationId = randomUUID();
const conversation = {
  id: conversationId,
  title: 'Revenue',
  messages: [],
  propertyId: fixture.hotels[0].id,
  month: '2026-10',
  roomDate: '2026-11-14',
  updatedAt: new Date().toISOString(),
};
const env: KassandraEnvironment = {
  JUYO_API_URL: 'https://hotel.example.invalid/api/v1',
  MCP_PUBLIC_URL: 'https://assistant.example.invalid/mcp',
  OPENAI_API_KEY: 'unit-test-key',
};
const token = 'a'.repeat(64);
const chat = (overrides: Record<string, unknown> = {}): Request =>
  new Request('https://assistant.example.invalid/chat', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Origin: 'http://127.0.0.1:4200',
    },
    body: JSON.stringify({ conversationId, content: 'What revenue is booked?', ...overrides }),
  });

test('local frontend preflights allow ports 4200 and 4201 without upstream access', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = (async () => {
      calls++;
      throw new Error('preflight must not fetch');
    }) as typeof fetch;
    for (const origin of [
      'http://127.0.0.1:4200',
      'http://localhost:4200',
      'http://127.0.0.1:4201',
      'http://localhost:4201',
    ]) {
      const response = await handleKassandra(
        new Request('https://assistant.example.invalid/chat', {
          method: 'OPTIONS',
          headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
        }),
        env,
      );
      assert.equal(response.status, 204);
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
      assert.match(response.headers.get('Access-Control-Allow-Headers') ?? '', /Authorization/);
    }
    const blocked = await handleKassandra(
      new Request('https://assistant.example.invalid/chat', {
        method: 'OPTIONS',
        headers: { Origin: 'http://127.0.0.1:4202' },
      }),
      env,
    );
    assert.equal(blocked.status, 403);
    assert.equal(blocked.headers.has('Access-Control-Allow-Origin'), false);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

function upstream(onInference?: (body: any) => void, sessionStatus = 200): typeof fetch {
  return (async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.openai.com') {
      onInference?.(JSON.parse(String(init?.body)));
      return Response.json({
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [
              { type: 'output_text', text: 'Booked revenue is based on accepted reservations.' },
            ],
          },
        ],
      });
    }
    assert.equal(url.hostname, 'hotel.example.invalid');
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${token}`);
    assert.equal(init?.redirect, 'manual');
    if (url.pathname === '/api/v1/sessions/current')
      return Response.json(
        { user: { email: 'worker-test@example.invalid' } },
        { status: sessionStatus },
      );
    if (url.pathname === `/api/v1/conversations/${conversationId}`)
      return Response.json(conversation);
    if (url.pathname === '/api/v1/reference-data') return Response.json(reference);
    throw new Error(`Unexpected test URL: ${url.pathname}`);
  }) as typeof fetch;
}

test('health is public, but MCP metadata and chat require a valid current backend session', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = (async () => {
      calls++;
      throw new Error('should not fetch');
    }) as typeof fetch;
    assert.equal(
      (await handleKassandra(new Request('https://assistant.example.invalid/health'), env)).status,
      200,
    );
    assert.equal(
      (
        await handleKassandra(
          new Request('https://assistant.example.invalid/mcp', { method: 'POST' }),
          env,
        )
      ).status,
      401,
    );
    assert.equal(calls, 0);
    const blocked = chat();
    blocked.headers.set('Origin', 'https://untrusted.example.invalid');
    assert.equal((await handleKassandra(blocked, env)).status, 403);
    assert.equal(calls, 0);
    globalThis.fetch = upstream(undefined, 401);
    const expired = await handleKassandra(chat(), env);
    assert.equal(expired.status, 401);
    assert.equal((await expired.json()).code, 'SESSION_EXPIRED');
  } finally {
    globalThis.fetch = original;
  }
});

test('authenticated MCP initializes statelessly and advertises only safe data/proposal tools', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = upstream();
    const rpc = (method: string, params?: unknown) =>
      new Request('https://assistant.example.invalid/mcp', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
    const initialize = await handleKassandra(
      rpc('initialize', {
        protocolVersion: '2025-11-25',
        clientInfo: { name: 'test', version: '1' },
        capabilities: {},
      }),
      env,
    );
    assert.equal(initialize.status, 200);
    assert.equal(initialize.headers.has('Mcp-Session-Id'), false);
    assert.equal((await initialize.json()).result.protocolVersion, '2025-11-25');
    const listed = await handleKassandra(rpc('tools/list'), env);
    const tools = (await listed.json()).result.tools;
    assert(tools.some((tool: any) => tool.name === 'recommend_room_price'));
    assert(tools.some((tool: any) => tool.name === 'propose_rate_update'));
    assert(
      tools.every(
        (tool: any) => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint,
      ),
    );
    assert(!tools.some((tool: any) => /apply|execute|sql/.test(tool.name)));
    assert.equal(
      (
        await handleKassandra(
          new Request('https://assistant.example.invalid/mcp', {
            headers: { Authorization: `Bearer ${token}` },
          }),
          env,
        )
      ).status,
      405,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('chat preserves custom hotel/range and resolves saved reporting month by its key', async () => {
  const original = globalThis.fetch;
  try {
    const bodies: any[] = [];
    globalThis.fetch = upstream((body) => bodies.push(body));
    const context = {
      propertyId: fixture.hotels[1].id,
      startDate: '2026-11-18',
      endDate: '2026-11-18',
    };
    const response = await handleKassandra(chat({ context }), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'http://127.0.0.1:4200');
    assert.match((await response.json()).content, /accepted reservations/);
    assert(bodies[0].instructions.includes(JSON.stringify(context)));
    assert.equal(bodies[0].tools[0].authorization, token);
    assert.equal((await handleKassandra(chat(), env)).status, 200);
    assert(bodies[1].instructions.includes('"startDate":"2026-10-01","endDate":"2026-10-31"'));
  } finally {
    globalThis.fetch = original;
  }
});

test('invalid chat context and body never invoke OpenAI; unavailable data is not replaced by fabricated answers', async () => {
  const original = globalThis.fetch;
  try {
    let inferences = 0;
    globalThis.fetch = upstream(() => inferences++);
    for (const context of [
      { propertyId: 'unknown', startDate: '2026-11-14', endDate: '2026-11-20' },
      { propertyId: 'portfolio', startDate: '2026-11-31', endDate: '2026-12-01' },
      { propertyId: 'portfolio', startDate: '2026-09-30', endDate: '2026-11-01' },
      { propertyId: 'portfolio', startDate: '2026-11-20', endDate: '2026-11-14' },
    ])
      assert.equal((await handleKassandra(chat({ context }), env)).status, 422);
    assert.equal((await handleKassandra(chat({ content: 'x'.repeat(4001) }), env)).status, 422);
    assert.equal((await handleKassandra(chat({ content: 'x'.repeat(17000) }), env)).status, 413);
    assert.equal(inferences, 0);
    const unavailable = await handleKassandra(chat(), { ...env, OPENAI_API_KEY: '' });
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).code, 'CHAT_NOT_CONFIGURED');
    globalThis.fetch = (async () => {
      throw new Error('private-upstream-body-must-not-leak');
    }) as typeof fetch;
    const failure = await handleKassandra(chat(), env);
    assert.equal(failure.status, 503);
    assert(!(await failure.text()).includes('private-upstream'));
  } finally {
    globalThis.fetch = original;
  }
});

test('hotel GET retries are finite, recover from 503 and never retry authentication or redirects', async () => {
  const original = globalThis.fetch;
  const rpc = () =>
    new Request('https://assistant.example.invalid/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
  try {
    let calls = 0;
    globalThis.fetch = (async (_url, init) => {
      calls++;
      assert.equal(init?.redirect, 'manual');
      if (calls === 1) return Response.json({ unavailable: true }, { status: 503 });
      return Response.json({ user: { email: 'retry-test@example.invalid' } });
    }) as typeof fetch;
    assert.equal((await handleKassandra(rpc(), env)).status, 200);
    assert.equal(calls, 2, 'One transient read recovers with exactly one retry.');

    for (const status of [401, 302]) {
      calls = 0;
      globalThis.fetch = (async (url, init) => {
        calls++;
        assert.equal(new URL(String(url)).hostname, 'hotel.example.invalid');
        assert.equal(init?.redirect, 'manual');
        return Response.json(
          {},
          {
            status,
            headers: status === 302 ? { Location: 'https://untrusted.example.invalid/steal' } : {},
          },
        );
      }) as typeof fetch;
      const response = await handleKassandra(rpc(), env);
      assert.equal(response.status, status === 401 ? 401 : 502);
      assert.equal(calls, 1, 'Authentication failures and redirects are not retried or followed.');
    }

    calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return Response.json({}, { status: 503 });
    }) as typeof fetch;
    assert.equal((await handleKassandra(rpc(), env)).status, 503);
    assert.equal(calls, 3, 'Permanent transient failure stops after three attempts.');
  } finally {
    globalThis.fetch = original;
  }
});
