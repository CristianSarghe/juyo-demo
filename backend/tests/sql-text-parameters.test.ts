import assert from 'node:assert/strict';
import test from 'node:test';
import type sql from 'mssql';
import {
  withSqlTextParameters,
  sqlTextChunks,
  SQL_TEXT_CHUNK_CHARACTERS,
} from '../src/persistence/sql-text-parameters.js';
import { createDatabase } from '../src/database.js';
import { WORKER_SQL_PACKET_SIZE } from '../src/sql-worker-transport.js';

function transaction(dropError?: Error) {
  const batches: string[] = [];
  const chunks: { part: string; ordinal: number; chunk: string }[] = [];
  const parameters: Record<string, unknown>[] = [];
  const tx = {
    request() {
      const values: Record<string, any> = {};
      parameters.push(values);
      return {
        input(name: string, _type: unknown, value: unknown) {
          values[name] = value;
          return this;
        },
        async batch(statement: string) {
          batches.push(statement);
          if (statement.startsWith('DROP') && dropError) throw dropError;
          return { recordset: [] };
        },
        async query(statement: string) {
          assert.match(statement, /^INSERT #JuyoSqlText/);
          chunks.push(values as { part: string; ordinal: number; chunk: string });
          return { recordset: [] };
        },
      };
    },
  } as unknown as sql.Transaction;
  return { tx, batches, chunks, parameters };
}

test('Unicode text chunks preserve exact code units and never split a surrogate pair', () => {
  const text = 'A'.repeat(SQL_TEXT_CHUNK_CHARACTERS - 1) + '🛎️' + 'Z'.repeat(5_000) + '€中文';
  const chunks = sqlTextChunks(text);
  assert.equal(chunks.join(''), text);
  assert(
    chunks.every((chunk) => Buffer.byteLength(chunk, 'utf16le') <= SQL_TEXT_CHUNK_CHARACTERS * 2),
  );
  assert(!/[\uD800-\uDBFF]$/.test(chunks[0]));
  assert.deepEqual(sqlTextChunks(''), ['']);
});

test('short text uses ordinary bound parameters and preserves a null payload', async () => {
  const fake = transaction();
  const value = await withSqlTextParameters(
    fake.tx,
    { content: 'Small message €', insight: null },
    async (_request, text) => {
      assert.deepEqual(text, { content: '@content', insight: '@insight' });
      return 17;
    },
  );
  assert.equal(value, 17);
  assert.deepEqual(fake.batches, []);
  assert.deepEqual(fake.parameters, [{ content: 'Small message €', insight: null }]);
});

test('large combined text stages ordered bounded pieces and assembles complete values once', async () => {
  const fake = transaction();
  const content = '🛎'.repeat(2_000);
  const insight = JSON.stringify({ text: '東京 € '.repeat(1_000) });
  await withSqlTextParameters(fake.tx, { content, insight }, async (_request, text) => {
    assert.match(text.content, /STRING_AGG\(CONVERT\(nvarchar\(max\),Chunk\)/);
    assert.match(text.insight, /WITHIN GROUP \(ORDER BY Ordinal\)/);
    assert.match(text.insight, /WHERE Part='insight'/);
    assert.equal(
      fake.batches.length,
      1,
      'The table remains on the pinned connection until the final write.',
    );
    for (const [part, expected] of Object.entries({ content, insight })) {
      const pieces = fake.chunks.filter((row) => row.part === part);
      assert.equal(pieces.map((row) => row.chunk).join(''), expected);
      assert.deepEqual(
        pieces.map((row) => row.ordinal),
        pieces.map((_row, index) => index),
      );
      assert(pieces.every((row) => row.chunk.length <= SQL_TEXT_CHUNK_CHARACTERS));
    }
  });
  assert.match(fake.batches[0], /^CREATE TABLE #JuyoSqlText/);
  assert.equal(fake.batches[1], 'DROP TABLE #JuyoSqlText;');
});

test('failed final writes still drop staging and preserve the original rollback cause', async () => {
  const original = new Error('Final write failed.');
  const fake = transaction(new Error('Transaction already rolled back.'));
  await assert.rejects(
    withSqlTextParameters(fake.tx, { content: 'x'.repeat(5_000), insight: null }, async () => {
      throw original;
    }),
    (error) => error === original,
  );
  assert(
    fake.chunks.every((row) => row.part === 'content'),
    'Null remains SQL NULL rather than an empty JSON document.',
  );
  assert.equal(fake.batches.at(-1), 'DROP TABLE #JuyoSqlText;');
});

test('Worker database configuration uses the encrypted packet limit constant', () => {
  const env = {
    SQL_SERVER: 'unused.example.invalid',
    SQL_DATABASE: 'unused',
    SQL_USER: 'unused',
    SQL_PASSWORD: 'not-a-secret',
  };
  assert.equal(WORKER_SQL_PACKET_SIZE, 16_000);
  assert.equal(createDatabase(env, true).pool.config.options?.packetSize, WORKER_SQL_PACKET_SIZE);
  assert.equal(createDatabase(env).pool.config.options?.packetSize, 4096);
});
