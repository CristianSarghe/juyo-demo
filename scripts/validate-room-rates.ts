import '@angular/compiler';
import assert from 'node:assert/strict';
import { MockRoomRatesRepository as RoomRateService } from '../src/app/core/api/mock/mock-room-rates.repository';
import type { RoomRateUpdateRequest } from '../src/app/core/api/mutation.models';
import {
  DAILY_ROOM_STATES,
  EVENTS,
  NETWORK_DATA,
  ROOM_RATES,
  ROOM_TYPES,
} from '../src/app/core/network.data';

const KEY = 'juyo.room-rates.v1';
const LEGACY = 'juyo.event-rate-plans.v1';
const storage = new Map<string, string>();
let blocked = false;
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (blocked) throw new Error('Storage blocked');
      storage.set(key, value);
    },
  },
});

const service = new RoomRateService();
const quarter = { startDate: '2026-10-01', endDate: '2026-12-31' };
let checked = 0;
for (const type of ROOM_TYPES) {
  const rows = service.rows(type.hotelId, type.id, quarter);
  assert.equal(rows.length, 92);
  const seeds = ROOM_RATES.filter((rate) => rate.roomTypeId === type.id);
  const roomIds = new Set(
    NETWORK_DATA.rooms.filter((room) => room.roomTypeId === type.id).map((room) => room.id),
  );
  for (const row of rows) {
    const inventory = DAILY_ROOM_STATES.filter(
      (state) => roomIds.has(state.roomId) && state.date === row.date,
    );
    assert.equal(row.nightlyRate, seeds.find((rate) => rate.date === row.date)!.nightlyRate);
    assert.equal(row.seedRate, row.nightlyRate);
    assert.equal(row.updated, false);
    assert.equal(
      row.availableRooms,
      inventory.filter((state) => state.occupancy === 'available').length,
    );
    assert.equal(
      row.sellableRooms,
      inventory.filter((state) => state.occupancy !== 'out_of_service').length,
    );
    assert.equal(row.availableRooms + row.bookedRooms, row.sellableRooms);
    checked++;
  }
}

const type = ROOM_TYPES[0];
const request: RoomRateUpdateRequest = {
  hotelId: type.hotelId,
  roomTypeId: type.id,
  startDate: '2026-10-30',
  endDate: '2026-11-02',
  nightlyRate: 151.25,
};
assert(service.update(request), 'No event is required, including past and cross-month dates');
assert.deepEqual(
  service.rows(type.hotelId, type.id, request).map((row) => row.nightlyRate),
  [151.25, 151.25, 151.25, 151.25],
);
assert(
  service.update({ ...request, startDate: '2026-11-01', endDate: '2026-11-01', nightlyRate: 165 }),
);
assert.deepEqual(
  service.rows(type.hotelId, type.id, request).map((row) => row.nightlyRate),
  [151.25, 151.25, 165, 151.25],
);
assert(
  service.update({
    ...request,
    startDate: '2026-10-31',
    endDate: '2026-11-03',
    nightlyRate: 172.99,
    eventId: EVENTS[0].id,
    reason: '  Weekend demand  ',
  }),
);
assert.deepEqual(
  service
    .rows(type.hotelId, type.id, { startDate: '2026-10-30', endDate: '2026-11-03' })
    .map((row) => row.nightlyRate),
  [151.25, 172.99, 172.99, 172.99, 172.99],
);
assert.equal(
  service.rows(type.hotelId, type.id, { startDate: '2026-11-03', endDate: '2026-11-03' })[0].reason,
  'Weekend demand',
);
assert.deepEqual(
  new RoomRateService().rows(type.hotelId, type.id, request),
  service.rows(type.hotelId, type.id, request),
  'Effective rates restore on reload',
);
assert.equal(service.changes().length, 3);

const count = service.changes().length;
for (const invalid of [
  { ...request, nightlyRate: 0 },
  { ...request, nightlyRate: -1 },
  { ...request, nightlyRate: Number.NaN },
  { ...request, nightlyRate: 10_000.01 },
  { ...request, nightlyRate: 1.001 },
  { ...request, startDate: '2026-09-30' },
  { ...request, endDate: '2027-01-01' },
  { ...request, endDate: '2026-10-29' },
  { ...request, startDate: '2026-11-31' },
  { ...request, roomTypeId: 'missing' },
  {
    ...request,
    hotelId: ROOM_TYPES.find((candidate) => candidate.hotelId !== type.hotelId)!.hotelId,
  },
  { ...request, eventId: 'missing-event' },
  { ...request, reason: 'a'.repeat(241) },
]) {
  assert.equal(service.update(invalid), false);
  assert(service.error());
  assert.equal(service.changes().length, count);
}
blocked = true;
const beforeFailure = service.rows(type.hotelId, type.id, request);
assert.equal(service.update({ ...request, nightlyRate: 200 }), false);
assert.deepEqual(
  service.rows(type.hotelId, type.id, request),
  beforeFailure,
  'Failed persistence does not publish unsaved rates',
);
blocked = false;

// Legacy proposals survive a device upgrade and resolve overlaps by timestamp,
// not by the old source array's incidental order. The original key is preserved.
storage.clear();
storage.set(
  LEGACY,
  JSON.stringify([
    {
      ...request,
      currency: 'EUR',
      eventId: EVENTS[0].id,
      nightlyRate: 190,
      savedAt: '2026-11-14T12:00:00Z',
    },
    {
      ...request,
      currency: 'EUR',
      eventId: EVENTS[0].id,
      nightlyRate: 180,
      savedAt: '2026-11-14T13:00:00+02:00',
    },
    { ...request, currency: 'USD', nightlyRate: 300, savedAt: '2026-11-14T14:00:00Z' },
  ]),
);
const legacyBefore = storage.get(LEGACY);
const migrated = new RoomRateService();
assert.equal(migrated.changes().length, 2);
assert(migrated.rows(type.hotelId, type.id, request).every((row) => row.nightlyRate === 190));
assert(migrated.update({ ...request, nightlyRate: 195, eventId: null }));
assert(
  new RoomRateService()
    .rows(type.hotelId, type.id, request)
    .every((row) => row.nightlyRate === 195),
);
assert.equal(storage.get(LEGACY), legacyBefore);

storage.set(KEY, '{invalid');
assert.equal(new RoomRateService().changes().length, 0);
storage.set(KEY, JSON.stringify({ version: 1, updates: [{ nope: true }] }));
assert.equal(new RoomRateService().changes().length, 0);
storage.set(KEY, JSON.stringify({ version: 2, updates: migrated.changes() }));
assert.equal(new RoomRateService().changes().length, 0);
console.log(
  `Validated ${checked} daily rates, inventory counts, independent intervals, overlap precedence, migration, reload and storage failure.`,
);
