import type { Page, ReferenceDataDto } from '../domain/api.models';
import type { BookingRateHistoryDay } from '../domain/room-price-history';
import { applyRoomChange } from '../domain/room-operation-state';
import type { RoomOperationAction, RoomOperationChange } from '../domain/mutation.models';
import type { DailyRoomState, Facility, Room, RoomRate, RoomType } from '../domain/network.models';
import {
  isRateUpdateBatch,
  MAX_RATE_BATCH_UPDATES,
  rateVersion,
  type RateUpdateReviewItem,
} from '../domain/rate-batch';

/** The transport binds this reader to one authenticated user and a fixed API origin. */
export interface McpDependencies {
  read(path: string, params?: URLSearchParams): Promise<unknown>;
  allowedOrigins?: ReadonlySet<string>;
}

export type ActionCandidate =
  | {
      kind: 'rate_update';
      summary: string;
      details: RateUpdateReviewItem;
    }
  | {
      kind: 'rate_batch_update';
      summary: string;
      details: { updates: RateUpdateReviewItem[] };
    }
  | {
      kind: 'room_action';
      summary: string;
      details: {
        roomId: string;
        hotelName: string;
        roomNumber: string;
        action: RoomOperationAction;
        date: string;
      };
    };

export interface McpToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const text = { type: 'string', minLength: 1, maxLength: 64 } as const;
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
const range = { hotelId: text, from: date, to: date };
const rateUpdateProperties = {
  hotelId: text,
  roomTypeId: text,
  from: date,
  to: date,
  nightlyRate: { type: 'number', minimum: 0.01, maximum: 10000, multipleOf: 0.01 },
  reason: { type: 'string', maxLength: 240 },
  eventId: text,
} as const;
const rateUpdateRequired = ['hotelId', 'roomTypeId', 'from', 'to', 'nightlyRate'];
const pagination = {
  page: { type: 'integer', minimum: 1, maximum: 100000 },
  pageSize: { type: 'integer', minimum: 1, maximum: 100 },
};
const resources = {
  hotels: '/hotels',
  room_types: '/room-types',
  selling_rates: '/room-rates',
  rooms: '/rooms',
  room_states: '/room-states',
  reservations: '/reservations',
  reservation_nights: '/reservation-nights',
  performance_days: '/analytics/performance-days',
  booking_positions: '/analytics/booking-positions',
  channel_days: '/analytics/channel-days',
  channel_months: '/analytics/channel-months',
  cost_entries: '/cost-entries',
  monthly_costs: '/costs',
  unit_costs: '/unit-costs',
  facilities: '/facilities',
  facility_activity: '/facility-activity',
  restaurants: '/restaurants',
  events: '/events',
  event_hotel_impacts: '/event-hotel-impacts',
  reporting_periods: '/reporting-periods',
} as const;

interface ArgumentSchema {
  type: string;
  properties?: Record<string, ArgumentSchema>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: ArgumentSchema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
  pattern?: string;
  enum?: readonly unknown[];
}

function tool(
  name: string,
  description: string,
  properties: Record<string, ArgumentSchema>,
  required: string[] = [],
) {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    // All tools retrieve data or prepare proposals. None executes a domain write.
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  };
}

