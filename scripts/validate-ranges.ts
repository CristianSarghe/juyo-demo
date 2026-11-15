import assert from 'node:assert/strict';
import '@angular/compiler';
import {
  createEnvironmentInjector,
  Injector,
  runInInjectionContext,
  type EnvironmentInjector,
} from '@angular/core';
import { ReferenceDataService } from '../src/app/core/api/reference-data.service';
import { AppUiStore } from '../src/app/core/app-ui.store';
import { ReportingScopeService } from '../src/app/core/reporting-scope.service.ts';
import { HotelScopeService } from '../src/app/core/hotel-scope.service.ts';
import {
  BOOKING_POSITIONS,
  BOOKING_SNAPSHOT,
  DAILY_PERFORMANCE,
  DAILY_ROOM_STATES,
  HOTELS,
  NETWORK_DATA,
  REPORTING_DATES,
  REPORTING_PERIODS,
  RESERVATIONS,
  RESERVATION_NIGHTS,
  ROOMS,
} from '../src/app/core/network.data.ts';
import type { BookingOutlook, DateRange, PropertyScope } from '../src/app/core/network.models.ts';
import {
  bookingOutlook,
  bookingChartContext,
  bookingPace,
  bookingSources,
  hotelDaySummary,
  validateDateRange,
} from '../src/app/core/api/mock/fixture-selectors.ts';

const cents = (value: number): number => Math.round(value * 100);
const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);
const sumCents = (values: number[]): number => sum(values.map(cents));
const percentage = (part: number, total: number): number =>
  total ? Math.round((part / total) * 10_000) / 100 : 0;
