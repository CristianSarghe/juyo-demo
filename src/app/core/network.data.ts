import {
  BookingChannel,
  BookingPosition,
  BookingSnapshot,
  ChannelPerformance,
  DailyChannel,
  DailyCost,
  DailyFacilityActivity,
  DailyPerformance,
  DailyRoomState,
  Facility,
  EventHotelImpact,
  Geography,
  Hotel,
  HotelEvent,
  HotelId,
  HotelNetwork,
  MonthlyCost,
  NetworkMeta,
  ReportingMonth,
  ReportingPeriod,
  Reservation,
  ReservationNight,
  Restaurant,
  Room,
  RoomRate,
  RoomType,
  UnitCost,
} from './network.models';

const money = (value: number): number => Math.round(value * 100) / 100;
const percentageAmount = (value: number, rate: number): number =>
  Math.round((Math.round(value * 100) * Math.round(rate * 10_000)) / 10_000) / 100;
const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const monthOf = (date: string): ReportingMonth => date.slice(0, 7) as ReportingMonth;
const asOf = '2026-11-14';
const previousAsOf = '2026-11-07';
const quarter = {
  startDate: '2026-10-01',
  endDate: '2026-12-31',
  days: 92,
  label: 'October–December 2026',
};

export const REPORTING_PERIODS: ReportingPeriod[] = [
  {
    key: '2026-10',
    startDate: '2026-10-01',
    endDate: '2026-10-31',
    days: 31,
    label: 'October 2026',
  },
  {
    key: '2026-11',
    startDate: '2026-11-01',
    endDate: '2026-11-30',
    days: 30,
    label: 'November 2026',
  },
  {
    key: '2026-12',
    startDate: '2026-12-01',
    endDate: '2026-12-31',
    days: 31,
    label: 'December 2026',
  },
];
export const REPORTING_DATES: string[] = Array.from({ length: quarter.days }, (_, index) =>
  addDays(quarter.startDate, index),
);

export const FIXTURE_META: NetworkMeta = {
  id: 'dev-europe-network',
  name: 'European hotel network',
  schemaVersion: '2.3.0',
  testData: true,
  currency: 'EUR',
  amountBasis: 'net_excluding_vat',
  reportingPeriod: quarter,
  snapshotDate: asOf,
  notes: [
    'Coverage is one daily record per relevant hotel, room, channel, cost line and facility from October 1 through December 31, 2026.',
    'Amounts are EUR excluding VAT. Room revenue is allocated by stay date before channel acquisition costs.',
    'Accepted reservation-night rows are the canonical room ledger. Daily occupied room states, room revenue, booking positions and channels reconcile to these rows. Cancelled, pending and no-show records have no accepted room-night rows.',
    'Dates before November 14 are closed actuals. November 14 and later room states are scheduled, room revenue is on books, and ancillary activity and expenses are planned.',
    'Restaurant activity includes breakfast and other meal services. Other revenue contains only non-restaurant facility revenue, so breakfast and bar sales are never counted twice.',
    'Monthly costs and channel totals are grouped from daily records, split by accounting basis. Operating profit uses closed actual revenue and actual costs only; future booking revenue is never treated as earned profit.',
    'Unit costs are planning reference rates, not additional ledger expenses. Acquisition costs are rounded per channel per stay date and then summed.',
    'Event names, dates, venues, attendance and hotel/venue positions are fictional illustrative fixtures, not a verified public calendar. Impact assessments are seeded fixtures, not live AI output, and do not modify booking or financial records.',
    'Event distances use hotel and venue WGS84 coordinates with the Haversine formula (Earth radius 6,371 km), rounded to 0.01 km. Relevance and importance are explicit per-hotel assessments rather than distance thresholds.',
    'Daily room rates are fictional selling quotes for every room type and quarter date, independent of events and booked revenue. Accepted reservations use flat room-type quotes within a few arrival-date bands: regular autumn, November 16–21 peak, and December. A limited one-night November 18 offer adds an occasional third price. Most occupied room-type/stay dates have one booked price; transition dates have two or three as earlier bookings keep their accepted quote. Selling quotes fall on November 22–25. Local rate updates never reprice accepted reservation nights.',
    'Hotel street addresses and postal codes are sample data for the fictional properties, not verified hotel locations. Hotel coordinates are illustrative city positions, not geocoded or validated matches to those sample addresses. Public repair-provider searches use only city and country.',
  ],
};

export const BOOKING_SNAPSHOT: BookingSnapshot = {
  asOf,
  previousAsOf,
  period: quarter,
  testData: true,
  source: 'development_aggregated_pms_positions',
  includedOnBooksStatuses: ['confirmed', 'checked_in'],
  excludedStatuses: ['cancelled', 'pending', 'no_show'],
  notes: [
    'Booking positions as of November 14, 2026 cover October, November and December stay dates.',
    'Past stay dates use accepted room-night actuals. Today and later dates use confirmed or checked-in reservations, not completed revenue or a forecast.',
    'Seven-day pickup compares accepted bookings made by November 14 with the same future stay dates booked by November 7. Reservations cancelled between the snapshots are included only in the earlier position.',
    'Targets are daily planning baselines. To-target values are unbooked target amounts for open stay dates, floored at zero.',
    'Future ancillary activity, housekeeping and costs are explicitly scheduled or planned. No future operating profit is reported.',
  ],
};

export const HOTELS: Hotel[] = [
  {
    id: 'dev-bru',
    name: 'Meridian Brussels',
    city: 'Brussels',
    country: 'Belgium',
    countryCode: 'BE',
    timezone: 'Europe/Brussels',
    status: 'active',
    category: 'business',
    starRating: 4,
    openedYear: 2014,
    coordinates: { latitude: 50.8465, longitude: 4.3572 },
    address: { line1: 'Rue du Marché aux Herbes 42', postalCode: '1000' },
  },
  {
    id: 'dev-ams',
    name: 'Canal House Amsterdam',
    city: 'Amsterdam',
    country: 'Netherlands',
    countryCode: 'NL',
    timezone: 'Europe/Amsterdam',
    status: 'active',
    category: 'boutique',
    starRating: 4,
    openedYear: 2018,
    coordinates: { latitude: 52.3702, longitude: 4.8888 },
    address: { line1: 'Nieuwezijds Voorburgwal 118', postalCode: '1012 SH' },
  },
  {
    id: 'dev-ber',
    name: 'Spreehof Berlin',
    city: 'Berlin',
    country: 'Germany',
    countryCode: 'DE',
    timezone: 'Europe/Berlin',
    status: 'active',
    category: 'business',
    starRating: 4,
    openedYear: 2011,
    coordinates: { latitude: 52.5186, longitude: 13.4099 },
    address: { line1: 'Dircksenstraße 28', postalCode: '10178' },
  },
  {
    id: 'dev-opo',
    name: 'Ribeira Porto',
    city: 'Porto',
    country: 'Portugal',
    countryCode: 'PT',
    timezone: 'Europe/Lisbon',
    status: 'active',
    category: 'city',
    starRating: 3,
    openedYear: 2021,
    coordinates: { latitude: 41.1415, longitude: -8.6138 },
    address: { line1: 'Rua de São João 64', postalCode: '4050-552' },
  },
];