export const MCP_TOOLS = [
  tool(
    'get_workspace_context',
    'Start here. Get available hotels and their coordinates, reporting calendar, business/snapshot date, currency and data provenance. Today means the business date, not the system clock.',
    {},
  ),
  tool(
    'get_hotel_analytics',
    'Revenue, occupancy, ADR, RevPAR, targets, daily booking pace and booking sources for an inclusive stay-date interval. Future revenue is existing on-the-books reservations, never a forecast. Omit hotelId for all hotels.',
    range,
    ['from', 'to'],
  ),
  tool(
    'get_hotel_data',
    'Read bounded normalized hotel facts. Choose one resource and optional exact IDs or inclusive stay dates. Reservations overlap the stay interval; multi-night bookings are not new bookings per night. Selling rates are effective asking quotes, not accepted booking prices. Paginate until total is exhausted before claiming complete totals.',
    {
      resource: { type: 'string', enum: Object.keys(resources) },
      ...range,
      roomTypeId: text,
      roomId: text,
      eventId: text,
      status: { ...text, maxLength: 32 },
      stayDate: date,
      ...pagination,
    },
    ['resource'],
  ),
  tool(
    'get_room_inventory',
    'Physical rooms with current operational overrides, housekeeping and maintenance; counts reconcile available, booked, manually held and out-of-service rooms. Defaults to business date. Optional hotelId, date and roomTypeId.',
    { hotelId: text, date, roomTypeId: text },
  ),
  tool(
    'get_hotel_repair_context',
    'Get one hotel’s configured location, current business-date technical room issues, maintenance notes and facility facts before helping with repairs. Optional roomId narrows the issue scope. Includes operational overrides and explicit missing address/problem details. Configured hotel locations are not independently verified; this tool does not find providers, verify contacts, arrange repairs or change rooms. Use only trade and city/area for a public provider search, never private room notes or an exact street address.',
    { hotelId: text, roomId: text },
    ['hotelId'],
  ),
  tool(
    'get_booked_price_history',
    'Accepted nightly booking price buckets, booking-weighted average, accepted room nights and room revenue by stay date. The average is room-night revenue divided by room nights; cancelled/pending/no-show/unassigned/not-yet-booked reservations are excluded. This is NOT current selling rates.',
    { roomTypeId: text, from: date, to: date },
    ['roomTypeId', 'from', 'to'],
  ),
  tool(
    'get_warnings',
    'Dated warnings with hotel and room details. Defaults to business date; includes manual operational changes. Currently the available warning type is out-of-service rooms; an empty list does not assert that every other hotel risk is absent.',
    { hotelId: text, date, ...pagination },
  ),
  tool(
    'get_upcoming_events',
    'Upcoming/ongoing events nearest first, coordinates, importance, hotel-specific distance and assessment reasons. Data provenance is included; these are stored assessments, not verified live event listings.',
    { hotelId: text, date, ...pagination },
  ),
  tool(
    'get_data_dictionary',
    'Schema, entities, relationships, field meanings and enum values. Read when a field or business metric needs clarification.',
    {},
  ),
  tool(
    'recommend_room_price',
    'Calculate an explainable selling-rate suggestion from current effective quotes, hotel occupancy and nearby stored event assessments; include accepted booked-price history for comparison. This is a transparent heuristic, not a demand forecast or competitor-market claim. It changes nothing. Choose one hotel, room type and inclusive date interval.',
    { hotelId: text, roomTypeId: text, from: date, to: date },
    ['hotelId', 'roomTypeId', 'from', 'to'],
  ),
  tool(
    'propose_rate_update',
    'Prepare one exact room-type/range price change for user review. Never applies it. Use propose_rate_updates instead when multiple room types, hotels or date ranges are requested. Existing bookings keep accepted rates. Only prepare a change when requested, not merely for an analysis.',
    rateUpdateProperties,
    rateUpdateRequired,
  ),
  tool(
    'propose_rate_updates',
    'Prepare one combined review for 1–20 exact selling-rate changes across room types, hotels or separate inclusive date ranges. Each update sets one nightly rate for one room type/range. Ranges for the same hotel/type must not overlap. The server supplies current prices and checks all rows; nothing is applied until the user chooses Apply all in the app. Preserve every requested change; do not split a batch into separate proposals or silently omit rows. Existing bookings keep accepted rates.',
    {
      updates: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_RATE_BATCH_UPDATES,
        items: {
          type: 'object',
          properties: rateUpdateProperties,
          required: rateUpdateRequired,
          additionalProperties: false,
        },
      },
    },
    ['updates'],
  ),
  tool(
    'propose_room_action',
    'Prepare ONE room housekeeping/availability change for review, on the current business date only. Never applies it. Occupied rooms permit clean/dirty but cannot be freed, held or blocked. Reserved means a manual hold, not a guest reservation.',
    {
      roomId: text,
      action: {
        type: 'string',
        enum: ['clean', 'dirty', 'reserve', 'out_of_service', 'available', 'reset'],
      },
    },
    ['roomId', 'action'],
  ),
] as const;

export class McpInputError extends Error {}
type Args = Record<string, unknown>;

