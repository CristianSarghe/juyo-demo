import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi, type ApiDependencies } from '../src/app.js';
import { createDatabase, runInferenceWithoutSql } from '../src/database.js';
import type { ApiEnvironment } from '../src/config.js';
import type { Conversation, Message } from '../src/domain/models.js';
import { encodeMessagePayload } from '../src/domain/chat.models.js';
import type { SqlWorkspaceRepository } from '../src/persistence/sql-workspace.repository.js';

const env: ApiEnvironment = {
  SQL_SERVER: 'unused.example.invalid',
  SQL_DATABASE: 'unused',
  SQL_USER: 'unused',
  SQL_PASSWORD: 'unit-test-password',
  KASSANDRA_URL: 'https://assistant.example.invalid',
};
const conversation: Conversation = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  title: 'Event price review',
  messages: [],
  updatedAt: '2026-11-15T00:00:00Z',
};
const request = () =>
  new Request(`https://hotel.example.invalid/api/v1/conversations/${conversation.id}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bearer unit-test-session', 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'Review the event prices.' }),
  });

function dependencies(trace: string[], scoped = true, reconnectFails = false) {
  let connected = true;
  const database = {
    async close() {
      trace.push('close');
      connected = false;
    },
    async connect() {
      trace.push('connect');
      if (reconnectFails) throw new Error('Test reconnection failure.');
      connected = true;
    },
  };
  const deps: ApiDependencies = {
    env,
    sessions: {
      async authenticate() {
        return { id: 'test-user', name: 'Test', email: 'test@example.invalid' };
      },
      async login() {
        throw new Error('Not used.');
      },
      async logout() {},
    },
    workspace: {
      async getConversation() {
        assert.equal(connected, true);
        trace.push('getConversation');
        return conversation;
      },
      async appendMessages(_user: string, _id: string, messages: Message[]) {
        assert.equal(connected, true, 'Persistence uses the fresh SQL connection.');
        trace.push('append');
        assert.equal(messages.length, 2);
        return { ...conversation, messages };
      },
    } as unknown as SqlWorkspaceRepository,
    async loadNetwork() {
      throw new Error('The message route needs no network snapshot.');
    },
    ...(scoped
      ? { runInference: <T>(infer: () => Promise<T>) => runInferenceWithoutSql(database, infer) }
      : {}),
  };
  return { deps, isConnected: () => connected };
}

test('request-owned SQL closes for inference and reconnects once before persisting its answer', async (t) => {
  const trace: string[] = [];
  const { deps, isConnected } = dependencies(trace);
  const inference = t.mock.method(globalThis, 'fetch', async () => {
    trace.push('infer');
    assert.equal(isConnected(), false, 'No SQL socket remains during the model wait.');
    return Response.json({ content: 'Review these event prices.' });
  });
  const response = await handleApi(request(), deps);
  assert.equal(response.status, 201);
  assert.deepEqual(trace, ['getConversation', 'close', 'infer', 'connect', 'append']);
  assert.equal(inference.mock.calls.length, 1);
  assert.equal((await response.json()).messages.length, 2);
});

test('failed inference leaves SQL closed and never appends or retries a message', async (t) => {
  const trace: string[] = [];
  const { deps, isConnected } = dependencies(trace);
  const inference = t.mock.method(globalThis, 'fetch', async () => {
    trace.push('infer');
    return Response.json({ code: 'CHAT_UNAVAILABLE' }, { status: 503 });
  });
  const response = await handleApi(request(), deps);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'CHAT_UNAVAILABLE');
  assert.deepEqual(trace, ['getConversation', 'close', 'infer']);
  assert.equal(isConnected(), false);
  assert.equal(inference.mock.calls.length, 1);
});

test('a failed SQL reopen cannot append or retry a successful model answer', async (t) => {
  const trace: string[] = [];
  const { deps } = dependencies(trace, true, true);
  t.mock.method(console, 'error', () => {});
  const inference = t.mock.method(globalThis, 'fetch', async () => {
    trace.push('infer');
    return Response.json({ content: 'Review these event prices.' });
  });
  const response = await handleApi(request(), deps);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'SERVICE_UNAVAILABLE');
  assert.deepEqual(trace, ['getConversation', 'close', 'infer', 'connect']);
  assert.equal(inference.mock.calls.length, 1);
});

test('the Node dependency path keeps its shared SQL pool open during inference', async (t) => {
  const trace: string[] = [];
  const { deps, isConnected } = dependencies(trace, false);
  t.mock.method(globalThis, 'fetch', async () => {
    trace.push('infer');
    assert.equal(isConnected(), true);
    return Response.json({ content: 'Review these event prices.' });
  });
  assert.equal((await handleApi(request(), deps)).status, 201);
  assert.deepEqual(trace, ['getConversation', 'infer', 'append']);
});

test('database connect caches only in-flight work and reopens the same explicitly closed pool', async (t) => {
  const database = createDatabase(env);
  // Exercise actual mssql pool lifecycle without opening any socket or using SQL credentials.
  const driver = database.pool as unknown as {
    _poolCreate(): Promise<object>;
    _poolDestroy(connection: unknown): Promise<void>;
  };
  const create = t.mock.method(driver, '_poolCreate', async () => ({}));
  t.mock.method(driver, '_poolDestroy', async () => {});
  try {
    const first = database.connect();
    assert.equal(database.connect(), first, 'Concurrent callers share the in-flight connect.');
    assert.equal(await first, database.pool);
    assert.equal(database.pool.connected, true);
    await database.close();
    assert.equal(database.pool.connected, false);
    assert.equal(
      await database.connect(),
      database.pool,
      'Repositories retain the same pool object.',
    );
    assert.equal(
      database.pool.connected,
      true,
      'A resolved prior connect cannot mask a closed pool.',
    );
    assert.equal(
      create.mock.calls.length,
      2,
      'Each explicit opening performs a fresh driver probe.',
    );
  } finally {
    await database.close();
  }
});

test('large batch preparation logs only correlated UTF-16 sizes before persistence', async (t) => {
  const logs: Record<string, unknown>[] = [];
  const trace: string[] = [];
  const { deps } = dependencies(trace, false);
  const content = 'Prepared a review 😊';
  const updates = Array.from({ length: 9 }, (_, index) => ({
    hotelId: 'private-hotel',
    roomTypeId: `private-type-${index}`,
    hotelName: 'Private hotel name',
    roomTypeName: `Room type ${index}`,
    startDate: '2026-12-01',
    endDate: '2026-12-01',
    nightlyRate: 123.45,
    currentMinRate: 100,
    currentMaxRate: 100,
    expectedRateVersion: 'a'.repeat(64),
  }));
  const action = {
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    kind: 'rate_batch_update' as const,
    status: 'pending' as const,
    summary: 'Private review',
    details: { updates },
  };
  t.mock.method(console, 'info', (value: string) => {
    trace.push('prepared');
    logs.push(JSON.parse(value));
  });
  let count = 8;
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      content,
      action: { ...action, details: { updates: updates.slice(0, count) } },
    }),
  );
  assert.equal((await handleApi(request(), deps)).status, 201);
  assert.equal(logs.length, 0, 'Normal small reviews do not emit diagnostics.');
  trace.length = 0;
  count = 9;
  const response = await handleApi(request(), deps);
  assert.equal(response.status, 201);
  assert.deepEqual(trace, ['getConversation', 'prepared', 'append']);
  assert.deepEqual(
    logs,
    [
      {
        code: 'CHAT_REPLY_PREPARED',
        requestId: response.headers.get('X-Request-Id'),
        contentUtf16Bytes: Buffer.byteLength(content, 'utf16le'),
        encodedPayloadUtf16Bytes: Buffer.byteLength(
          encodeMessagePayload({ content, action })!,
          'utf16le',
        ),
        rowCount: 9,
      },
    ],
    'Logs exclude text, hotel/type identifiers, rates and authentication.',
  );
});