const ranges: DateRange[] = [
  { startDate: '2026-10-01', endDate: '2026-10-01' },
  { startDate: '2026-11-14', endDate: '2026-11-14' },
  { startDate: '2026-12-31', endDate: '2026-12-31' },
  { startDate: '2026-10-10', endDate: '2026-10-20' },
  { startDate: '2026-11-01', endDate: '2026-11-13' },
  { startDate: '2026-10-28', endDate: '2026-11-16' },
  { startDate: '2026-11-28', endDate: '2026-12-04' },
  { startDate: '2026-11-15', endDate: '2026-12-31' },
  { startDate: '2026-10-01', endDate: '2026-12-31' },
  ...REPORTING_PERIODS.map(({ startDate, endDate }) => ({ startDate, endDate })),
];
let checked = 0;
for (const scope of [...HOTELS.map((hotel) => hotel.id), 'portfolio'] as const) {
  const belongs = (row: { hotelId: string }): boolean =>
    scope === 'portfolio' || row.hotelId === scope;
  for (const range of ranges) {
    const context = `${scope}/${range.startDate}–${range.endDate}`;
    const input = Object.freeze({ ...range });
    assert.deepEqual(validateDateRange(input), input);
    const canonical = DAILY_PERFORMANCE.filter(
      (day) => belongs(day) && day.date >= range.startDate && day.date <= range.endDate,
    );
    const dates = REPORTING_DATES.filter(
      (date) => date >= range.startDate && date <= range.endDate,
    );
    const pace = bookingPace(scope, input);
    assert.deepEqual(
      pace.map((day) => day.date),
      dates,
      `${context}: inclusive date bounds, with no outside rows`,
    );
    for (const day of pace) {
      const rows = canonical.filter((row) => row.date === day.date);
      assert.equal(day.roomsAvailable, sum(rows.map((row) => row.roomsAvailable)));
      assert.equal(day.securedRooms, sum(rows.map((row) => row.soldNights)));
      assert.equal(cents(day.securedRevenue), sumCents(rows.map((row) => row.roomRevenue)));
      assert.equal(cents(day.targetRevenue), sumCents(rows.map((row) => row.budgetRoomRevenue)));
      assert.equal(
        day.state,
        day.date < BOOKING_SNAPSHOT.asOf
          ? 'past'
          : day.date === BOOKING_SNAPSHOT.asOf
            ? 'today'
            : 'future',
      );
    }
    const outlook = bookingOutlook(scope, input);
    const past = canonical.filter((day) => day.date < BOOKING_SNAPSHOT.asOf);
    const open = canonical.filter((day) => day.date >= BOOKING_SNAPSHOT.asOf);
    const realizedCents = sumCents(past.map((day) => day.roomRevenue));
    const onBooksCents = sumCents(open.map((day) => day.roomRevenue));
    const totalCents = realizedCents + onBooksCents;
    const actualNights = sum(past.map((day) => day.soldNights));
    const bookedNights = sum(open.map((day) => day.soldNights));
    const soldNights = actualNights + bookedNights;
    const sources = bookingSources(scope, input);
    const accepted = RESERVATIONS.filter(
      (reservation) =>
        belongs(reservation) &&
        reservation.roomId !== null &&
        ['confirmed', 'checked_in', 'checked_out'].includes(reservation.status) &&
        reservation.bookedOn <= BOOKING_SNAPSHOT.asOf &&
        (!reservation.cancelledOn || reservation.cancelledOn > BOOKING_SNAPSHOT.asOf) &&
        reservation.arrival <= range.endDate &&
        reservation.departure > range.startDate,
    );
    assert.equal(sources.length, 4, `${context}: all booking sources retained`);
    assert.equal(
      sum(sources.map((source) => source.bookings)),
      accepted.length,
      `${context}: a multi-night booking counts once, using stay dates`,
    );
    assert.equal(sum(sources.map((source) => source.roomNights)), soldNights, context);
    assert.equal(sumCents(sources.map((source) => source.roomRevenue)), totalCents, context);
    for (const source of sources) {
      const reservations = accepted.filter((reservation) => reservation.channel === source.channel);
      assert.equal(source.bookings, reservations.length, `${context}/${source.channel}`);
      assert.equal(source.share, percentage(reservations.length, accepted.length), context);
      const nights = reservations.reduce(
        (sum, reservation) =>
          sum +
          dates.filter((date) => date >= reservation.arrival && date < reservation.departure)
            .length,
        0,
      );
      assert.equal(source.roomNights, nights, context);
      assert.equal(
        cents(source.roomRevenue),
        reservations.reduce(
          (sum, reservation) =>
            sum +
            dates.filter((date) => date >= reservation.arrival && date < reservation.departure)
              .length *
              cents(reservation.quotedNightlyRate),
          0,
        ),
        context,
      );
    }
    const actualCapacity = sum(past.map((day) => day.roomsAvailable));
    const bookedCapacity = sum(open.map((day) => day.roomsAvailable));
    const capacity = actualCapacity + bookedCapacity;
    const targetCents = sumCents(canonical.map((day) => day.budgetRoomRevenue));
    const targetNights = sum(canonical.map((day) => day.budgetSoldNights));
    assert.equal(outlook.period.startDate, range.startDate);
    assert.equal(outlook.period.endDate, range.endDate);
    assert.equal(outlook.period.days, dates.length);
    assert.ok(outlook.period.label.length > 0);
    assert.equal(outlook.asOf, BOOKING_SNAPSHOT.asOf);
    assert.equal(
      cents(outlook.realizedRevenue),
      realizedCents,
      `${context}: actual revenue uses past dates only`,
    );
    assert.equal(
      cents(outlook.onBooksRevenue),
      onBooksCents,
      `${context}: booked revenue uses today/future only`,
    );
    assert.equal(cents(outlook.totalSecuredRevenue), totalCents);
    assert.equal(cents(outlook.targetRevenue), targetCents);
    assert.equal(outlook.actualSoldRooms, actualNights);
    assert.equal(outlook.futureBookedRooms, bookedNights);
    assert.equal(outlook.securedRooms, soldNights);
    assert.equal(outlook.actualAvailableRooms, actualCapacity);
    assert.equal(outlook.futureAvailableRooms, bookedCapacity);
    assert.equal(outlook.availableRooms, capacity);
    assert.equal(outlook.targetRooms, targetNights);
    assert.equal(outlook.realizedOccupancy, percentage(actualNights, actualCapacity));
    assert.equal(outlook.onBooksOccupancy, percentage(bookedNights, bookedCapacity));
    assert.equal(
      outlook.securedOccupancy,
      percentage(soldNights, capacity),
      `${context}: occupancy is weighted room nights, not added daily percentages`,
    );
    assert.equal(outlook.targetOccupancy, percentage(targetNights, capacity));
    for (const [key, revenueCents, denominator] of [
      ['realizedADR', realizedCents, actualNights],
      ['onBooksADR', onBooksCents, bookedNights],
      ['securedADR', totalCents, soldNights],
      ['targetADR', targetCents, targetNights],
      ['securedRevPAR', totalCents, capacity],
      ['targetRevPAR', targetCents, capacity],
    ] as const)
      assert.equal(
        cents(outlook[key]),
        denominator ? Math.round(revenueCents / denominator) : 0,
        `${context}: weighted ${key}`,
      );
    assert.equal(outlook.remainingRooms, bookedCapacity - bookedNights);
    assert.equal(cents(outlook.targetGapRevenue), targetCents - totalCents);
    assert.equal(
      cents(outlook.remainingTargetRevenue),
      sumCents(pace.filter((day) => day.state !== 'past').map((day) => day.remainingTargetRevenue)),
    );
    assert.equal(
      outlook.remainingTargetRooms,
      sum(pace.filter((day) => day.state !== 'past').map((day) => day.remainingTargetRooms)),
    );
    const pickup = BOOKING_POSITIONS.filter(
      (row) =>
        belongs(row) &&
        row.stayDate >= range.startDate &&
        row.stayDate <= range.endDate &&
        row.stayDate >= BOOKING_SNAPSHOT.asOf,
    );
    assert.equal(
      outlook.sevenDayPickupRooms,
      sum(pickup.map((row) => row.pickup7dRoomNights ?? 0)),
    );
    assert.equal(
      cents(outlook.sevenDayPickupRevenue),
      sumCents(pickup.map((row) => row.pickup7dRevenue ?? 0)),
    );
    const today = open.filter((day) => day.date === BOOKING_SNAPSHOT.asOf);
    assert.equal(outlook.todayRooms, sum(today.map((day) => day.soldNights)));
    assert.equal(cents(outlook.todayRevenue), sumCents(today.map((day) => day.roomRevenue)));
    for (const value of Object.values(outlook))
      if (typeof value === 'number')
        assert.ok(
          Number.isFinite(value),
          `${context}: no NaN or infinity for zero actual/booked denominators`,
        );
    assert.deepEqual(input, range, `${context}: selector never mutates its selection input`);
    checked++;
  }
  for (const period of REPORTING_PERIODS) {
    const monthly = bookingOutlook(scope, period.key);
    assert.deepEqual(
      monthly.period,
      period,
      'Existing month inputs retain period metadata including key',
    );
    const ranged = bookingOutlook(scope, { startDate: period.startDate, endDate: period.endDate });
    for (const [key, value] of Object.entries(monthly))
      if (key !== 'period')
        assert.deepEqual(
          ranged[key as keyof BookingOutlook],
          value,
          `Month/range compatibility for ${scope}/${period.key}/${key}`,
        );
    assert.deepEqual(
      bookingPace(scope, period.key),
      bookingPace(scope, { startDate: period.startDate, endDate: period.endDate }),
    );
    assert.deepEqual(
      bookingSources(scope, period.key),
      bookingSources(scope, { startDate: period.startDate, endDate: period.endDate }),
    );
  }
  assert.deepEqual(bookingOutlook(scope), bookingOutlook(scope, '2026-11'));
}

