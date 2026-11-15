import { ENUM_OPTIONS, EnumKey, type HotelNetwork } from './network.models';

type SchemaField = {
  type?: string | string[];
  description: string;
  enum?: readonly string[];
  const?: string | boolean;
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  items?: Record<string, unknown>;
  [key: string]: unknown;
};

const text = (description: string): SchemaField => ({ type: 'string', minLength: 1, description });
const integer = (description: string, minimum = 0): SchemaField => ({
  type: 'integer',
  minimum,
  description,
});
const amount = (description: string): SchemaField => ({ type: 'number', minimum: 0, description });
const date = (description: string): SchemaField => ({
  type: 'string',
  format: 'date',
  description,
});
const choice = (key: EnumKey, description: string): SchemaField => ({
  type: 'string',
  enum: ENUM_OPTIONS[key],
  description,
});
const hotelId = (): SchemaField => ({
  type: 'string',
  enum: ['dev-bru', 'dev-ams', 'dev-ber', 'dev-opo'],
  description: 'Hotel.id foreign key.',
});
const period = (): SchemaField => ({
  type: 'string',
  enum: ['2026-10', '2026-11', '2026-12'],
  description: 'Selected reporting month, YYYY-MM, within the covered quarter.',
});
const object = (properties: Record<string, SchemaField>, optional: readonly string[] = []) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties).filter((key) => !optional.includes(key)),
  properties,
});

const rangeFields = {
  startDate: date('First covered calendar date, inclusive.'),
  endDate: date('Last covered calendar date, inclusive.'),
  days: integer('Number of covered calendar dates.', 1),
  label: text('Human-readable reporting range.'),
};
const roomStateFields = {
  occupancy: choice('roomOccupancy', 'Occupied, available, or excluded from sellable inventory.'),
  housekeeping: choice('housekeeping', 'Housekeeping state for this stay date.'),
  maintenance: choice('maintenance', 'Open maintenance blocks the room from sale.'),
  maintenanceNote: {
    type: ['string', 'null'],
    description: 'Work description for open maintenance; otherwise null.',
  } as SchemaField,
};
const roomStateRules = [
  {
    if: { properties: { occupancy: { const: 'out_of_service' } }, required: ['occupancy'] },
    then: {
      properties: {
        maintenance: { enum: ['reported', 'in_progress'] },
        housekeeping: { const: 'dirty' },
        maintenanceNote: { type: 'string', minLength: 1 },
      },
    },
  },
  {
    if: { properties: { occupancy: { const: 'occupied' } }, required: ['occupancy'] },
    then: {
      properties: { maintenance: { const: 'none' }, housekeeping: { enum: ['clean', 'dirty'] } },
    },
  },
  {
    if: { properties: { maintenance: { const: 'none' } }, required: ['maintenance'] },
    then: { properties: { maintenanceNote: { type: 'null' } } },
  },
];
const costFields = {
  id: text('Unique expense-ledger line identifier.'),
  hotelId: hotelId(),
  category: choice('costCategory', 'Operating expense category.'),
  department: choice('department', 'Department charged by this expense.'),
  amount: amount('Expense in EUR, excluding VAT.'),
  description: text('What this expense includes, to prevent double counting.'),
  basis: choice('costBasis', 'Completed actual expense or planned expense for today and later.'),
};
const channelFields = {
  id: text('Unique channel-performance group identifier.'),
  hotelId: hotelId(),
  channel: choice('bookingChannel', 'Source of accepted room demand.'),
  soldNights: integer('Accepted room nights in this channel group.'),
  grossRevenue: amount('Room revenue before acquisition costs, excluding VAT.'),
  commissionRate: {
    type: 'number',
    minimum: 0,
    maximum: 1,
    description: 'Acquisition fraction; 0.18 means 18%.',
  } as SchemaField,
  acquisitionCost: amount(
    'Acquisition cost; monthly groups sum the individually rounded daily fees.',
  ),
  basis: choice(
    'revenueBasis',
    'Completed actual room revenue or provisional on-the-books revenue.',
  ),
};

