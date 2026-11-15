import '@angular/compiler';
import assert from 'node:assert/strict';
import { eventRateContext, suggestEventRate } from '../src/app/core/api/mock/fixture-domain';
import {
  BOOKING_SNAPSHOT,
  DAILY_ROOM_STATES,
  EVENTS,
  NETWORK_DATA,
  ROOM_TYPES,
} from '../src/app/core/network.data';
import { upcomingEvents } from '../src/app/core/api/mock/fixture-selectors';

let contexts = 0;
for (const item of upcomingEvents()) {
  for (const impact of item.impacts) {
    for (const type of ROOM_TYPES.filter((type) => type.hotelId === impact.hotelId)) {
      const context = eventRateContext(item.event, type);
      assert(context);
      assert(
        context.startDate >= BOOKING_SNAPSHOT.asOf,
        'Event insights only cover current and future demand',
      );
      const roomIds = new Set(
        NETWORK_DATA.rooms.filter((room) => room.roomTypeId === type.id).map((room) => room.id),
      );
      const states = DAILY_ROOM_STATES.filter(
        (state) =>
          roomIds.has(state.roomId) &&
          state.date >= context.startDate &&
          state.date <= context.endDate,
      );
      assert.equal(
        context.availableRoomNights,
        states.filter((state) => state.occupancy === 'available').length,
      );
      assert.equal(
        context.bookedRoomNights,
        states.filter((state) => state.occupancy === 'occupied').length,
      );
      assert.equal(
        context.sellableRoomNights,
        states.filter((state) => state.occupancy !== 'out_of_service').length,
      );
      assert.equal(
        context.availableRoomNights + context.bookedRoomNights,
        context.sellableRoomNights,
      );
      const suggestion = suggestEventRate(context, impact.importance);
      assert(suggestion.nightlyRate >= context.baseRate);
      assert(suggestion.nightlyRate <= Math.ceil(context.baseRate * 1.12));
      assert(suggestion.explanation.startsWith('Rule-based suggestion:'));
      contexts++;
    }
  }
}

const ongoing = EVENTS.find(
  (event) => event.startDate < BOOKING_SNAPSHOT.asOf && event.endDate >= BOOKING_SNAPSHOT.asOf,
)!;
const ongoingType = ROOM_TYPES.find(
  (type) =>
    type.hotelId ===
    upcomingEvents().find((item) => item.event.id === ongoing.id)!.impacts[0].hotelId,
)!;
const clipped = eventRateContext(ongoing, ongoingType)!;
assert.equal(clipped.startDate, BOOKING_SNAPSHOT.asOf);
assert.equal(clipped.nights, 2);
assert.equal(
  eventRateContext(ongoing, ongoingType, { startDate: '2026-11-15', endDate: '2026-11-15' })
    ?.nights,
  1,
);
assert.throws(
  () => eventRateContext(ongoing, ongoingType, { startDate: '2026-11-14', endDate: '2026-11-16' }),
  RangeError,
);
assert.equal(
  eventRateContext({ ...ongoing, startDate: '2026-11-01', endDate: '2026-11-02' }, ongoingType),
  null,
);
assert.equal(
  suggestEventRate({ ...clipped, baseRate: 100, bookedOccupancy: 90 }, 'important').nightlyRate,
  112,
);
assert.equal(
  suggestEventRate({ ...clipped, baseRate: 100, bookedOccupancy: 40 }, 'medium').nightlyRate,
  100,
);
assert.equal(
  suggestEventRate({ ...clipped, baseRate: 99.99, bookedOccupancy: 40 }, 'mild').nightlyRate,
  99.99,
);

console.log(`Validated ${contexts} event-demand contexts and local rate-insight suggestions.`);