function validateArguments(value: unknown, schema: ArgumentSchema, label: string): void {
  if (schema.type === 'array') {
    if (
      !Array.isArray(value) ||
      value.length < Number(schema.minItems ?? 0) ||
      value.length > Number(schema.maxItems ?? Number.MAX_SAFE_INTEGER)
    )
      throw new McpInputError(`Invalid ${label}; choose 1–${MAX_RATE_BATCH_UPDATES} changes.`);
    for (const [index, item] of value.entries())
      validateArguments(item, schema.items!, `${label}[${index + 1}]`);
    return;
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new McpInputError(`${label} must be an object.`);
    const args = value as Args;
    for (const required of schema.required ?? [])
      if (args[required] === undefined) throw new McpInputError(`Missing ${label}.${required}.`);
    for (const [key, item] of Object.entries(args)) {
      const property = schema.properties?.[key];
      if (!property) throw new McpInputError(`Unsupported argument: ${label}.${key}.`);
      validateArguments(item, property, key);
    }
    if ((args.from === undefined) !== (args.to === undefined))
      throw new McpInputError('Provide both from and to.');
    if (args.from && args.to && String(args.from) > String(args.to))
      throw new McpInputError('from must be on or before to.');
    return;
  }
  if (schema.type === 'string') {
    if (
      typeof value !== 'string' ||
      value.length < Number(schema.minLength ?? 0) ||
      value.length > Number(schema.maxLength ?? 10000)
    )
      throw new McpInputError(`Invalid ${label}.`);
    if (schema.pattern && (!new RegExp(String(schema.pattern)).test(value) || !validDate(value)))
      throw new McpInputError(`Invalid ${label}; use a real ISO calendar date.`);
    if (Array.isArray(schema.enum) && !schema.enum.includes(value))
      throw new McpInputError(`Invalid ${label}.`);
    return;
  }
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < Number(schema.minimum) ||
    value > Number(schema.maximum) ||
    (schema.type === 'integer' && !Number.isSafeInteger(value)) ||
    (schema.multipleOf &&
      Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 0.000001)
  )
    throw new McpInputError(`Invalid ${label}.`);
}

function argumentsFor(name: string, raw: unknown): Args {
  const definition = MCP_TOOLS.find((entry) => entry.name === name);
  if (!definition)
    throw new McpInputError('Unknown tool. Use tools/list to discover available tools.');
  validateArguments(raw, definition.inputSchema, 'arguments');
  return raw as Args;
}

function validDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function params(args: Args, keys: string[], defaults: Args = {}): URLSearchParams {
  const result = new URLSearchParams();
  for (const key of keys) {
    const value = args[key] ?? defaults[key];
    if (value !== undefined) result.set(key, String(value));
  }
  return result;
}
const filterKeys = [
  'hotelId',
  'from',
  'to',
  'roomTypeId',
  'roomId',
  'eventId',
  'status',
  'stayDate',
  'page',
  'pageSize',
];
const pageDefaults = { page: 1, pageSize: 50 };
const result = (data: unknown, extra: Record<string, unknown> = {}): McpToolResult => {
  const structuredContent = { data, ...extra };
  const serialized = JSON.stringify(structuredContent);
  if (serialized.length > 80000)
    throw new McpInputError(
      'Result too large. Narrow the hotel/date filters or request a smaller page.',
    );
  return { content: [{ type: 'text', text: serialized }], structuredContent };
};

async function reference(deps: McpDependencies): Promise<ReferenceDataDto> {
  return (await deps.read('/reference-data')) as ReferenceDataDto;
}

function assertRange(context: ReferenceDataDto, args: Args): void {
  if (args.hotelId && !context.hotels.some((hotel) => hotel.id === args.hotelId))
    throw new McpInputError('Choose a valid hotel from get_workspace_context.');
  if (
    args.from &&
    (String(args.from) < context.meta.reportingPeriod.startDate ||
      String(args.to) > context.meta.reportingPeriod.endDate)
  )
    throw new McpInputError('Dates must stay within the available reporting calendar.');
  if (
    args.date &&
    (String(args.date) < context.meta.reportingPeriod.startDate ||
      String(args.date) > context.meta.reportingPeriod.endDate)
  )
    throw new McpInputError('Date must stay within the available reporting calendar.');
}

async function selectedType(
  deps: McpDependencies,
  hotelId: string,
  roomTypeId: string,
): Promise<RoomType> {
  const page = (await deps.read(
    '/room-types',
    new URLSearchParams({ hotelId, pageSize: '100' }),
  )) as Page<RoomType>;
  const type = page.items.find((row) => row.id === roomTypeId);
  if (!type) throw new McpInputError('Choose a room type belonging to the selected hotel.');
  return type;
}

