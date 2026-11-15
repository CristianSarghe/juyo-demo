import assert from 'node:assert/strict';
import {
  BOOKING_SNAPSHOT,
  REPORTING_DATES,
  RESERVATIONS,
  RESERVATION_NIGHTS,
  ROOM_RATES,
  ROOM_TYPES,
} from '../src/app/core/network.data';
import type { Reservation, ReservationNight } from '../src/app/core/network.models';
import {
  aggregateBookingRateHistory,
  bookingRateHistory,
} from '../src/app/core/api/mock/fixture-domain';

const cents = (amount: number): number => Math.round(amount * 100);
let checked = 0;
let totalNights = 0;
let totalCents = 0;
let emptyDates = 0;
let singlePriceDates = 0;
let doublePriceDates = 0;
let triplePriceDates = 0;
let novemberOccupiedDates = 0;
let novemberSinglePriceDates = 0;
for (const type of ROOM_TYPES) {
  const history = bookingRateHistory(type.hotelId, type.id);
  assert.deepEqual(
    history.map((day) => day.date),
    REPORTING_DATES,
  );
  for (const day of history) {
    // Independently start with accepted covering reservations, then their nightly ledger.
    const reservations = RESERVATIONS.filter(
      (reservation) =>
        reservation.hotelId === type.hotelId &&
        reservation.roomTypeId === type.id &&
        reservation.arrival <= day.date &&
        reservation.departure > day.date &&
        reservation.bookedOn <= BOOKING_SNAPSHOT.asOf &&
        !['cancelled', 'pending', 'no_show'].includes(reservation.status) &&
        reservation.roomId !== null,
    );
    const nights = reservations.flatMap((reservation) =>
      RESERVATION_NIGHTS.filter(
        (night) => night.reservationId === reservation.id && night.date === day.date,
      ),
    );
    const expectedCents = nights.reduce((sum, night) => sum + cents(night.roomRevenue), 0);
    assert.equal(day.bookedRoomNights, nights.length);
    assert.equal(cents(day.bookedRevenue), expectedCents);
    assert.equal(
      day.weightedRate,
      nights.length ? Math.round(expectedCents / nights.length) / 100 : null,
    );
    assert.equal(day.rateCount, new Set(nights.map((night) => cents(night.roomRevenue))).size);
    assert(day.rateCount <= 3, `${type.id} ${day.date}: at most three distinct accepted prices`);
    assert.equal(
      day.priceBuckets.reduce((sum, price) => sum + price.roomNights, 0),
      nights.length,
    );
    assert.equal(
      day.priceBuckets.reduce((sum, price) => sum + cents(price.nightlyRate) * price.roomNights, 0),
      expectedCents,
    );
    if (day.priceBuckets.length === 1) {
      singlePriceDates++;
      assert.equal(
        day.weightedRate,
        day.priceBuckets[0].nightlyRate,
        `${type.id} ${day.date}: one booked price must equal the average exactly`,
      );
    }
    if (day.rateCount === 2) doublePriceDates++;
    if (day.rateCount === 3) triplePriceDates++;
    if (day.date.startsWith('2026-11') && day.bookedRoomNights) {
      novemberOccupiedDates++;
      if (day.rateCount === 1) novemberSinglePriceDates++;
    }
    if (day.priceBuckets.length) {
      assert(
        day.weightedRate! >= day.priceBuckets[0].nightlyRate &&
          day.weightedRate! <= day.priceBuckets.at(-1)!.nightlyRate,
        `${type.id} ${day.date}: the average remains between the actual booked prices`,
      );
    }
    totalNights += day.bookedRoomNights;
    totalCents += cents(day.bookedRevenue);
    if (!nights.length) {
      emptyDates++;
      assert.equal(day.weightedRate, null, 'No bookings is a gap, never a zero or a forecast');
    }
    checked++;
  }
  for (const [label, occupied] of [
    ['Quarter', history.filter((day) => day.bookedRoomNights > 0)],
    [
      'November',
      history.filter((day) => day.date.startsWith('2026-11') && day.bookedRoomNights > 0),
    ],
  ] as const) {
    assert(
      occupied.filter((day) => day.rateCount === 1).length * 2 > occupied.length,
      `${type.id}: most occupied ${label} dates have one accepted price`,
    );
  }
}
assert.equal(totalNights, RESERVATION_NIGHTS.length);
assert.equal(
  totalCents,
  RESERVATION_NIGHTS.reduce((sum, night) => sum + cents(night.roomRevenue), 0),
);
assert(emptyDates > 0, 'The fixture exercises genuinely empty dates');
assert(singlePriceDates > 0, 'The fixture exercises dates with one unique booked price');
assert(
  singlePriceDates * 2 > checked - emptyDates,
  'Most occupied room-type dates in the quarter have a single accepted price',
);
assert(
  novemberSinglePriceDates * 2 > novemberOccupiedDates,
  'Most occupied November room-type dates have a single accepted price',
);
assert.throws(() => bookingRateHistory(ROOM_TYPES[0].hotelId, ROOM_TYPES.at(-1)!.id), RangeError);