export const EVENTS: HotelEvent[] = [
  {
    id: 'event-douro-makers',
    name: 'Douro Makers Weekend',
    category: 'market',
    startDate: '2026-11-13',
    endDate: '2026-11-15',
    venue: 'Ribeira Market Hall',
    city: 'Porto',
    country: 'Portugal',
    coordinates: { latitude: 41.1403, longitude: -8.6111 },
    expectedAttendance: 2200,
  },
  {
    id: 'event-benelux-buyers',
    name: 'Benelux Hospitality Buyers Roadshow',
    category: 'conference',
    startDate: '2026-11-17',
    endDate: '2026-11-20',
    venue: 'North District Forum',
    city: 'Brussels',
    country: 'Belgium',
    coordinates: { latitude: 50.8594, longitude: 4.3599 },
    expectedAttendance: 680,
  },
  {
    id: 'event-canal-commerce',
    name: 'Canal Digital Commerce Forum',
    category: 'conference',
    startDate: '2026-11-20',
    endDate: '2026-11-21',
    venue: 'Canal Conference Hall',
    city: 'Amsterdam',
    country: 'Netherlands',
    coordinates: { latitude: 52.3631, longitude: 4.8915 },
    expectedAttendance: 950,
  },
  {
    id: 'event-spree-winter-sessions',
    name: 'Spree Arena Winter Sessions',
    category: 'concert',
    startDate: '2026-11-21',
    endDate: '2026-11-21',
    venue: 'Spree Live Arena',
    city: 'Berlin',
    country: 'Germany',
    coordinates: { latitude: 52.5052, longitude: 13.4376 },
    expectedAttendance: 5200,
  },
  {
    id: 'event-atlantic-wine-food',
    name: 'Atlantic Wine & Food Exchange',
    category: 'trade_fair',
    startDate: '2026-11-26',
    endDate: '2026-11-28',
    venue: 'Riverside Congress Hall',
    city: 'Porto',
    country: 'Portugal',
    coordinates: { latitude: 41.1421, longitude: -8.6238 },
    expectedAttendance: 1600,
  },
  {
    id: 'event-old-quarter-market',
    name: 'Old Quarter Winter Market',
    category: 'market',
    startDate: '2026-11-27',
    endDate: '2026-12-20',
    venue: 'Old Quarter Square',
    city: 'Brussels',
    country: 'Belgium',
    coordinates: { latitude: 50.8504, longitude: 4.3488 },
    expectedAttendance: 8000,
  },
  {
    id: 'event-urban-mobility',
    name: 'Urban Mobility Suppliers Forum',
    category: 'trade_fair',
    startDate: '2026-12-01',
    endDate: '2026-12-03',
    venue: 'Spree Exhibition Hall',
    city: 'Berlin',
    country: 'Germany',
    coordinates: { latitude: 52.5234, longitude: 13.3818 },
    expectedAttendance: 2100,
  },
  {
    id: 'event-harbour-sports',
    name: 'Harbour Indoor Sports Weekend',
    category: 'sport',
    startDate: '2026-12-04',
    endDate: '2026-12-06',
    venue: 'Harbour Sports Centre',
    city: 'Amsterdam',
    country: 'Netherlands',
    coordinates: { latitude: 52.3841, longitude: 4.9227 },
    expectedAttendance: 2400,
  },
  {
    id: 'event-riverside-design',
    name: 'Riverside Design Festival',
    category: 'festival',
    startDate: '2026-12-05',
    endDate: '2026-12-06',
    venue: 'Riverside Design Exchange',
    city: 'Porto',
    country: 'Portugal',
    coordinates: { latitude: 41.1463, longitude: -8.6068 },
    expectedAttendance: 1800,
  },
  {
    id: 'event-hotel-finance',
    name: 'European Hotel Finance Assembly',
    category: 'conference',
    startDate: '2026-12-09',
    endDate: '2026-12-10',
    venue: 'Central Business Assembly Hall',
    city: 'Brussels',
    country: 'Belgium',
    coordinates: { latitude: 50.8426, longitude: 4.3691 },
    expectedAttendance: 750,
  },
  {
    id: 'event-west-quay-concerts',
    name: 'West Quay Winter Concerts',
    category: 'concert',
    startDate: '2026-12-18',
    endDate: '2026-12-19',
    venue: 'West Quay Live Hall',
    city: 'Amsterdam',
    country: 'Netherlands',
    coordinates: { latitude: 52.3887, longitude: 4.8822 },
    expectedAttendance: 3600,
  },
  {
    id: 'event-spree-new-year',
    name: 'Spree New Year Arts Programme',
    category: 'festival',
    startDate: '2026-12-29',
    endDate: '2026-12-31',
    venue: 'Spree Arts Grounds',
    city: 'Berlin',
    country: 'Germany',
    coordinates: { latitude: 52.5131, longitude: 13.3951 },
    expectedAttendance: 4200,
  },
];

function distanceKm(from: Geography, to: Geography): number {
  const radians = (degrees: number): number => (degrees * Math.PI) / 180;
  const latitude = radians(to.latitude - from.latitude);
  const longitude = radians(to.longitude - from.longitude);
  const haversine =
    Math.sin(latitude / 2) ** 2 +
    Math.cos(radians(from.latitude)) *
      Math.cos(radians(to.latitude)) *
      Math.sin(longitude / 2) ** 2;
  return money(2 * 6371 * Math.asin(Math.min(1, Math.sqrt(haversine))));
}

