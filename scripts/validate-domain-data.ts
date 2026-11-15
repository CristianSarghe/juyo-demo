import assert from 'node:assert/strict';
import { NETWORK_DATA } from '../src/app/core/network.data';
import { createNetworkSelectors, reportingDatesFor } from '../src/app/core/network.selectors';
import { createBookingRateHistory } from '../src/app/core/room-price-history';
import { createEventRateContext } from '../src/app/core/event-rate-plan.service';
import { buildNetworkSchema } from '../src/app/core/network.schema';

// Different API responses must remain independent, without module-level fixture indexes.
const first = structuredClone(NETWORK_DATA);
const second = structuredClone(NETWORK_DATA);
second.hotels[0].name = 'Alternate property response';
const roomState = second.dailyRoomStates.find(
  (row) => row.date === second.bookingSnapshot.asOf && row.occupancy === 'occupied',
)!;
roomState.housekeeping = roomState.housekeeping === 'clean' ? 'dirty' : 'clean';
const firstSelectors = createNetworkSelectors(first);
const secondSelectors = createNetworkSelectors(second);
assert.equal(firstSelectors.hotelSummary(first.hotels[0].id).name, first.hotels[0].name);
assert.equal(secondSelectors.hotelSummary(second.hotels[0].id).name, second.hotels[0].name);
assert.notEqual(
  firstSelectors.hotelInventory().find((room) => room.id === roomState.roomId)!.housekeeping,
  secondSelectors.hotelInventory().find((room) => room.id === roomState.roomId)!.housekeeping,
);

const acceptedNight = second.reservationNights[0];
acceptedNight.roomRevenue += 11;
const reservation = second.reservations.find((row) => row.id === acceptedNight.reservationId)!;
const firstHistory = createBookingRateHistory(first)(reservation.hotelId, reservation.roomTypeId);
const secondHistory = createBookingRateHistory(second)(reservation.hotelId, reservation.roomTypeId);
assert.equal(
  Math.round(secondHistory.find((row) => row.date === acceptedNight.date)!.bookedRevenue * 100) -
    Math.round(firstHistory.find((row) => row.date === acceptedNight.date)!.bookedRevenue * 100),
  1100,
);

const events = createEventRateContext(first);
const candidate = first.events
  .flatMap((event) =>
    first.roomTypes.map((type) => ({ event, type, context: events(event, type) })),
  )
  .find((row) => row.context && row.context.availableRoomNights > 0)!;
const typeRooms = new Set(
  first.rooms.filter((room) => room.roomTypeId === candidate.type.id).map((room) => room.id),
);
const unavailable = second.dailyRoomStates.find(
  (row) =>
    typeRooms.has(row.roomId) &&
    row.occupancy === 'available' &&
    row.date >= candidate.context!.startDate &&
    row.date <= candidate.context!.endDate,
)!;
unavailable.occupancy = 'out_of_service';
unavailable.maintenance = 'reported';
unavailable.housekeeping = 'dirty';
unavailable.maintenanceNote = 'Alternative API response maintenance';
const secondContext = createEventRateContext(second)(candidate.event, candidate.type)!;
assert.equal(secondContext.availableRoomNights, candidate.context!.availableRoomNights - 1);
assert.equal(secondContext.sellableRoomNights, candidate.context!.sellableRoomNights - 1);
assert.equal(
  events(candidate.event, candidate.type)!.availableRoomNights,
  candidate.context!.availableRoomNights,
);

const pending = {
  ...second.reservations.find((row) => row.status === 'pending')!,
  id: 'alternate-pending',
};
second.reservations.push(pending);
const firstSchema = buildNetworkSchema(first);
const secondSchema = buildNetworkSchema(second);
assert.equal(
  secondSchema.dataDictionary.find((row) => row.key === 'reservations')!.rowCount,
  firstSchema.dataDictionary.find((row) => row.key === 'reservations')!.rowCount + 1,
);
assert.equal(
  secondSchema.enumDictionary
    .find((row) => row.key === 'reservationStatus')!
    .values.find((row) => row.value === 'pending')!.count,
  firstSchema.enumDictionary
    .find((row) => row.key === 'reservationStatus')!
    .values.find((row) => row.value === 'pending')!.count + 1,
);

assert.deepEqual(reportingDatesFor({ startDate: '2026-11-30', endDate: '2026-12-01' }), [
  '2026-11-30',
  '2026-12-01',
]);
assert.throws(
  () => reportingDatesFor({ startDate: '2026-11-31', endDate: '2026-12-01' }),
  RangeError,
);
assert.throws(
  () => reportingDatesFor({ startDate: '2026-12-01', endDate: '2026-11-30' }),
  RangeError,
);
console.log(
  'Validated independent API snapshot calculations, accepted-price histories, event inventory, schema counts and reporting calendars.',
);