const DEFINITIONS = {
  Geography: object({
    latitude: {
      type: 'number',
      minimum: -90,
      maximum: 90,
      description: 'WGS84 latitude in decimal degrees, from -90 to 90.',
    },
    longitude: {
      type: 'number',
      minimum: -180,
      maximum: 180,
      description: 'WGS84 longitude in decimal degrees, from -180 to 180.',
    },
  }),
  ReportingPeriod: object({ key: period(), ...rangeFields }),
  RoomRate: object({
    hotelId: hotelId(),
    roomTypeId: text('RoomType.id foreign key within the same hotel.'),
    date: date('Quoted stay date; unique with roomTypeId across the full covered quarter.'),
    nightlyRate: {
      type: 'number',
      minimum: 0.01,
      maximum: 10_000,
      description:
        'Selling quote per room per night in EUR excluding VAT, rounded to cents. Independent of booked reservation revenue and event relevance.',
    },
    currency: { type: 'string', const: 'EUR', description: 'Euro selling-quote currency.' },
  }),
  DailyRoomState: {
    ...object({
      roomId: text('Room.id foreign key.'),
      hotelId: hotelId(),
      date: date('Stay date, unique with roomId.'),
      ...roomStateFields,
      basis: choice(
        'roomStateBasis',
        'Completed actual state before asOf; scheduled state today and later.',
      ),
    }),
    allOf: roomStateRules,
  },
  DailyCost: object({
    ...costFields,
    date: date('Operating expense date, including zero-volume days.'),
  }),
  DailyChannel: object({
    ...channelFields,
    date: date('Stay date, unique with hotelId and channel.'),
  }),
  ReservationNight: object({
    reservationId: text('Reservation.id foreign key.'),
    hotelId: hotelId(),
    roomId: text('Assigned Room.id; unique with date across accepted reservations.'),
    date: date('Occupied stay date, inside the reservation arrival/departure range.'),
    channel: choice('bookingChannel', 'Must match the parent reservation channel.'),
    roomRevenue: amount('Accepted nightly room revenue; sums exactly to the reservation value.'),
  }),
  DailyFacilityActivity: object({
    hotelId: hotelId(),
    facilityId: text('Facility.id foreign key within the same hotel.'),
    date: date('Activity date, unique with facilityId.'),
    uses: integer(
      'Daily people, covers, room uses, parking nights, or hours, according to facility kind.',
    ),
    revenue: amount('Daily facility revenue in EUR, excluding VAT.'),
    basis: choice(
      'activityBasis',
      'Completed activity before asOf; planned activity today and later.',
    ),
  }),
  NetworkMeta: object({
    id: text('Stable network identifier.'),
    name: text('Hotel network name.'),
    schemaVersion: text('Dataset schema version.'),
    testData: {
      type: 'boolean',
      const: true,
      description: 'Dataset classification flag.',
    },
    currency: {
      type: 'string',
      const: 'EUR',
      description: 'Currency for every amount in this dataset.',
    },
    amountBasis: {
      type: 'string',
      const: 'net_excluding_vat',
      description: 'All financial amounts exclude VAT.',
    },
    reportingPeriod: {
      ...object({
        startDate: date('First reporting day, inclusive.'),
        endDate: date('Last reporting day, inclusive.'),
        days: integer('Number of calendar days.', 1),
        label: text('Human-readable reporting period.'),
      }),
      description:
        'Full quarter coverage: October 1 through December 31, 2026, including actual and planned rows.',
    },
    snapshotDate: date('Date represented by room and reservation operational states.'),
    notes: {
      type: 'array',
      minItems: 1,
      items: { type: 'string' },
      description: 'Accounting and reporting assumptions.',
    },
  }),
  BookingSnapshot: object({
    asOf: date('Booking business date.'),
    previousAsOf: date('Prior booking snapshot date, seven days before asOf.'),
    period: {
      ...object({
        startDate: date('First stay date, inclusive.'),
        endDate: date('Last stay date, inclusive.'),
        days: integer('Number of stay dates in the quarter.', 1),
        label: text('Human-readable booking coverage.'),
      }),
      description:
        'Full quarter stay-date coverage; each UI month selects a complete calendar slice.',
    },
    testData: {
      type: 'boolean',
      const: true,
      description: 'Dataset classification flag.',
    },
    source: {
      type: 'string',
      const: 'development_aggregated_pms_positions',
      description:
        'Aggregated positions reconciled to the complete accepted reservation-night ledger.',
    },
    includedOnBooksStatuses: {
      type: 'array',
      items: { type: 'string', enum: ['confirmed', 'checked_in'] },
      uniqueItems: true,
      minItems: 2,
      maxItems: 2,
      description: 'Reservation states included in current and prior on-the-books aggregates.',
    },
    excludedStatuses: {
      type: 'array',
      items: { type: 'string', enum: ['cancelled', 'pending', 'no_show'] },
      uniqueItems: true,
      minItems: 3,
      maxItems: 3,
      description: 'States excluded from booking aggregates.',
    },
    notes: {
      type: 'array',
      minItems: 1,
      items: { type: 'string' },
      description: 'Stay-date, current-day, pickup, target and accounting semantics.',
    },
  }),
  BookingPosition: {
    ...object({
      hotelId: hotelId(),
      stayDate: date('Date of the room night; unique with hotelId.'),
      capturedAsOf: date('Business date of this fixed booking snapshot.'),
      state: choice('bookingState', 'Position relative to the booking snapshot business date.'),
      roomsAvailable: integer('Sellable physical room-night capacity for this stay date.', 1),
      actualRooms: {
        type: ['integer', 'null'],
        minimum: 0,
        description: 'Completed sold room nights for past dates only; null for today and future.',
      },
      actualRoomRevenue: {
        type: ['number', 'null'],
        minimum: 0,
        description:
          'Completed past stay-date room revenue, EUR net of VAT; null for today and future.',
      },
      roomsOnBooks: {
        type: ['integer', 'null'],
        minimum: 0,
        description:
          'Confirmed/checked-in room nights for today and future only; null for completed dates.',
      },
      revenueOnBooks: {
        type: ['number', 'null'],
        minimum: 0,
        description:
          'Current confirmed/checked-in room revenue by stay date; not realized revenue or a forecast.',
      },
      roomsOnBooks7dAgo: {
        type: ['integer', 'null'],
        minimum: 0,
        description:
          'On-the-books room nights for this same stay date at previousAsOf; null for past stay dates.',
      },
      revenueOnBooks7dAgo: {
        type: ['number', 'null'],
        minimum: 0,
        description:
          'On-the-books revenue for this same stay date at previousAsOf; null for past stay dates.',
      },
      pickup7dRoomNights: {
        type: ['integer', 'null'],
        description: 'Signed roomsOnBooks minus roomsOnBooks7dAgo; null for completed dates.',
      },
      pickup7dRevenue: {
        type: ['number', 'null'],
        description:
          'Signed revenueOnBooks minus revenueOnBooks7dAgo, in EUR; null for completed dates.',
      },
      targetRooms: integer('Planned sold room nights for the stay date, not above roomsAvailable.'),
      targetRevenue: amount(
        'Planned room revenue for the stay date, EUR net of VAT. Not expected sales.',
      ),
    }),
    allOf: [
      {
        if: { properties: { state: { const: 'past' } }, required: ['state'] },
        then: {
          properties: {
            actualRooms: { type: 'integer' },
            actualRoomRevenue: { type: 'number' },
            roomsOnBooks: { type: 'null' },
            revenueOnBooks: { type: 'null' },
            roomsOnBooks7dAgo: { type: 'null' },
            revenueOnBooks7dAgo: { type: 'null' },
            pickup7dRoomNights: { type: 'null' },
            pickup7dRevenue: { type: 'null' },
          },
        },
      },
      {
        if: { properties: { state: { enum: ['today', 'future'] } }, required: ['state'] },
        then: {
          properties: {
            actualRooms: { type: 'null' },
            actualRoomRevenue: { type: 'null' },
            roomsOnBooks: { type: 'integer' },
            revenueOnBooks: { type: 'number' },
            roomsOnBooks7dAgo: { type: 'integer' },
            revenueOnBooks7dAgo: { type: 'number' },
            pickup7dRoomNights: { type: 'integer' },
            pickup7dRevenue: { type: 'number' },
          },
        },
      },
    ],
  },
  HotelAddress: object(
    {
      line1: {
        ...text(
          'Configured street and building; fixture values are sample addresses, not verified hotel locations.',
        ),
        maxLength: 200,
      },
      line2: {
        type: ['string', 'null'],
        minLength: 1,
        maxLength: 200,
        description: 'Optional additional postal address line.',
      },
      postalCode: {
        ...text('Configured postal code, with no claim of independent address verification.'),
        maxLength: 20,
      },
    },
    ['line2'],
  ),
  Hotel: object(
    {
      id: hotelId(),
      name: { ...text('Hotel name.'), maxLength: 120 },
      city: text('Hotel city.'),
      country: text('Country name.'),
      coordinates: {
        $ref: '#/$defs/Geography',
        description:
          'Hotel location in WGS84 decimal degrees: latitude -90 to 90, longitude -180 to 180.',
      },
      address: {
        type: ['object', 'null'],
        anyOf: [{ $ref: '#/$defs/HotelAddress' }, { type: 'null' }],
        description:
          'Optional configured postal address with line1, optional line2 and postalCode. City and country belong to the hotel. Fixture addresses are sample data and coordinates are not geocoded matches.',
      },
      countryCode: { ...text('ISO 3166-1 alpha-2 country code.'), pattern: '^[A-Z]{2}$' },
      timezone: text('IANA local timezone.'),
      status: choice('hotelStatus', 'Property operating state.'),
      category: choice('hotelCategory', 'Hotel operating segment.'),
      starRating: {
        ...integer('Hotel star category.', 1),
        maximum: 5,
      },
      openedYear: { ...integer('Opening year.', 1900), maximum: 2026 },
    },
    ['address'],
  ),
  HotelEvent: object({
    id: text('Unique event identifier, shared by every related hotel assessment.'),
    name: text('Generated event name; not a verified live event listing.'),
    category: choice('eventCategory', 'Event format or demand category.'),
    startDate: date('First event date, inclusive.'),
    endDate: date('Last event date, inclusive; not before startDate.'),
    venue: text('Venue used by the generated event.'),
    city: text('Event city.'),
    country: text('Event country.'),
    coordinates: {
      $ref: '#/$defs/Geography',
      description:
        'Venue location in WGS84 decimal degrees: latitude -90 to 90, longitude -180 to 180.',
    },
    expectedAttendance: integer('Illustrative expected attendance, not measured attendance.', 1),
  }),
  EventHotelImpact: object({
    eventId: text('HotelEvent.id foreign key; unique with hotelId.'),
    hotelId: hotelId(),
    importance: choice(
      'eventImportance',
      'Hotel-specific assessment considering proximity and event relevance; not a demand forecast.',
    ),
    distanceKm: amount(
      'Straight-line Haversine distance from hotel to venue, using Earth radius 6371 km, rounded to two decimals. Not a road distance.',
    ),
    reason: text('Explanation of this hotel-specific relevance assessment.'),
    source: choice(
      'eventImpactSource',
      'Assessment provenance. Seeded records use fixture; kassandra is reserved for a future assistant assessment.',
    ),
    assessedAt: date('Date this assessment was made, no later than the fixed business date.'),
  }),
  RoomType: object({
    id: text('Unique room-type identifier.'),
    hotelId: hotelId(),
    name: text('Room category name.'),
    inventory: integer('Number of physical rooms of this type.', 1),
    maxAdults: integer('Maximum adult occupancy per room.', 1),
    maxChildren: integer('Additional child occupancy per room.'),
    areaM2: {
      type: 'number',
      exclusiveMinimum: 0,
      description: 'Approximate room area in square metres.',
    },
    baseRate: amount('Reference nightly room rate, EUR net of VAT. Actual daily rates vary.'),
    facilities: {
      type: 'array',
      uniqueItems: true,
      items: { type: 'string', enum: ENUM_OPTIONS.roomFacility },
      description: 'Facilities shared by every room in this room type.',
    },
  }),
  Room: {
    ...object({
      id: text('Unique physical-room identifier.'),
      hotelId: hotelId(),
      roomTypeId: text('RoomType.id foreign key within the same hotel.'),
      number: text('Room number, unique within a hotel.'),
      floor: integer('Guest floor number.', 1),
      date: date('Current room-state snapshot date, derived from dailyRoomStates.'),
      basis: choice(
        'roomStateBasis',
        'Current state basis, using the same calendar boundary as daily room states.',
      ),
      occupancy: choice('roomOccupancy', 'Snapshot room availability or occupancy.'),
      housekeeping: choice(
        'housekeeping',
        'Snapshot housekeeping state, independent of occupancy.',
      ),
      maintenance: choice('maintenance', 'Snapshot maintenance work state.'),
      maintenanceNote: {
        type: ['string', 'null'],
        description: 'Short work description when maintenance is open, otherwise null.',
      },
    }),
    allOf: [
      {
        if: { properties: { occupancy: { const: 'out_of_service' } }, required: ['occupancy'] },
        then: {
          properties: {
            maintenance: { enum: ['reported', 'in_progress'] },
            housekeeping: { const: 'dirty' },
            maintenanceNote: { type: 'string', minLength: 1 },
          },
        },
      },
      {
        if: { properties: { occupancy: { const: 'occupied' } }, required: ['occupancy'] },
        then: {
          properties: {
            housekeeping: { enum: ['clean', 'dirty'] },
            maintenance: { const: 'none' },
          },
        },
      },
      {
        if: { properties: { maintenance: { const: 'none' } }, required: ['maintenance'] },
        then: { properties: { maintenanceNote: { type: 'null' } } },
      },
    ],
  },
  Facility: object({
    id: text('Unique facility identifier.'),
    hotelId: hotelId(),
    kind: choice('facilityKind', 'Facility or guest-service category.'),
    name: text('Facility name.'),
    capacity: {
      type: ['integer', 'null'],
      minimum: 1,
      description: 'People or spaces, as appropriate; null when not capacity-limited.',
    },
    openingHours: text('Local opening hours, including service windows.'),
    fee: amount('Published reference guest fee, EUR net of VAT.'),
    feeUnit: choice('feeUnit', 'Basis of the listed guest fee; included means zero fee.'),
  }),
  Restaurant: object({
    id: text('Unique restaurant identifier, also the matching restaurant Facility.id.'),
    hotelId: hotelId(),
    name: text('Outlet name.'),
    cuisine: text('Cuisine.'),
    seats: integer('Seated outlet capacity.', 1),
    openingHours: text('Local breakfast, lunch and dinner service windows.'),
    breakfastPrice: amount('Breakfast selling price per person, EUR net of VAT.'),
    averageCheck: amount('Average lunch/dinner spend per cover, excluding breakfast.'),
  }),
  MonthlyCost: object({ ...costFields, period: period() }),
  UnitCost: object({
    id: text('Unique planning unit-cost identifier.'),
    hotelId: hotelId(),
    basis: choice('unitCostBasis', 'Physical unit used by the planning rate.'),
    amount: amount('Planning cost per unit, EUR net of VAT.'),
    description: text('Scope of the planning cost. Not an extra ledger expense.'),
  }),
  ChannelPerformance: object({ ...channelFields, period: period() }),
  DailyPerformance: object({
    hotelId: hotelId(),
    date: date('Reporting day; unique with hotelId.'),
    roomsAvailable: integer(
      'Sellable physical rooms that day, after out-of-service exclusions.',
      1,
    ),
    soldNights: integer('Sold room nights for the day, at most roomsAvailable.'),
    roomRevenue: amount('Daily room revenue, before acquisition costs and net of VAT.'),
    restaurantRevenue: amount(
      'All restaurant service revenue, including breakfast; zero where no restaurant exists.',
    ),
    restaurantCovers: integer('All restaurant service covers; zero where no restaurant exists.'),
    otherRevenue: amount(
      'Revenue from all non-restaurant facilities, including the Porto breakfast lounge.',
    ),
    budgetSoldNights: integer('Planned room nights, at most roomsAvailable.'),
    budgetRoomRevenue: amount('Planned room revenue, net of VAT.'),
    basis: choice(
      'revenueBasis',
      'Completed room revenue before asOf; on-the-books room revenue today and later.',
    ),
    ancillaryBasis: choice(
      'activityBasis',
      'Completed restaurant/other activity before asOf; planned activity today and later.',
    ),
  }),
  Reservation: {
    ...object({
      id: text('Unique reservation workflow identifier.'),
      hotelId: hotelId(),
      roomTypeId: text('RoomType.id foreign key in the same hotel.'),
      roomId: {
        type: ['string', 'null'],
        description: 'Assigned Room.id in the same hotel and room type; null when unassigned.',
      },
      guestRef: {
        ...text('Guest reference.'),
        pattern: '^GUEST-\\d{3,}$',
      },
      channel: choice('bookingChannel', 'Reservation acquisition channel.'),
      status: choice('reservationStatus', 'Reservation workflow state at the snapshot date.'),
      arrival: date('Arrival date, inclusive.'),
      departure: date('Departure date, exclusive and after arrival.'),
      adults: integer('Number of adults, within the room-type capacity.', 1),
      children: integer('Number of children, within the room-type capacity.'),
      roomRevenue: amount(
        'Accepted stay value, exactly equal to reservationNights; zero for cancelled, no-show and pending records.',
      ),
      currency: { type: 'string', const: 'EUR', description: 'Reservation amount currency.' },
      bookedOn: date('Creation date used to reconstruct prior on-the-books positions.'),
      cancelledOn: {
        type: ['string', 'null'],
        format: 'date',
        description: 'Cancellation date; null when no cancellation has occurred.',
      },
      quotedNightlyRate: amount(
        'Quoted room-night rate, including the historical quote on an excluded reservation.',
      ),
      quotedRevenue: amount(
        'Quoted full stay value before any cancellation; preserves prior-snapshot value.',
      ),
    }),
    allOf: [
      {
        if: { properties: { status: { const: 'checked_in' } }, required: ['status'] },
        then: { properties: { roomId: { type: 'string' } } },
      },
      {
        if: {
          properties: { status: { enum: ['cancelled', 'no_show', 'pending'] } },
          required: ['status'],
        },
        then: { properties: { roomRevenue: { const: 0 } } },
      },
    ],
  },
};