const eventAssessments: Omit<EventHotelImpact, 'distanceKm' | 'source' | 'assessedAt'>[] = [
  {
    eventId: 'event-douro-makers',
    hotelId: 'dev-opo',
    importance: 'medium',
    reason: 'A three-day market near the hotel brings exhibitors and weekend visitors.',
  },
  {
    eventId: 'event-benelux-buyers',
    hotelId: 'dev-bru',
    importance: 'important',
    reason: 'Brussels hosts the main buyer sessions, with delegates staying across several nights.',
  },
  {
    eventId: 'event-benelux-buyers',
    hotelId: 'dev-ams',
    importance: 'mild',
    reason:
      'The delegation itinerary includes an Amsterdam overnight visit on 19 November after the Brussels sessions.',
  },
  {
    eventId: 'event-canal-commerce',
    hotelId: 'dev-ams',
    importance: 'important',
    reason: 'Two days of business sessions near the hotel may increase weekday room demand.',
  },
  {
    eventId: 'event-spree-winter-sessions',
    hotelId: 'dev-ber',
    importance: 'important',
    reason: 'An evening concert with 5,200 attendees may concentrate arrivals on Saturday.',
  },
  {
    eventId: 'event-atlantic-wine-food',
    hotelId: 'dev-opo',
    importance: 'important',
    reason: 'A three-day trade fair brings exhibitors and trade buyers to the riverside district.',
  },
  {
    eventId: 'event-old-quarter-market',
    hotelId: 'dev-bru',
    importance: 'medium',
    reason: 'A nearby seasonal market supports leisure demand, especially on December weekends.',
  },
  {
    eventId: 'event-urban-mobility',
    hotelId: 'dev-ber',
    importance: 'important',
    reason: 'The supplier programme spans three weekdays and requires multi-night business stays.',
  },
  {
    eventId: 'event-harbour-sports',
    hotelId: 'dev-ams',
    importance: 'medium',
    reason: 'Visiting teams and accompanying families may need rooms for the tournament weekend.',
  },
  {
    eventId: 'event-riverside-design',
    hotelId: 'dev-opo',
    importance: 'medium',
    reason: 'The local design programme brings visiting exhibitors over two weekend days.',
  },
  {
    eventId: 'event-hotel-finance',
    hotelId: 'dev-bru',
    importance: 'important',
    reason: 'Finance delegates attend a two-day midweek programme close to the hotel.',
  },
  {
    eventId: 'event-west-quay-concerts',
    hotelId: 'dev-ams',
    importance: 'medium',
    reason: 'Two evening concerts may add overnight leisure demand on Friday and Saturday.',
  },
  {
    eventId: 'event-spree-new-year',
    hotelId: 'dev-ber',
    importance: 'important',
    reason: 'A three-day arts programme overlaps New Year stays in central Berlin.',
  },
];
export const EVENT_HOTEL_IMPACTS: EventHotelImpact[] = eventAssessments.map((assessment) => ({
  ...assessment,
  distanceKm: distanceKm(
    HOTELS.find((hotel) => hotel.id === assessment.hotelId)!.coordinates,
    EVENTS.find((event) => event.id === assessment.eventId)!.coordinates,
  ),
  source: 'fixture',
  assessedAt: asOf,
}));

function roomTypes(hotelId: HotelId, inventories: number[], rates: number[]): RoomType[] {
  return ['Classic', 'Superior', 'Deluxe', hotelId === 'dev-ber' ? 'Studio suite' : 'Suite'].map(
    (name, index) => ({
      id: `${hotelId}-type-${index + 1}`,
      hotelId,
      name,
      inventory: inventories[index],
      maxAdults: index === 3 ? 3 : 2,
      maxChildren: index >= 2 ? 2 : 1,
      areaM2: [21, 26, 32, 44][index],
      baseRate: rates[index],
      facilities: [
        'wifi',
        'air_conditioning',
        'desk',
        ...(index > 0 ? ['coffee_machine' as const] : []),
        ...(index === 2 && hotelId === 'dev-opo' ? ['balcony' as const] : []),
        ...(index === 3
          ? [hotelId === 'dev-ber' ? ('kitchenette' as const) : ('bathtub' as const)]
          : []),
      ],
    }),
  );
}
export const ROOM_TYPES: RoomType[] = [
  ...roomTypes('dev-bru', [12, 7, 4, 1], [145, 175, 215, 295]),
  ...roomTypes('dev-ams', [9, 6, 4, 1], [195, 235, 285, 365]),
  ...roomTypes('dev-ber', [14, 8, 4, 2], [120, 150, 185, 245]),
  ...roomTypes('dev-opo', [8, 4, 3, 1], [99, 125, 155, 205]),
];

// Sunday through Saturday. Business properties lean toward midweek demand;
// Amsterdam and Porto have stronger weekend leisure rates. Events are not inputs.
const sellingRateWeekdays: Record<HotelId, readonly number[]> = {
  'dev-bru': [0.94, 1, 1.04, 1.04, 1.01, 0.97, 0.96],
  'dev-ams': [0.97, 0.98, 1, 1.01, 1.03, 1.08, 1.1],
  'dev-ber': [0.96, 0.99, 1.02, 1.03, 1.02, 1.04, 1.05],
  'dev-opo': [0.96, 0.97, 0.98, 1, 1.02, 1.07, 1.08],
};
const sellingRateMonths: Record<ReportingMonth, number> = {
  '2026-10': 1.02,
  '2026-11': 1,
  '2026-12': 1.04,
};
// Six November stay-date periods: 1–7, 8–13, 14–17, 18–21, 22–25 and 26–30.
// The midmonth rise and later price reduction make retained booking prices visible.
const novemberRatePeriods: Record<HotelId, readonly number[]> = {
  'dev-bru': [0.98, 1.02, 1.08, 1.16, 0.95, 1.04],
  'dev-ams': [1, 1.04, 1.06, 1.12, 0.98, 1.06],
  'dev-ber': [0.98, 1.02, 1.08, 1.18, 0.94, 1.03],
  'dev-opo': [0.96, 0.99, 1.04, 1.1, 0.96, 1.02],
};
function sellingRate(type: RoomType, date: string): number {
  const day = Number(date.slice(-2));
  const novemberPeriod = [7, 13, 17, 21, 25, 30].findIndex((lastDay) => day <= lastDay);
  const periodFactor =
    monthOf(date) === '2026-11' ? novemberRatePeriods[type.hotelId][novemberPeriod] : 1;
  return money(
    type.baseRate *
      sellingRateWeekdays[type.hotelId][new Date(`${date}T12:00:00Z`).getUTCDay()] *
      sellingRateMonths[monthOf(date)] *
      periodFactor,
  );
}
function acceptedNightlyRate(type: RoomType, arrival: string, nights: number): number {
  // A few arrival-date bands keep accepted quotes understandable. Existing stays
  // retain their flat quote when another band starts, creating short transition mixes.
  const regularFactor = monthOf(arrival) === '2026-12' ? 1.04 : 1.02;
  const peakFactor = arrival >= '2026-11-16' && arrival <= '2026-11-21' ? 1.12 : regularFactor;
  const oneNightOffer = arrival === '2026-11-18' && nights === 1;
  return money(type.baseRate * (oneNightOffer ? 1.08 : peakFactor));
}
export const ROOM_RATES: RoomRate[] = ROOM_TYPES.flatMap((type) =>
  REPORTING_DATES.map((date) => ({
    hotelId: type.hotelId,
    roomTypeId: type.id,
    date,
    nightlyRate: sellingRate(type, date),
    currency: 'EUR',
  })),
);