for (const range of [
  { startDate: '2026-11-31', endDate: '2026-12-01' },
  { startDate: '2026-10-01', endDate: '2026-12-32' },
  { startDate: '2026-11-1', endDate: '2026-11-14' },
  { startDate: '2026-12-15', endDate: '2026-12-01' },
  { startDate: '2026-09-30', endDate: '2026-10-01' },
  { startDate: '2026-12-31', endDate: '2027-01-01' },
  { startDate: '', endDate: '2026-11-14' },
  { startDate: 'not-a-date', endDate: '2026-11-14' },
]) {
  assert.throws(() => validateDateRange(range), RangeError);
  assert.throws(() => bookingPace('portfolio', range), RangeError);
  assert.throws(() => bookingOutlook('portfolio', range), RangeError);
  assert.throws(() => bookingSources('portfolio', range), RangeError);
}

for (const [range, label] of [
  [{ startDate: '2026-11-01', endDate: '2026-11-30' }, 'November 2026'],
  [{ startDate: '2026-11-10', endDate: '2026-11-20' }, '10–20 Nov 2026'],
  [{ startDate: '2026-10-28', endDate: '2026-11-05' }, '28 Oct – 5 Nov 2026'],
  [{ startDate: '2026-11-14', endDate: '2026-11-14' }, '14 Nov 2026'],
] as const)
  assert.equal(bookingOutlook('portfolio', range).period.label, label);