const collections = {
  reportingPeriods: {
    definition: 'ReportingPeriod',
    name: 'Reporting months',
    description: 'October, November and December 2026, each with a complete calendar range.',
  },
  dailyRoomStates: {
    definition: 'DailyRoomState',
    name: 'Daily room states',
    description:
      'Every physical room on every date in the quarter, including vacant and out-of-service dates.',
  },
  dailyCosts: {
    definition: 'DailyCost',
    name: 'Daily operating costs',
    description:
      'Daily actual and planned expenses. The monthly cost ledger is an exact grouping of these rows.',
  },
  dailyChannels: {
    definition: 'DailyChannel',
    name: 'Daily booking channels',
    description:
      'All four channels on every hotel stay date, reconciled to the accepted room-night ledger.',
  },
  reservationNights: {
    definition: 'ReservationNight',
    name: 'Reservation room nights',
    description: 'Complete accepted stay-night ledger. Each room/date can appear only once.',
  },
  dailyFacilityActivity: {
    definition: 'DailyFacilityActivity',
    name: 'Daily facility activity',
    description:
      'Every facility on every quarter date, including zero-use days. Actual and planned activity remain separate.',
  },
  hotels: {
    definition: 'Hotel',
    name: 'Hotels',
    description: 'The four hotel properties, including their WGS84 locations.',
  },
  events: {
    definition: 'HotelEvent',
    name: 'Events',
    description:
      'Generated ongoing and upcoming event fixtures with venue coordinates, inclusive dates and illustrative attendance. Not live or verified event listings.',
  },
  eventHotelImpacts: {
    definition: 'EventHotelImpact',
    name: 'Event hotel impacts',
    description:
      'Normalized hotel-event relevance assessments, with distance, importance, rationale and explicit provenance. Events can influence more than one hotel without duplicating event records.',
  },
  roomTypes: {
    definition: 'RoomType',
    name: 'Room types',
    description: 'Physical inventory, capacity, reference rates and common facilities.',
  },
  roomRates: {
    definition: 'RoomRate',
    name: 'Daily room rates',
    description:
      'One selling quote for each room type and quarter date. Current local updates override quotes; accepted reservations retain their booked rates.',
  },
  rooms: {
    definition: 'Room',
    name: 'Rooms',
    description:
      'All 88 physical rooms and their November 14 operational snapshot, derived from daily states.',
  },
  facilities: {
    definition: 'Facility',
    name: 'Facilities',
    description: 'Property services, capacities, local hours and guest fees.',
  },
  restaurants: {
    definition: 'Restaurant',
    name: 'Restaurants',
    description: 'Three full-service outlets. Porto has a breakfast lounge instead.',
  },
  costs: {
    definition: 'MonthlyCost',
    name: 'Monthly costs',
    description:
      'Monthly operating expenses grouped by hotel, category, department and actual/planned basis.',
  },
  unitCosts: {
    definition: 'UnitCost',
    name: 'Unit costs',
    description: 'Planning reference costs per operational unit.',
  },
  channels: {
    definition: 'ChannelPerformance',
    name: 'Booking channels',
    description:
      'Monthly room nights, room revenue and acquisition fees, separated into actual and on-the-books groups.',
  },
  dailyPerformance: {
    definition: 'DailyPerformance',
    name: 'Daily performance',
    description:
      'One row per hotel for all 92 quarter dates. Room revenue reconciles to accepted nights; facility revenues reconcile to activity.',
  },
  reservations: {
    definition: 'Reservation',
    name: 'Reservations',
    description:
      'Complete one-to-four-night stays across the quarter, with excluded reservations retained for workflow and prior-snapshot reconstruction.',
  },
  bookingPositions: {
    definition: 'BookingPosition',
    name: 'Booking positions',
    description:
      'All quarter stay-date actuals and current/prior confirmed booking aggregates, captured as of November 14.',
  },
} as const;