type PhysicalRoom = Pick<Room, 'id' | 'hotelId' | 'roomTypeId' | 'number' | 'floor'>;
const physicalRooms: PhysicalRoom[] = HOTELS.flatMap((hotel) => {
  let sequence = 0;
  return ROOM_TYPES.filter((type) => type.hotelId === hotel.id).flatMap((type) =>
    Array.from({ length: type.inventory }, () => {
      const index = sequence++;
      const floor = Math.floor(index / 8) + 1;
      const number = String(floor * 100 + (index % 8) + 1);
      return {
        id: `${hotel.id}-room-${number}`,
        hotelId: hotel.id,
        roomTypeId: type.id,
        number,
        floor,
      };
    }),
  );
});

function facility(
  hotelId: HotelId,
  kind: Facility['kind'],
  name: string,
  capacity: number | null,
  openingHours: string,
  fee = 0,
  feeUnit: Facility['feeUnit'] = 'included',
): Facility {
  return { id: `${hotelId}-${kind}`, hotelId, kind, name, capacity, openingHours, fee, feeUnit };
}
export const FACILITIES: Facility[] = [
  facility('dev-bru', 'wifi', 'Guest Wi-Fi', null, '24 hours'),
  facility('dev-bru', 'parking', 'Underground parking', 10, '24 hours', 24, 'per_night'),
  facility('dev-bru', 'gym', 'Fitness room', 6, '06:00–23:00'),
  facility('dev-bru', 'meeting_room', 'Meridian meeting room', 20, '08:00–20:00', 60, 'per_hour'),
  facility('dev-bru', 'bar', 'Lobby bar', 10, '16:00–23:00'),
  facility(
    'dev-bru',
    'restaurant',
    'Atelier Meridian',
    26,
    '07:00–10:00; 12:00–14:00; 18:00–22:00',
  ),
  facility('dev-ams', 'wifi', 'Guest Wi-Fi', null, '24 hours'),
  facility('dev-ams', 'parking', 'Reserved parking', 6, '24 hours', 38, 'per_night'),
  facility('dev-ams', 'gym', 'Fitness room', 4, '06:00–22:00'),
  facility('dev-ams', 'spa', 'Sauna and treatment room', 4, '10:00–20:00', 25, 'per_person'),
  facility('dev-ams', 'bar', 'Canal bar', 12, '15:00–00:00'),
  facility('dev-ams', 'restaurant', 'Canal Table', 22, '07:00–10:30; 18:00–22:00'),
  facility('dev-ber', 'wifi', 'Guest Wi-Fi', null, '24 hours'),
  facility('dev-ber', 'parking', 'Courtyard parking', 12, '24 hours', 20, 'per_night'),
  facility('dev-ber', 'gym', 'Fitness room', 8, '05:30–23:00'),
  facility('dev-ber', 'meeting_room', 'Spree meeting room', 30, '07:00–22:00', 75, 'per_hour'),
  facility('dev-ber', 'pool', 'Indoor pool', 8, '06:00–22:00'),
  facility('dev-ber', 'bar', 'Spree bar', 14, '16:00–00:00'),
  facility('dev-ber', 'restaurant', 'Spree Kitchen', 32, '06:30–10:00; 12:00–14:30; 18:00–22:00'),
  facility('dev-opo', 'wifi', 'Guest Wi-Fi', null, '24 hours'),
  facility('dev-opo', 'parking', 'Guest parking', 6, '24 hours', 16, 'per_night'),
  facility(
    'dev-opo',
    'breakfast_lounge',
    'Ribeira breakfast lounge',
    18,
    '07:30–10:30',
    15,
    'per_person',
  ),
  facility('dev-opo', 'bar', 'Terrace bar', 8, '16:00–22:00'),
];
export const RESTAURANTS: Restaurant[] = [
  {
    id: 'dev-bru-restaurant',
    hotelId: 'dev-bru',
    name: 'Atelier Meridian',
    cuisine: 'Belgian and seasonal European',
    seats: 26,
    openingHours: '07:00–10:00; 12:00–14:00; 18:00–22:00',
    breakfastPrice: 22,
    averageCheck: 42,
  },
  {
    id: 'dev-ams-restaurant',
    hotelId: 'dev-ams',
    name: 'Canal Table',
    cuisine: 'Modern Dutch',
    seats: 22,
    openingHours: '07:00–10:30; 18:00–22:00',
    breakfastPrice: 26,
    averageCheck: 48,
  },
  {
    id: 'dev-ber-restaurant',
    hotelId: 'dev-ber',
    name: 'Spree Kitchen',
    cuisine: 'Regional German',
    seats: 32,
    openingHours: '06:30–10:00; 12:00–14:30; 18:00–22:00',
    breakfastPrice: 20,
    averageCheck: 36,
  },
];
export const UNIT_COSTS: UnitCost[] = HOTELS.flatMap((hotel, index) =>
  (
    [
      [
        'occupied_room',
        [13.5, 15, 12.8, 10.5][index],
        'Laundry, supplies and contracted cleaning per sold room night',
      ],
      ['breakfast', [5.2, 6.1, 4.8, 3.9][index], 'Food purchasing per breakfast served'],
      ['staff_hour', [27, 31, 25, 17][index], 'Average loaded hourly planning cost'],
      [
        'parking_night',
        [3.5, 5, 3, 2.5][index],
        'Operating cost per occupied parking space and night',
      ],
    ] as [UnitCost['basis'], number, string][]
  ).map(([basis, amount, description]) => ({
    id: `${hotel.id}-unit-${basis}`,
    hotelId: hotel.id,
    basis,
    amount,
    description,
  })),
);