async function inventory(deps: McpDependencies, args: Args, workspace?: ReferenceDataDto) {
  const context = workspace ?? (await reference(deps));
  assertRange(context, args);
  const date = String(args.date ?? context.bookingSnapshot.asOf);
  const scoped = { ...args, from: date, to: date, pageSize: 100 };
  // All four hotels total 88 rooms, below one page. Do not silently truncate a larger deployment.
  const [physical, states, changes] = await Promise.all([
    deps.read('/rooms', params(scoped, ['hotelId', 'roomTypeId', 'pageSize'])) as Promise<
      Page<Room>
    >,
    deps.read('/room-states', params(scoped, ['hotelId', 'from', 'to', 'pageSize'])) as Promise<
      Page<DailyRoomState>
    >,
    deps.read('/room-state-changes') as Promise<RoomOperationChange[]>,
  ]);
  if (physical.total > 100 || states.total > 100)
    throw new McpInputError('Inventory is too large for this tool; use paginated room facts.');
  if (physical.items.length !== physical.total || states.items.length !== states.total)
    throw new McpInputError(
      'Dated room inventory is incomplete; no inventory totals can be asserted.',
    );
  const rows = physical.items.map((room) => {
    const state = states.items.find((value) => value.roomId === room.id);
    if (!state)
      throw new McpInputError(
        'Dated room-state data is incomplete; no inventory totals can be asserted.',
      );
    const change = changes.find((value) => value.roomId === room.id && value.date === date);
    return applyRoomChange({ ...room, ...state, id: room.id, date }, change);
  });
  return {
    date,
    hotelId: args.hotelId ?? 'portfolio',
    rooms: rows,
    counts: {
      physical: rows.length,
      available: rows.filter((room) => room.status === 'available').length,
      booked: rows.filter((room) => room.status === 'occupied').length,
      held: rows.filter((room) => room.status === 'reserved').length,
      outOfService: rows.filter((room) => room.status === 'out_of_service').length,
      dirty: rows.filter((room) => room.housekeeping === 'dirty').length,
      sellable: rows.filter((room) => room.status !== 'out_of_service').length,
    },
    note: 'Manual holds are not guest bookings. Available + booked + held = sellable; out-of-service rooms are excluded.',
  };
}

