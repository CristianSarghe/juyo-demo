import { Conversation, HotelProperty, Insight } from './models';
import {
  BOOKING_SNAPSHOT,
  DAILY_COSTS,
  DAILY_PERFORMANCE,
  FACILITIES,
  FIXTURE_META,
  HOTELS,
  REPORTING_DATES,
  REPORTING_PERIODS,
  RESERVATIONS,
  RESTAURANTS,
} from './network.data';
import type { PropertyScope, ReportingMonth } from './network.models';
import {
  bookingOutlook,
  bookingPace,
  channelSummary,
  costTotals,
  hotelSummary,
} from './api/mock/fixture-selectors';

export const PROPERTIES: readonly HotelProperty[] = [
  ...HOTELS.map((hotel) => ({
    id: hotel.id,
    name: hotel.name,
    location: `${hotel.city}, ${hotel.country}`,
  })),
  { id: 'portfolio', name: 'All hotels', location: 'Europe · 4 hotels' },
];
const eur = (value: number): string =>
  new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
const number = (value: number): string =>
  new Intl.NumberFormat('en-IE', { maximumFractionDigits: 2 }).format(value);
const percent = (part: number, total: number): number =>
  total ? Math.round((part / total) * 10_000) / 100 : 0;
const selected = <T extends { hotelId: string }>(rows: readonly T[], scope: PropertyScope): T[] =>
  rows.filter((row) => scope === 'portfolio' || row.hotelId === scope);
const period = (month: ReportingMonth) => REPORTING_PERIODS.find((entry) => entry.key === month)!;
const monthName = (month: ReportingMonth): string => period(month).label.split(' ')[0];
const dateLabel = (date: string): string =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    new Date(`${date}T12:00:00Z`),
  );