// November examples must visibly exercise repricing and retained, unequal booking prices.
for (const classic of ROOM_TYPES.filter((roomType) => roomType.id.endsWith('-type-1'))) {
  const november = bookingRateHistory(classic.hotelId, classic.id).filter((day) =>
    day.date.startsWith('2026-11-'),
  );
  assert(
    november.some((day) => day.rateCount >= 2),
    `${classic.id}: November includes occasional overlapping accepted quotes`,
  );
  const quote = (date: string): number =>
    ROOM_RATES.find((rate) => rate.roomTypeId === classic.id && rate.date === date)!.nightlyRate;
  assert(quote('2026-11-18') > quote('2026-11-17'), `${classic.id}: midmonth rate increase`);
  assert(quote('2026-11-22') < quote('2026-11-21'), `${classic.id}: later rate reduction`);
}
const amsterdamHistory = bookingRateHistory('dev-ams', 'dev-ams-type-1');
const amsterdamVariation = amsterdamHistory.find((day) => day.date === '2026-11-18')!;
assert.equal(amsterdamVariation.rateCount, 3, 'A limited midmonth example has three prices');
assert.equal(amsterdamHistory.find((day) => day.date === '2026-11-14')!.rateCount, 1);
assert.equal(amsterdamHistory.find((day) => day.date === '2026-11-19')!.rateCount, 1);
assert(
  new Set(amsterdamVariation.priceBuckets.map((price) => price.roomNights)).size > 1,
  'The three-price example has unequal booking weights',
);
const berlinHistory = bookingRateHistory('dev-ber', 'dev-ber-type-1');
const reducedDay = berlinHistory.find((day) => day.date === '2026-11-22')!;
const reducedQuote = ROOM_RATES.find(
  (rate) => rate.roomTypeId === 'dev-ber-type-1' && rate.date === reducedDay.date,
)!;
assert(
  reducedDay.weightedRate! > reducedQuote.nightlyRate,
  'Existing Berlin bookings retain earlier prices after the selling quote drops',
);

const type = ROOM_TYPES[0];
const base = RESERVATIONS.find((reservation) => reservation.roomTypeId === type.id)!;
const reservations: Reservation[] = [];
const nights: ReservationNight[] = [];
function add(
  id: string,
  revenue: number,
  overrides: Partial<Reservation> = {},
  date = '2026-11-14',
): void {
  const roomId = `${id}-room`;
  reservations.push({
    ...base,
    id,
    roomId,
    hotelId: type.hotelId,
    roomTypeId: type.id,
    status: 'confirmed',
    arrival: date,
    departure: '2026-11-16',
    bookedOn: '2026-11-01',
    cancelledOn: null,
    quotedNightlyRate: 999, // The chart must use nightly revenue, not a stay quote.
    ...overrides,
  });
  nights.push({
    reservationId: id,
    roomId,
    hotelId: type.hotelId,
    date,
    roomRevenue: revenue,
    channel: 'direct',
  });
}
add('at-100-a', 100);
add('at-100-b', 100);
add('at-100-c', 100);
add('at-200', 200);
add('cancelled', 1000, { status: 'cancelled', cancelledOn: '2026-11-13' });
add('pending', 1000, { status: 'pending' });
add('no-show', 1000, { status: 'no_show' });
add('not-yet-booked', 1000, { bookedOn: '2026-11-15' });
add('cancelled-by-snapshot', 1000, { cancelledOn: '2026-11-14' });
add('unassigned', 1000, { roomId: null });
add('different-type', 1000, { roomTypeId: ROOM_TYPES[1].id });
add('nightly-140', 140, {}, '2026-11-15');
add('nightly-160', 160, {}, '2026-11-15');
const synthetic = aggregateBookingRateHistory(type.hotelId, type.id, {
  reservations,
  nights,
  dates: ['2026-11-14', '2026-11-15', '2026-11-16'],
  asOf: '2026-11-14',
});
assert.equal(synthetic[0].weightedRate, 125, '3×€100 + 1×€200 is €125, not €150');
assert.equal(synthetic[0].bookedRoomNights, 4);
assert.equal(synthetic[0].bookedRevenue, 500);
assert.deepEqual(synthetic[0].priceBuckets, [
  { nightlyRate: 100, roomNights: 3 },
  { nightlyRate: 200, roomNights: 1 },
]);
assert.equal(
  synthetic[1].weightedRate,
  150,
  'Future booked nights use their actual nightly prices',
);
assert.equal(synthetic[2].weightedRate, null);

console.log(
  `Validated ${checked} room-type/date weighted rates, ${totalNights} booked room nights, ${singlePriceDates} single-price / ${doublePriceDates} double-price / ${triplePriceDates} triple-price dates (${novemberSinglePriceDates}/${novemberOccupiedDates} occupied November dates have one price), unequal price weights, exclusions and ${emptyDates} empty-date gaps.`,
);