async function repairContext(deps: McpDependencies, args: Args) {
  const context = await reference(deps);
  assertRange(context, args);
  const hotel = context.hotels.find((row) => row.id === args.hotelId)!;
  const current = await inventory(deps, { hotelId: hotel.id }, context);
  const requestedRoom = args.roomId
    ? current.rooms.find((room) => room.id === args.roomId)
    : undefined;
  if (args.roomId && !requestedRoom)
    throw new McpInputError('Choose a room belonging to the selected hotel.');

  const [facilities, types] = (await Promise.all([
    deps.read('/facilities', new URLSearchParams({ hotelId: hotel.id, pageSize: '100' })),
    deps.read('/room-types', new URLSearchParams({ hotelId: hotel.id, pageSize: '100' })),
  ])) as [Page<Facility>, Page<RoomType>];
  if (facilities.items.length !== facilities.total || types.items.length !== types.total)
    throw new McpInputError(
      'Repair context is too large or incomplete; use paginated hotel facts before drawing conclusions.',
    );

  // Location comes only from configured hotel facts. Missing fields must not be
  // reconstructed from the hotel name, coordinates, or a provider search result.
  const configuredAddress = hotel.address;
  const address =
    configuredAddress?.line1.trim() && configuredAddress.postalCode.trim()
      ? {
          line1: configuredAddress.line1.trim(),
          ...(configuredAddress.line2?.trim() ? { line2: configuredAddress.line2.trim() } : {}),
          postalCode: configuredAddress.postalCode.trim(),
        }
      : null;
  const roomDetail = (room: (typeof current.rooms)[number]) => {
    const type = types.items.find((row) => row.id === room.roomTypeId);
    const note = room.maintenanceNote?.trim() || null;
    return {
      roomId: room.id,
      number: room.number,
      floor: room.floor,
      roomTypeId: room.roomTypeId,
      roomTypeName: type?.name ?? null,
      roomFacilities: type?.facilities ?? [],
      status: room.status,
      housekeeping: room.housekeeping,
      maintenance: room.maintenance,
      maintenanceNote: note,
      needsProblemDescription: !note || note === 'Set out of service manually.',
    };
  };
  const scopedRooms = requestedRoom ? [requestedRoom] : current.rooms;
  const issues = scopedRooms
    .filter((room) => room.status === 'out_of_service' || room.maintenance !== 'none')
    .map(roomDetail);
  const missingInformation = [
    ...(!address ? ['Hotel street address and postal code are not configured.'] : []),
    ...issues
      .filter((room) => room.needsProblemDescription)
      .map(
        (room) =>
          `Room ${room.number}: the technical fault is not described; ask before choosing a repair trade.`,
      ),
  ];

  return {
    asOf: current.date,
    hotel: {
      id: hotel.id,
      name: hotel.name,
      city: hotel.city,
      country: hotel.country,
      countryCode: hotel.countryCode,
      coordinates: hotel.coordinates,
      address,
      addressStatus: address ? 'available' : 'missing',
      addressSource: address ? 'configured' : 'missing',
      locationProvenance: context.meta.testData
        ? 'sample_application_data'
        : 'configured_application_data',
    },
    roomScope: requestedRoom ? roomDetail(requestedRoom) : null,
    issues,
    counts: {
      hotelPhysicalRooms: current.counts.physical,
      hotelOutOfServiceRooms: current.counts.outOfService,
      scopedTechnicalIssues: issues.length,
    },
    facilities: facilities.items.map(({ id, kind, name }) => ({ id, kind, name })),
    publicSearchLocation: {
      city: hotel.city,
      country: hotel.country,
      countryCode: hotel.countryCode,
      coordinates: hotel.coordinates,
    },
    missingInformation,
    limitations: [
      ...(context.meta.testData
        ? [
            'Hotel street addresses are sample data for fictional properties; coordinates are illustrative city positions, not verified or geocoded address matches.',
          ]
        : []),
      'Hotel location and issue notes are configured application facts, not independently verified findings.',
      'A maintenance note describes the recorded problem; it does not establish a diagnosis, safety clearance, repair cost or provider availability.',
      'No provider or contact is returned by this tool. Public searches must omit exact hotel addresses, room numbers and private maintenance notes.',
      ...(issues.length
        ? []
        : ['No current technical room issues are recorded in this scope; do not invent a fault.']),
    ],
  };
}

async function rateContext(deps: McpDependencies, args: Args) {
  const context = await reference(deps);
  assertRange(context, args);
  const hotel = context.hotels.find((row) => row.id === args.hotelId)!;
  const type = await selectedType(deps, String(args.hotelId), String(args.roomTypeId));
  const rates = (await deps.read(
    '/room-rates',
    params({ ...args, pageSize: 100 }, ['hotelId', 'roomTypeId', 'from', 'to', 'pageSize']),
  )) as Page<RoomRate>;
  const days =
    Math.round((Date.parse(String(args.to)) - Date.parse(String(args.from))) / 86400000) + 1;
  if (
    rates.total !== days ||
    rates.items.length !== days ||
    new Set(rates.items.map((row) => row.date)).size !== days ||
    !rates.items.every(
      (row) =>
        row.hotelId === hotel.id &&
        row.roomTypeId === type.id &&
        row.date >= String(args.from) &&
        row.date <= String(args.to) &&
        typeof row.nightlyRate === 'number' &&
        Number.isFinite(row.nightlyRate) &&
        row.nightlyRate >= 0.01,
    )
  )
    throw new McpInputError(
      'Current dated selling rates are incomplete; no recommendation or proposal can be prepared.',
    );
  return { context, hotel, type, rates: rates.items };
}

/** A batch shares only its own authenticated read results, never data across users/requests. */
function memoizedReads(deps: McpDependencies): McpDependencies {
  const pending = new Map<string, Promise<unknown>>();
  return {
    ...deps,
    read(path, query = new URLSearchParams()) {
      const key = JSON.stringify([
        path,
        [...query.entries()].sort(([left], [right]) => left.localeCompare(right)),
      ]);
      let result = pending.get(key);
      if (!result) {
        result = deps.read(path, query);
        pending.set(key, result);
      }
      return result;
    },
  };
}