/** Structural schema. Cross-row reconciliation and foreign keys are checked by test:data. */
export const NETWORK_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:juyo:hotel-network:2.3.0',
  title: 'European hotel network',
  description:
    'Four geolocated hotels and 88 rooms across the complete October–December 2026 quarter, with daily room-type selling quotes, generated event fixtures and hotel-specific relevance assessments. EUR amounts exclude VAT. Selling quotes remain separate from accepted booking revenue. Past actuals, scheduled occupancy, on-the-books revenue and planned expenses remain explicit.',
  type: 'object',
  additionalProperties: false,
  required: ['meta', 'bookingSnapshot', ...Object.keys(collections)],
  properties: {
    meta: { $ref: '#/$defs/NetworkMeta' },
    bookingSnapshot: { $ref: '#/$defs/BookingSnapshot' },
    ...Object.fromEntries(
      Object.entries(collections).map(([key, value]) => [
        key,
        {
          type: 'array',
          description: value.description,
          ...(key === 'hotels'
            ? { minItems: 4, maxItems: 4 }
            : key === 'rooms'
              ? { minItems: 88, maxItems: 88 }
              : {}),
          items: { $ref: `#/$defs/${value.definition}` },
        },
      ]),
    ),
  },
  $defs: DEFINITIONS,
};