/** Stable hash supplies reproducible variation without a clock or random runtime state. */
function variation(seed: number): number {
  let value = seed | 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return ((value ^ (value >>> 16)) >>> 0) / 4_294_967_296;
}
const profiles: Record<string, number[]> = {
  'dev-bru': [0.6, 0.73, 0.83, 0.85, 0.8, 0.7, 0.65],
  'dev-ams': [0.8, 0.74, 0.75, 0.79, 0.86, 0.94, 0.95],
  'dev-ber': [0.61, 0.76, 0.84, 0.86, 0.81, 0.72, 0.67],
  'dev-opo': [0.7, 0.61, 0.59, 0.65, 0.72, 0.86, 0.9],
} satisfies Record<HotelId, number[]>;
const hotelRooms = new Map(
  HOTELS.map((hotel) => [hotel.id, physicalRooms.filter((room) => room.hotelId === hotel.id)]),
);
const typeById = new Map(ROOM_TYPES.map((type) => [type.id, type]));
const blocked = (hotelIndex: number, roomIndex: number, dateIndex: number): boolean => {
  if (hotelIndex === 2 && dateIndex >= 43 && dateIndex <= 45) return roomIndex === 4;
  if (hotelIndex === 0 && dateIndex >= 44 && dateIndex <= 45) return roomIndex === 7;
  const phase = (dateIndex + hotelIndex * 5) % 29;
  return (
    phase >= 11 &&
    phase <= 13 &&
    roomIndex ===
      (Math.floor(dateIndex / 29) * 7 + hotelIndex * 3) %
        hotelRooms.get(HOTELS[hotelIndex].id)!.length
  );
};
function targetOccupancy(hotel: Hotel, date: string): number {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const month = monthOf(date);
  const festive = date >= '2026-12-24';
  const seasonal =
    month === '2026-10'
      ? 0.02
      : month === '2026-12'
        ? hotel.category === 'business'
          ? -0.08
          : 0.03
        : 0;
  return Math.max(
    0.35,
    Math.min(
      0.97,
      profiles[hotel.id][weekday] +
        seasonal +
        (festive ? (hotel.category === 'business' ? -0.12 : 0.04) : 0),
    ),
  );
}
function targetRate(hotel: Hotel, date: string): number {
  const types = ROOM_TYPES.filter((type) => type.hotelId === hotel.id);
  const average =
    types.reduce((sum, type) => sum + type.baseRate * type.inventory, 0) /
    types.reduce((sum, type) => sum + type.inventory, 0);
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const monthFactor =
    monthOf(date) === '2026-10' ? 1.03 : monthOf(date) === '2026-12' ? 1.05 : 0.98;
  return money(average * monthFactor + (weekday === 5 || weekday === 6 ? 12 : 0));
}

const acceptedReservations: Reservation[] = [];
export const RESERVATION_NIGHTS: ReservationNight[] = [];
const nightByRoomDate = new Map<string, ReservationNight>();
let reservationSequence = 0;
for (const [hotelIndex, hotel] of HOTELS.entries()) {
  for (const [roomIndex, room] of hotelRooms.get(hotel.id)!.entries()) {
    const type = typeById.get(room.roomTypeId)!;
    let dateIndex = 0;
    while (dateIndex < REPORTING_DATES.length) {
      const arrival = REPORTING_DATES[dateIndex];
      const seed = (hotelIndex + 1) * 100_000 + roomIndex * 1000 + dateIndex * 13;
      if (blocked(hotelIndex, roomIndex, dateIndex)) {
        dateIndex++;
        continue;
      }
      const lead = Math.max(0, (Date.parse(arrival) - Date.parse(asOf)) / 86_400_000);
      const pace =
        arrival < asOf
          ? 1
          : Math.max(0.32, 0.98 - lead * 0.013 + (hotel.id === 'dev-ams' ? 0.025 : 0));
      const desired = Math.min(0.96, targetOccupancy(hotel, arrival) * pace);
      const startProbability = desired / (2.5 - 1.5 * desired);
      if (variation(seed) > startProbability) {
        dateIndex++;
        continue;
      }
      let length = 1 + Math.floor(variation(seed + 7) * 4);
      length = Math.min(length, REPORTING_DATES.length - dateIndex);
      for (let offset = 1; offset < length; offset++)
        if (blocked(hotelIndex, roomIndex, dateIndex + offset)) {
          length = offset;
          break;
        }
      const channelPick = variation(seed + 19);
      const channel: BookingChannel =
        channelPick < 0.38
          ? 'direct'
          : channelPick < 0.74
            ? 'ota'
            : channelPick < 0.94
              ? 'corporate'
              : 'wholesale';
      const departure = addDays(arrival, length);
      const bookedOn =
        arrival < asOf
          ? addDays(arrival, -5 - Math.floor(variation(seed + 31) * 45))
          : addDays(asOf, -Math.floor(variation(seed + 31) * 35));
      const nightlyRate = acceptedNightlyRate(type, arrival, length);
      const id = `${hotel.id}-reservation-${++reservationSequence}`;
      const reservation: Reservation = {
        id,
        hotelId: hotel.id,
        roomTypeId: room.roomTypeId,
        roomId: room.id,
        guestRef: `GUEST-${String(reservationSequence).padStart(5, '0')}`,
        channel,
        status: departure <= asOf ? 'checked_out' : arrival < asOf ? 'checked_in' : 'confirmed',
        arrival,
        departure,
        adults: Math.min(type.maxAdults, variation(seed + 41) < 0.35 ? 1 : 2),
        children: type.maxChildren > 0 && variation(seed + 43) > 0.85 ? 1 : 0,
        roomRevenue: money(nightlyRate * length),
        currency: 'EUR',
        bookedOn,
        cancelledOn: null,
        quotedNightlyRate: nightlyRate,
        quotedRevenue: money(nightlyRate * length),
      };
      acceptedReservations.push(reservation);
      for (let offset = 0; offset < length; offset++) {
        const date = REPORTING_DATES[dateIndex + offset];
        const night = {
          reservationId: id,
          hotelId: hotel.id,
          roomId: room.id,
          date,
          channel,
          roomRevenue: nightlyRate,
        };
        RESERVATION_NIGHTS.push(night);
        nightByRoomDate.set(`${room.id}/${date}`, night);
      }
      dateIndex += length;
    }
  }
}

