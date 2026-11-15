import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type sql from 'mssql';
import {
  decodeMessagePayload,
  encodeMessagePayload,
  isChatAction,
  type ChatAction,
} from '../src/domain/chat.models.js';
import type { Insight, Message } from '../src/domain/models.js';
import { SqlWorkspaceRepository } from '../src/persistence/sql-workspace.repository.js';
import {
  isRateUpdateBatch,
  rateVersion,
  type RateUpdateReviewItem,
} from '../src/domain/rate-batch.js';

const proposal = (): ChatAction => ({
  id: randomUUID(),
  kind: 'rate_update',
  status: 'pending',
  summary: 'Set Classic rooms to €195 for 14–20 November.',
  details: {
    hotelId: 'dev-ams',
    hotelName: 'Canal House Amsterdam',
    roomTypeId: 'dev-ams-type-1',
    roomTypeName: 'Classic',
    startDate: '2026-11-14',
    endDate: '2026-11-20',
    nightlyRate: 195,
  },
});

const reviewed = (
  type = 'dev-ams-type-1',
  startDate = '2026-11-14',
  endDate = startDate,
): RateUpdateReviewItem => ({
  hotelId: 'dev-ams',
  hotelName: 'Canal House Amsterdam',
  roomTypeId: type,
  roomTypeName: 'Classic',
  startDate,
  endDate,
  nightlyRate: 195,
  currentMinRate: 180,
  currentMaxRate: 180,
  expectedRateVersion: rateVersion([{ date: startDate, nightlyRate: 180 }]),
});
const batch = (updates: RateUpdateReviewItem[] = [reviewed()]): ChatAction => ({
  id: randomUUID(),
  kind: 'rate_batch_update',
  status: 'pending',
  summary: 'Review these selling-rate changes.',
  details: { updates },
});

test('batch proposals require bounded, non-overlapping grounded review rows', () => {
  const multi = batch([
    reviewed('dev-ams-type-1', '2026-11-14', '2026-11-16'),
    reviewed('dev-ams-type-1', '2026-11-17', '2026-11-20'),
    reviewed('dev-ams-type-2', '2026-11-14', '2026-11-20'),
  ]);
  assert(isChatAction(multi), 'Adjacent intervals and simultaneous different types are supported.');
  assert.deepEqual(decodeMessagePayload(encodeMessagePayload({ action: multi })), {
    action: multi,
  });
  assert(!isChatAction(batch([])));
  assert(!isChatAction(batch(Array.from({ length: 21 }, (_, index) => reviewed(`type-${index}`)))));
  assert(isChatAction(batch(Array.from({ length: 20 }, (_, index) => reviewed(`type-${index}`)))));
  for (const changes of [
    { currentMinRate: Number.NaN },
    { currentMaxRate: 179 },
    { currentMinRate: 180.001 },
    { expectedRateVersion: '' },
    { expectedRateVersion: 'a'.repeat(63) },
    { nightlyRate: 0 },
    { hotelId: 'dev-ams ' },
    { roomTypeId: ' dev-ams-type-1' },
    { startDate: '0000-11-14' },
    { startDate: '2026-02-30' },
    { endDate: '2026-11-13' },
  ])
    assert(!isChatAction(batch([{ ...reviewed(), ...changes }])));
  assert(
    !isRateUpdateBatch([
      reviewed('type', '2026-11-14', '2026-11-17'),
      reviewed('type', '2026-11-17', '2026-11-20'),
    ]),
    'Shared inclusive endpoints overlap.',
  );
});

test('selling-rate versions cover every date and cent, independent of response ordering', () => {
  const rates = [
    { date: '2026-11-14', nightlyRate: 100 },
    { date: '2026-11-15', nightlyRate: 150 },
    { date: '2026-11-16', nightlyRate: 200 },
  ];
  assert.equal(rateVersion(rates), rateVersion([...rates].reverse()));
  assert.notEqual(
    rateVersion(rates),
    rateVersion(rates.map((row, index) => (index === 1 ? { ...row, nightlyRate: 150.01 } : row))),
    'A changed interior quote invalidates the version even when min/max stay the same.',
  );
  assert.throws(() => rateVersion([]));
  assert.throws(() => rateVersion([rates[0], rates[0]]));
  assert.throws(() => rateVersion([{ date: '2026-02-30', nightlyRate: 100 }]));
});

test('chat proposals validate exact dates, finite cents, identities and supported actions', () => {
  const rate = proposal();
  assert(isChatAction(rate));
  for (const changes of [
    { nightlyRate: Number.NaN },
    { nightlyRate: 1.001 },
    { nightlyRate: 0 },
    { nightlyRate: 10_001 },
    { startDate: '2026-02-30' },
    { endDate: '2026-11-13' },
    { hotelId: '' },
  ])
    assert(!isChatAction({ ...rate, details: { ...rate.details, ...changes } }));
  assert(!isChatAction({ ...rate, status: 'confirmed' }));
  assert(!isChatAction({ ...rate, id: 'not-an-id' }));
  assert(
    isChatAction({
      id: randomUUID(),
      kind: 'room_action',
      status: 'pending',
      summary: 'Mark room 101 clean.',
      details: {
        roomId: 'dev-ams-room-101',
        roomNumber: '101',
        hotelName: 'Canal House Amsterdam',
        date: '2026-11-14',
        action: 'clean',
      },
    }),
  );
});

test('bounded message payload round-trips proposals and preserves legacy Insights', () => {
  const insight: Insight = {
    title: 'Revenue',
    summary: 'Rooms already booked.',
    metrics: [],
    recommendation: 'Review the remaining inventory.',
    sources: ['Reservation nights'],
  };
  const value = { insight, action: proposal() };
  assert.deepEqual(decodeMessagePayload(encodeMessagePayload(value)), value);
  assert.deepEqual(decodeMessagePayload(JSON.stringify(insight)), { insight });
  assert.deepEqual(decodeMessagePayload(null), {});
  assert.equal(encodeMessagePayload({}), null);
});

test('only pending assistant proposals may be persisted and invalid decisions never reach SQL', async () => {
  const repository = new SqlWorkspaceRepository({} as sql.ConnectionPool);
  const user: Message = {
    id: randomUUID(),
    role: 'user',
    content: 'Set this price.',
    createdAt: new Date().toISOString(),
  };
  const assistant: Message = {
    ...user,
    id: randomUUID(),
    role: 'assistant',
    action: { ...proposal(), status: 'applied' },
  };
  await assert.rejects(repository.appendMessages(randomUUID(), randomUUID(), [user, assistant]), {
    code: 'INVALID_MESSAGE',
  });
  await assert.rejects(
    repository.appendMessages(randomUUID(), randomUUID(), [
      { ...user, action: proposal() },
      { ...assistant, action: undefined },
    ]),
    { code: 'INVALID_MESSAGE' },
  );
  await assert.rejects(
    repository.confirmChatAction(randomUUID(), randomUUID(), randomUUID(), 'other' as 'apply'),
    { code: 'INVALID_CHAT_DECISION' },
  );
});