const chartCases: {
  range: DateRange;
  contextStart: string;
  contextEnd: string;
  count: number;
  window: number;
  start: number;
  scrollable: boolean;
}[] = [
  {
    range: { startDate: '2026-11-14', endDate: '2026-11-14' },
    contextStart: '2026-11-01',
    contextEnd: '2026-11-30',
    count: 30,
    window: 30,
    start: 0,
    scrollable: false,
  },
  {
    range: { startDate: '2026-10-10', endDate: '2026-10-20' },
    contextStart: '2026-10-01',
    contextEnd: '2026-10-31',
    count: 31,
    window: 31,
    start: 0,
    scrollable: false,
  },
  {
    range: { startDate: '2026-10-28', endDate: '2026-11-05' },
    contextStart: '2026-10-01',
    contextEnd: '2026-11-30',
    count: 61,
    window: 30,
    start: 16,
    scrollable: true,
  },
  {
    range: { startDate: '2026-11-28', endDate: '2026-12-04' },
    contextStart: '2026-11-01',
    contextEnd: '2026-12-31',
    count: 61,
    window: 30,
    start: 15,
    scrollable: true,
  },
  {
    range: { startDate: '2026-10-01', endDate: '2026-12-31' },
    contextStart: '2026-10-01',
    contextEnd: '2026-12-31',
    count: 92,
    window: 30,
    start: 0,
    scrollable: true,
  },
  {
    range: { startDate: '2026-12-31', endDate: '2026-12-31' },
    contextStart: '2026-12-01',
    contextEnd: '2026-12-31',
    count: 31,
    window: 31,
    start: 0,
    scrollable: false,
  },
  {
    range: { startDate: '2026-10-31', endDate: '2026-11-30' },
    contextStart: '2026-10-01',
    contextEnd: '2026-11-30',
    count: 61,
    window: 30,
    start: 30,
    scrollable: true,
  },
];
let chartChecks = 0;
for (const scope of [...HOTELS.map((hotel) => hotel.id), 'portfolio'] as const) {
  for (const test of chartCases) {
    const selectedMetrics = bookingOutlook(scope, test.range);
    const context = bookingChartContext(scope, Object.freeze({ ...test.range }));
    assert.deepEqual(context.range, test.range);
    assert.equal(context.rows.length, test.count);
    assert.equal(context.rows[0].date, test.contextStart);
    assert.equal(context.rows.at(-1)!.date, test.contextEnd);
    assert.equal(context.windowSize, test.window);
    assert.equal(context.startIndex, test.start);
    assert.equal(context.endIndex, test.start + test.window - 1, 'Window end index is inclusive');
    assert.equal(context.scrollable, test.scrollable);
    assert.ok(context.startIndex >= 0 && context.endIndex < context.rows.length);
    assert.deepEqual(
      context.rows,
      bookingPace(scope, { startDate: test.contextStart, endDate: test.contextEnd }),
      'Chart context retains canonical day rows; it does not invent or mask financial values',
    );
    assert.deepEqual(
      context.rows.filter(
        (row) => row.date >= test.range.startDate && row.date <= test.range.endDate,
      ),
      bookingPace(scope, test.range),
      'Context contains the exact selected interval',
    );
    assert.deepEqual(
      bookingOutlook(scope, test.range),
      selectedMetrics,
      'Chart context leaves interval metrics unchanged',
    );
    const selectedDates = context.rows.filter(
      (row) => row.date >= test.range.startDate && row.date <= test.range.endDate,
    );
    if (test.scrollable && selectedDates.length <= 30) {
      assert.ok(context.rows[context.startIndex].date <= test.range.startDate);
      assert.ok(
        context.rows[context.endIndex].date >= test.range.endDate,
        'Short cross-month selection fits inside the initial centered window',
      );
    }
    chartChecks++;
  }
}
assert.throws(
  () => bookingChartContext('portfolio', { startDate: '2026-11-31', endDate: '2026-12-01' }),
  RangeError,
);