const inactiveReservations: Reservation[] = [];
for (const [hotelIndex, hotel] of HOTELS.entries()) {
  const room = hotelRooms.get(hotel.id)![0];
  const type = typeById.get(room.roomTypeId)!;
  for (const [status, arrival, departure] of [
    ['pending', '2026-12-12', '2026-12-14'],
    ['no_show', '2026-10-20', '2026-10-21'],
  ] as const) {
    const id = `${hotel.id}-reservation-${++reservationSequence}`;
    inactiveReservations.push({
      id,
      hotelId: hotel.id,
      roomTypeId: type.id,
      roomId: null,
      guestRef: `GUEST-${String(reservationSequence).padStart(5, '0')}`,
      channel: status === 'pending' ? 'direct' : 'ota',
      status,
      arrival,
      departure,
      adults: 2,
      children: 0,
      roomRevenue: 0,
      currency: 'EUR',
      bookedOn: status === 'pending' ? '2026-11-12' : '2026-10-05',
      cancelledOn: null,
      quotedNightlyRate: type.baseRate,
      quotedRevenue: type.baseRate * (status === 'pending' ? 2 : 1),
    });
  }
  if (hotelIndex !== 2 && hotelIndex !== 3) continue;
  const arrival = hotelIndex === 2 ? '2026-11-22' : '2026-11-24';
  const dateIndex = REPORTING_DATES.indexOf(arrival);
  const acceptedThatDay = RESERVATION_NIGHTS.filter(
    (night) => night.hotelId === hotel.id && night.date === arrival,
  );
  const acceptedById = new Map(acceptedReservations.map((row) => [row.id, row]));
  const newRooms = acceptedThatDay.filter(
    (night) => acceptedById.get(night.reservationId)!.bookedOn > previousAsOf,
  ).length;
  const free = hotelRooms
    .get(hotel.id)!
    .filter(
      (candidate, index) =>
        !blocked(hotelIndex, index, dateIndex) &&
        !nightByRoomDate.has(`${candidate.id}/${arrival}`),
    );
  for (const candidate of free.slice(0, newRooms + 2)) {
    const candidateType = typeById.get(candidate.roomTypeId)!;
    const id = `${hotel.id}-reservation-${++reservationSequence}`;
    inactiveReservations.push({
      id,
      hotelId: hotel.id,
      roomTypeId: candidateType.id,
      roomId: candidate.id,
      guestRef: `GUEST-${String(reservationSequence).padStart(5, '0')}`,
      channel: 'corporate',
      status: 'cancelled',
      arrival,
      departure: addDays(arrival, 1),
      adults: 2,
      children: 0,
      roomRevenue: 0,
      currency: 'EUR',
      bookedOn: '2026-10-30',
      cancelledOn: '2026-11-10',
      quotedNightlyRate: candidateType.baseRate,
      quotedRevenue: candidateType.baseRate,
    });
  }
}
export const RESERVATIONS: Reservation[] = [...acceptedReservations, ...inactiveReservations].sort(
  (a, b) => a.arrival.localeCompare(b.arrival) || a.id.localeCompare(b.id),
);
const reservationById = new Map(RESERVATIONS.map((row) => [row.id, row]));

export const DAILY_ROOM_STATES: DailyRoomState[] = HOTELS.flatMap((hotel, hotelIndex) =>
  REPORTING_DATES.flatMap((date, dateIndex) =>
    hotelRooms.get(hotel.id)!.map((room, roomIndex) => {
      const out = blocked(hotelIndex, roomIndex, dateIndex);
      const occupied = nightByRoomDate.has(`${room.id}/${date}`);
      const previousOccupied =
        dateIndex > 0 && nightByRoomDate.has(`${room.id}/${REPORTING_DATES[dateIndex - 1]}`);
      return {
        roomId: room.id,
        hotelId: hotel.id,
        date,
        occupancy: out ? 'out_of_service' : occupied ? 'occupied' : 'available',
        housekeeping: out
          ? 'dirty'
          : occupied
            ? (roomIndex + dateIndex) % 3 === 0
              ? 'dirty'
              : 'clean'
            : previousOccupied
              ? 'dirty'
              : 'inspected',
        maintenance: out ? (dateIndex % 2 === 0 ? 'in_progress' : 'reported') : 'none',
        maintenanceNote: out ? 'Bathroom and ventilation maintenance' : null,
        basis: date < asOf ? 'actual' : 'scheduled',
      };
    }),
  ),
);
const snapshotStates = new Map(
  DAILY_ROOM_STATES.filter((row) => row.date === asOf).map((row) => [row.roomId, row]),
);
export const ROOMS: Room[] = physicalRooms.map((room) => {
  const { roomId: _roomId, hotelId: _hotelId, ...state } = snapshotStates.get(room.id)!;
  return { ...room, ...state };
});
const nightsByHotelDate = new Map<string, ReservationNight[]>();
for (const night of RESERVATION_NIGHTS) {
  const key = `${night.hotelId}/${night.date}`;
  const entries = nightsByHotelDate.get(key) ?? [];
  entries.push(night);
  nightsByHotelDate.set(key, entries);
}

export const DAILY_FACILITY_ACTIVITY: DailyFacilityActivity[] = FACILITIES.flatMap((facility) =>
  REPORTING_DATES.map((date, dateIndex) => {
    const nights = nightsByHotelDate.get(`${facility.hotelId}/${date}`) ?? [];
    const sold = nights.length;
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    const weekend = weekday === 5 || weekday === 6;
    const restaurant = RESTAURANTS.find((row) => row.id === facility.id);
    let uses = 0;
    let revenue = 0;
    switch (facility.kind) {
      case 'restaurant': {
        const breakfast = Math.round(sold * 1.05);
        const meals = Math.min(
          (facility.capacity ?? 0) * 2,
          Math.round(sold * 0.65) + (weekend ? 12 : 6) + (dateIndex % 3),
        );
        uses = breakfast + meals;
        revenue = money(breakfast * restaurant!.breakfastPrice + meals * restaurant!.averageCheck);
        break;
      }
      case 'breakfast_lounge':
        uses = Math.min((facility.capacity ?? 0) * 2, Math.round(sold * 1.1));
        revenue = money(uses * facility.fee);
        break;
      case 'bar':
        uses = Math.min((facility.capacity ?? 0) * 2, Math.round(sold * 0.55) + (weekend ? 4 : 1));
        revenue = money(uses * (facility.hotelId === 'dev-ams' ? 14 : 11));
        break;
      case 'parking':
        uses = Math.min(facility.capacity ?? 0, Math.round(sold * 0.35));
        revenue = money(uses * facility.fee);
        break;
      case 'meeting_room':
        uses = weekday >= 1 && weekday <= 4 ? (dateIndex % 4) * 2 : 0;
        revenue = money(uses * facility.fee);
        break;
      case 'spa':
        uses = Math.min(facility.capacity ?? 0, Math.round(sold * 0.18));
        revenue = money(uses * facility.fee);
        break;
      case 'gym':
        uses = Math.min((facility.capacity ?? 0) * 3, Math.round(sold * 0.3));
        break;
      case 'pool':
        uses = Math.min((facility.capacity ?? 0) * 3, Math.round(sold * 0.45));
        break;
      case 'wifi':
        uses = Math.round(sold * 1.8);
        break;
    }
    return {
      hotelId: facility.hotelId,
      facilityId: facility.id,
      date,
      uses,
      revenue,
      basis: date < asOf ? 'actual' : 'planned',
    };
  }),
);
const activityByHotelDate = new Map<string, DailyFacilityActivity[]>();
for (const row of DAILY_FACILITY_ACTIVITY) {
  const key = `${row.hotelId}/${row.date}`;
  const entries = activityByHotelDate.get(key) ?? [];
  entries.push(row);
  activityByHotelDate.set(key, entries);
}

