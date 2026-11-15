import assert from 'node:assert/strict';
import test from 'node:test';
import { requestKassandra } from '../src/chat/remote.js';
import { handleKassandra, type KassandraEnvironment } from '../src/kassandra-worker.js';

const conversation = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  title: 'Repairs',
  updatedAt: '2026-11-14T12:00:00Z',
  messages: [],
};
const env: KassandraEnvironment = {
  JUYO_API_URL: 'https://hotel.example.invalid/api/v1',
  MCP_PUBLIC_URL: 'https://assistant.example.invalid/mcp',
  OPENAI_API_KEY: 'unit-test-key',
};
const request = (path: string, signal?: AbortSignal) =>
  new Request(`https://assistant.example.invalid${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${'a'.repeat(64)}` },
    signal,
  });

test('inference has 160 seconds while MCP reads retain their shorter deadline', async (t) => {
  const deadlines: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    deadlines.push(milliseconds);
    return new AbortController().signal;
  });
  const upstream = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ code: 'UNAUTHENTICATED' }, { status: 401 }),
  );
  assert.equal((await handleKassandra(request('/chat'), env)).status, 401);
  assert.equal((await handleKassandra(request('/mcp'), env)).status, 401);
  assert.deepEqual(deadlines, [160_000, 75_000]);
  assert.equal(upstream.mock.calls.length, 2, 'Authentication failures never retry or invoke a model.');
});

test('the outer inference deadline leaves response time and still cancels without retry', async (t) => {
  const deadlines: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    deadlines.push(milliseconds);
    return new AbortController().signal;
  });
  const caller = new AbortController();
  let upstreamSignal: AbortSignal | undefined;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const upstream = t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      upstreamSignal = init?.signal ?? undefined;
      assert(upstreamSignal);
      upstreamSignal.addEventListener('abort', () => reject(upstreamSignal!.reason), { once: true });
      started();
    }),
  );
  const result = requestKassandra(
    'https://assistant.example.invalid',
    'Bearer unit-test-session',
    conversation,
    'Find repair companies for this hotel.',
    undefined,
    caller.signal,
  );
  const rejected = assert.rejects(result, { code: 'CHAT_UNAVAILABLE' });
  await ready;
  caller.abort();
  await rejected;
  assert.deepEqual(deadlines, [170_000]);
  assert.equal(upstreamSignal?.aborted, true);
  assert.equal(upstream.mock.calls.length, 1, 'A cancelled inference is never sent again.');
});

test('caller cancellation propagates into Worker hotel reads without retry', async (t) => {
  t.mock.method(AbortSignal, 'timeout', () => new AbortController().signal);
  const caller = new AbortController();
  let upstreamSignal: AbortSignal | undefined;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const upstream = t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      upstreamSignal = init?.signal ?? undefined;
      assert(upstreamSignal);
      upstreamSignal.addEventListener('abort', () => reject(upstreamSignal!.reason), { once: true });
      started();
    }),
  );
  const result = handleKassandra(request('/chat', caller.signal), env);
  await ready;
  caller.abort();
  const response = await result;
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'HOTEL_DATA_UNAVAILABLE');
  assert.equal(upstreamSignal?.aborted, true);
  assert.equal(upstream.mock.calls.length, 1);
});
