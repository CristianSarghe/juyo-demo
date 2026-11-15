import {
  BookingOutlook,
  BookingChartContext,
  BookingPaceDay,
  BookingPosition,
  BookingPeriod,
  BookingSelection,
  BookingChannel,
  CostCategory,
  DailyPerformance,
  DateRange,
  HotelDaySummary,
  HotelSummary,
  HotelNetwork,
  PropertyScope,
  ReportingMonth,
  Room,
  RoomWarning,
  UpcomingHotelEvent,
} from './network.models';

const money = (value: number): number => Math.round(value * 100) / 100;
const averageRate = (revenue: number, roomNights: number): number =>
  roomNights ? Math.round(Math.round(revenue * 100) / roomNights) / 100 : 0;
const percent = (part: number, total: number): number =>
  total ? Math.round((part / total) * 10_000) / 100 : 0;
const selected = <T extends { hotelId: string }>(rows: readonly T[], scope: PropertyScope): T[] =>
  rows.filter((row) => scope === 'portfolio' || row.hotelId === scope);
export const COST_LABELS: Record<CostCategory, string> = {
  payroll: 'Payroll',
  utilities: 'Utilities',
  housekeeping: 'Housekeeping',
  maintenance: 'Maintenance',
  admin: 'Administration',
  rent: 'Rent',
  food_beverage: 'Food & beverage',
  channel_commission: 'Channel acquisition',
  marketing: 'Marketing',
  insurance: 'Insurance',
};
export const CHANNEL_LABELS: Record<BookingChannel, string> = {
  direct: 'Direct',
  ota: 'OTA',
  corporate: 'Corporate',
  wholesale: 'Wholesale',
};
export interface CostTotal {
  category: CostCategory;
  label: string;
  amount: number;
}
export interface ChannelSummary {
  channel: BookingChannel;
  label: string;
  soldNights: number;
  grossRevenue: number;
  acquisitionCost: number;
  netRevenue: number;
  adr: number;
  netAdr: number;
  share: number;
  commissionRate: number;
}
export interface BookingSourceSummary {
  channel: BookingChannel;
  label: string;
  bookings: number;
  roomNights: number;
  roomRevenue: number;
  share: number;
}

export function reportingDatesFor(range: DateRange): string[] {
  const start = Date.parse(`${range.startDate}T12:00:00Z`);
  const end = Date.parse(`${range.endDate}T12:00:00Z`);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    new Date(start).toISOString().slice(0, 10) !== range.startDate ||
    new Date(end).toISOString().slice(0, 10) !== range.endDate ||
    start > end
  )
    throw new RangeError('Use a valid inclusive reporting calendar range.');
  return Array.from({ length: Math.round((end - start) / 86_400_000) + 1 }, (_, index) =>
    new Date(start + index * 86_400_000).toISOString().slice(0, 10),
  );
}