let dailyChecks = 0;
const excludedStatuses = new Set(['cancelled', 'pending', 'no_show']);
for (const scope of [...HOTELS.map((hotel) => hotel.id), 'portfolio'] as const) {
  const belongs = (row: { hotelId: string }): boolean =>
    scope === 'portfolio' || row.hotelId === scope;
  const physicalRooms = ROOMS.filter(belongs).length;
  const accepted = RESERVATIONS.filter(
    (reservation) =>
      belongs(reservation) &&
      reservation.roomId !== null &&
      !excludedStatuses.has(reservation.status),
  );
  for (const date of REPORTING_DATES) {
    const context = `${scope}/${date}`;
    const summary = hotelDaySummary(scope, date);
    const states = DAILY_ROOM_STATES.filter((row) => belongs(row) && row.date === date);
    const nights = RESERVATION_NIGHTS.filter((row) => belongs(row) && row.date === date);
    const performance = DAILY_PERFORMANCE.filter((row) => belongs(row) && row.date === date);
    const closed = date < BOOKING_SNAPSHOT.asOf;
    const revenueCents = sumCents(nights.map((night) => night.roomRevenue));
    const outOfOrder = states.filter((row) => row.occupancy === 'out_of_service').length;
    const occupied = states.filter((row) => row.occupancy === 'occupied').length;
    assert.equal(summary.date, date, context);
    assert.equal(summary.basis, closed ? 'actual' : 'scheduled', context);
    assert.equal(summary.physicalRooms, physicalRooms, context);
    assert.equal(summary.outOfOrderRooms, outOfOrder, context);
    assert.equal(summary.sellableRooms, physicalRooms - outOfOrder, context);
    assert.equal(summary.sellableRooms, sum(performance.map((row) => row.roomsAvailable)), context);
    assert.equal(summary.occupiedRooms, occupied, context);
    assert.equal(summary.occupiedRooms, nights.length, context);
    assert.equal(summary.roomsToSell, summary.sellableRooms - nights.length, context);
    assert.ok(summary.roomsToSell >= 0, context);
    assert.equal(summary.arrivals, accepted.filter((row) => row.arrival === date).length, context);
    assert.equal(
      summary.departures,
      accepted.filter((row) => row.departure === date).length,
      context,
    );
    assert.equal(cents(summary.roomRevenue), revenueCents, context);
    assert.equal(
      cents(summary.targetRevenue),
      sumCents(performance.map((row) => row.budgetRoomRevenue)),
      context,
    );
    assert.equal(
      cents(summary.averageRate),
      nights.length ? Math.round(revenueCents / nights.length) : 0,
      context,
    );
    assert.equal(summary.occupancy, percentage(nights.length, summary.sellableRooms), context);
    if (scope === 'portfolio') {
      const hotels = HOTELS.map((hotel) => hotelDaySummary(hotel.id, date));
      for (const key of [
        'physicalRooms',
        'sellableRooms',
        'occupiedRooms',
        'roomsToSell',
        'outOfOrderRooms',
        'arrivals',
        'departures',
      ] as const)
        assert.equal(summary[key], sum(hotels.map((hotel) => hotel[key])), `${context}/${key}`);
      assert.equal(cents(summary.roomRevenue), sumCents(hotels.map((hotel) => hotel.roomRevenue)));
      assert.equal(
        cents(summary.targetRevenue),
        sumCents(hotels.map((hotel) => hotel.targetRevenue)),
      );
    }
    dailyChecks++;
  }
}
for (const date of ['2026-09-30', '2027-01-01', '2026-11-31', '2026-11-1', ''])
  assert.throws(() => hotelDaySummary('portfolio', date), RangeError);