async function rateProposal(deps: McpDependencies, args: Args): Promise<RateUpdateReviewItem> {
  const { hotel, type, rates } = await rateContext(deps, args);
  if (args.eventId) {
    const events = (await deps.read(
      '/events',
      new URLSearchParams({ hotelId: hotel.id, pageSize: '100' }),
    )) as Page<{ id: string }>;
    if (
      events.total !== events.items.length ||
      !events.items.some((event) => event.id === args.eventId)
    )
      throw new McpInputError('Choose an event relevant to the selected hotel, or omit eventId.');
  }
  return {
    hotelId: hotel.id,
    roomTypeId: type.id,
    hotelName: hotel.name,
    roomTypeName: type.name,
    startDate: String(args.from),
    endDate: String(args.to),
    nightlyRate: Number(args.nightlyRate),
    ...(args.reason ? { reason: String(args.reason).trim() } : {}),
    ...(args.eventId ? { eventId: String(args.eventId) } : {}),
    currentMinRate: Math.min(...rates.map((rate) => rate.nightlyRate)),
    currentMaxRate: Math.max(...rates.map((rate) => rate.nightlyRate)),
    expectedRateVersion: rateVersion(rates),
  };
}

function assertNonOverlapping(updates: Args[]): void {
  for (let index = 0; index < updates.length; index++) {
    const left = updates[index];
    for (const right of updates.slice(index + 1))
      if (
        left.hotelId === right.hotelId &&
        left.roomTypeId === right.roomTypeId &&
        String(left.from) <= String(right.to) &&
        String(right.from) <= String(left.to)
      )
        throw new McpInputError('Date ranges for the same hotel and room type must not overlap.');
  }
}

async function batchProposal(
  deps: McpDependencies,
  updates: Args[],
): Promise<RateUpdateReviewItem[]> {
  assertNonOverlapping(updates);
  const reader = memoizedReads(deps);
  const context = await reference(reader);
  for (const update of updates) assertRange(context, update);
  const prepared: RateUpdateReviewItem[] = new Array(updates.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, updates.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= updates.length) return;
        prepared[index] = await rateProposal(reader, updates[index]);
      }
    }),
  );
  if (!isRateUpdateBatch(prepared))
    throw new McpInputError(
      'The combined price proposal is invalid. Narrow the request and try again.',
    );
  return prepared;
}