export function resolveReportingMonth(
  prompt: string,
  fallback: ReportingMonth = '2026-11',
): ReportingMonth {
  const query = prompt.toLowerCase();
  return (
    REPORTING_PERIODS.find(
      (entry) =>
        query.includes(entry.key) || query.includes(entry.label.split(' ')[0].toLowerCase()),
    )?.key ?? fallback
  );
}
function roomBasis(scope: PropertyScope, month: ReportingMonth): string {
  const rows = bookingPace(scope, month);
  return rows.every((row) => row.state === 'past')
    ? 'Actual'
    : rows.every((row) => row.state !== 'past')
      ? 'On the books'
      : 'Actual + booked';
}
function occupancyInsight(scope: PropertyScope, month: ReportingMonth): Insight {
  const outlook = bookingOutlook(scope, month);
  const days = bookingPace(scope, month);
  const basis = roomBasis(scope, month);
  const lowest = [...days].sort(
    (a, b) => a.securedRooms / a.roomsAvailable - b.securedRooms / b.roomsAvailable,
  )[0];
  return {
    title: `${monthName(month)} occupancy: ${number(outlook.securedOccupancy)}%.`,
    summary: `${basis}: ${number(outlook.securedRooms)} of ${number(outlook.availableRooms)} sellable room nights. Lowest date: ${dateLabel(lowest.date)}, ${number(percent(lowest.securedRooms, lowest.roomsAvailable))}%.`,
    metrics: [
      { label: 'Occupancy', value: `${number(outlook.securedOccupancy)}%`, change: basis },
      {
        label: 'Average room rate',
        value: eur(outlook.securedADR),
        change: 'Room revenue ÷ sold or booked room nights',
      },
      {
        label: 'Revenue per available room',
        value: eur(outlook.securedRevPAR),
        change: 'Room revenue ÷ sellable room nights',
      },
    ],
    chart: Array.from({ length: Math.ceil(days.length / 7) }, (_, index) => {
      const bucket = days.slice(index * 7, index * 7 + 7);
      const capacity = bucket.reduce((sum, row) => sum + row.roomsAvailable, 0);
      return {
        label: `${index * 7 + 1}–${Math.min(index * 7 + 7, days.length)} ${dateLabel(bucket[0].date).split(' ')[1]}`,
        value: percent(
          bucket.reduce((sum, row) => sum + row.securedRooms, 0),
          capacity,
        ),
        comparison: percent(
          bucket.reduce((sum, row) => sum + row.targetRooms, 0),
          capacity,
        ),
      };
    }),
    chartTitle: `${monthName(month)} occupancy by week`,
    chartUnit: 'percent',
    chartSeries: { value: basis, comparison: 'Target' },
    reportingPeriod: `${period(month).label} · as of ${dateLabel(BOOKING_SNAPSHOT.asOf)}`,
    recommendation:
      lowest.state === 'past'
        ? `Review the booking mix for ${dateLabel(lowest.date)} before planning offers for similar weekdays.`
        : `Review pricing and availability for ${dateLabel(lowest.date)} before adding discounts.`,
    sources: [
      `${monthName(month)} reservation nights`,
      `${monthName(month)} room availability and targets`,
    ],
  };
}
function revenueInsight(scope: PropertyScope, month: ReportingMonth): Insight {
  const outlook = bookingOutlook(scope, month);
  return {
    title: `${monthName(month)} room revenue: ${eur(outlook.totalSecuredRevenue)}.`,
    summary: `${eur(outlook.realizedRevenue)} earned; ${eur(outlook.onBooksRevenue)} in existing future reservations. Monthly target: ${eur(outlook.targetRevenue)}. Future bookings can change.`,
    metrics: [
      { label: 'Earned', value: eur(outlook.realizedRevenue), change: 'Closed stay dates' },
      {
        label: 'On the books',
        value: eur(outlook.onBooksRevenue),
        change: `As of ${dateLabel(BOOKING_SNAPSHOT.asOf)}`,
      },
      {
        label: outlook.targetGapRevenue >= 0 ? 'To target' : 'Above target',
        value: eur(Math.abs(outlook.targetGapRevenue)),
        change: 'Planning target, not a forecast',
      },
    ],
    reportingPeriod: period(month).label,
    recommendation: 'Compare net room rates and unsold dates before changing prices.',
    sources: [
      `${monthName(month)} reservation-night ledger`,
      `${monthName(month)} daily revenue targets`,
    ],
  };
}
function channelsInsight(scope: PropertyScope, month: ReportingMonth): Insight {
  const channels = channelSummary(scope, month)
    .filter((row) => row.soldNights > 0)
    .sort((a, b) => b.netAdr - a.netAdr);
  const best = channels[0];
  if (!best) return occupancyInsight(scope, month);
  return {
    title: `${best.label} has the highest ${monthName(month)} net room rate.`,
    summary: `${eur(best.netAdr)} per room night after acquisition costs. ${roomBasis(scope, month)} room revenue; future acquisition costs are planned.`,
    metrics: channels.slice(0, 3).map((row) => ({
      label: `${row.label} net rate`,
      value: eur(row.netAdr),
      change: `${number(row.share)}% of sold or booked room nights`,
    })),
    reportingPeriod: period(month).label,
    recommendation:
      'Compare channel costs alongside room rates before changing distribution allocations.',
    sources: [
      `${monthName(month)} daily channel ledger`,
      `${monthName(month)} channel acquisition costs`,
    ],
  };
}
function costsInsight(scope: PropertyScope, month: ReportingMonth): Insight {
  const actual = costTotals(scope, month, 'actual');
  const planned = costTotals(scope, month, 'planned');
  const actualTotal = actual.reduce((sum, row) => sum + row.amount, 0);
  const plannedTotal = planned.reduce((sum, row) => sum + row.amount, 0);
  const summary = hotelSummary(scope, month);
  return {
    title: `${monthName(month)} ${actual.length ? 'operating' : 'planned operating'} costs: ${eur(actual.length ? actualTotal : plannedTotal)}.`,
    summary: `${eur(actualTotal)} actual costs on closed dates; ${eur(plannedTotal)} planned for remaining dates. Unit-cost references are separate and are not added again.`,
    metrics: [
      {
        label: 'Actual costs',
        value: actual.length ? eur(actualTotal) : '—',
        change: actual.length ? 'Closed dates only' : 'No closed dates in this month',
      },
      { label: 'Planned costs', value: eur(plannedTotal), change: 'Today and future dates' },
      {
        label: 'Actual operating result',
        value: actual.length ? eur(summary.operatingProfit) : '—',
        change: 'Actual revenue less actual costs; before depreciation, interest and tax',
      },
    ],
    reportingPeriod: period(month).label,
    recommendation:
      'Review payroll, food purchasing and channel costs against their daily activity before changing budgets.',
    sources: [`${monthName(month)} daily cost ledger`, `${monthName(month)} actual daily revenue`],
  };
}
function restaurantInsight(scope: PropertyScope, month: ReportingMonth): Insight {
  const outlets = selected(RESTAURANTS, scope);
  if (!outlets.length) {
    const lounge = selected(FACILITIES, scope).find(
      (facility) => facility.kind === 'breakfast_lounge',
    );
    return {
      title: 'Porto has a breakfast lounge, no restaurant.',
      summary: `${lounge?.name ?? 'Breakfast lounge'} serves breakfast ${lounge?.openingHours ?? 'each morning'}. Breakfast revenue is included in other revenue.`,
      metrics: [
        { label: 'Seats', value: number(lounge?.capacity ?? 0), change: 'Breakfast lounge' },
        {
          label: 'Breakfast price',
          value: eur(lounge?.fee ?? 0),
          change: 'Per person, excluding VAT',
        },
      ],
      reportingPeriod: period(month).label,
      recommendation: 'Use daily facility activity to compare breakfast covers and revenue.',
      sources: ['Porto facilities', `${monthName(month)} daily facility activity`],
    };
  }
  const days = selected(DAILY_PERFORMANCE, scope).filter((day) => day.date.startsWith(month));
  const actual = days.filter((day) => day.basis === 'actual');
  const planned = days.filter((day) => day.basis !== 'actual');
  const actualRevenue = actual.reduce((sum, day) => sum + day.restaurantRevenue, 0);
  const plannedRevenue = planned.reduce((sum, day) => sum + day.restaurantRevenue, 0);
  const restaurantCosts = selected(DAILY_COSTS, scope)
    .filter(
      (cost) =>
        cost.date.startsWith(month) &&
        cost.basis === 'actual' &&
        cost.department === 'food_beverage',
    )
    .reduce((sum, cost) => sum + cost.amount, 0);
  return {
    title: `${monthName(month)} restaurant revenue: ${eur(actual.length ? actualRevenue : plannedRevenue)}${actual.length ? '' : ' planned'}.`,
    summary: `${outlets.length} ${outlets.length === 1 ? 'restaurant' : 'restaurants'}. ${eur(actualRevenue)} actual meal sales and ${eur(plannedRevenue)} planned sales.`,
    metrics: [
      {
        label: 'Actual covers',
        value: actual.length
          ? number(actual.reduce((sum, day) => sum + day.restaurantCovers, 0))
          : '—',
        change: 'Closed dates',
      },
      {
        label: 'Planned covers',
        value: number(planned.reduce((sum, day) => sum + day.restaurantCovers, 0)),
        change: 'Today and future dates',
      },
      {
        label: 'Actual department costs',
        value: actual.length ? eur(restaurantCosts) : '—',
        change: 'Restaurant food and payroll',
      },
    ],
    reportingPeriod: period(month).label,
    recommendation: 'Compare daily covers with food purchasing and staffing hours.',
    sources: [
      `${monthName(month)} daily restaurant activity`,
      `${monthName(month)} food and beverage cost ledger`,
    ],
  };
}
function inventoryInsight(scope: PropertyScope, month: ReportingMonth, date: string): Insight {
  const summary = hotelSummary(scope, month, date);
  const scheduled = date >= BOOKING_SNAPSHOT.asOf;
  return {
    title: `${summary.roomStateCounts.available} rooms available on ${dateLabel(date)}.`,
    summary: `${scheduled ? 'Scheduled' : 'Actual'} room states. ${summary.housekeepingCounts.dirty} rooms ${scheduled ? 'scheduled for' : 'need'} cleaning; ${summary.roomStateCounts.out_of_service} unavailable for maintenance.`,
    metrics: [
      {
        label: 'Available',
        value: number(summary.roomStateCounts.available),
        change: 'Unreserved and sellable',
      },
      {
        label: scheduled ? 'Booked' : 'Occupied',
        value: number(summary.roomStateCounts.occupied),
        change: scheduled ? 'Existing reservations for this night' : 'Stayed room nights',
      },
      {
        label: 'Out of service',
        value: number(summary.roomStateCounts.out_of_service),
        change: 'Blocked for maintenance',
      },
    ],
    reportingPeriod: `${dateLabel(date)} 2026`,
    recommendation: 'Review maintenance and housekeeping before releasing unavailable rooms.',
    sources: [
      `${dateLabel(date)} daily room states`,
      `${dateLabel(date)} assigned reservation nights`,
    ],
  };
}
function facilitiesInsight(scope: PropertyScope, month: ReportingMonth): Insight {
  const facilities = selected(FACILITIES, scope);
  const summary = hotelSummary(scope, month);
  const restaurants = selected(RESTAURANTS, scope);
  return {
    title:
      scope === 'portfolio'
        ? 'Facilities across 4 hotels.'
        : `Facilities in ${HOTELS.find((hotel) => hotel.id === scope)!.city}.`,
    summary:
      scope === 'portfolio'
        ? 'Amsterdam has a spa, Berlin an indoor pool. Porto serves breakfast in its lounge.'
        : facilities.map((facility) => facility.name).join(', ') + '.',
    metrics: [
      { label: 'Rooms', value: number(summary.roomCount), change: 'Physical inventory' },
      {
        label: 'Parking spaces',
        value: number(
          facilities
            .filter((facility) => facility.kind === 'parking')
            .reduce((sum, facility) => sum + (facility.capacity ?? 0), 0),
        ),
        change: 'Capacity; daily use available in facility activity',
      },
      {
        label: 'Restaurants',
        value: number(restaurants.length),
        change: 'Breakfast lounges excluded',
      },
    ],
    reportingPeriod: period(month).label,
    recommendation:
      'Check daily facility activity and remaining capacity before confirming services.',
    sources: ['Property facilities and room types', `${monthName(month)} daily facility activity`],
  };
}

