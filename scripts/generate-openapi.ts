import { writeFileSync } from 'node:fs';
import { NETWORK_SCHEMA } from '../src/app/core/network.schema';
import { RESOURCE_PATHS } from '../src/app/core/api/resource-paths';

type Schema = Record<string, unknown>;
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const array = (name: string): Schema => ({ type: 'array', items: ref(name) });
const text = (description?: string): Schema => ({
  type: 'string',
  ...(description ? { description } : {}),
});
const opaque = (): Schema => ({
  type: 'string',
  minLength: 1,
  description: 'Opaque identifier. Do not infer meaning from its format.',
});
const date = (): Schema => ({ type: 'string', format: 'date' });
const timestamp = (): Schema => ({ type: 'string', format: 'date-time' });
const number = (minimum?: number): Schema => ({
  type: 'number',
  ...(minimum === undefined ? {} : { minimum }),
});
const integer = (minimum = 0): Schema => ({ type: 'integer', minimum });
const object = (
  properties: Record<string, Schema>,
  required = Object.keys(properties),
): Schema => ({ type: 'object', properties, required, additionalProperties: false });

/** Reuse field contracts without baking the current fixture's IDs/calendar/counts into the API. */
function generalize(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((item) => generalize(item, key));
  if (!value || typeof value !== 'object')
    return typeof value === 'string'
      ? value.replaceAll('#/$defs/', '#/components/schemas/')
      : value;
  const original = value as Schema;
  const result: Schema = Object.fromEntries(
    Object.entries(original).map(([name, item]) => [name, generalize(item, name)]),
  );
  delete result.$schema;
  delete result.$id;
  delete result.minItems;
  delete result.maxItems;
  const choices = original.enum;
  if (
    Array.isArray(choices) &&
    choices.some((item) => typeof item === 'string' && item.startsWith('dev-'))
  ) {
    delete result.enum;
    result.minLength = 1;
    result.description = 'Opaque Hotel.id foreign key.';
  }
  if (
    Array.isArray(choices) &&
    choices.length &&
    choices.every((item) => typeof item === 'string' && /^\d{4}-\d{2}$/.test(item))
  ) {
    delete result.enum;
    result.pattern = '^[0-9]{4}-(0[1-9]|1[0-2])$';
    result.description = 'Reporting month, YYYY-MM. Availability comes from reference data.';
  }
  if (key === 'testData') delete result.const;
  if (result.const === 'development_aggregated_pms_positions') {
    delete result.const;
    result.description = 'Source system or aggregation provenance.';
  }
  if (key === 'openedYear') delete result.maximum;
  if (key === 'guestRef') delete result.pattern;
  if (key === 'reportingPeriod' || key === 'period') {
    if (typeof result.description === 'string' && /quarter|2026/.test(result.description))
      result.description = 'Covered reporting interval. Bounds are supplied by reference data.';
  }
  if (typeof result.description === 'string')
    result.description = result.description
      .replace(
        'including vacant and out-of-service dates in the quarter',
        'including vacant and out-of-service dates',
      )
      .replace('Generated event name; not a verified live event listing.', 'Event name.')
      .replace('Venue used by the generated event.', 'Event venue.')
      .replace(
        'Illustrative expected attendance, not measured attendance.',
        'Expected attendance, not measured attendance.',
      )
      .replace('within the covered quarter', 'within the available reporting calendar')
      .replace('across the full covered quarter', 'across the available reporting calendar')
      .replace('Number of stay dates in the quarter.', 'Number of covered stay dates.');
  return result;
}
const schemas = generalize(NETWORK_SCHEMA.$defs) as Record<string, Schema>;
const networkProperties = generalize(NETWORK_SCHEMA.properties) as Record<string, Schema>;
const collectionDescriptions: Record<string, string> = {
  reportingPeriods: 'Available reporting months, each with its calendar range.',
  dailyRoomStates: 'Dated room states, including vacant and out-of-service dates.',
  dailyFacilityActivity:
    'Dated facility use, including zero-use days; actual and planned activity are separate.',
  hotels: 'Authorized hotel properties with WGS84 locations.',
  roomRates:
    'Dated selling quotes by room type. Selling-rate updates do not alter accepted booked rates.',
  rooms: 'Physical rooms and their operational snapshot, derived from daily states.',
  dailyPerformance:
    'Dated hotel performance, reconciled to reservation nights and facility activity.',
  reservations:
    'Stays and their workflow status, including excluded reservations for prior-snapshot reconstruction.',
  bookingPositions:
    'Stay-date actuals and current/prior booking aggregates, captured at the business snapshot date.',
};
for (const [key, description] of Object.entries(collectionDescriptions))
  networkProperties[key].description = description;
