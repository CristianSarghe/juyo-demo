import type { RoomOperationAction } from '../src/app/core/api/mutation.models';
import assert from 'node:assert/strict';
import {
  BOOKING_SNAPSHOT,
  RESERVATIONS,
  RESERVATION_NIGHTS,
  ROOM_TYPES,
} from '../src/app/core/network.data';
import { hotelInventory } from '../src/app/core/api/mock/fixture-selectors';
import { MockRoomRatesRepository as RoomRateService } from '../src/app/core/api/mock/mock-room-rates.repository';
import { MockRoomOperationsRepository as RoomOperationsService } from '../src/app/core/api/mock/mock-room-operations.repository';

const key = 'juyo.room-operations.v1';
const storage = new Map<string, string>();
let storageBlocked = false;
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (name: string) => storage.get(name) ?? null,
    setItem: (name: string, value: string) => {
      if (storageBlocked) throw new Error('Storage blocked');
      storage.set(name, value);
    },
  },
});

const date = BOOKING_SNAPSHOT.asOf;
const interval = { startDate: date, endDate: date };
const canonical = hotelInventory('portfolio', date);
const ledger = JSON.stringify([RESERVATIONS, RESERVATION_NIGHTS]);
const operations = new RoomOperationsService();
const rates = new RoomRateService(operations);
const occupied = canonical.find((room) => room.occupancy === 'occupied')!;
const available = canonical.find((room) => room.occupancy === 'available')!;
const outOfService = canonical.find((room) => room.occupancy === 'out_of_service')!;
assert(occupied && available && outOfService);
const managed = (id: string) => operations.rooms().find((room) => room.id === id)!;
const typeRates = () => rates.rows(available.hotelId, available.roomTypeId, interval)[0];
const baseRateCounts = typeRates();

assert.equal(operations.rooms().length, 88);
assert(operations.rooms().every((room) => room.status === room.occupancy && !room.hasChanges));

for (const action of ['reserve', 'out_of_service', 'available'] as const) {
  assert.equal(operations.update(occupied.id, action), false);
  assert.match(operations.error(), /booking today/);
  assert.equal(managed(occupied.id).status, 'occupied');
}
assert(operations.update(occupied.id, 'clean'));
assert.equal(managed(occupied.id).housekeeping, 'clean');
assert.equal(managed(occupied.id).status, 'occupied');
assert(operations.update(occupied.id, 'dirty'));
assert.equal(managed(occupied.id).housekeeping, 'dirty');
assert(operations.update(occupied.id, 'reset'));
assert.equal(managed(occupied.id).housekeeping, occupied.housekeeping);

assert(operations.update(available.id, 'reserve'));
assert.equal(managed(available.id).status, 'reserved');
assert.equal(managed(available.id).occupancy, 'available');
assert.equal(managed(available.id).hasChanges, true);
assert.equal(typeRates().availableRooms, baseRateCounts.availableRooms - 1);
assert.equal(typeRates().heldRooms, 1);
assert.equal(typeRates().bookedRooms, baseRateCounts.bookedRooms);
assert.equal(typeRates().sellableRooms, baseRateCounts.sellableRooms);
assert.deepEqual(
  new RoomOperationsService().rooms(),
  operations.rooms(),
  'Manual room holds persist on this device',
);

assert(operations.update(available.id, 'out_of_service'));
assert.equal(managed(available.id).status, 'out_of_service');
assert.equal(managed(available.id).occupancy, 'out_of_service');
assert.equal(managed(available.id).maintenance, 'reported');
assert.match(managed(available.id).maintenanceNote!, /manually/);
assert.equal(typeRates().heldRooms, 0);
assert.equal(typeRates().sellableRooms, baseRateCounts.sellableRooms - 1);
assert.equal(typeRates().bookedRooms, baseRateCounts.bookedRooms);
assert.equal(operations.update(available.id, 'reserve'), false);
assert.match(operations.error(), /Return this room to service/);
assert(operations.update(available.id, 'available'));
assert.equal(managed(available.id).status, 'available');
assert.equal(managed(available.id).maintenance, 'none');
assert.equal(managed(available.id).maintenanceNote, null);

assert(operations.update(outOfService.id, 'available'));
assert.equal(managed(outOfService.id).status, 'available');
assert(operations.update(outOfService.id, 'reserve'));
assert.equal(managed(outOfService.id).status, 'reserved');
assert(operations.update(outOfService.id, 'reset'));
assert.equal(managed(outOfService.id).status, 'out_of_service');
assert.equal(managed(outOfService.id).maintenance, outOfService.maintenance);
assert.equal(managed(outOfService.id).maintenanceNote, outOfService.maintenanceNote);

assert(operations.update(available.id, 'reserve'));
assert(operations.update(available.id, 'dirty'));
assert.equal(managed(available.id).status, 'reserved');
assert.equal(managed(available.id).housekeeping, 'dirty');
for (const otherDate of ['2026-10-01', '2026-11-15', '2026-12-31']) {
  assert.deepEqual(
    operations.rooms('portfolio', otherDate),
    hotelInventory('portfolio', otherDate).map((room) => ({
      ...room,
      status: room.occupancy,
      hasChanges: false,
    })),
    'Current-day room changes never spread to historical or future dates',
  );
}
for (const type of ROOM_TYPES) {
  const [row] = rates.rows(type.hotelId, type.id, interval);
  assert.equal(row.availableRooms + row.bookedRooms + row.heldRooms, row.sellableRooms);
}
assert.equal(JSON.stringify([RESERVATIONS, RESERVATION_NIGHTS]), ledger);
assert.deepEqual(
  hotelInventory('portfolio', date),
  canonical,
  'Operational overlays do not mutate canonical rooms.',
);
assert(operations.update(available.id, 'reset'));
assert.equal(managed(available.id).housekeeping, available.housekeeping);
assert.equal(managed(available.id).hasChanges, false);
assert.equal(operations.changes().length, 0);

const beforeFailure = operations.rooms();
storageBlocked = true;
assert.equal(operations.update(available.id, 'reserve'), false);
assert.match(operations.error(), /Could not save/);
assert.deepEqual(operations.rooms(), beforeFailure);
storageBlocked = false;
assert.equal(operations.update('unknown-room', 'clean'), false);
assert.equal(operations.update(available.id, 'unknown-action' as RoomOperationAction), false);
assert.throws(() => operations.rooms('portfolio', '2026-11-31'));

const storedChange = {
  roomId: available.id,
  date,
  status: 'reserved',
  appliedAt: '2026-11-14T12:00:00Z',
};
for (const invalid of [
  { ...storedChange, date: '2026-11-15' },
  { ...storedChange, roomId: 'unknown-room' },
  { ...storedChange, roomId: occupied.id },
  { ...storedChange, status: 'occupied' },
  { ...storedChange, housekeeping: 'unknown-state' },
  { ...storedChange, appliedAt: 'not-a-date' },
]) {
  storage.set(key, JSON.stringify({ version: 1, changes: [invalid] }));
  assert.equal(new RoomOperationsService().changes().length, 0);
}
storage.set(key, '{invalid');
assert.equal(new RoomOperationsService().changes().length, 0);
storage.set(key, JSON.stringify({ version: 2, changes: [storedChange] }));
assert.equal(new RoomOperationsService().changes().length, 0);
storage.set(key, JSON.stringify({ version: 1, changes: [storedChange] }));
assert.equal(
  new RoomOperationsService().rooms().find((room) => room.id === available.id)!.status,
  'reserved',
);

console.log(
  'Validated mock room operations, booking protection, shared rate availability, immutable history, persistence, reset and storage failure.',
);