assert.throws(() => hotelDaySummary('unknown' as PropertyScope, '2026-11-14'), /Unknown hotel/);

// Exercise the actual shared calendar service, including linked-signal resets.
const environment = createEnvironmentInjector(
  [
    {
      provide: ReferenceDataService,
      useValue: {
        data: {
          meta: NETWORK_DATA.meta,
          bookingSnapshot: NETWORK_DATA.bookingSnapshot,
          hotels: NETWORK_DATA.hotels,
          reportingPeriods: REPORTING_PERIODS,
          dates: REPORTING_DATES,
        },
        validateDateRange: ReferenceDataService.prototype.validateDateRange,
      },
    },
  ],
  Injector.NULL as EnvironmentInjector,
);
const store = runInInjectionContext(environment, () => new AppUiStore());
const reporting = new ReportingScopeService(store);
const hotels = new HotelScopeService(store);
const november = { startDate: '2026-11-01', endDate: '2026-11-30' };
assert.deepEqual(reporting.dashboardRange(), november);
const custom = { startDate: '2026-10-28', endDate: '2026-11-16' };
assert.equal(reporting.selectDashboardRange(custom), true);
assert.deepEqual(reporting.dashboardRange(), custom);
assert.equal(
  reporting.month(),
  '2026-11',
  'Custom dashboard range does not replace other pages’ month context',
);
assert.equal(reporting.date(), BOOKING_SNAPSHOT.asOf);
hotels.select('dev-ams');
assert.deepEqual(
  reporting.dashboardRange(),
  custom,
  'Hotel selection preserves the dashboard calendar range',
);
assert.equal(
  reporting.selectDashboardRange({ startDate: '2026-11-31', endDate: '2026-12-01' }),
  false,
);
assert.deepEqual(
  reporting.dashboardRange(),
  custom,
  'Rejected range does not change committed dates',
);
reporting.selectMonth('2026-12');
assert.deepEqual(
  reporting.dashboardRange(),
  { startDate: '2026-12-01', endDate: '2026-12-31' },
  'External month changes reset a custom dashboard range',
);
const oneDay = { startDate: '2026-12-14', endDate: '2026-12-14' };
assert.equal(reporting.selectDashboardRange(oneDay), true);
assert.deepEqual(reporting.dashboardRange(), oneDay);
assert.equal(reporting.selectDashboardRange(november), true);
assert.deepEqual(
  reporting.dashboardRange(),
  november,
  'Exact month selection replaces a custom range',
);
assert.equal(reporting.month(), '2026-11');
assert.equal(reporting.date(), BOOKING_SNAPSHOT.asOf);
reporting.selectDashboardRange({ startDate: '2026-11-10', endDate: '2026-11-20' });
assert.equal(reporting.selectDashboardRange(november), true);
assert.deepEqual(
  reporting.dashboardRange(),
  november,
  'Selecting the current full month also clears its custom range',
);
reporting.selectDashboardRange(custom);
reporting.selectDate('2026-10-15');
assert.deepEqual(
  reporting.dashboardRange(),
  { startDate: '2026-10-01', endDate: '2026-10-31' },
  'A date selected in another month updates dashboard bounds through the shared month',
);
assert.equal(reporting.date(), '2026-10-15');
environment.destroy();
console.log(
  `Validated ${checked} hotel/range combinations, ${chartChecks} whole-month chart contexts, ${dailyChecks} hotel/day summaries, inclusive totals, weighted rates, invalid-date rejection and shared calendar state.`,
);