export interface DictionaryField {
  name: string;
  type: string;
  description: string;
  required: boolean;
  reference?: string;
  enum?: string[];
}
export interface DictionaryEntity {
  key: string;
  name: string;
  description: string;
  rowCount: number;
  fields: DictionaryField[];
}
const references: Record<string, string> = {
  hotelId: 'Hotel.id',
  roomTypeId: 'RoomType.id',
  roomId: 'Room.id',
  facilityId: 'Facility.id',
  reservationId: 'Reservation.id',
  eventId: 'HotelEvent.id',
  coordinates: 'Geography (WGS84)',
  address: 'HotelAddress (configured postal lines and code)',
};

/** Derive dictionary counts from the supplied API snapshot, never imported fixtures. */
export function buildNetworkSchema(data: HotelNetwork) {
  const DATA_DICTIONARY: DictionaryEntity[] = [
    {
      key: 'meta',
      name: 'Network metadata',
      description: 'Version, accounting basis and reporting/snapshot scope.',
      rowCount: 1,
      fields: dictionaryFields(
        DEFINITIONS.NetworkMeta.properties,
        DEFINITIONS.NetworkMeta.required,
      ),
    },
    {
      key: 'bookingSnapshot',
      name: 'Booking snapshot',
      description:
        'Booking business date, complete quarter stay-date coverage, prior-snapshot baseline and included statuses.',
      rowCount: 1,
      fields: dictionaryFields(
        DEFINITIONS.BookingSnapshot.properties,
        DEFINITIONS.BookingSnapshot.required,
      ),
    },
    ...Object.entries(collections).map(([key, value]) => ({
      key,
      name: value.name,
      description: value.description,
      rowCount: data[key as keyof typeof collections].length,
      fields: dictionaryFields(
        DEFINITIONS[value.definition].properties,
        DEFINITIONS[value.definition].required,
      ),
    })),
  ];

  function dictionaryFields(
    properties: Record<string, SchemaField>,
    required: readonly string[],
  ): DictionaryField[] {
    return Object.entries(properties).map(([name, field]) => ({
      name,
      type: Array.isArray(field.type) ? field.type.join(' | ') : (field.type ?? 'object'),
      description: field.description,
      required: required.includes(name),
      ...(references[name] ? { reference: references[name] } : {}),
      ...(field.enum ? { enum: [...field.enum] } : {}),
    }));
  }

  const enumDescriptions: Record<
    EnumKey,
    {
      label: string;
      description: string;
      usage: string;
      values: Record<string, [string, string]>;
      counts: string[];
    }
  > = {
    eventCategory: {
      label: 'Event categories',
      description: 'Format of a generated event that may affect hotel demand.',
      usage: 'events.category',
      counts: data.events.map((row) => row.category),
      values: {
        conference: ['Conference', 'Professional congress or industry gathering.'],
        trade_fair: ['Trade fair', 'Exhibition bringing business visitors to the area.'],
        concert: ['Concert', 'Live music performance.'],
        festival: ['Festival', 'Multi-activity cultural or seasonal programme.'],
        market: ['Market', 'Public seasonal or specialist market.'],
        sport: ['Sport', 'Sporting event with spectators or participants.'],
      },
    },
    eventImportance: {
      label: 'Event importance',
      description:
        'Hotel-specific qualitative relevance, considering distance and the type and scale of the event. Not a predicted occupancy or revenue uplift.',
      usage: 'eventHotelImpacts.importance',
      counts: data.eventHotelImpacts.map((row) => row.importance),
      values: {
        mild: ['Mild', 'Limited or indirect relevance for this hotel.'],
        medium: ['Medium', 'Meaningful local relevance for this hotel.'],
        important: ['Important', 'Strong relevance for this hotel and its guest demand.'],
      },
    },
    eventImpactSource: {
      label: 'Event assessment source',
      description: 'Provenance of a hotel-event relevance assessment.',
      usage: 'eventHotelImpacts.source',
      counts: data.eventHotelImpacts.map((row) => row.source),
      values: {
        fixture: [
          'Fixture',
          'Generated local example data, without a live AI or event-feed claim.',
        ],
        kassandra: ['Kassandra', 'Reserved for future assistant-produced assessments; not seeded.'],
      },
    },
    roomStateBasis: {
      label: 'Room-state basis',
      description: 'Calendar basis of every physical room state.',
      usage: 'dailyRoomStates.basis',
      counts: data.dailyRoomStates.map((row) => row.basis),
      values: {
        actual: ['Actual', 'Completed stay-date room state before the booking business date.'],
        scheduled: [
          'Scheduled',
          'Room state today or later, reflecting accepted bookings and planned maintenance.',
        ],
      },
    },
    costBasis: {
      label: 'Expense basis',
      description: 'Actual expenses remain separate from planned spending.',
      usage: 'dailyCosts.basis',
      counts: data.dailyCosts.map((row) => row.basis),
      values: {
        actual: ['Actual', 'Completed operating expense before the business date.'],
        planned: [
          'Planned',
          'Planning expense for today or later; excluded from actual operating profit.',
        ],
      },
    },
    revenueBasis: {
      label: 'Room-revenue basis',
      description: 'Completed revenue and provisional bookings use distinct bases.',
      usage: 'dailyPerformance.basis',
      counts: data.dailyPerformance.map((row) => row.basis),
      values: {
        actual: ['Actual', 'Completed room nights and room revenue before the business date.'],
        on_books: [
          'On the books',
          'Accepted booked room nights and revenue today or later; subject to change.',
        ],
      },
    },
    activityBasis: {
      label: 'Facility-activity basis',
      description: 'Actual and planned restaurant and facility activity.',
      usage: 'dailyFacilityActivity.basis',
      counts: data.dailyFacilityActivity.map((row) => row.basis),
      values: {
        actual: ['Actual', 'Completed facility uses and revenue before the business date.'],
        planned: [
          'Planned',
          'Expected activity today or later, shown as planning data rather than actual results.',
        ],
      },
    },
    bookingState: {
      label: 'Booking day state',
      description: 'Relationship between stay date and the fixed booking snapshot business date.',
      usage: 'bookingPositions.state',
      counts: data.bookingPositions.map((row) => row.state),
      values: {
        past: [
          'Completed',
          'Stay date before asOf; revenue and sold room nights are completed actuals.',
        ],
        today: [
          'Today',
          'Stay date equals asOf; values are provisional confirmed/checked-in bookings, not completed actuals.',
        ],
        future: [
          'Future',
          'Stay date after asOf; values are confirmed on-the-books positions, not a revenue forecast.',
        ],
      },
    },
    hotelStatus: {
      label: 'Hotel status',
      description: 'Property operating lifecycle.',
      usage: 'hotels.status',
      counts: data.hotels.map((row) => row.status),
      values: {
        active: ['Active', 'Operating and accepting guests.'],
        renovation: ['Renovation', 'Temporarily undergoing major renovation.'],
        closed: ['Closed', 'Not operating.'],
      },
    },
    hotelCategory: {
      label: 'Hotel category',
      description: 'Main operating segment.',
      usage: 'hotels.category',
      counts: data.hotels.map((row) => row.category),
      values: {
        business: ['Business', 'Business and meetings-led hotel.'],
        boutique: ['Boutique', 'Small design-led urban hotel.'],
        city: ['City', 'Urban leisure and short-stay hotel.'],
      },
    },
    roomOccupancy: {
      label: 'Room occupancy',
      description: 'Snapshot availability. This is separate from monthly occupancy percentage.',
      usage: 'rooms.occupancy',
      counts: data.rooms.map((row) => row.occupancy),
      values: {
        available: [
          'Available',
          'Not occupied and not blocked for maintenance; a dirty room still needs servicing.',
        ],
        occupied: ['Occupied', 'Assigned to a guest currently in house.'],
        out_of_service: [
          'Out of service',
          'Unavailable for sale while reported or active maintenance is outstanding.',
        ],
      },
    },
    housekeeping: {
      label: 'Housekeeping',
      description:
        'Housekeeping state at the snapshot. Occupied rooms may be clean or dirty, never inspected.',
      usage: 'rooms.housekeeping',
      counts: data.rooms.map((row) => row.housekeeping),
      values: {
        clean: ['Clean', 'Serviced; may still be occupied or await final inspection.'],
        dirty: ['Dirty', 'Requires cleaning or return-to-service work.'],
        inspected: ['Inspected', 'Vacant, serviced and checked for the next arrival.'],
      },
    },
    maintenance: {
      label: 'Maintenance',
      description: 'Work state. Rooms with open maintenance are unavailable for sale.',
      usage: 'rooms.maintenance',
      counts: data.rooms.map((row) => row.maintenance),
      values: {
        none: ['None', 'No open maintenance work.'],
        reported: ['Reported', 'Issue recorded; room is out of service pending work.'],
        in_progress: ['In progress', 'Work is underway; room is out of service.'],
      },
    },
    roomFacility: {
      label: 'Room facilities',
      description: 'Applies to every room in the listed room type.',
      usage: 'roomTypes.facilities (room-type occurrences)',
      counts: data.roomTypes.flatMap((row) => row.facilities),
      values: {
        wifi: ['Wi-Fi', 'In-room wireless internet.'],
        air_conditioning: ['Air conditioning', 'Guest-controlled room cooling.'],
        desk: ['Desk', 'In-room work desk.'],
        coffee_machine: ['Coffee machine', 'In-room coffee equipment.'],
        balcony: ['Balcony', 'Private outdoor balcony.'],
        accessible: ['Accessible', 'Accessible room specification, only when explicitly assigned.'],
        kitchenette: ['Kitchenette', 'Small in-room cooking area.'],
        bathtub: ['Bathtub', 'Bathroom includes a bath.'],
      },
    },
    facilityKind: {
      label: 'Property facilities',
      description: 'Guest services and physical facilities.',
      usage: 'facilities.kind',
      counts: data.facilities.map((row) => row.kind),
      values: {
        wifi: ['Wi-Fi', 'Property internet service.'],
        parking: ['Parking', 'Vehicle parking spaces.'],
        gym: ['Gym', 'Fitness facility.'],
        meeting_room: ['Meeting rooms', 'Bookable event or meeting capacity.'],
        spa: ['Spa', 'Sauna or treatment facility.'],
        pool: ['Pool', 'Swimming facility.'],
        bar: ['Bar', 'Drinks outlet; sales are other revenue.'],
        restaurant: ['Restaurant', 'Full-service outlet with a matching restaurant record.'],
        breakfast_lounge: [
          'Breakfast lounge',
          'Breakfast-only space, not a full-service restaurant.',
        ],
      },
    },
    feeUnit: {
      label: 'Guest fee units',
      description: 'Basis of facility selling fees, not hotel operating costs.',
      usage: 'facilities.feeUnit',
      counts: data.facilities.map((row) => row.feeUnit),
      values: {
        included: ['Included', 'No additional guest fee.'],
        per_hour: ['Per hour', 'Fee for one hour.'],
        per_day: ['Per day', 'Fee for one day.'],
        per_night: ['Per night', 'Fee for one overnight use.'],
        per_person: ['Per person', 'Fee per guest or visit.'],
      },
    },
    costCategory: {
      label: 'Cost categories',
      description: 'Monthly operating cost ledger categories.',
      usage: 'costs.category',
      counts: data.costs.map((row) => row.category),
      values: {
        payroll: ['Payroll', 'Staff expense, split by department.'],
        utilities: ['Utilities', 'Energy and water.'],
        housekeeping: ['Housekeeping', 'Laundry, supplies and contracted cleaning.'],
        maintenance: ['Maintenance', 'Repairs and preventive work.'],
        admin: ['Administration', 'Systems, accounting and office costs, excluding payroll.'],
        rent: ['Rent', 'Property lease.'],
        food_beverage: [
          'Food & beverage',
          'Ingredient and beverage purchasing. All restaurant services use the food_beverage department; bar and breakfast-lounge supplies use shared.',
        ],
        channel_commission: [
          'Channel acquisition',
          'Commissions and direct channel acquisition costs.',
        ],
        marketing: ['Marketing', 'Brand marketing excluding channel acquisition.'],
        insurance: ['Insurance', 'Property and operating insurance.'],
      },
    },
    department: {
      label: 'Departments',
      description: 'Cost ownership for financial analysis.',
      usage: 'costs.department',
      counts: data.costs.map((row) => row.department),
      values: {
        rooms: ['Rooms', 'Rooms operation and distribution.'],
        food_beverage: ['Food & beverage', 'Restaurant operation.'],
        shared: ['Shared', 'Hotel-wide, guest-service or administrative expense.'],
      },
    },
    unitCostBasis: {
      label: 'Unit-cost bases',
      description: 'Planning rate denominator; these are not additional ledger expenses.',
      usage: 'unitCosts.basis',
      counts: data.unitCosts.map((row) => row.basis),
      values: {
        occupied_room: ['Occupied room night', 'Cleaning operating cost per sold room night.'],
        breakfast: ['Breakfast', 'Food purchasing per breakfast.'],
        staff_hour: ['Staff hour', 'Average loaded hourly staff cost.'],
        parking_night: ['Parking night', 'Operating cost per parking space used for one night.'],
      },
    },
    bookingChannel: {
      label: 'Booking channels',
      description: 'Acquisition sources for rooms.',
      usage: 'channels.channel',
      counts: data.channels.map((row) => row.channel),
      values: {
        direct: ['Direct', 'Hotel website, telephone or direct sales.'],
        ota: ['OTA', 'Online travel agent.'],
        corporate: ['Corporate', 'Negotiated company accounts.'],
        wholesale: ['Wholesale', 'Tour operator or intermediary allocation.'],
      },
    },
    reservationStatus: {
      label: 'Reservation status',
      description: 'Reservation states as of the snapshot date.',
      usage: 'reservations.status',
      counts: data.reservations.map((row) => row.status),
      values: {
        confirmed: ['Confirmed', 'Accepted booking for a future stay.'],
        checked_in: ['Checked in', 'Guest in house with an occupied assigned room.'],
        checked_out: ['Checked out', 'Completed stay by the snapshot business date.'],
        cancelled: ['Cancelled', 'Booking cancelled; booked value is zero.'],
        no_show: ['No-show', 'Expected arrival did not check in; booked value is zero.'],
        pending: ['Pending', 'Unconfirmed future booking; booked value is zero.'],
      },
    },
  };

  const ENUM_DICTIONARY = (Object.keys(ENUM_OPTIONS) as EnumKey[]).map((key) => {
    const definition = enumDescriptions[key];
    return {
      key,
      label: definition.label,
      description: definition.description,
      usage: definition.usage,
      values: ENUM_OPTIONS[key].map((value) => ({
        value,
        label: definition.values[value][0],
        description: definition.values[value][1],
        count: definition.counts.filter((row) => row === value).length,
      })),
    };
  });

  return {
    schema: NETWORK_SCHEMA,
    dataDictionary: DATA_DICTIONARY,
    enumDictionary: ENUM_DICTIONARY,
  };
}

export type NetworkSchemaDescription = ReturnType<typeof buildNetworkSchema>;
