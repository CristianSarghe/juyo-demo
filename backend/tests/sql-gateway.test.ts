import assert from 'node:assert/strict';
import test from 'node:test';
import worker, { JuyoSqlGateway } from '../src/worker.js';
import type { ApiEnvironment } from '../src/config.js';

test('the edge gateway forwards the untouched authenticated request to one stable compute object', async () => {
  let name = '';
  let forwarded: Request | undefined;
  const expected = Response.json({ forwarded: true });
  const environment = {
    SQL_GATEWAY: {
      getByName(value: string) {
        name = value;
        return {
          fetch: async (request: Request) => {
            forwarded = request;
            return expected;
          },
        };
      },
    },
  } as unknown as ApiEnvironment & { SQL_GATEWAY: any };
  const request = new Request('https://hotel.example.invalid/api/v1/conversations/one/messages', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer unit-test-session',
      'Content-Type': 'application/json',
      Origin: 'http://127.0.0.1:4200',
    },
    body: JSON.stringify({ content: 'A question' }),
  });
  const response = await worker.fetch(request, environment);
  assert.equal(response.status, expected.status);
  assert.equal(response.headers.get('Content-Type'), expected.headers.get('Content-Type'));
  assert.deepEqual(await response.json(), { forwarded: true });
  assert.equal(name, 'juyo-network');
  assert.equal(forwarded, request);
  assert.equal(forwarded?.headers.get('Authorization'), 'Bearer unit-test-session');
  assert.deepEqual(await forwarded!.json(), { content: 'A question' });
});

test('health bypasses the namespace, SQL configuration and Durable Object storage', async () => {
  const request = new Request('https://hotel.example.invalid/health');
  const environment = {
    get SQL_GATEWAY() {
      throw new Error('Health must not resolve the object.');
    },
  } as unknown as ApiEnvironment;
  assert.equal((await worker.fetch(request, environment)).status, 200);
  const state = {
    get storage() {
      throw new Error('The compute adapter must not use storage.');
    },
  };
  const object = new JuyoSqlGateway(state, {} as ApiEnvironment);
  assert.equal((await object.fetch(request)).status, 200);
  assert.equal(
    (
      await worker.fetch(
        new Request('https://hotel.example.invalid/api/v1/hotels'),
        {} as ApiEnvironment,
      )
    ).status,
    503,
  );
});