/** Answers derive from the same daily ledger as the network views. */
export function demoReply(
  prompt: string,
  property: HotelProperty,
  selectedMonth: ReportingMonth = '2026-11',
  selectedDate = BOOKING_SNAPSHOT.asOf,
): { content: string; insight?: Insight } {
  const scope: PropertyScope =
    property.id === 'portfolio'
      ? 'portfolio'
      : (HOTELS.find((hotel) => hotel.id === property.id)?.id ?? HOTELS[0].id);
  const month = resolveReportingMonth(prompt, selectedMonth);
  const requestedDate = prompt.match(/2026-(?:10|11|12)-\d{2}/)?.[0];
  const date =
    requestedDate && REPORTING_DATES.includes(requestedDate)
      ? requestedDate
      : selectedDate.startsWith(month)
        ? selectedDate
        : month === '2026-11'
          ? BOOKING_SNAPSHOT.asOf
          : period(month).startDate;
  const query = prompt.toLowerCase();
  let insight: Insight;
  if (/restaurant|food|beverage|f&b|cover|menu|rota/.test(query))
    insight = restaurantInsight(scope, month);
  else if (/channel|direct|ota|commission|distribution/.test(query))
    insight = channelsInsight(scope, month);
  else if (/cost|expense|profit|margin|payroll|labou?r|staff|utilities|rent/.test(query))
    insight = costsInsight(scope, month);
  else if (/facilit|amenit|parking|gym|spa|pool|breakfast|wifi|wi-fi|meeting/.test(query))
    insight = facilitiesInsight(scope, month);
  else if (
    /room state|room status|housekeep|out.of.service|dirty|clean|maintenance|available|occupied|vacant/.test(
      query,
    )
  )
    insight = inventoryInsight(scope, month, date);
  else if (/reservation|arrival|departure|guest/.test(query)) {
    const rows = selected(RESERVATIONS, scope).filter(
      (row) => row.arrival <= period(month).endDate && row.departure > period(month).startDate,
    );
    return {
      content: `${period(month).label}: ${rows.length} reservations overlap the month. ${rows.filter((row) => ['cancelled', 'no_show', 'pending'].includes(row.status)).length} cancelled, no-show or pending stays are excluded from occupancy and room revenue. Open Rooms & bookings to inspect each date and assigned room.`,
    };
  } else if (/revenue|revpar|income|finance|adr|rate|booking|pickup/.test(query))
    insight = revenueInsight(scope, month);
  else if (/occup|room|pace|october|november|december|perform|business|overview|doing/.test(query))
    insight = occupancyInsight(scope, month);
  else
    return {
      content:
        'Ask about occupancy, revenue, bookings, costs, restaurants, facilities or room status for October, November or December.',
    };
  return { content: '', insight };
}

export function initialConversations(): Conversation[] {
  const createdAt = `${FIXTURE_META.snapshotDate}T08:00:00.000Z`;
  return [
    {
      id: 'dev-october-bru',
      title: 'October performance',
      updatedAt: createdAt,
      propertyId: PROPERTIES[0].id,
      month: '2026-10',
      roomDate: '2026-10-31',
      dataVersion: FIXTURE_META.schemaVersion,
      messages: [
        {
          id: 'dev-october-question',
          role: 'user',
          content: 'How did October perform?',
          createdAt,
        },
        {
          id: 'dev-october-answer',
          role: 'assistant',
          createdAt,
          ...demoReply('October performance', PROPERTIES[0]),
        },
      ],
    },
  ];
}