/** Pure domain calculations over one API reporting snapshot, with no fixture dependency. */
export function createNetworkSelectors(data: HotelNetwork) {
  const {
    bookingPositions: BOOKING_POSITIONS,
    bookingSnapshot: BOOKING_SNAPSHOT,
    channels: CHANNELS,
    costs: COSTS,
    dailyPerformance: DAILY_PERFORMANCE,
    dailyRoomStates: DAILY_ROOM_STATES,
    events: EVENTS,
    eventHotelImpacts: EVENT_HOTEL_IMPACTS,
    hotels: HOTELS,
    reportingPeriods: REPORTING_PERIODS,
    reservations: RESERVATIONS,
    reservationNights: RESERVATION_NIGHTS,
    rooms: ROOMS,
    roomTypes: ROOM_TYPES,
  } = data;
  const REPORTING_DATES = reportingDatesFor(data.meta.reportingPeriod);
  const defaultMonth =
    REPORTING_PERIODS.find(
      (period) =>
        BOOKING_SNAPSHOT.asOf >= period.startDate && BOOKING_SNAPSHOT.asOf <= period.endDate,
    )?.key ?? REPORTING_PERIODS[0].key;
  const periodFor = (month: ReportingMonth) => {
    const period = REPORTING_PERIODS.find((row) => row.key === month);
    if (!period) throw new Error(`Unknown reporting month: ${month}`);
    return period;
  };

  /** Inclusive, real calendar dates within the available ledger. Invalid input never silently clamps. */
  function validateDateRange(range: DateRange): DateRange {
    const validDate = (value: unknown): value is string => {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const parsed = Date.parse(`${value}T12:00:00Z`);
      return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
    };
    if (!range || !validDate(range.startDate) || !validDate(range.endDate))
      throw new RangeError('Use valid dates in YYYY-MM-DD format.');
    if (range.startDate > range.endDate)
      throw new RangeError('The start date must be on or before the end date.');
    if (range.startDate < REPORTING_DATES[0] || range.endDate > REPORTING_DATES.at(-1)!)
      throw new RangeError(
        `Choose dates from ${REPORTING_DATES[0]} through ${REPORTING_DATES.at(-1)}.`,
      );
    return { startDate: range.startDate, endDate: range.endDate };
  }

  function bookingPeriodFor(selection: BookingSelection): BookingPeriod {
    if (typeof selection === 'string') return periodFor(selection);
    const range = validateDateRange(selection);
    const exactMonth = REPORTING_PERIODS.find(
      (period) => period.startDate === range.startDate && period.endDate === range.endDate,
    );
    if (exactMonth) return exactMonth;
    const formatter = new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' });
    const monthLabel = (date: string): string => formatter.format(new Date(`${date}T12:00:00Z`));
    const startDay = Number(range.startDate.slice(-2));
    const endDay = Number(range.endDate.slice(-2));
    const sameMonth = range.startDate.slice(0, 7) === range.endDate.slice(0, 7);
    const label =
      range.startDate === range.endDate
        ? `${startDay} ${monthLabel(range.startDate)} ${range.endDate.slice(0, 4)}`
        : `${startDay}${sameMonth ? '–' : ` ${monthLabel(range.startDate)} – `}${endDay} ${monthLabel(range.endDate)} ${range.endDate.slice(0, 4)}`;
    return {
      ...range,
      days:
        (Date.parse(`${range.endDate}T12:00:00Z`) - Date.parse(`${range.startDate}T12:00:00Z`)) /
          86_400_000 +
        1,
      label,
    };
  }
  const stateByRoomDate = new Map(
    DAILY_ROOM_STATES.map((row) => [`${row.roomId}/${row.date}`, row]),
  );
  const assertScope = (scope: PropertyScope): void => {
    if (scope !== 'portfolio' && !HOTELS.some((hotel) => hotel.id === scope))
      throw new Error(`Unknown hotel: ${scope}`);
  };

  function hotelInventory(
    scope: PropertyScope = 'portfolio',
    date = BOOKING_SNAPSHOT.asOf,
  ): Room[] {
    assertScope(scope);
    return selected(ROOMS, scope).map((room) => {
      const state = stateByRoomDate.get(`${room.id}/${date}`);
      if (!state) throw new Error(`No room state for date: ${date}`);
      const { roomId: _roomId, hotelId: _hotelId, ...daily } = state;
      return { ...room, ...daily };
    });
  }

  /** Toolbar warnings always use a specific business date, independently of analytics ranges. */
  function roomWarnings(
    scope: PropertyScope = 'portfolio',
    date = BOOKING_SNAPSHOT.asOf,
  ): RoomWarning[] {
    validateDateRange({ startDate: date, endDate: date });
    return hotelInventory(scope, date)
      .filter((room) => room.occupancy === 'out_of_service')
      .map((room) => ({ room, hotel: HOTELS.find((hotel) => hotel.id === room.hotelId)! }))
      .sort(
        (a, b) =>
          a.hotel.city.localeCompare(b.hotel.city) ||
          a.hotel.name.localeCompare(b.hotel.name) ||
          a.room.number.localeCompare(b.room.number, undefined, { numeric: true }),
      );
  }

  /** Curated hotel relevance, with one event row even when several scoped hotels are affected. */
  function upcomingEvents(
    scope: PropertyScope = 'portfolio',
    date = BOOKING_SNAPSHOT.asOf,
  ): UpcomingHotelEvent[] {
    assertScope(scope);
    validateDateRange({ startDate: date, endDate: date });
    const importance = { mild: 0, medium: 1, important: 2 } as const;
    const impacts = selected(EVENT_HOTEL_IMPACTS, scope);
    return EVENTS.filter((event) => event.endDate >= date)
      .map((event) => {
        const relevant = impacts
          .filter((impact) => impact.eventId === event.id)
          .map((impact) => ({
            ...impact,
            hotel: HOTELS.find((hotel) => hotel.id === impact.hotelId)!,
          }))
          .sort(
            (a, b) =>
              importance[b.importance] - importance[a.importance] ||
              a.distanceKm - b.distanceKm ||
              a.hotel.name.localeCompare(b.hotel.name),
          );
        return { event, impacts: relevant, importance: relevant[0]?.importance ?? 'mild' };
      })
      .filter((row) => row.impacts.length > 0)
      .sort(
        (a, b) =>
          Number(a.event.startDate > date) - Number(b.event.startDate > date) ||
          a.event.startDate.localeCompare(b.event.startDate) ||
          a.event.name.localeCompare(b.event.name),
      );
  }

  function costTotals(
    scope: PropertyScope = 'portfolio',
    month: ReportingMonth = defaultMonth,
    basis: 'actual' | 'planned' | 'all' = 'actual',
  ): CostTotal[] {
    assertScope(scope);
    periodFor(month);
    const rows = selected(COSTS, scope).filter(
      (row) => row.period === month && (basis === 'all' || row.basis === basis),
    );
    return (Object.keys(COST_LABELS) as CostCategory[])
      .map((category) => ({
        category,
        label: COST_LABELS[category],
        amount: money(
          rows.filter((row) => row.category === category).reduce((sum, row) => sum + row.amount, 0),
        ),
      }))
      .filter((row) => row.amount > 0)
      .sort((a, b) => b.amount - a.amount);
  }

  function dailyTrend(
    scope: PropertyScope = 'portfolio',
    month: ReportingMonth = defaultMonth,
  ): Omit<DailyPerformance, 'hotelId'>[] {
    assertScope(scope);
    periodFor(month);
    const rows = selected(DAILY_PERFORMANCE, scope).filter((row) => row.date.startsWith(month));
    type Metric = Exclude<keyof DailyPerformance, 'hotelId' | 'date' | 'basis' | 'ancillaryBasis'>;
    return [...new Set(rows.map((row) => row.date))].sort().map((date) => {
      const day = rows.filter((row) => row.date === date);
      const sum = (key: Metric): number => money(day.reduce((total, row) => total + row[key], 0));
      return {
        date,
        roomsAvailable: sum('roomsAvailable'),
        soldNights: sum('soldNights'),
        roomRevenue: sum('roomRevenue'),
        restaurantRevenue: sum('restaurantRevenue'),
        restaurantCovers: sum('restaurantCovers'),
        otherRevenue: sum('otherRevenue'),
        budgetSoldNights: sum('budgetSoldNights'),
        budgetRoomRevenue: sum('budgetRoomRevenue'),
        basis: day[0].basis,
        ancillaryBasis: day[0].ancillaryBasis,
      };
    });
  }

  /** Whole-month accepted nights by default; callers can request one revenue basis. */
  function channelSummary(
    scope: PropertyScope = 'portfolio',
    month: ReportingMonth = defaultMonth,
    basis: 'actual' | 'on_books' | 'all' = 'all',
  ): ChannelSummary[] {
    assertScope(scope);
    periodFor(month);
    const rows = selected(CHANNELS, scope).filter(
      (row) => row.period === month && (basis === 'all' || row.basis === basis),
    );
    const totalNights = rows.reduce((sum, row) => sum + row.soldNights, 0);
    return (Object.keys(CHANNEL_LABELS) as BookingChannel[]).map((channel) => {
      const group = rows.filter((row) => row.channel === channel);
      const soldNights = group.reduce((sum, row) => sum + row.soldNights, 0);
      const grossRevenue = money(group.reduce((sum, row) => sum + row.grossRevenue, 0));
      const acquisitionCost = money(group.reduce((sum, row) => sum + row.acquisitionCost, 0));
      const netRevenue = money(grossRevenue - acquisitionCost);
      return {
        channel,
        label: CHANNEL_LABELS[channel],
        soldNights,
        grossRevenue,
        acquisitionCost,
        netRevenue,
        adr: soldNights ? money(grossRevenue / soldNights) : 0,
        netAdr: soldNights ? money(netRevenue / soldNights) : 0,
        share: percent(soldNights, totalNights),
        commissionRate: grossRevenue ? acquisitionCost / grossRevenue : 0,
      };
    });
  }

  /**
   * Distinct accepted bookings with a stay night in the inclusive selection, not
   * bookings created in that period. The canonical night ledger already excludes
   * cancelled, pending, no-show and not-yet-booked reservations at the snapshot.
   * A multi-night booking counts once; its nights/revenue include selected dates only.
   */
  function bookingSources(
    scope: PropertyScope = 'portfolio',
    selection: BookingSelection = defaultMonth,
  ): BookingSourceSummary[] {
    assertScope(scope);
    const period = bookingPeriodFor(selection);
    const nights = selected(RESERVATION_NIGHTS, scope).filter(
      (night) => night.date >= period.startDate && night.date <= period.endDate,
    );
    const totalBookings = new Set(nights.map((night) => night.reservationId)).size;
    return (Object.keys(CHANNEL_LABELS) as BookingChannel[]).map((channel) => {
      const group = nights.filter((night) => night.channel === channel);
      const bookings = new Set(group.map((night) => night.reservationId)).size;
      return {
        channel,
        label: CHANNEL_LABELS[channel],
        bookings,
        roomNights: group.length,
        roomRevenue:
          group.reduce((sum, night) => sum + Math.round(night.roomRevenue * 100), 0) / 100,
        share: percent(bookings, totalBookings),
      };
    });
  }

  /** Financial metrics use closed actual dates only. Room counts use the independently selected date. */
  function hotelSummary(
    scope: PropertyScope = 'portfolio',
    month: ReportingMonth = defaultMonth,
    date = BOOKING_SNAPSHOT.asOf,
  ): HotelSummary {
    assertScope(scope);
    periodFor(month);
    const hotels = HOTELS.filter((hotel) => scope === 'portfolio' || hotel.id === scope);
    const types = selected(ROOM_TYPES, scope);
    const rooms = hotelInventory(scope, date);
    const daily = dailyTrend(scope, month).filter(
      (row) => row.basis === 'actual' && row.date < BOOKING_SNAPSHOT.asOf,
    );
    type Metric = Exclude<keyof DailyPerformance, 'hotelId' | 'date' | 'basis' | 'ancillaryBasis'>;
    const sum = (key: Metric): number => money(daily.reduce((total, row) => total + row[key], 0));
    const roomRevenue = sum('roomRevenue');
    const restaurantRevenue = sum('restaurantRevenue');
    const otherRevenue = sum('otherRevenue');
    const totalRevenue = money(roomRevenue + restaurantRevenue + otherRevenue);
    const totalCosts = money(
      costTotals(scope, month, 'actual').reduce((total, row) => total + row.amount, 0),
    );
    const roomsAvailable = sum('roomsAvailable');
    const soldNights = sum('soldNights');
    return {
      id: scope,
      name: scope === 'portfolio' ? 'All hotels' : hotels[0].name,
      month,
      hasActuals: daily.length > 0,
      actualDays: daily.length,
      hotelCount: hotels.length,
      roomCount: rooms.length,
      guestCapacity: types.reduce(
        (sum, type) => sum + type.inventory * (type.maxAdults + type.maxChildren),
        0,
      ),
      roomsAvailable,
      soldNights,
      roomRevenue,
      restaurantRevenue,
      restaurantCovers: sum('restaurantCovers'),
      otherRevenue,
      totalRevenue,
      totalCosts,
      operatingProfit: money(totalRevenue - totalCosts),
      occupancy: percent(soldNights, roomsAvailable),
      adr: soldNights ? money(roomRevenue / soldNights) : 0,
      revpar: roomsAvailable ? money(roomRevenue / roomsAvailable) : 0,
      budgetOccupancy: percent(sum('budgetSoldNights'), roomsAvailable),
      budgetRoomRevenue: sum('budgetRoomRevenue'),
      roomStateCounts: {
        available: rooms.filter((room) => room.occupancy === 'available').length,
        occupied: rooms.filter((room) => room.occupancy === 'occupied').length,
        out_of_service: rooms.filter((room) => room.occupancy === 'out_of_service').length,
      },
      housekeepingCounts: {
        clean: rooms.filter((room) => room.housekeeping === 'clean').length,
        dirty: rooms.filter((room) => room.housekeeping === 'dirty').length,
        inspected: rooms.filter((room) => room.housekeeping === 'inspected').length,
      },
      maintenanceCounts: {
        none: rooms.filter((room) => room.maintenance === 'none').length,
        reported: rooms.filter((room) => room.maintenance === 'reported').length,
        in_progress: rooms.filter((room) => room.maintenance === 'in_progress').length,
      },
    };
  }

  function bookingPace(
    scope: PropertyScope = 'portfolio',
    selection: BookingSelection = defaultMonth,
  ): BookingPaceDay[] {
    assertScope(scope);
    const period = bookingPeriodFor(selection);
    const positions = selected(BOOKING_POSITIONS, scope).filter(
      (row) => row.stayDate >= period.startDate && row.stayDate <= period.endDate,
    );
    type Metric = Exclude<keyof BookingPosition, 'hotelId' | 'stayDate' | 'capturedAsOf' | 'state'>;
    return [...new Set(positions.map((row) => row.stayDate))].sort().map((date) => {
      const rows = positions.filter((row) => row.stayDate === date);
      const state = rows[0].state;
      const sum = (key: Metric): number =>
        money(rows.reduce((total, row) => total + (row[key] ?? 0), 0));
      const actualRooms = sum('actualRooms');
      const actualRevenue = sum('actualRoomRevenue');
      const onBooksRooms = sum('roomsOnBooks');
      const onBooksRevenue = sum('revenueOnBooks');
      const targetRooms = sum('targetRooms');
      const targetRevenue = sum('targetRevenue');
      const securedRooms = actualRooms + onBooksRooms;
      const securedRevenue = money(actualRevenue + onBooksRevenue);
      return {
        date,
        state,
        roomsAvailable: sum('roomsAvailable'),
        actualRooms,
        actualRevenue,
        onBooksRooms,
        onBooksRevenue,
        securedRooms,
        securedRevenue,
        targetRooms,
        targetRevenue,
        remainingTargetRooms: state === 'past' ? 0 : Math.max(targetRooms - securedRooms, 0),
        remainingTargetRevenue:
          state === 'past' ? 0 : money(Math.max(targetRevenue - securedRevenue, 0)),
        pickup7dRooms: sum('pickup7dRoomNights'),
        pickup7dRevenue: sum('pickup7dRevenue'),
      };
    });
  }

  /** One stay date: settled actuals before the business date, scheduled rooms thereafter. */
  function hotelDaySummary(scope: PropertyScope, date: string): HotelDaySummary {
    const [day] = bookingPace(scope, { startDate: date, endDate: date });
    const rooms = hotelInventory(scope, date);
    const outOfOrderRooms = rooms.filter((room) => room.occupancy === 'out_of_service').length;
    const occupiedRooms = rooms.filter((room) => room.occupancy === 'occupied').length;
    const sellableRooms = rooms.length - outOfOrderRooms;
    const reservations = selected(RESERVATIONS, scope).filter(
      (reservation) =>
        reservation.roomId !== null &&
        (reservation.status === 'confirmed' ||
          reservation.status === 'checked_in' ||
          reservation.status === 'checked_out'),
    );
    return {
      date,
      basis: day.state === 'past' ? 'actual' : 'scheduled',
      physicalRooms: rooms.length,
      sellableRooms,
      occupiedRooms,
      roomsToSell: sellableRooms - occupiedRooms,
      outOfOrderRooms,
      arrivals: reservations.filter((reservation) => reservation.arrival === date).length,
      departures: reservations.filter((reservation) => reservation.departure === date).length,
      averageRate: averageRate(day.securedRevenue, occupiedRooms),
      roomRevenue: day.securedRevenue,
      targetRevenue: day.targetRevenue,
      occupancy: percent(occupiedRooms, sellableRooms),
    };
  }

  /** Full enclosing months for chart context; selection metrics remain in bookingPace/bookingOutlook. */
  function bookingChartContext(
    scope: PropertyScope,
    selectedRange: DateRange,
  ): BookingChartContext {
    const range = validateDateRange(selectedRange);
    const firstMonth = periodFor(range.startDate.slice(0, 7) as ReportingMonth);
    const lastMonth = periodFor(range.endDate.slice(0, 7) as ReportingMonth);
    const rows = bookingPace(scope, {
      startDate: firstMonth.startDate,
      endDate: lastMonth.endDate,
    });
    const scrollable = firstMonth.key !== lastMonth.key;
    const windowSize = scrollable ? 30 : rows.length;
    const selectedStart = rows.findIndex((row) => row.date === range.startDate);
    const selectedEnd = rows.findIndex((row) => row.date === range.endDate);
    const initialStart =
      selectedEnd - selectedStart + 1 <= windowSize
        ? Math.floor((selectedStart + selectedEnd) / 2 - (windowSize - 1) / 2)
        : selectedStart;
    const startIndex = scrollable
      ? Math.max(0, Math.min(initialStart, rows.length - windowSize))
      : 0;
    return {
      rows,
      range,
      windowSize,
      startIndex,
      endIndex: startIndex + windowSize - 1,
      scrollable,
    };
  }

  function bookingOutlook(
    scope: PropertyScope = 'portfolio',
    selection: BookingSelection = defaultMonth,
  ): BookingOutlook {
    const rows = bookingPace(scope, selection);
    const past = rows.filter((row) => row.state === 'past');
    const open = rows.filter((row) => row.state !== 'past');
    const sum = (
      entries: BookingPaceDay[],
      key: Exclude<keyof BookingPaceDay, 'date' | 'state'>,
    ): number => money(entries.reduce((total, row) => total + row[key], 0));
    const realizedRevenue = sum(past, 'actualRevenue');
    const onBooksRevenue = sum(open, 'onBooksRevenue');
    const actualAvailableRooms = sum(past, 'roomsAvailable');
    const actualSoldRooms = sum(past, 'actualRooms');
    const futureAvailableRooms = sum(open, 'roomsAvailable');
    const futureBookedRooms = sum(open, 'onBooksRooms');
    const totalSecuredRevenue = money(realizedRevenue + onBooksRevenue);
    const securedRooms = actualSoldRooms + futureBookedRooms;
    const availableRooms = actualAvailableRooms + futureAvailableRooms;
    const targetRevenue = sum(rows, 'targetRevenue');
    const targetRooms = sum(rows, 'targetRooms');
    const today = rows.find((row) => row.state === 'today');
    return {
      asOf: BOOKING_SNAPSHOT.asOf,
      previousAsOf: BOOKING_SNAPSHOT.previousAsOf,
      period: bookingPeriodFor(selection),
      realizedRevenue,
      onBooksRevenue,
      totalSecuredRevenue,
      targetRevenue,
      securedRooms,
      availableRooms,
      targetRooms,
      securedOccupancy: percent(securedRooms, availableRooms),
      targetOccupancy: percent(targetRooms, availableRooms),
      securedADR: averageRate(totalSecuredRevenue, securedRooms),
      targetADR: averageRate(targetRevenue, targetRooms),
      securedRevPAR: averageRate(totalSecuredRevenue, availableRooms),
      targetRevPAR: averageRate(targetRevenue, availableRooms),
      actualAvailableRooms,
      actualSoldRooms,
      futureAvailableRooms,
      futureBookedRooms,
      realizedOccupancy: percent(actualSoldRooms, actualAvailableRooms),
      onBooksOccupancy: percent(futureBookedRooms, futureAvailableRooms),
      realizedADR: averageRate(realizedRevenue, actualSoldRooms),
      onBooksADR: averageRate(onBooksRevenue, futureBookedRooms),
      remainingRooms: futureAvailableRooms - futureBookedRooms,
      remainingTargetRooms: sum(open, 'remainingTargetRooms'),
      remainingTargetRevenue: sum(open, 'remainingTargetRevenue'),
      targetGapRevenue: money(targetRevenue - totalSecuredRevenue),
      sevenDayPickupRevenue: sum(open, 'pickup7dRevenue'),
      sevenDayPickupRooms: sum(open, 'pickup7dRooms'),
      todayRevenue: today?.onBooksRevenue ?? 0,
      todayRooms: today?.onBooksRooms ?? 0,
    };
  }

  return {
    validateDateRange,
    hotelInventory,
    roomWarnings,
    upcomingEvents,
    costTotals,
    dailyTrend,
    channelSummary,
    bookingSources,
    hotelSummary,
    bookingPace,
    hotelDaySummary,
    bookingChartContext,
    bookingOutlook,
  };
}

export type NetworkSelectors = ReturnType<typeof createNetworkSelectors>;