export const DAILY_PERFORMANCE: DailyPerformance[] = HOTELS.flatMap((hotel, hotelIndex) =>
  REPORTING_DATES.map((date, dateIndex) => {
    const nights = nightsByHotelDate.get(`${hotel.id}/${date}`) ?? [];
    const activity = activityByHotelDate.get(`${hotel.id}/${date}`) ?? [];
    const restaurantIds = new Set(
      RESTAURANTS.filter((row) => row.hotelId === hotel.id).map((row) => row.id),
    );
    const dining = activity.filter((row) => restaurantIds.has(row.facilityId));
    const roomsAvailable = hotelRooms
      .get(hotel.id)!
      .filter((_room, index) => !blocked(hotelIndex, index, dateIndex)).length;
    const budgetSoldNights = Math.round(roomsAvailable * targetOccupancy(hotel, date));
    return {
      hotelId: hotel.id,
      date,
      roomsAvailable,
      soldNights: nights.length,
      roomRevenue: money(nights.reduce((sum, row) => sum + row.roomRevenue, 0)),
      restaurantRevenue: money(dining.reduce((sum, row) => sum + row.revenue, 0)),
      restaurantCovers: dining.reduce((sum, row) => sum + row.uses, 0),
      otherRevenue: money(
        activity
          .filter((row) => !restaurantIds.has(row.facilityId))
          .reduce((sum, row) => sum + row.revenue, 0),
      ),
      budgetSoldNights,
      budgetRoomRevenue: money(budgetSoldNights * targetRate(hotel, date)),
      basis: date < asOf ? 'actual' : 'on_books',
      ancillaryBasis: date < asOf ? 'actual' : 'planned',
    };
  }),
);

const commissionRates: Record<BookingChannel, number> = {
  direct: 0.025,
  ota: 0.18,
  corporate: 0.06,
  wholesale: 0.12,
};
export const DAILY_CHANNELS: DailyChannel[] = HOTELS.flatMap((hotel) =>
  REPORTING_DATES.flatMap((date) =>
    (['direct', 'ota', 'corporate', 'wholesale'] as const).map((channel) => {
      const nights = (nightsByHotelDate.get(`${hotel.id}/${date}`) ?? []).filter(
        (row) => row.channel === channel,
      );
      const grossRevenue = money(nights.reduce((sum, row) => sum + row.roomRevenue, 0));
      return {
        id: `${hotel.id}-${date}-${channel}`,
        hotelId: hotel.id,
        date,
        channel,
        soldNights: nights.length,
        grossRevenue,
        commissionRate: commissionRates[channel],
        acquisitionCost: percentageAmount(grossRevenue, commissionRates[channel]),
        basis: date < asOf ? 'actual' : 'on_books',
      };
    }),
  ),
);
export const CHANNELS: ChannelPerformance[] = HOTELS.flatMap((hotel) =>
  REPORTING_PERIODS.flatMap((period) =>
    (['actual', 'on_books'] as const).flatMap((basis) =>
      (['direct', 'ota', 'corporate', 'wholesale'] as const).flatMap((channel) => {
        const rows = DAILY_CHANNELS.filter(
          (row) =>
            row.hotelId === hotel.id &&
            monthOf(row.date) === period.key &&
            row.basis === basis &&
            row.channel === channel,
        );
        return rows.length
          ? [
              {
                id: `${hotel.id}-${period.key}-${basis}-${channel}`,
                hotelId: hotel.id,
                period: period.key,
                basis,
                channel,
                soldNights: rows.reduce((sum, row) => sum + row.soldNights, 0),
                grossRevenue: money(rows.reduce((sum, row) => sum + row.grossRevenue, 0)),
                commissionRate: commissionRates[channel],
                acquisitionCost: money(rows.reduce((sum, row) => sum + row.acquisitionCost, 0)),
              },
            ]
          : [];
      }),
    ),
  ),
);

