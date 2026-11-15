import {
  NETWORK_DATA as data,
  REPORTING_DATES,
  REPORTING_PERIODS,
} from '../src/app/core/network.data.ts';
import { type BookingPosition, type PropertyScope } from '../src/app/core/network.models.ts';
import { bookingOutlook, bookingPace } from '../src/app/core/api/mock/fixture-selectors.ts';
import {
  assert,
  cents,
  groupBy,
  money,
  percent,
  rateCents,
  sum,
  sumCents,
  unique,
} from './validation-helpers.ts';

/** Calendar, ledger and two-snapshot reconciliation, independently of the UI selectors. */
export function validateBookingFixtures(): void {
  const { bookingSnapshot: snapshot, bookingPositions: positions } = data;
  assert.equal(snapshot.asOf, '2026-11-14');
  assert.equal(snapshot.previousAsOf, '2026-11-07');
  assert.equal((Date.parse(snapshot.asOf) - Date.parse(snapshot.previousAsOf)) / 86_400_000, 7);
  assert.deepEqual(snapshot.period, data.meta.reportingPeriod);
  assert.equal(snapshot.period.days, 92);
  assert.deepEqual(new Set(snapshot.includedOnBooksStatuses), new Set(['confirmed', 'checked_in']));
  assert.deepEqual(
    new Set(snapshot.excludedStatuses),
    new Set(['cancelled', 'pending', 'no_show']),
  );
  assert.equal(positions.length, data.hotels.length * REPORTING_DATES.length);
  unique(
    positions.map((row) => `${row.hotelId}/${row.stayDate}`),
    'Booking-position hotel/date',
  );
  const nightsByDay = groupBy(data.reservationNights, (row) => `${row.hotelId}/${row.date}`);
  const daily = new Map(data.dailyPerformance.map((row) => [`${row.hotelId}/${row.date}`, row]));
  const stateFor = (date: string): 'past' | 'today' | 'future' =>
    date < snapshot.asOf ? 'past' : date === snapshot.asOf ? 'today' : 'future';

  for (const hotel of data.hotels) {
    const rows = positions.filter((row) => row.hotelId === hotel.id);
    assert.deepEqual(rows.map((row) => row.stayDate).sort(), REPORTING_DATES);
    for (const row of rows) {
      const key = `${hotel.id}/${row.stayDate}`;
      const performance = daily.get(key)!;
      const nights = nightsByDay.get(key) ?? [];
      assert.equal(row.capturedAsOf, snapshot.asOf, `${key}: snapshot date`);
      assert.equal(row.state, stateFor(row.stayDate));
      assert.equal(row.roomsAvailable, performance.roomsAvailable);
      assert.equal(row.targetRooms, performance.budgetSoldNights);
      assert.equal(cents(row.targetRevenue), cents(performance.budgetRoomRevenue));
      assert.ok(row.targetRooms <= row.roomsAvailable);
      if (row.state === 'past') {
        assert.equal(row.actualRooms, nights.length);
        assert.equal(
          cents(row.actualRoomRevenue!),
          sumCents(nights.map((night) => night.roomRevenue)),
        );
        for (const field of [
          'roomsOnBooks',
          'revenueOnBooks',
          'roomsOnBooks7dAgo',
          'revenueOnBooks7dAgo',
          'pickup7dRoomNights',
          'pickup7dRevenue',
        ] as const)
          assert.equal(row[field], null, `${key}/${field}: past dates have no open position`);
      } else {
        assert.equal(
          row.actualRooms,
          null,
          `${key}: today/future is never completed actual occupancy`,
        );
        assert.equal(
          row.actualRoomRevenue,
          null,
          `${key}: today/future is never completed actual revenue`,
        );
        assert.equal(row.roomsOnBooks, nights.length);
        assert.equal(
          cents(row.revenueOnBooks!),
          sumCents(nights.map((night) => night.roomRevenue)),
        );
        const prior = data.reservations.filter(
          (reservation) =>
            reservation.hotelId === hotel.id &&
            reservation.bookedOn <= snapshot.previousAsOf &&
            (!reservation.cancelledOn || reservation.cancelledOn > snapshot.previousAsOf) &&
            !['pending', 'no_show'].includes(reservation.status) &&
            reservation.arrival <= row.stayDate &&
            reservation.departure > row.stayDate,
        );
        unique(
          prior.map((reservation) => reservation.roomId ?? reservation.id),
          `${key}: prior snapshot cannot double-book a physical room`,
        );
        assert.ok(
          prior.length <= data.rooms.filter((room) => room.hotelId === hotel.id).length,
          `${key}: prior bookings cannot exceed physical inventory`,
        );
        assert.equal(
          row.roomsOnBooks7dAgo,
          prior.length,
          `${key}: prior OTB reconstructs from booking/cancellation history`,
        );
        assert.equal(
          cents(row.revenueOnBooks7dAgo!),
          sumCents(prior.map((reservation) => reservation.quotedNightlyRate)),
          `${key}: prior quoted room-night value`,
        );
        assert.equal(row.pickup7dRoomNights, row.roomsOnBooks! - row.roomsOnBooks7dAgo!);
        assert.equal(
          cents(row.pickup7dRevenue!),
          cents(row.revenueOnBooks!) - cents(row.revenueOnBooks7dAgo!),
          `${key}: signed pickup in exact cents`,
        );
        assert.ok(row.roomsOnBooks! <= row.roomsAvailable);
      }
      for (const field of [
        'actualRoomRevenue',
        'revenueOnBooks',
        'revenueOnBooks7dAgo',
        'pickup7dRevenue',
        'targetRevenue',
      ] as const)
        if (row[field] !== null) money(row[field]!, `${key}/${field}`);
    }
  }
  assert.ok(positions.every((row) => data.hotels.some((hotel) => hotel.id === row.hotelId)));
  assert.ok(
    positions.some((row) => (row.pickup7dRoomNights ?? 0) < 0 && (row.pickup7dRevenue ?? 0) < 0),
    'Cancellation-led negative pickup is represented',
  );
  assert.ok(
    positions.some((row) => (row.pickup7dRoomNights ?? 0) > 0 && (row.pickup7dRevenue ?? 0) > 0),
    'Positive pickup is represented',
  );

  const scopes: PropertyScope[] = [...data.hotels.map((hotel) => hotel.id), 'portfolio'];
  for (const scope of scopes)
    for (const period of REPORTING_PERIODS) {
      const entries = positions.filter(
        (row) =>
          (scope === 'portfolio' || row.hotelId === scope) && row.stayDate.startsWith(period.key),
      );
      const pace = bookingPace(scope, period.key);
      assert.equal(pace.length, period.days);
      assert.deepEqual(
        pace.map((row) => row.date),
        REPORTING_DATES.filter((date) => date.startsWith(period.key)),
      );
      type Metric = Exclude<
        keyof BookingPosition,
        'hotelId' | 'stayDate' | 'capturedAsOf' | 'state'
      >;
      const values = (rows: BookingPosition[], key: Metric): number[] =>
        rows.map((row) => row[key] ?? 0);
      for (const day of pace) {
        const rows = entries.filter((row) => row.stayDate === day.date);
        const actualCents = sumCents(values(rows, 'actualRoomRevenue'));
        const bookedCents = sumCents(values(rows, 'revenueOnBooks'));
        const targetCents = sumCents(values(rows, 'targetRevenue'));
        const sold = sum(values(rows, 'actualRooms')) + sum(values(rows, 'roomsOnBooks'));
        const past = stateFor(day.date) === 'past';
        assert.equal(day.state, stateFor(day.date));
        assert.equal(day.roomsAvailable, sum(values(rows, 'roomsAvailable')));
        assert.equal(day.actualRooms, sum(values(rows, 'actualRooms')));
        assert.equal(cents(day.actualRevenue), actualCents);
        assert.equal(day.onBooksRooms, sum(values(rows, 'roomsOnBooks')));
        assert.equal(cents(day.onBooksRevenue), bookedCents);
        assert.equal(day.securedRooms, sold);
        assert.equal(cents(day.securedRevenue), actualCents + bookedCents);
        assert.equal(day.targetRooms, sum(values(rows, 'targetRooms')));
        assert.equal(cents(day.targetRevenue), targetCents);
        assert.equal(day.remainingTargetRooms, past ? 0 : Math.max(day.targetRooms - sold, 0));
        assert.equal(
          cents(day.remainingTargetRevenue),
          past ? 0 : Math.max(targetCents - actualCents - bookedCents, 0),
        );
        assert.equal(day.pickup7dRooms, sum(values(rows, 'pickup7dRoomNights')));
        assert.equal(cents(day.pickup7dRevenue), sumCents(values(rows, 'pickup7dRevenue')));
      }
      const outlook = bookingOutlook(scope, period.key);
      const past = entries.filter((row) => row.stayDate < snapshot.asOf);
      const open = entries.filter((row) => row.stayDate >= snapshot.asOf);
      const actualCents = sumCents(values(past, 'actualRoomRevenue'));
      const bookedCents = sumCents(values(open, 'revenueOnBooks'));
      const sold = sum(values(past, 'actualRooms'));
      const booked = sum(values(open, 'roomsOnBooks'));
      const pastAvailable = sum(values(past, 'roomsAvailable'));
      const openAvailable = sum(values(open, 'roomsAvailable'));
      assert.deepEqual(outlook.period, period);
      assert.equal(outlook.asOf, snapshot.asOf);
      assert.equal(outlook.previousAsOf, snapshot.previousAsOf);
      assert.equal(cents(outlook.realizedRevenue), actualCents);
      assert.equal(cents(outlook.onBooksRevenue), bookedCents);
      assert.equal(cents(outlook.totalSecuredRevenue), actualCents + bookedCents);
      assert.equal(cents(outlook.targetRevenue), sumCents(values(entries, 'targetRevenue')));
      assert.equal(outlook.targetRooms, sum(values(entries, 'targetRooms')));
      assert.equal(outlook.actualAvailableRooms, pastAvailable);
      assert.equal(outlook.actualSoldRooms, sold);
      assert.equal(outlook.futureAvailableRooms, openAvailable);
      assert.equal(outlook.futureBookedRooms, booked);
      assert.equal(outlook.availableRooms, pastAvailable + openAvailable);
      assert.equal(outlook.securedRooms, sold + booked);
      assert.equal(outlook.realizedOccupancy, percent(sold, pastAvailable));
      assert.equal(outlook.onBooksOccupancy, percent(booked, openAvailable));
      assert.equal(outlook.securedOccupancy, percent(sold + booked, pastAvailable + openAvailable));
      assert.equal(
        outlook.targetOccupancy,
        percent(outlook.targetRooms, pastAvailable + openAvailable),
      );
      assert.equal(cents(outlook.realizedADR), rateCents(actualCents, sold));
      assert.equal(cents(outlook.onBooksADR), rateCents(bookedCents, booked));
      assert.equal(cents(outlook.securedADR), rateCents(actualCents + bookedCents, sold + booked));
      assert.equal(
        cents(outlook.securedRevPAR),
        rateCents(actualCents + bookedCents, pastAvailable + openAvailable),
      );
      assert.equal(outlook.remainingRooms, openAvailable - booked);
      assert.equal(outlook.remainingTargetRooms, sum(pace.map((row) => row.remainingTargetRooms)));
      assert.equal(
        cents(outlook.remainingTargetRevenue),
        sumCents(pace.map((row) => row.remainingTargetRevenue)),
      );
      assert.equal(
        cents(outlook.targetGapRevenue),
        cents(outlook.targetRevenue) - actualCents - bookedCents,
      );
      assert.equal(
        outlook.sevenDayPickupRooms,
        sum(values(open, 'roomsOnBooks')) - sum(values(open, 'roomsOnBooks7dAgo')),
      );
      assert.equal(
        cents(outlook.sevenDayPickupRevenue),
        sumCents(values(open, 'revenueOnBooks')) - sumCents(values(open, 'revenueOnBooks7dAgo')),
      );
      const today = entries.filter((row) => row.stayDate === snapshot.asOf);
      assert.equal(
        outlook.todayRooms,
        sum(values(today, 'roomsOnBooks')),
        `${scope}/${period.key}: absent current day yields zero`,
      );
      assert.equal(cents(outlook.todayRevenue), sumCents(values(today, 'revenueOnBooks')));
      for (const value of Object.values(outlook))
        if (typeof value === 'number')
          assert.ok(Number.isFinite(value), `${scope}/${period.key}: finite summary metric`);
      assert.ok(
        !('operatingProfit' in outlook),
        'Booking positions do not invent future operating profit',
      );
    }
  for (const scope of scopes)
    assert.deepEqual(
      bookingOutlook(scope),
      bookingOutlook(scope, '2026-11'),
      `${scope}: default booking month`,
    );
}