export async function callMcpTool(
  name: string,
  raw: unknown,
  deps: McpDependencies,
): Promise<McpToolResult> {
  try {
    const args = argumentsFor(name, raw ?? {});
    switch (name) {
      case 'get_workspace_context':
        return result(await reference(deps));
      case 'get_hotel_analytics': {
        const dashboard = (await deps.read(
          '/analytics/dashboard',
          params(args, ['hotelId', 'from', 'to']),
        )) as Record<string, unknown>;
        // Chart context repeats enclosing-month days outside the requested range;
        // those dates must not be mistaken for the selected interval's metrics.
        const { chartContext: _context, ...selected } = dashboard;
        return result(selected, {
          semantics:
            'Inclusive stay dates; past = actual, today/future = on the books. Booking channels count each accepted reservation once per interval.',
        });
      }
      case 'get_hotel_data': {
        const supported: Record<string, readonly string[]> = {
          roomTypeId: ['selling_rates', 'rooms', 'reservations'],
          roomId: ['room_states', 'reservations', 'reservation_nights'],
          eventId: ['event_hotel_impacts'],
          status: ['hotels', 'reservations'],
          stayDate: ['reservations'],
        };
        for (const [filter, allowed] of Object.entries(supported))
          if (args[filter] !== undefined && !allowed.includes(String(args.resource)))
            throw new McpInputError(
              `${filter} does not apply to ${args.resource}. Use a supported resource/filter pair.`,
            );
        return result(
          await deps.read(
            resources[args.resource as keyof typeof resources],
            params(args, filterKeys, pageDefaults),
          ),
        );
      }
      case 'get_room_inventory':
        return result(await inventory(deps, args));
      case 'get_hotel_repair_context':
        return result(await repairContext(deps, args));
      case 'get_booked_price_history':
        return result(
          await deps.read(
            `/room-types/${encodeURIComponent(String(args.roomTypeId))}/price-history`,
            params(args, ['from', 'to']),
          ),
        );
      case 'get_warnings':
        return result(
          await deps.read(
            '/warnings',
            params(args, ['hotelId', 'date', 'page', 'pageSize'], pageDefaults),
          ),
        );
      case 'get_upcoming_events':
        return result(
          await deps.read(
            '/events/upcoming',
            params(args, ['hotelId', 'date', 'page', 'pageSize'], pageDefaults),
          ),
        );
      case 'get_data_dictionary': {
        const dictionary = (await deps.read('/schema')) as {
          dataDictionary: unknown;
          enumDictionary: unknown;
        };
        // Fields already include types, references and enums; omit duplicate JSON Schema.
        return result({
          dataDictionary: dictionary.dataDictionary,
          enumDictionary: dictionary.enumDictionary,
        });
      }
      case 'recommend_room_price': {
        const { context, hotel, type, rates } = await rateContext(deps, args);
        const [history, dashboard, events] = await Promise.all([
          deps.read(
            `/room-types/${encodeURIComponent(type.id)}/price-history`,
            params(args, ['from', 'to']),
          ) as Promise<BookingRateHistoryDay[]>,
          deps.read('/analytics/dashboard', params(args, ['hotelId', 'from', 'to'])) as Promise<{
            outlook: { securedOccupancy: number };
            days: { date: string; roomsAvailable: number; securedRooms: number }[];
          }>,
          deps.read(
            '/events',
            params({ ...args, pageSize: 100 }, ['hotelId', 'from', 'to', 'pageSize']),
          ) as Promise<Page<{ id: string; name: string; startDate: string; endDate: string }>>,
        ]);
        const impacts = (await deps.read(
          '/event-hotel-impacts',
          params({ ...args, pageSize: 100 }, ['hotelId', 'pageSize']),
        )) as Page<{
          eventId: string;
          importance: string;
          distanceKm: number;
          reason: string;
          source: string;
        }>;
        if (events.total > events.items.length || impacts.total > impacts.items.length)
          throw new McpInputError(
            'Event context is incomplete; narrow the request before asking for a price recommendation.',
          );
        const eventRows = events.items
          .map((event) => ({
            ...event,
            impact: impacts.items.find((impact) => impact.eventId === event.id),
          }))
          .filter((event) => event.impact);
        const dailySuggestions = rates.map((rate) => {
          const day = dashboard.days.find((row) => row.date === rate.date);
          const occupancy =
            day && day.roomsAvailable > 0 ? (day.securedRooms / day.roomsAvailable) * 100 : null;
          const demandAdjustment =
            occupancy === null
              ? 0
              : occupancy >= 90
                ? 0.1
                : occupancy >= 75
                  ? 0.05
                  : occupancy < 45
                    ? -0.05
                    : 0;
          const relevant = eventRows.filter(
            (event) => event.startDate <= rate.date && event.endDate >= rate.date,
          );
          const eventAdjustment = relevant.some((event) => event.impact!.importance === 'important')
            ? 0.05
            : relevant.some((event) => event.impact!.importance === 'medium')
              ? 0.025
              : 0;
          const adjustment = Math.min(0.15, demandAdjustment + eventAdjustment);
          return {
            date: rate.date,
            currentSellingRate: rate.nightlyRate,
            suggestedSellingRate: Math.round(rate.nightlyRate * (1 + adjustment) * 100) / 100,
            adjustmentPercent: Math.round(adjustment * 1000) / 10,
            hotelBookedOccupancy: occupancy === null ? null : Math.round(occupancy * 10) / 10,
            events: relevant.map((event) => event.id),
            historicalDate: rate.date < context.bookingSnapshot.asOf,
          };
        });
        const bookedNights = history.reduce((sum, day) => sum + day.bookedRoomNights, 0);
        const bookedRevenue =
          history.reduce((sum, day) => sum + Math.round(day.bookedRevenue * 100), 0) / 100;
        return result({
          hotel: { id: hotel.id, name: hotel.name },
          roomType: { id: type.id, name: type.name },
          from: args.from,
          to: args.to,
          currency: context.meta.currency,
          amountBasis: context.meta.amountBasis,
          asOf: context.bookingSnapshot.asOf,
          method: 'Occupancy-and-event heuristic v1',
          rules:
            'Hotel booked occupancy >=90%: +10%; >=75%: +5%; <45%: -5%; otherwise 0%. Stored important event: +5%; medium: +2.5%. Combined increase capped at 15%. Apply to each current selling quote.',
          acceptedBookingEvidence: {
            roomNights: bookedNights,
            roomRevenue: bookedRevenue,
            averageNightlyPrice: bookedNights
              ? Math.round((bookedRevenue / bookedNights) * 100) / 100
              : null,
          },
          events: eventRows,
          days: dailySuggestions,
          limitations: [
            'No competitor rates, booking elasticity or live demand data are available.',
            'This is a reviewable suggestion, not a forecast or guaranteed revenue uplift.',
            'Existing accepted reservation prices remain unchanged.',
            'Historical dates are for analysis; changing their asking quotes does not alter settled revenue.',
          ],
        });
      }
      case 'propose_rate_update': {
        const details = await rateProposal(deps, args);
        const actionCandidate: ActionCandidate = {
          kind: 'rate_update',
          summary: `Set ${details.hotelName} · ${details.roomTypeName} to €${details.nightlyRate.toFixed(2)} per night, ${details.startDate} through ${details.endDate}.`,
          details,
        };
        return result(
          {
            requiresConfirmation: true,
            applied: false,
            currentMinRate: details.currentMinRate,
            currentMaxRate: details.currentMaxRate,
            note: 'No rate changed. Review the proposal and explicitly confirm it in the app. Existing bookings keep accepted rates.',
          },
          { actionCandidate },
        );
      }
      case 'propose_rate_updates': {
        const updates = await batchProposal(deps, args.updates as Args[]);
        const typeCount = new Set(updates.map((row) => row.roomTypeId)).size;
        const hotelCount = new Set(updates.map((row) => row.hotelId)).size;
        const actionCandidate: ActionCandidate = {
          kind: 'rate_batch_update',
          summary: `Update ${updates.length} price ${updates.length === 1 ? 'change' : 'changes'} across ${typeCount} room ${typeCount === 1 ? 'type' : 'types'}${hotelCount > 1 ? ` and ${hotelCount} hotels` : ''}.`,
          details: { updates },
        };
        return result(
          {
            requiresConfirmation: true,
            applied: false,
            changes: updates.length,
            note: 'No rate changed. All listed changes are one reviewable batch. Apply all or cancel in the app; execution is atomic and current prices are rechecked. Existing bookings keep accepted rates.',
          },
          { actionCandidate },
        );
      }
      case 'propose_room_action': {
        const context = await reference(deps);
        const room = (await deps.read(
          `/rooms/${encodeURIComponent(String(args.roomId))}/state`,
        )) as Room & { status: string };
        const action = args.action as RoomOperationAction;
        if (
          room.status === 'occupied' &&
          ['reserve', 'out_of_service', 'available'].includes(action)
        )
          throw new McpInputError(
            'This room has a booking today. Move the booking before changing availability.',
          );
        if (action === 'reserve' && room.status === 'out_of_service')
          throw new McpInputError('Return this room to service before reserving it.');
        const hotel = context.hotels.find((value) => value.id === room.hotelId);
        if (!hotel || room.id !== args.roomId) throw new McpInputError('Room not found.');
        const actionCandidate: ActionCandidate = {
          kind: 'room_action',
          summary: `${hotel.name} · room ${room.number}: ${action.replaceAll('_', ' ')}.`,
          details: {
            roomId: room.id,
            hotelName: hotel.name,
            roomNumber: room.number,
            action,
            date: context.bookingSnapshot.asOf,
          },
        };
        return result(
          {
            requiresConfirmation: true,
            applied: false,
            currentRoom: room,
            note: 'No room changed. The application must stage this proposal and obtain explicit user confirmation. Availability is revalidated when applying.',
          },
          { actionCandidate },
        );
      }
      default:
        throw new McpInputError('Unknown tool.');
    }
  } catch (error) {
    // Never echo request URLs, authorization, SQL errors or upstream response bodies.
    const message =
      error instanceof McpInputError
        ? error.message
        : 'The hotel API could not complete this tool. Retry or narrow the request; do not infer missing values.';
    return { content: [{ type: 'text', text: message }], isError: true };
  }
}
