import assert from 'node:assert/strict';
import test from 'node:test';
import worker, { JuyoSqlGateway } from '../src/worker.js';
import type { ApiEnvironment } from '../src/config.js';
import { SEARCH_ROBOTS_POLICY } from '../src/search-indexing.js';

const origin = 'http://127.0.0.1:4200';
const apiUrl = 'https://api.example.invalid/api/v1/hotels';
type WorkerEnvironment = Parameters<typeof worker.fetch>[1];

test('edge and direct gateway health/robots bypass SQL and opt out of indexing', async () => {
  const environment = {
    get SQL_GATEWAY() {
      throw new Error('Public metadata must not resolve the SQL gateway.');
    },
  } as WorkerEnvironment;
  const state = {
    get storage() {
      throw new Error('Public metadata must not access Durable Object storage.');
    },
  };
  const gateway = new JuyoSqlGateway(state, {} as ApiEnvironment);
  const handlers = [
    (request: Request) => worker.fetch(request, environment),
    (request: Request) => gateway.fetch(request),
  ];
  for (const fetch of handlers) {
    const health = await fetch(new Request('https://api.example.invalid/health'));
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('X-Robots-Tag'), SEARCH_ROBOTS_POLICY);
    assert.equal(health.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await health.json(), { status: 'ok', service: 'juyo-api' });

    const robots = await fetch(new Request('https://api.example.invalid/robots.txt'));
    assert.equal(robots.status, 200);
    assert.equal(robots.headers.get('X-Robots-Tag'), SEARCH_ROBOTS_POLICY);
    assert.equal(robots.headers.get('Content-Type'), 'text/plain; charset=utf-8');
    const text = await robots.text();
    assert.match(text, /User-agent: \*/);
    assert.match(text, /Disallow:\s*$/);
    assert.doesNotMatch(text, /Disallow:\s*\//, 'Crawlers need access to the noindex header.');

    const head = await fetch(
      new Request('https://api.example.invalid/robots.txt', { method: 'HEAD' }),
    );
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('X-Robots-Tag'), SEARCH_ROBOTS_POLICY);
    assert.equal(head.headers.get('Content-Type'), 'text/plain; charset=utf-8');
    assert.equal(head.body, null);
  }
});

test('delegated streamed success preserves status, body, authentication and CORS with noindex', async () => {
  let forwarded: Request | undefined;
  let objectName = '';
  const payload = '{"created":true}';
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  });
  const environment = {
    SQL_GATEWAY: {
      getByName(name: string) {
        objectName = name;
        return {
          async fetch(request: Request) {
            forwarded = request;
            return new Response(stream, {
              status: 201,
              statusText: 'Created',
              headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': origin,
                Location: '/api/v1/conversations/one',
                'X-Request-Id': 'request-1',
              },
            });
          },
        };
      },
    },
  } as WorkerEnvironment;
  const request = new Request(apiUrl, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-session', Origin: origin },
    body: '{}',
  });

  const response = await worker.fetch(request, environment);

  assert.equal(forwarded, request);
  assert.equal(forwarded.headers.get('Authorization'), 'Bearer test-session');
  assert.equal(objectName, 'juyo-network');
  assert.equal(response.status, 201);
  assert.equal(response.statusText, 'Created');
  assert.equal(response.headers.get('X-Robots-Tag'), SEARCH_ROBOTS_POLICY);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal(response.headers.get('Location'), '/api/v1/conversations/one');
  assert.equal(response.headers.get('X-Request-Id'), 'request-1');
  assert.equal(await response.text(), payload);
});

test('delegated problem and preflight responses retain their status and CORS headers', async () => {
  for (const status of [503, 204]) {
    const environment = {
      SQL_GATEWAY: {
        getByName() {
          return {
            async fetch() {
              return new Response(status === 204 ? null : '{"code":"SERVICE_UNAVAILABLE"}', {
                status,
                headers: {
                  'Content-Type': 'application/problem+json',
                  'Access-Control-Allow-Origin': origin,
                  'Access-Control-Allow-Methods': 'GET, OPTIONS',
                  'Cache-Control': 'no-store',
                },
              });
            },
          };
        },
      },
    } as WorkerEnvironment;
    const response = await worker.fetch(
      new Request(apiUrl, {
        method: status === 204 ? 'OPTIONS' : 'GET',
        headers: { Origin: origin },
      }),
      environment,
    );
    assert.equal(response.status, status);
    assert.equal(response.headers.get('X-Robots-Tag'), SEARCH_ROBOTS_POLICY);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'GET, OPTIONS');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    if (status === 204) assert.equal(response.body, null);
    else assert.deepEqual(await response.json(), { code: 'SERVICE_UNAVAILABLE' });
  }
});

test('gateway transport failures return a safe excluded problem response', async () => {
  const environment = {
    SQL_GATEWAY: {
      getByName() {
        return {
          async fetch(): Promise<Response> {
            throw new Error('Private upstream connection detail must not appear.');
          },
        };
      },
    },
  } as WorkerEnvironment;

  const response = await worker.fetch(new Request(apiUrl), environment);

  assert.equal(response.status, 503);
  assert.equal(response.headers.get('X-Robots-Tag'), SEARCH_ROBOTS_POLICY);
  assert.equal(response.headers.get('Content-Type'), 'application/problem+json');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = await response.text();
  assert.match(body, /SERVICE_UNAVAILABLE/);
  assert.doesNotMatch(body, /Private upstream/);
});

test('direct fallback and direct gateway configuration errors also carry search exclusion', async () => {
  const gateway = new JuyoSqlGateway({}, {} as ApiEnvironment);
  const responses = await Promise.all([
    worker.fetch(new Request(apiUrl), {} as WorkerEnvironment),
    gateway.fetch(new Request(apiUrl)),
  ]);
  for (const response of responses) {
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('X-Robots-Tag'), SEARCH_ROBOTS_POLICY);
    assert.equal(response.headers.get('Content-Type'), 'application/problem+json');
    assert.equal(((await response.json()) as { code: string }).code, 'SERVICE_UNAVAILABLE');
  }
});