export const DAILY_COSTS: DailyCost[] = HOTELS.flatMap((hotel, hotelIndex) =>
  REPORTING_DATES.flatMap((date) => {
    const day = DAILY_PERFORMANCE.find((row) => row.hotelId === hotel.id && row.date === date)!;
    const period = REPORTING_PERIODS.find((row) => row.key === monthOf(date))!;
    const dayOfMonth = Number(date.slice(-2));
    const fixedShare = (monthly: number): number => {
      const total = Math.round(monthly * 100);
      return (Math.floor(total / period.days) + (dayOfMonth <= total % period.days ? 1 : 0)) / 100;
    };
    const acquisition = money(
      DAILY_CHANNELS.filter((row) => row.hotelId === hotel.id && row.date === date).reduce(
        (sum, row) => sum + row.acquisitionCost,
        0,
      ),
    );
    const facilities = activityByHotelDate.get(`${hotel.id}/${date}`) ?? [];
    const otherDiningIds = new Set(
      FACILITIES.filter(
        (row) =>
          row.hotelId === hotel.id && (row.kind === 'bar' || row.kind === 'breakfast_lounge'),
      ).map((row) => row.id),
    );
    const otherDiningRevenue = facilities
      .filter((row) => otherDiningIds.has(row.facilityId))
      .reduce((sum, row) => sum + row.revenue, 0);
    const lines: [MonthlyCost['category'], MonthlyCost['department'], number, string][] = [
      [
        'payroll',
        'rooms',
        fixedShare([16500, 18500, 17500, 9500][hotelIndex]),
        'Front office and rooms payroll',
      ],
      [
        'payroll',
        'shared',
        fixedShare([6200, 6800, 6100, 3900][hotelIndex]),
        'Management and shared operations payroll',
      ],
      [
        'utilities',
        'shared',
        fixedShare([3200, 3400, 3800, 1900][hotelIndex]),
        'Electricity, heating and water',
      ],
      [
        'housekeeping',
        'rooms',
        money(day.soldNights * [13.5, 15, 12.8, 10.5][hotelIndex]),
        'Laundry, supplies and contracted room cleaning',
      ],
      [
        'maintenance',
        'shared',
        fixedShare([1500, 1800, 1700, 900][hotelIndex]),
        'Repairs and preventive maintenance',
      ],
      [
        'admin',
        'shared',
        fixedShare([1900, 2200, 1900, 1100][hotelIndex]),
        'Software, accounting and office expenses, excluding payroll',
      ],
      ['rent', 'shared', fixedShare([13500, 17000, 12500, 7200][hotelIndex]), 'Property lease'],
      [
        'channel_commission',
        'rooms',
        acquisition,
        'Channel commissions and direct acquisition costs',
      ],
      [
        'marketing',
        'shared',
        fixedShare([1200, 1500, 1100, 700][hotelIndex]),
        'Brand marketing, excluding channel acquisition costs',
      ],
      [
        'insurance',
        'shared',
        fixedShare([600, 700, 700, 400][hotelIndex]),
        'Property and operational insurance',
      ],
      [
        'food_beverage',
        'shared',
        money(otherDiningRevenue * 0.3),
        'Bar and breakfast-lounge supplies, excluding restaurant purchasing',
      ],
    ];
    if (RESTAURANTS.some((row) => row.hotelId === hotel.id))
      lines.push(
        [
          'payroll',
          'food_beverage',
          fixedShare([8500, 9000, 9800][hotelIndex]),
          'Restaurant payroll',
        ],
        [
          'food_beverage',
          'food_beverage',
          money(day.restaurantRevenue * [0.29, 0.31, 0.28][hotelIndex]),
          'Restaurant purchasing for all meal services',
        ],
      );
    return lines.map(([category, department, amount, description], index) => ({
      id: `${hotel.id}-${date}-cost-${index + 1}`,
      hotelId: hotel.id,
      date,
      category,
      department,
      amount,
      description,
      basis: date < asOf ? 'actual' : 'planned',
    }));
  }),
);
export const COSTS: MonthlyCost[] = HOTELS.flatMap((hotel) =>
  REPORTING_PERIODS.flatMap((period) =>
    (['actual', 'planned'] as const).flatMap((basis) => {
      const rows = DAILY_COSTS.filter(
        (row) =>
          row.hotelId === hotel.id && monthOf(row.date) === period.key && row.basis === basis,
      );
      const groups = new Map<string, DailyCost[]>();
      for (const row of rows) {
        const key = `${row.category}/${row.department}`;
        const group = groups.get(key) ?? [];
        group.push(row);
        groups.set(key, group);
      }
      return [...groups.values()].map((group) => ({
        id: `${hotel.id}-${period.key}-${basis}-${group[0].category}-${group[0].department}`,
        hotelId: hotel.id,
        period: period.key,
        basis,
        category: group[0].category,
        department: group[0].department,
        amount: money(group.reduce((sum, row) => sum + row.amount, 0)),
        description: group[0].description,
      }));
    }),
  ),
);

export const BOOKING_POSITIONS: BookingPosition[] = DAILY_PERFORMANCE.map((day) => {
  const state = day.date < asOf ? 'past' : day.date === asOf ? 'today' : 'future';
  const common = {
    hotelId: day.hotelId,
    stayDate: day.date,
    capturedAsOf: asOf,
    state,
    roomsAvailable: day.roomsAvailable,
    targetRooms: day.budgetSoldNights,
    targetRevenue: day.budgetRoomRevenue,
  } as const;
  if (state === 'past')
    return {
      ...common,
      actualRooms: day.soldNights,
      actualRoomRevenue: day.roomRevenue,
      roomsOnBooks: null,
      revenueOnBooks: null,
      roomsOnBooks7dAgo: null,
      revenueOnBooks7dAgo: null,
      pickup7dRoomNights: null,
      pickup7dRevenue: null,
    };
  const currentNights = nightsByHotelDate.get(`${day.hotelId}/${day.date}`) ?? [];
  const previousAccepted = currentNights.filter(
    (night) => reservationById.get(night.reservationId)!.bookedOn <= previousAsOf,
  );
  const cancelled = inactiveReservations.filter(
    (reservation) =>
      reservation.hotelId === day.hotelId &&
      reservation.status === 'cancelled' &&
      reservation.bookedOn <= previousAsOf &&
      reservation.cancelledOn! > previousAsOf &&
      reservation.arrival <= day.date &&
      reservation.departure > day.date,
  );
  const roomsOnBooks7dAgo = previousAccepted.length + cancelled.length;
  const revenueOnBooks7dAgo = money(
    previousAccepted.reduce((sum, row) => sum + row.roomRevenue, 0) +
      cancelled.reduce((sum, row) => sum + row.quotedNightlyRate, 0),
  );
  return {
    ...common,
    actualRooms: null,
    actualRoomRevenue: null,
    roomsOnBooks: day.soldNights,
    revenueOnBooks: day.roomRevenue,
    roomsOnBooks7dAgo,
    revenueOnBooks7dAgo,
    pickup7dRoomNights: day.soldNights - roomsOnBooks7dAgo,
    pickup7dRevenue: money(day.roomRevenue - revenueOnBooks7dAgo),
  };
});

export const NETWORK_DATA: HotelNetwork = {
  meta: FIXTURE_META,
  bookingSnapshot: BOOKING_SNAPSHOT,
  reportingPeriods: REPORTING_PERIODS,
  hotels: HOTELS,
  events: EVENTS,
  eventHotelImpacts: EVENT_HOTEL_IMPACTS,
  roomTypes: ROOM_TYPES,
  roomRates: ROOM_RATES,
  rooms: ROOMS,
  facilities: FACILITIES,
  restaurants: RESTAURANTS,
  costs: COSTS,
  unitCosts: UNIT_COSTS,
  channels: CHANNELS,
  dailyPerformance: DAILY_PERFORMANCE,
  reservations: RESERVATIONS,
  bookingPositions: BOOKING_POSITIONS,
  dailyRoomStates: DAILY_ROOM_STATES,
  dailyCosts: DAILY_COSTS,
  dailyChannels: DAILY_CHANNELS,
  reservationNights: RESERVATION_NIGHTS,
  dailyFacilityActivity: DAILY_FACILITY_ACTIVITY,
};