schemas.NetworkExport = object(networkProperties);
schemas.DateRange = object({ startDate: date(), endDate: date() });
schemas.ReportingMonth = { type: 'string', pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$' };
schemas.User = object({ name: text(), email: { type: 'string', format: 'email' } });
schemas.Session = object({
  user: ref('User'),
  token: {
    type: 'string',
    minLength: 1,
    description:
      'Opaque bearer credential returned by HTTP sign-in. Never log it or place it in a URL.',
  },
});
schemas.CurrentSession = object({ user: ref('User') });
schemas.CreateSession = object(
  {
    email: { type: 'string', format: 'email', maxLength: 254 },
    password: { type: 'string', format: 'password', minLength: 8, maxLength: 256, writeOnly: true },
    remember: { type: 'boolean', default: false },
  },
  ['email', 'password'],
);
schemas.ApiProblem = object(
  {
    type: { type: 'string', format: 'uri-reference' },
    title: text(),
    status: integer(100),
    detail: text(),
    code: text(),
    errors: { type: 'object', additionalProperties: { type: 'string' } },
  },
  ['type', 'title', 'status', 'detail', 'code'],
);
schemas.ReferenceData = object({
  meta: ref('NetworkMeta'),
  bookingSnapshot: ref('BookingSnapshot'),
  hotels: { ...array('Hotel'), minItems: 1 },
  reportingPeriods: { ...array('ReportingPeriod'), minItems: 1 },
  dates: {
    type: 'array',
    minItems: 1,
    items: date(),
    description:
      'Ordered available dates. All date queries must remain within these metadata bounds.',
  },
});
schemas.RoomOperationChange = object(
  {
    roomId: opaque(),
    date: date(),
    housekeeping: { type: 'string', enum: ['clean', 'dirty', 'inspected'] },
    status: { type: 'string', enum: ['available', 'reserved', 'out_of_service'] },
    appliedAt: timestamp(),
  },
  ['roomId', 'date', 'appliedAt'],
);
schemas.RoomStatePatch = object({
  action: {
    type: 'string',
    enum: ['clean', 'dirty', 'reserve', 'out_of_service', 'available', 'reset'],
    description:
      'Changes current-business-date state only. DELETE is the preferred reset operation.',
  },
});
schemas.ManagedRoom = object({
  ...(schemas.Room.properties as Record<string, Schema>),
  status: { type: 'string', enum: ['available', 'occupied', 'reserved', 'out_of_service'] },
  hasChanges: { type: 'boolean' },
});
schemas.Warning = object({ room: ref('ManagedRoom'), hotel: ref('Hotel') });
schemas.UpcomingEvent = object({
  event: ref('HotelEvent'),
  impacts: {
    type: 'array',
    items: object({
      ...(schemas.EventHotelImpact.properties as Record<string, Schema>),
      hotel: ref('Hotel'),
    }),
  },
  importance: { type: 'string', enum: ['mild', 'medium', 'important'] },
});
schemas.RoomRateUpdate = object(
  {
    hotelId: opaque(),
    roomTypeId: opaque(),
    startDate: date(),
    endDate: date(),
    nightlyRate: { type: 'number', minimum: 0.01, maximum: 10000, multipleOf: 0.01 },
    eventId: { type: ['string', 'null'] },
    reason: { type: 'string', maxLength: 240 },
  },
  ['hotelId', 'roomTypeId', 'startDate', 'endDate', 'nightlyRate'],
);
schemas.RoomRateChange = object(
  {
    ...(schemas.RoomRateUpdate.properties as Record<string, Schema>),
    id: opaque(),
    appliedAt: timestamp(),
  },
  ['hotelId', 'roomTypeId', 'startDate', 'endDate', 'nightlyRate', 'id', 'appliedAt'],
);
schemas.BookingPriceBucket = object({ nightlyRate: number(0), roomNights: integer(1) });
schemas.BookingRateHistoryDay = object({
  date: date(),
  weightedRate: { type: ['number', 'null'], minimum: 0 },
  bookedRoomNights: integer(),
  bookedRevenue: number(0),
  rateCount: integer(),
  priceBuckets: array('BookingPriceBucket'),
});
schemas.BookingSource = object({
  channel: { type: 'string', enum: ['direct', 'ota', 'corporate', 'wholesale'] },
  label: text(),
  bookings: integer(),
  roomNights: integer(),
  roomRevenue: number(0),
  share: { type: 'number', minimum: 0, maximum: 100 },
});
schemas.BookingPaceDay = object({
  date: date(),
  state: { type: 'string', enum: ['past', 'today', 'future'] },
  ...Object.fromEntries(
    'roomsAvailable actualRooms actualRevenue onBooksRooms onBooksRevenue securedRooms securedRevenue targetRooms targetRevenue remainingTargetRooms remainingTargetRevenue pickup7dRooms pickup7dRevenue'
      .split(' ')
      .map((key) => [key, number()]),
  ),
});
schemas.BookingPeriod = object(
  {
    startDate: date(),
    endDate: date(),
    days: integer(1),
    label: text(),
    key: ref('ReportingMonth'),
  },
  ['startDate', 'endDate', 'days', 'label'],
);
schemas.BookingOutlook = object({
  asOf: date(),
  previousAsOf: date(),
  period: ref('BookingPeriod'),
  ...Object.fromEntries(
    'realizedRevenue onBooksRevenue totalSecuredRevenue targetRevenue securedRooms availableRooms targetRooms securedOccupancy targetOccupancy securedADR targetADR securedRevPAR targetRevPAR actualAvailableRooms actualSoldRooms futureAvailableRooms futureBookedRooms realizedOccupancy onBooksOccupancy realizedADR onBooksADR remainingRooms remainingTargetRooms remainingTargetRevenue targetGapRevenue sevenDayPickupRevenue sevenDayPickupRooms todayRevenue todayRooms'
      .split(' ')
      .map((key) => [key, number()]),
  ),
});
schemas.BookingChartContext = object({
  rows: array('BookingPaceDay'),
  range: ref('DateRange'),
  windowSize: integer(),
  startIndex: integer(),
  endIndex: { type: 'integer' },
  scrollable: { type: 'boolean' },
});
schemas.Dashboard = object({
  outlook: ref('BookingOutlook'),
  days: array('BookingPaceDay'),
  chartContext: ref('BookingChartContext'),
  bookingSources: array('BookingSource'),
  hotels: { type: 'array', items: object({ hotel: ref('Hotel'), outlook: ref('BookingOutlook') }) },
});
schemas.Insight = object(
  {
    title: text(),
    summary: text(),
    metrics: { type: 'array', items: object({ label: text(), value: text(), change: text() }) },
    chart: {
      type: 'array',
      items: object({ label: text(), value: number(), comparison: number() }),
    },
    chartTitle: text(),
    chartUnit: { type: 'string', enum: ['percent', 'currency'] },
    chartSeries: object({ value: text(), comparison: text() }),
    reportingPeriod: text(),
    recommendation: text(),
    sources: { type: 'array', items: text() },
  },
  ['title', 'summary', 'metrics', 'recommendation', 'sources'],
);
const actionBase = {
  id: opaque(),
  status: { type: 'string', enum: ['pending', 'applied', 'cancelled'] },
  summary: text(),
};
schemas.RateUpdateReviewItem = object(
  {
    ...(schemas.RoomRateUpdate.properties as Record<string, Schema>),
    hotelName: text(),
    roomTypeName: text(),
    currentMinRate: { ...number(), minimum: 0.01, maximum: 10000 },
    currentMaxRate: { ...number(), minimum: 0.01, maximum: 10000 },
    expectedRateVersion: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  },
  [
    'hotelId',
    'roomTypeId',
    'startDate',
    'endDate',
    'nightlyRate',
    'hotelName',
    'roomTypeName',
    'currentMinRate',
    'currentMaxRate',
    'expectedRateVersion',
  ],
);
schemas.ChatAction = {
  oneOf: [
    object({
      ...actionBase,
      kind: { type: 'string', const: 'rate_batch_update' },
      details: object({
        updates: { type: 'array', minItems: 1, maxItems: 20, items: ref('RateUpdateReviewItem') },
      }),
    }),
    object({
      ...actionBase,
      kind: { type: 'string', const: 'rate_update' },
      details: object(
        {
          ...(schemas.RateUpdateReviewItem.properties as Record<string, Schema>),
        },
        [
          'hotelId',
          'roomTypeId',
          'startDate',
          'endDate',
          'nightlyRate',
          'hotelName',
          'roomTypeName',
        ],
      ),
    }),
    object({
      ...actionBase,
      kind: { type: 'string', const: 'room_action' },
      details: object({
        roomId: opaque(),
        hotelName: text(),
        roomNumber: text(),
        action: (schemas.RoomStatePatch.properties as Record<string, Schema>).action,
        date: date(),
      }),
    }),
  ],
  description:
    'A server-staged proposal. The model cannot apply it. An explicit authenticated decision applies or cancels the exact stored details; accepted booking prices remain immutable.',
};
schemas.WebSource = object({
  url: { type: 'string', format: 'uri', pattern: '^https?://', maxLength: 2048 },
  title: { type: 'string', minLength: 1, maxLength: 300 },
});
schemas.WebCitation = object({
  ...(schemas.WebSource.properties as Record<string, Schema>),
  startIndex: { ...integer(), description: 'Inclusive UTF-16 offset in message content.' },
  endIndex: { ...integer(1), description: 'Exclusive UTF-16 offset in message content.' },
});
schemas.Message = object(
  {
    id: opaque(),
    role: { type: 'string', enum: ['user', 'assistant'] },
    content: text(),
    insight: ref('Insight'),
    action: ref('ChatAction'),
    citations: { ...array('WebCitation'), maxItems: 64 },
    webSources: { ...array('WebSource'), maxItems: 32 },
    createdAt: timestamp(),
  },
  ['id', 'role', 'content', 'createdAt'],
);
schemas.Conversation = object(
  {
    id: opaque(),
    title: text(),
    messages: array('Message'),
    updatedAt: timestamp(),
    propertyId: opaque(),
    month: ref('ReportingMonth'),
    roomDate: date(),
    dataVersion: text(),
  },
  ['id', 'title', 'messages', 'updatedAt'],
);
schemas.CreateConversation = object({
  title: { type: 'string', minLength: 1, maxLength: 100 },
  propertyId: {
    type: 'string',
    minLength: 1,
    description: 'Opaque hotel ID or the portfolio selection token.',
  },
  month: ref('ReportingMonth'),
  roomDate: date(),
});
schemas.ChatContext = object({
  propertyId: text(
    'Opaque hotel ID or portfolio. Query scope within the authorized shared workspace.',
  ),
  startDate: date(),
  endDate: date(),
});
schemas.SendMessage = object(
  {
    content: { type: 'string', minLength: 1, maxLength: 4000 },
    context: ref('ChatContext'),
  },
  ['content'],
);
schemas.ChatActionDecision = object({ decision: { type: 'string', enum: ['apply', 'cancel'] } });
schemas.DictionaryField = object(
  {
    name: text(),
    type: text(),
    description: text(),
    required: { type: 'boolean' },
    reference: text(),
    enum: { type: 'array', items: text() },
  },
  ['name', 'type', 'description', 'required'],
);
schemas.DictionaryEntity = object({
  key: text(),
  name: text(),
  description: text(),
  rowCount: integer(),
  fields: array('DictionaryField'),
});
schemas.EnumDictionary = object({
  key: text(),
  label: text(),
  description: text(),
  usage: text(),
  values: {
    type: 'array',
    items: object({ value: text(), label: text(), description: text(), count: integer() }),
  },
});
schemas.SchemaDescription = object({
  schema: {
    type: 'object',
    additionalProperties: true,
    description:
      'JSON Schema of the current canonical export; may include fixture-specific constraints in mock mode.',
  },
  dataDictionary: array('DictionaryEntity'),
  enumDictionary: array('EnumDictionary'),
});
const param = (
  name: string,
  schema: Schema,
  description: string,
  location = 'query',
  required = false,
): Schema => ({ name, in: location, required, description, schema });
const hotel = param(
  'hotelId',
  opaque(),
  'Omit for all authorized hotels; otherwise filter to one opaque hotel ID.',
);
const from = param(
  'from',
  date(),
  'Inclusive first stay/reporting date. Supply together with to; must be within reference-data bounds.',
);
const to = param('to', date(), 'Inclusive last stay/reporting date; must be on or after from.');
const businessDate = param(
  'date',
  date(),
  'Defaults to bookingSnapshot.asOf. Must be within the reporting calendar.',
);
const pagination = [
  param(
    'page',
    { type: 'integer', minimum: 1, maximum: 100000, default: 1 },
    'One-based page number.',
  ),
  param(
    'pageSize',
    { type: 'integer', minimum: 1, maximum: 1000, default: 50 },
    'Maximum rows per page. Cache loaders request 500.',
  ),
];
const response = (schema?: Schema, description = 'Successful response', status = 200): Schema => ({
  description,
  ...(schema ? { content: { 'application/json': { schema } } } : {}),
  ...(status === 201
    ? {
        headers: {
          Location: {
            description: 'URI of the created resource when supplied by this endpoint.',
            schema: { type: 'string' },
          },
        },
      }
    : {}),
});
const errorResponse = (code: number): Schema => ({
  description:
    (
      {
        400: 'Invalid filter, date or pagination.',
        401: 'No authenticated session.',
        403: 'Browser origin is not allowed.',
        404: 'Resource not found.',
        405: 'Method not allowed. The Allow header lists supported methods.',
        409: 'State conflict; no change committed.',
        413: 'Request body or bounded history is too large.',
        415: 'Send an application/json request body.',
        422: 'Invalid request body; no change committed.',
        429: 'Sign-in or chat rate limit, or exhausted upstream quota. Retry-After gives a delay when available; quota errors require account configuration.',
        500: 'Unexpected API failure.',
        502: 'Upstream model failure or incomplete answer. No fabricated fallback answer is returned.',
        503: 'Persistence or service temporarily unavailable. A failed response can occur after commit; refresh state before manually retrying a write.',
        504: 'Upstream chat deadline exceeded.',
      } as Record<number, string>
    )[code] ?? 'Request failed.',
  headers:
    code === 405
      ? { Allow: { schema: text(), description: 'Comma-separated supported HTTP methods.' } }
      : code === 429
        ? {
            'Retry-After': {
              schema: { type: 'integer', minimum: 1 },
              description: 'Seconds before retrying.',
            },
          }
        : undefined,
  content: { 'application/problem+json': { schema: ref('ApiProblem') } },
});
const op = (
  id: string,
  summary: string,
  body: Schema | undefined,
  result: Schema | undefined,
  status = 200,
  codes = [400, 401, 404, 405, 500, 503],
): Schema => ({
  operationId: id,
  summary,
  ...(body
    ? { requestBody: { required: true, content: { 'application/json': { schema: body } } } }
    : {}),
  responses: {
    [status]: response(
      result,
      status === 204 ? 'Deleted; no response body.' : 'Successful response.',
      status,
    ),
    ...Object.fromEntries(
      [...new Set([...codes, 403, 503, ...(body ? [400, 413, 415] : [])])].map((code) => [
        String(code),
        errorResponse(code),
      ]),
    ),
  },
});
const paths: Record<string, Record<string, unknown>> = {};
schemas.Health = object({ status: { type: 'string', enum: ['ok'] }, service: text() }, ['status']);
paths['/health'] = {
  servers: [{ url: 'https://api-juyo.cristiansarghe.com' }, { url: 'http://127.0.0.1:8788' }],
  get: {
    ...op(
      'getHealth',
      'Check API process availability without querying SQL',
      undefined,
      ref('Health'),
      200,
      [],
    ),
    security: [],
    description:
      'Unversioned HTTP runtime endpoint; not implemented by the browser-local mock. A healthy process does not guarantee database availability.',
  },
};
const definitions: Record<string, string> = {
  hotels: 'Hotel',
  events: 'HotelEvent',
  eventHotelImpacts: 'EventHotelImpact',
  roomTypes: 'RoomType',
  roomRates: 'RoomRate',
  rooms: 'Room',
  facilities: 'Facility',
  restaurants: 'Restaurant',
  costs: 'MonthlyCost',
  unitCosts: 'UnitCost',
  channels: 'ChannelPerformance',
  dailyPerformance: 'DailyPerformance',
  reservations: 'Reservation',
  bookingPositions: 'BookingPosition',
  reportingPeriods: 'ReportingPeriod',
  dailyRoomStates: 'DailyRoomState',
  dailyCosts: 'DailyCost',
  dailyChannels: 'DailyChannel',
  reservationNights: 'ReservationNight',
  dailyFacilityActivity: 'DailyFacilityActivity',
};
const dated = new Set([
  'events',
  'roomRates',
  'rooms',
  'costs',
  'channels',
  'dailyPerformance',
  'reservations',
  'bookingPositions',
  'dailyRoomStates',
  'dailyCosts',
  'dailyChannels',
  'reservationNights',
  'dailyFacilityActivity',
]);
for (const [collection, path] of Object.entries(RESOURCE_PATHS)) {
  const definition = definitions[collection];
  const pageName = `${definition}Page`;
  schemas[pageName] = object({
    items: array(definition),
    page: integer(1),
    pageSize: integer(1),
    total: integer(),
  });
  const parameters: Schema[] = [...pagination];
  if (collection !== 'reportingPeriods') parameters.push(hotel);
  if (dated.has(collection)) parameters.push(from, to);
  if (['roomRates', 'rooms', 'reservations'].includes(collection))
    parameters.push(
      param('roomTypeId', opaque(), 'Filter records with this room-type foreign key.'),
    );
  if (['dailyRoomStates', 'reservationNights'].includes(collection))
    parameters.push(param('roomId', opaque(), 'Filter by assigned room ID.'));
  if (collection === 'eventHotelImpacts')
    parameters.push(param('eventId', opaque(), 'Filter by event ID.'));
  if (['hotels', 'reservations'].includes(collection))
    parameters.push(param('status', text(), 'Filter by the resource status enum.'));
  if (collection === 'reservations')
    parameters.push(
      param('stayDate', date(), 'Stays covering this date: arrival <= stayDate < departure.'),
    );
  if (collection === 'roomRates')
    parameters.push(
      param(
        'basis',
        { type: 'string', enum: ['canonical'] },
        'Omit for effective quotes including applied selling-rate changes. canonical returns immutable seeded/base quotes.',
      ),
    );
  paths[path] = {
    get: {
      ...op(`list${definition}`, `List ${collection}`, undefined, ref(pageName)),
      parameters,
      description:
        'Stable source order with a typed page envelope. from/to uses inclusive dates; reservations/events overlap the selection, monthly records use enclosing months. Unsupported query names are rejected.',
    },
  };
  if ((schemas[definition].properties as Record<string, Schema>)?.id) {
    paths[`${path}/{id}`] = {
      parameters: [param('id', opaque(), 'Opaque resource identifier.', 'path', true)],
      get: op(`get${definition}`, `Get one ${definition}`, undefined, ref(definition)),
    };
  }
}
paths['/reference-data'] = {
  get: op(
    'getReferenceData',
    'Get current workspace metadata and available calendar',
    undefined,
    ref('ReferenceData'),
  ),
};
paths['/schema'] = {
  get: op(
    'getSchema',
    'Get canonical export schema and data dictionary',
    undefined,
    ref('SchemaDescription'),
  ),
};
paths['/exports/network'] = {
  get: op(
    'exportNetwork',
    'Export immutable canonical network data',
    undefined,
    ref('NetworkExport'),
  ),
};
paths['/sessions'] = {
  post: {
    ...op(
      'createSession',
      'Sign in',
      ref('CreateSession'),
      ref('Session'),
      201,
      [401, 405, 422, 429, 500],
    ),
    security: [],
    description:
      'HTTP mode compares email/password directly with a backend-only hardcoded demo account catalog, checks its provisioned enabled SQL identity, and returns an opaque bearer token. Demo passwords are plaintext test values; login performs no password hashing. The catalog is never returned or bundled into Angular. The explicit browser-local mock accepts local credential formatting and returns CurrentSession without issuing a bearer token.',
  },
};
paths['/sessions/current'] = {
  get: op('getSession', 'Restore the current session', undefined, ref('CurrentSession')),
  delete: {
    ...op('deleteSession', 'Sign out', undefined, undefined, 204, [405, 500]),
    security: [],
    description:
      'Idempotently deletes the supplied bearer session, including absent/expired tokens. Mock mode clears its local session. No cookies are used.',
  },
};
paths['/room-state-changes'] = {
  get: op(
    'listRoomStateChanges',
    'Get current-day room state overlays',
    undefined,
    array('RoomOperationChange'),
    200,
    [400, 401, 404, 405, 413, 500],
  ),
};
paths['/rooms/{roomId}/state'] = {
  parameters: [param('roomId', opaque(), 'Opaque physical-room identifier.', 'path', true)],
  get: {
    ...op(
      'getRoomState',
      'Get dated room state including current overlay',
      undefined,
      ref('ManagedRoom'),
    ),
    parameters: [businessDate],
  },
  patch: {
    ...op(
      'patchRoomState',
      'Apply one current-day room operation',
      ref('RoomStatePatch'),
      array('RoomOperationChange'),
      200,
      [401, 404, 405, 409, 422, 500, 503],
    ),
    description:
      'Returns the complete operational overlay only after a successful commit. Occupied rooms cannot be reserved, blocked or made free while booked. Manual reservation is a hold, not a guest booking.',
  },
  delete: {
    ...op(
      'resetRoomState',
      'Reset local/manual changes for this room',
      undefined,
      array('RoomOperationChange'),
      200,
      [401, 404, 405, 409, 500, 503],
    ),
    description:
      'Returns the complete remaining overlay, including an empty array when all manual changes have been reset.',
  },
};
paths['/rate-updates'] = {
  get: op(
    'listRateUpdates',
    'Get chronological selling-rate update history',
    undefined,
    array('RoomRateChange'),
    200,
    [400, 401, 404, 405, 413, 500],
  ),
  post: {
    ...op(
      'createRateUpdate',
      'Create an inclusive interval selling-rate update',
      ref('RoomRateUpdate'),
      ref('RoomRateChange'),
      201,
      [401, 405, 422, 500, 503],
    ),
    description:
      'Later applications win on overlapping dates. Optional event/reason is context only. Existing reservation-night prices and revenue are unchanged.',
  },
};
paths['/rate-updates/{rateUpdateId}'] = {
  parameters: [
    param(
      'rateUpdateId',
      opaque(),
      'Opaque rate-update identifier returned by POST.',
      'path',
      true,
    ),
  ],
  get: op('getRateUpdate', 'Get one applied selling-rate update', undefined, ref('RoomRateChange')),
};
paths['/warnings'] = {
  get: {
    ...op(
      'listWarnings',
      'List scoped current or dated room warnings',
      undefined,
      ref('WarningPage'),
    ),
    parameters: [hotel, businessDate, ...pagination],
  },
};
schemas.WarningPage = object({
  items: array('Warning'),
  page: integer(1),
  pageSize: integer(1),
  total: integer(),
});
paths['/events/upcoming'] = {
  get: {
    ...op(
      'listUpcomingEvents',
      'List relevant ongoing and upcoming events',
      undefined,
      ref('UpcomingEventPage'),
    ),
    parameters: [hotel, businessDate, ...pagination],
    description:
      'Unique events, ongoing first then nearest future start date; each includes relevant hotel assessments and straight-line distances.',
  },
};
schemas.UpcomingEventPage = object({
  items: array('UpcomingEvent'),
  page: integer(1),
  pageSize: integer(1),
  total: integer(),
});
paths['/analytics/dashboard'] = {
  get: {
    ...op('getDashboard', 'Get scoped stay-date dashboard aggregates', undefined, ref('Dashboard')),
    parameters: [hotel, from, to],
    description:
      'Defaults to the business-date month. Bookings are distinct accepted reservations with nights in the inclusive interval; revenue/occupancy are based on selected stay dates. Period chart context includes enclosing full months without adding outside days to totals. Hotel comparison rows intentionally cover the full organization.',
  },
};
paths['/room-types/{roomTypeId}/price-history'] = {
  parameters: [param('roomTypeId', opaque(), 'Opaque room-type identifier.', 'path', true)],
  get: {
    ...op(
      'getBookedPriceHistory',
      'Get accepted-booking nightly price history',
      undefined,
      array('BookingRateHistoryDay'),
    ),
    parameters: [from, to],
    description:
      'Defaults to the full reporting calendar. Weighted rate = accepted nightly revenue / accepted booked room nights. Dates without bookings have null averages and no buckets. Selling-rate changes do not affect this endpoint.',
  },
};
paths['/conversations'] = {
  get: {
    ...op(
      'listConversations',
      'List stored conversation history',
      undefined,
      array('Conversation'),
    ),
    description: 'Current bounded history: at most 30 conversations, newest updated first.',
  },
  post: op(
    'createConversation',
    'Create a conversation for a hotel/reporting context',
    ref('CreateConversation'),
    ref('Conversation'),
    201,
    [401, 405, 422, 500],
  ),
};
paths['/conversations/{conversationId}'] = {
  parameters: [param('conversationId', opaque(), 'Opaque conversation identifier.', 'path', true)],
  get: op('getConversation', 'Get one conversation', undefined, ref('Conversation')),
  delete: op(
    'deleteConversation',
    'Delete one conversation',
    undefined,
    undefined,
    204,
    [401, 404, 405, 500],
  ),
};
paths['/conversations/{conversationId}/messages'] = {
  parameters: [param('conversationId', opaque(), 'Opaque conversation identifier.', 'path', true)],
  post: {
    ...op(
      'sendMessage',
      'Append a question and generated assistant answer',
      ref('SendMessage'),
      ref('Conversation'),
      201,
      [401, 404, 405, 422, 429, 500, 502, 503, 504],
    ),
    description:
      'Returns the updated user-owned conversation with the user message and OpenAI answer grounded through authenticated MCP tools. Optional context carries the current hotel and inclusive dashboard interval; explicit dates in the question do not alter global UI filters. A proposed change is stored as Message.action and needs a separate decision. The pair commits atomically and history retains at most 100 messages. The explicit offline mock returns deterministic fixture answers. Stop unsubscribes the client request; the server may already have accepted it. Chat uses a bounded 90-second client timeout and receives no automatic retry.',
  },
};
paths['/conversations/{conversationId}/actions/{actionId}'] = {
  parameters: [
    param('conversationId', opaque(), 'User-owned conversation identifier.', 'path', true),
    param('actionId', opaque(), 'Stored assistant proposal identifier.', 'path', true),
  ],
  post: {
    ...op(
      'decideChatAction',
      'Apply or cancel an exact stored assistant proposal',
      ref('ChatActionDecision'),
      ref('Conversation'),
      200,
      [401, 404, 405, 409, 422, 500, 503],
    ),
    description:
      'Requires the conversation owner and an explicit user decision. Applies the stored rate or room action in the same transaction as its status change. Repeating the same decision returns the existing result without another write; an opposite decision returns 409 CHAT_ACTION_ALREADY_DECIDED. Room changes reject stale business dates and occupied-room conflicts. The client refreshes the corresponding operational overlay after a successful apply. This endpoint is not implemented by the explicit offline fixture adapter.',
  },
};
const api = {
  openapi: '3.1.0',
  info: {
    title: 'Juyo hotel network API',
    version: '1.0.0',
    description:
      'SQL-backed REST API for a locally served Angular frontend. HTTP uses opaque bearer sessions; canonical hotel facts remain immutable. IDs are opaque and available dates/business date come from reference data. Explicit mock mode simulates this boundary in the browser, with CurrentSession instead of a bearer token at sign-in.',
  },
  servers: [
    {
      url: 'https://api-juyo.cristiansarghe.com/api/v1',
      description: 'Configured Cloudflare Worker API endpoint; frontend is not hosted.',
    },
    {
      url: 'http://127.0.0.1:8788/api/v1',
      description: 'Independent local Node backend with SQL environment variables.',
    },
    {
      url: '/api/v1',
      description: 'Explicit browser-local mock configuration only; no listening server.',
    },
  ],
  security: [{ bearerAuth: [] }],
  paths,
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description:
          'Opaque token from POST /sessions. SQL stores only its SHA-256 hash. Supply in Authorization, never URL parameters; no cookies are used. Explicit mock mode simulates its own local session instead.',
      },
    },
    schemas,
  },
};
writeFileSync(
  new URL('../docs/openapi.json', import.meta.url),
  JSON.stringify(api, null, 2) + '\n',
);
console.log(
  `Generated OpenAPI 3.1 contract: ${Object.keys(paths).length} paths, ${Object.keys(schemas).length} reusable schemas.`,
);
