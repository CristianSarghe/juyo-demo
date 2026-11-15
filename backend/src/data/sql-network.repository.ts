import sql from 'mssql';
import type { CollectionKey, CollectionItem, Page, ReferenceDataDto } from '../domain/api.models.js';
import { ApiProblemError } from '../problem.js';
import { ENUM_OPTIONS, type Hotel, type HotelEvent, type HotelNetwork, type RoomType, type ReportingRange } from '../domain/network.models.js';
import { selectedDate, selectedRange, selectedScope } from '../rest-data.js';

/** Only the collections required by one scoped calculation are populated. */
function scopedNetwork(reference: ReferenceDataDto): HotelNetwork {
  return {
    meta: reference.meta, bookingSnapshot: reference.bookingSnapshot,
    hotels: reference.hotels, reportingPeriods: reference.reportingPeriods,
    events: [], eventHotelImpacts: [], roomTypes: [], roomRates: [], rooms: [],
    facilities: [], restaurants: [], costs: [], unitCosts: [], channels: [],
    dailyPerformance: [], reservations: [], bookingPositions: [], dailyRoomStates: [],
    dailyCosts: [], dailyChannels: [], reservationNights: [], dailyFacilityActivity: [],
  };
}

/** A complete, organization-scoped read model over the normalized hotel facts.
 * Selling quotes and accepted reservation-night revenue intentionally stay separate.
 * No browser fixtures, local overrides or generated demo records enter this adapter.
 */
export class SqlNetworkRepository {
  constructor(private readonly pool: sql.ConnectionPool, private readonly organizationId?: string) {}

  async load(): Promise<HotelNetwork> {
    return decodeSnapshot(await this.read(SNAPSHOT_BATCHES));
  }

  /** The sign-in bootstrap does not need the entire reservation and cost ledger. */
  async loadReference(): Promise<ReferenceDataDto> {
    const sets = await this.read(REFERENCE_QUERY);
    if (sets.length !== 5) throw new Error('Incomplete SQL reference data.');
    const metadata = decodeMetadata(sets);
    const period = metadata.meta.reportingPeriod;
    return {
      ...metadata,
      hotels: decodeRows<FlatHotel>(sets, 3).map(withHotelAddress),
      reportingPeriods: decodeRows<HotelNetwork['reportingPeriods'][number]>(sets, 4),
      dates: Array.from({ length: period.days }, (_, index) =>
        new Date(Date.parse(`${period.startDate}T00:00:00Z`) + index * 86_400_000).toISOString().slice(0, 10)),
    };
  }

  async loadWarningsData(params: URLSearchParams): Promise<HotelNetwork> {
    const data = scopedNetwork(await this.loadReference());
    const hotelId = selectedScope(data, params);
    const date = selectedDate(data, params);
    const scope: Record<string, string> = hotelId === 'portfolio' ? {} : { hotelId };
    data.rooms = await this.readAll('rooms', scope);
    data.dailyRoomStates = await this.readAll('dailyRoomStates', { ...scope, from: date, to: date });
    return data;
  }

  async loadUpcomingEventsData(params: URLSearchParams): Promise<HotelNetwork> {
    const data = scopedNetwork(await this.loadReference());
    const hotelId = selectedScope(data, params);
    selectedDate(data, params);
    const scope: Record<string, string> = hotelId === 'portfolio' ? {} : { hotelId };
    // Event/assessment catalogs are small; the shared selector retains ongoing
    // and future events without assuming event dates end with the ledger.
    data.events = await this.readAll('events', scope);
    data.eventHotelImpacts = await this.readAll('eventHotelImpacts', scope);
    return data;
  }

  async loadPriceHistoryData(roomTypeId: string, params: URLSearchParams): Promise<HotelNetwork> {
    const data = scopedNetwork(await this.loadReference());
    data.roomTypes = await this.readAll('roomTypes');
    const type = data.roomTypes.find((row) => row.id === roomTypeId);
    if (!type) throw new ApiProblemError(404, 'ROOM_TYPE_NOT_FOUND', 'Room type not found.');
    const range = selectedRange(data, params) ?? data.meta.reportingPeriod;
    const scope = { hotelId: type.hotelId, roomTypeId, from: range.startDate, to: range.endDate };
    data.reservations = await this.readAll('reservations', scope);
    data.reservationNights = await this.readAll('reservationNights', scope);
    return data;
  }

  private async readAll<K extends CollectionKey>(
    key: K,
    query: Record<string, string> = {},
  ): Promise<CollectionItem<K>[]> {
    const first = await this.readCollection(key, new URLSearchParams({ ...query, pageSize: '1000' }));
    if (first.total > 50_000) throw new ApiProblemError(413, 'RESOURCE_LIMIT', 'Choose a narrower scope.');
    const items = [...first.items];
    for (let page = 2; items.length < first.total; page++) {
      const next = await this.readCollection(key, new URLSearchParams({ ...query, pageSize: '1000', page: String(page) }));
      if (next.total !== first.total || !next.items.length)
        throw new ApiProblemError(409, 'SNAPSHOT_CHANGED', 'The reporting data changed while loading. Please retry.');
      items.push(...next.items);
    }
    return items;
  }

  /** Server-side filtered pagination keeps each REST request independent of the full ledger. */
  async readCollection<K extends CollectionKey>(key: K, params: URLSearchParams): Promise<Page<CollectionItem<K>>> {
    const projection = projections.find((entry) => entry.key === key);
    if (!projection) throw new ApiProblemError(404, 'NOT_FOUND', 'API resource not found.');
    const filters = collectionFilters(key, params);
    const source = key === 'roomRates' && filters.basis !== 'canonical' ? effectiveRoomRates(projection.query) : projection.query;
    const where = [projection.where, ...filterPredicates(key)].join(' AND ');
    const validation = `
IF @HotelId IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM @Hotels WHERE HotelId COLLATE Latin1_General_100_BIN2=@HotelId)
  THROW 52003, 'Choose a valid hotel.', 1;
IF (@From IS NOT NULL AND (@From<@PeriodStart OR @Through>@PeriodEnd))
 OR (@StayDate IS NOT NULL AND (@StayDate<@PeriodStart OR @StayDate>@PeriodEnd))
  THROW 52004, 'Choose dates within the reporting calendar.', 1;`;
    const queries = [
      compactSql(SNAPSHOT_SETUP + validation + `
SELECT (SELECT COUNT_BIG(*) AS total FROM (${source}) AS q WHERE ${where} FOR JSON PATH) AS payload;`),
      compactSql(SNAPSHOT_SETUP + validation + `
SELECT COALESCE((SELECT q.* FROM (${source}) AS q WHERE ${where}
  ORDER BY ${projection.order} OFFSET @Offset ROWS FETCH NEXT @PageSize ROWS ONLY
  FOR JSON PATH, INCLUDE_NULL_VALUES),N'[]') AS payload;`),
      ...(key === 'roomTypes' ? [compactSql(SNAPSHOT_SETUP + project(projections.find((entry) => entry.key === 'amenities')!))] : []),
    ];
    let recordsets: JsonRecordset[];
    try {
      recordsets = await this.read(queries, filters);
    } catch (error) {
      const number = error && typeof error === 'object' && 'number' in error ? error.number : undefined;
      if (number === 52003) throw new ApiProblemError(400, 'INVALID_HOTEL', 'Choose a valid hotel.');
      if (number === 52004) throw new ApiProblemError(400, 'INVALID_RANGE', 'Choose dates within the reporting calendar.');
      throw error;
    }
    const total = decodeRows<{ total: number }>(recordsets, 0)[0]?.total;
    if (!Number.isSafeInteger(total) || total < 0) throw new Error('Invalid SQL collection count.');
    let items = decodeRows<unknown>(recordsets, 1);
    if (key === 'hotels') items = (items as FlatHotel[]).map(withHotelAddress);
    if (key === 'events') items = (items as FlatCoordinates<HotelEvent>[]).map(withCoordinates<HotelEvent>);
    if (key === 'roomTypes') items = withAmenities(items as FlatRoomType[], decodeRows<Amenity>(recordsets, 2));
    return { items: items as CollectionItem<K>[], total, page: filters.page, pageSize: filters.pageSize };
  }

  private async read(queries: string | readonly string[], filters?: CollectionFilters): Promise<JsonRecordset[]> {
    const transaction = new sql.Transaction(this.pool);
    let begun = false;
    let rolledBack = false;
    transaction.on('rollback', () => { rolledBack = true; });
    try {
      // All collections observe one consistent snapshot, including the selected
      // import manifest. SERIALIZABLE does not require database-level RCSI setup.
      await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
      begun = true;
      const recordsets: JsonRecordset[] = [];
      const batches = typeof queries === 'string' ? [queries] : queries;
      for (const [index, query] of batches.entries()) {
        const request = new sql.Request(transaction)
          .input('requestedOrganizationId', sql.VarChar(64), this.organizationId ?? null);
        if (filters) {
          if (query.includes('@HotelId')) request.input('HotelId', sql.VarChar(64), filters.hotelId);
          if (query.includes('@RoomTypeId')) request.input('RoomTypeId', sql.VarChar(64), filters.roomTypeId);
          if (query.includes('@RoomId')) request.input('RoomId', sql.VarChar(64), filters.roomId);
          if (query.includes('@EventId')) request.input('EventId', sql.VarChar(64), filters.eventId);
          if (query.includes('@Status')) request.input('Status', sql.VarChar(32), filters.status);
          if (query.includes('@From')) request.input('From', sql.Date, filters.from);
          if (query.includes('@Through')) request.input('Through', sql.Date, filters.through);
          if (query.includes('@StayDate')) request.input('StayDate', sql.Date, filters.stayDate);
          if (query.includes('@Offset')) request.input('Offset', sql.Int, (filters.page - 1) * filters.pageSize);
          if (query.includes('@PageSize')) request.input('PageSize', sql.Int, filters.pageSize);
        }
        try {
          const result = await request.query(query);
          recordsets.push(...result.recordsets as unknown as JsonRecordset[]);
        } catch (cause) {
          if (batches.length === 1) throw cause;
          // The HTTP layer returns a generic503; this bounded context is only
          // consumed by its private, redacted diagnostic logger.
          const detail = cause instanceof Error ? cause.message.slice(0, 160) : 'SQL request failed';
          const number = cause && typeof cause === 'object' && 'number' in cause ? cause.number : undefined;
          const label = filters ? 'collection' : 'snapshot';
          throw Object.assign(new Error(`SQL ${label} batch ${index + 1}/${batches.length} failed: ${detail}`, { cause }),
            { code: filters ? 'SQL_COLLECTION_BATCH_FAILED' : 'SQL_SNAPSHOT_BATCH_FAILED', number });
        }
      }
      await transaction.commit();
      return recordsets;
    } catch (error) {
      if (begun && !rolledBack) await transaction.rollback().catch(() => undefined);
      throw error;
    }
  }
}

type JsonRecordset = { payload: string }[];
type FlatCoordinates<T> = Omit<T, 'coordinates'> & { latitude: number; longitude: number };
type FlatHotel = FlatCoordinates<Omit<Hotel, 'address'>> & {
  addressLine1: string | null;
  addressLine2: string | null;
  addressPostalCode: string | null;
};
type FlatRoomType = Omit<RoomType, 'facilities'>;
interface Manifest {
  id: string;
  name: string;
  currency: 'EUR';
  amountBasis: 'net_excluding_vat';
  schemaVersion: string;
  testData: boolean;
  startDate: string;
  endDate: string;
  asOf: string;
  previousAsOf: string;
  source: string;
}
interface ImportNote { kind: 'meta' | 'bookingSnapshot'; text: string }
interface StatusPolicy { status: string; included: boolean }
interface Amenity { roomTypeId: string; amenity: RoomType['facilities'][number] }

type ArrayKey = { [K in keyof HotelNetwork]: HotelNetwork[K] extends unknown[] ? K : never }[keyof HotelNetwork];
interface Projection {
  key: ArrayKey | 'amenities';
  query: string;
  where: string;
  order: string;
}

const hotelScope = 'q.hotelId IN (SELECT HotelId FROM @Hotels)';
const datedScope = `${hotelScope} AND q.[date] BETWEEN @PeriodStart AND @PeriodEnd`;
const openingHours = `
  SELECT FacilityId,
    STRING_AGG(CONVERT(nvarchar(max), CASE
      WHEN OpensAt=CONVERT(time,'00:00') AND ClosesAt=CONVERT(time,'00:00') AND EndsNextDay=1
        THEN N'24 hours'
      ELSE CONVERT(nvarchar(5),OpensAt,108)+N'–'+CONVERT(nvarchar(5),ClosesAt,108)
    END), N'; ') WITHIN GROUP (ORDER BY [Sequence]) AS OpeningHours
  FROM juyo.FacilityOpeningWindow GROUP BY FacilityId`;

/** Static SQL projections, kept explicit so the REST DTO is independent of table layout. */
const projections: Projection[] = [
  { key: 'hotels', where: 'q.id IN (SELECT HotelId FROM @Hotels)', order: 'q.name,q.id', query: `
    SELECT h.HotelId AS id,h.Name AS name,c.Name AS city,co.Name AS country,
      co.CountryCode AS countryCode,h.TimeZoneId AS timezone,h.StatusCode AS status,
      h.CategoryCode AS category,h.StarRating AS starRating,h.OpenedYear AS openedYear,
      h.Latitude AS latitude,h.Longitude AS longitude,
      a.Line1 AS addressLine1,a.Line2 AS addressLine2,a.PostalCode AS addressPostalCode
    FROM juyo.Hotel h JOIN juyo.City c ON c.CityId=h.CityId
    JOIN juyo.Country co ON co.CountryCode=c.CountryCode
    LEFT JOIN juyo.HotelAddress a ON a.HotelId=h.HotelId` },
  { key: 'events', where: `EXISTS (SELECT 1 FROM juyo.EventHotelAssessment a
      WHERE a.EventId=q.id AND a.HotelId IN (SELECT HotelId FROM @Hotels))`, order: 'q.startDate,q.id', query: `
    SELECT e.EventId AS id,e.Name AS name,e.CategoryCode AS category,e.StartDate AS startDate,e.EndDate AS endDate,
      v.Name AS venue,c.Name AS city,co.Name AS country,v.Latitude AS latitude,v.Longitude AS longitude,
      e.ExpectedAttendance AS expectedAttendance
    FROM juyo.HotelEvent e JOIN juyo.EventVenue v ON v.VenueId=e.VenueId
    JOIN juyo.City c ON c.CityId=v.CityId JOIN juyo.Country co ON co.CountryCode=c.CountryCode` },
  { key: 'eventHotelImpacts', where: hotelScope, order: 'q.eventId,q.hotelId', query: `
    SELECT EventId AS eventId,HotelId AS hotelId,ImportanceCode AS importance,DistanceKm AS distanceKm,
      Reason AS reason,SourceCode AS source,AssessedOn AS assessedAt FROM juyo.EventHotelAssessment` },
  { key: 'roomTypes', where: hotelScope, order: 'q.hotelId,q.id', query: `
    SELECT t.RoomTypeId AS id,t.HotelId AS hotelId,t.Name AS name,i.Inventory AS inventory,
      t.MaxAdults AS maxAdults,t.MaxChildren AS maxChildren,t.AreaM2 AS areaM2,t.BaseRate AS baseRate
    FROM juyo.RoomType t JOIN juyo.RoomTypeInventory i ON i.RoomTypeId=t.RoomTypeId` },
  { key: 'amenities', where: `EXISTS (SELECT 1 FROM juyo.RoomType t
      WHERE t.RoomTypeId=q.roomTypeId AND t.HotelId IN (SELECT HotelId FROM @Hotels))`,
    order: 'q.roomTypeId,q.amenity', query: `
    SELECT RoomTypeId AS roomTypeId,AmenityCode AS amenity FROM juyo.RoomTypeAmenity` },
  { key: 'roomRates', where: datedScope, order: 'q.hotelId,q.roomTypeId,q.[date]', query: `
    SELECT t.HotelId AS hotelId,q.RoomTypeId AS roomTypeId,q.StayDate AS date,
      q.NightlyRate AS nightlyRate,h.CurrencyCode AS currency
    FROM juyo.RoomDailyRate q JOIN juyo.RoomType t ON t.RoomTypeId=q.RoomTypeId
    JOIN juyo.Hotel h ON h.HotelId=t.HotelId` },
  { key: 'rooms', where: hotelScope, order: 'q.hotelId,q.number,q.id', query: `
    SELECT RoomId AS id,HotelId AS hotelId,RoomTypeId AS roomTypeId,Number AS number,Floor AS floor,
      OccupancyCode AS occupancy,HousekeepingCode AS housekeeping,MaintenanceCode AS maintenance,
      MaintenanceNote AS maintenanceNote,StayDate AS date,BasisCode AS basis FROM juyo.CurrentRooms` },
  { key: 'facilities', where: hotelScope, order: 'q.hotelId,q.id', query: `
    SELECT f.FacilityId AS id,f.HotelId AS hotelId,f.KindCode AS kind,f.Name AS name,
      f.Capacity AS capacity,hours.OpeningHours AS openingHours,f.Fee AS fee,f.FeeUnitCode AS feeUnit
    FROM juyo.Facility f LEFT JOIN (${openingHours}) hours ON hours.FacilityId=f.FacilityId` },
  { key: 'restaurants', where: hotelScope, order: 'q.hotelId,q.id', query: `
    SELECT r.FacilityId AS id,f.HotelId AS hotelId,f.Name AS name,r.Cuisine AS cuisine,
      f.Capacity AS seats,hours.OpeningHours AS openingHours,r.BreakfastPrice AS breakfastPrice,r.AverageCheck AS averageCheck
    FROM juyo.Restaurant r JOIN juyo.Facility f ON f.FacilityId=r.FacilityId
    LEFT JOIN (${openingHours}) hours ON hours.FacilityId=r.FacilityId` },
  { key: 'costs', where: `${hotelScope} AND q.period BETWEEN CONVERT(char(7),@PeriodStart,126) AND CONVERT(char(7),@PeriodEnd,126)`,
    order: 'q.hotelId,q.period,q.id', query: `
    SELECT CONCAT(HotelId,'-',PeriodKey,'-',BasisCode,'-',CategoryCode,'-',DepartmentCode) AS id,
      HotelId AS hotelId,PeriodKey AS period,CategoryCode AS category,DepartmentCode AS department,
      Amount AS amount,Description AS description,BasisCode AS basis FROM juyo.MonthlyCosts` },
  { key: 'unitCosts', where: hotelScope, order: 'q.hotelId,q.id', query: `
    SELECT UnitCostId AS id,HotelId AS hotelId,BasisCode AS basis,Amount AS amount,Description AS description FROM juyo.UnitCost` },
  { key: 'channels', where: `${hotelScope} AND q.period BETWEEN CONVERT(char(7),@PeriodStart,126) AND CONVERT(char(7),@PeriodEnd,126)`,
    order: 'q.hotelId,q.period,q.id', query: `
    SELECT CONCAT(HotelId,'-',PeriodKey,'-',BasisCode,'-',ChannelCode) AS id,
      HotelId AS hotelId,PeriodKey AS period,ChannelCode AS channel,SoldNights AS soldNights,
      GrossRevenue AS grossRevenue,CommissionRate AS commissionRate,AcquisitionCost AS acquisitionCost,BasisCode AS basis
    FROM juyo.MonthlyChannels` },
  { key: 'dailyPerformance', where: datedScope, order: 'q.hotelId,q.[date]', query: `
    SELECT HotelId AS hotelId,StayDate AS date,RoomsAvailable AS roomsAvailable,SoldNights AS soldNights,
      RoomRevenue AS roomRevenue,RestaurantRevenue AS restaurantRevenue,RestaurantCovers AS restaurantCovers,
      OtherRevenue AS otherRevenue,BudgetSoldNights AS budgetSoldNights,BudgetRoomRevenue AS budgetRoomRevenue,
      BasisCode AS basis,AncillaryBasisCode AS ancillaryBasis FROM juyo.DailyPerformance` },
  { key: 'reservations', where: `${hotelScope} AND q.arrival<=@PeriodEnd AND q.departure>@PeriodStart`,
    order: 'q.hotelId,q.arrival,q.id', query: `
    SELECT r.ReservationId AS id,t.HotelId AS hotelId,r.RoomTypeId AS roomTypeId,a.RoomId AS roomId,
      r.GuestReference AS guestRef,r.ChannelCode AS channel,r.StatusCode AS status,
      r.ArrivalDate AS arrival,r.DepartureDate AS departure,r.Adults AS adults,r.Children AS children,
      totals.RoomRevenue AS roomRevenue,h.CurrencyCode AS currency,r.BookedOn AS bookedOn,
      r.CancelledOn AS cancelledOn,r.QuotedNightlyRate AS quotedNightlyRate,totals.QuotedRevenue AS quotedRevenue
    FROM juyo.Reservation r JOIN juyo.RoomType t ON t.RoomTypeId=r.RoomTypeId
    JOIN juyo.Hotel h ON h.HotelId=t.HotelId
    LEFT JOIN juyo.ReservationRoomAssignment a ON a.ReservationId=r.ReservationId
    JOIN juyo.ReservationTotals totals ON totals.ReservationId=r.ReservationId` },
  { key: 'bookingPositions', where: `${hotelScope} AND q.stayDate BETWEEN @PeriodStart AND @PeriodEnd`,
    order: 'q.hotelId,q.stayDate', query: `
    SELECT HotelId AS hotelId,StayDate AS stayDate,CapturedAsOf AS capturedAsOf,StateCode AS state,
      RoomsAvailable AS roomsAvailable,ActualRooms AS actualRooms,ActualRoomRevenue AS actualRoomRevenue,
      RoomsOnBooks AS roomsOnBooks,RevenueOnBooks AS revenueOnBooks,RoomsOnBooks7dAgo AS roomsOnBooks7dAgo,
      RevenueOnBooks7dAgo AS revenueOnBooks7dAgo,Pickup7dRoomNights AS pickup7dRoomNights,
      Pickup7dRevenue AS pickup7dRevenue,TargetRooms AS targetRooms,TargetRevenue AS targetRevenue
    FROM juyo.BookingPositions` },
  { key: 'reportingPeriods', where: 'q.startDate<=@PeriodEnd AND q.endDate>=@PeriodStart', order: 'q.[key]', query: `
    SELECT PeriodKey AS [key],StartDate AS startDate,EndDate AS endDate,Days AS days,Label AS label FROM juyo.ReportingPeriods` },
  { key: 'dailyRoomStates', where: datedScope, order: 'q.hotelId,q.roomId,q.[date]', query: `
    SELECT RoomId AS roomId,HotelId AS hotelId,StayDate AS date,OccupancyCode AS occupancy,
      HousekeepingCode AS housekeeping,MaintenanceCode AS maintenance,MaintenanceNote AS maintenanceNote,
      BasisCode AS basis FROM juyo.RoomDailyStates` },
  { key: 'dailyCosts', where: datedScope, order: 'q.hotelId,q.[date],q.id', query: `
    SELECT c.CostEntryId AS id,c.HotelId AS hotelId,c.StayDate AS date,a.CategoryCode AS category,
      a.DepartmentCode AS department,c.Amount AS amount,a.Description AS description,c.BasisCode AS basis
    FROM juyo.DailyCost c JOIN juyo.CostAccount a ON a.CostAccountId=c.CostAccountId` },
  { key: 'dailyChannels', where: datedScope, order: 'q.hotelId,q.[date],q.channel', query: `
    SELECT CONCAT(HotelId,'-',CONVERT(char(10),StayDate,23),'-',ChannelCode) AS id,
      HotelId AS hotelId,StayDate AS date,ChannelCode AS channel,SoldNights AS soldNights,
      GrossRevenue AS grossRevenue,CommissionRate AS commissionRate,AcquisitionCost AS acquisitionCost,BasisCode AS basis
    FROM juyo.DailyChannels` },
  { key: 'reservationNights', where: datedScope, order: 'q.hotelId,q.[date],q.reservationId', query: `
    SELECT n.ReservationId AS reservationId,t.HotelId AS hotelId,a.RoomId AS roomId,
      n.StayDate AS date,r.ChannelCode AS channel,n.RoomRevenue AS roomRevenue
    FROM juyo.ReservationNight n JOIN juyo.Reservation r ON r.ReservationId=n.ReservationId
    JOIN juyo.RoomType t ON t.RoomTypeId=r.RoomTypeId
    JOIN juyo.ReservationRoomAssignment a ON a.ReservationId=n.ReservationId` },
  { key: 'dailyFacilityActivity', where: datedScope, order: 'q.hotelId,q.[date],q.facilityId', query: `
    SELECT f.HotelId AS hotelId,a.FacilityId AS facilityId,a.StayDate AS date,
      a.Uses AS uses,a.Revenue AS revenue,a.BasisCode AS basis
    FROM juyo.FacilityDailyActivity a JOIN juyo.Facility f ON f.FacilityId=a.FacilityId` },
];

// FOR JSON retains SQL date precision and exact decimal/null DTO semantics;
// each collection is one resultset rather than many per-record API round trips.
const SNAPSHOT_SETUP = `
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @OrganizationId varchar(64)=@requestedOrganizationId;
IF @OrganizationId IS NULL
BEGIN
  IF (SELECT COUNT_BIG(*) FROM juyo.CurrentSourceImport)<>1
    THROW 52001, 'A single organization must be configured for this API.', 1;
  SELECT @OrganizationId=OrganizationId FROM juyo.CurrentSourceImport;
END;
DECLARE @ImportId char(64), @PeriodStart date, @PeriodEnd date;
SELECT @ImportId=ImportId,@PeriodStart=PeriodStartDate,@PeriodEnd=PeriodEndDate
FROM juyo.CurrentSourceImport WHERE OrganizationId=@OrganizationId;
IF @ImportId IS NULL THROW 52002, 'No reporting data exists for the configured organization.', 1;
DECLARE @Hotels TABLE (HotelId varchar(64) PRIMARY KEY);
INSERT INTO @Hotels (HotelId) SELECT HotelId FROM juyo.Hotel WHERE OrganizationId=@OrganizationId;
`;
const SNAPSHOT_METADATA = `SELECT (SELECT o.OrganizationId AS id,o.Name AS name,o.ReportingCurrencyCode AS currency,
  o.AmountBasisCode AS amountBasis,i.SchemaVersion AS schemaVersion,i.IsTestData AS testData,
  i.PeriodStartDate AS startDate,i.PeriodEndDate AS endDate,i.AsOfDate AS asOf,
  i.PreviousAsOfDate AS previousAsOf,i.BookingSource AS source
  FROM juyo.Organization o JOIN juyo.CurrentSourceImport i ON i.OrganizationId=o.OrganizationId
  WHERE o.OrganizationId=@OrganizationId FOR JSON PATH, INCLUDE_NULL_VALUES) AS payload;
SELECT (SELECT NoteKind AS kind,NoteText AS text FROM juyo.SourceImportNote
  WHERE ImportId=@ImportId ORDER BY NoteKind,Ordinal FOR JSON PATH, INCLUDE_NULL_VALUES) AS payload;
SELECT (SELECT StatusCode AS status,IsIncludedOnBooks AS included FROM juyo.SourceSnapshotStatusPolicy
  WHERE ImportId=@ImportId ORDER BY StatusCode FOR JSON PATH, INCLUDE_NULL_VALUES) AS payload;
`;

// SQL text is static here; its literals contain no significant repeated whitespace.
const compactSql = (query: string): string => query.replace(/\s+/g, ' ').trim();

const project = ({ query, where, order }: Projection): string =>
  `SELECT COALESCE((SELECT q.* FROM (${query}) AS q WHERE ${where} ORDER BY ${order} FOR JSON PATH, INCLUDE_NULL_VALUES),N'[]') AS payload;`;
// Cloudflare's native TLS writer must receive RPCs below a TLS record. The
// complete read still owns one transaction; only its static SQL text is split.
const SNAPSHOT_BATCHES: readonly string[] = [
  SNAPSHOT_SETUP + SNAPSHOT_METADATA,
  ...projections.map((projection) => SNAPSHOT_SETUP + project(projection)),
];
const REFERENCE_QUERY = SNAPSHOT_SETUP + SNAPSHOT_METADATA + projections.filter(({ key }) =>
  key === 'hotels' || key === 'reportingPeriods').map(project).join('\n');

function decodeRows<T>(recordsets: JsonRecordset[], index: number): T[] {
  const payload = recordsets[index]?.[0]?.payload;
  if (typeof payload !== 'string') throw new Error('Invalid SQL network resultset.');
  const parsed: unknown = JSON.parse(payload);
  if (!Array.isArray(parsed)) throw new Error('Invalid SQL network collection.');
  return parsed as T[];
}

function withCoordinates<T>(flat: FlatCoordinates<T>): T {
  const { latitude, longitude, ...record } = flat;
  return { ...record, coordinates: { latitude, longitude } } as T;
}

function withHotelAddress(flat: FlatHotel): Hotel {
  const { addressLine1, addressLine2, addressPostalCode, ...location } = flat;
  return {
    ...withCoordinates<Omit<Hotel, 'address'>>(location),
    address: addressLine1 !== null && addressPostalCode !== null
      ? {
          line1: addressLine1,
          ...(addressLine2 !== null ? { line2: addressLine2 } : {}),
          postalCode: addressPostalCode,
        }
      : null,
  };
}

function decodeMetadata(recordsets: JsonRecordset[]): Pick<HotelNetwork, 'meta' | 'bookingSnapshot'> {
  const manifests = decodeRows<Manifest>(recordsets, 0);
  if (manifests.length !== 1) throw new Error('Missing SQL reporting manifest.');
  const manifest = manifests[0];
  if (manifest.currency !== 'EUR' || manifest.amountBasis !== 'net_excluding_vat') {
    throw new Error('Unsupported reporting currency or amount basis.');
  }
  const notes = decodeRows<ImportNote>(recordsets, 1);
  const policies = decodeRows<StatusPolicy>(recordsets, 2);
  const period = reportingRange(manifest.startDate, manifest.endDate);
  return {
    meta: {
      id: manifest.id, name: manifest.name, schemaVersion: manifest.schemaVersion,
      testData: manifest.testData, currency: manifest.currency, amountBasis: manifest.amountBasis,
      reportingPeriod: period, snapshotDate: manifest.asOf,
      notes: notes.filter(({ kind }) => kind === 'meta').map(({ text }) => text),
    },
    bookingSnapshot: {
      asOf: manifest.asOf, previousAsOf: manifest.previousAsOf, period: { ...period },
      testData: manifest.testData, source: manifest.source,
      includedOnBooksStatuses: policies.filter(({ included }) => included).map(({ status }) => status) as HotelNetwork['bookingSnapshot']['includedOnBooksStatuses'],
      excludedStatuses: policies.filter(({ included }) => !included).map(({ status }) => status) as HotelNetwork['bookingSnapshot']['excludedStatuses'],
      notes: notes.filter(({ kind }) => kind === 'bookingSnapshot').map(({ text }) => text),
    },
  };
}

function decodeSnapshot(recordsets: JsonRecordset[]): HotelNetwork {
  if (recordsets.length !== projections.length + 3) throw new Error('Incomplete SQL network snapshot.');
  const metadata = decodeMetadata(recordsets);
  const collections = Object.fromEntries(projections.map(({ key }, index) => [key, decodeRows<unknown>(recordsets, index + 3)]));
  delete collections['amenities'];
  return {
    ...collections,
    ...metadata,
    hotels: (collections['hotels'] as FlatHotel[]).map(withHotelAddress),
    events: (collections['events'] as FlatCoordinates<HotelEvent>[]).map(withCoordinates<HotelEvent>),
    roomTypes: withAmenities(collections['roomTypes'] as FlatRoomType[], decodeRows<Amenity>(recordsets, projections.findIndex(({ key }) => key === 'amenities') + 3)),
  } as HotelNetwork;
}

interface CollectionFilters {
  hotelId: string | null;
  roomTypeId: string | null;
  roomId: string | null;
  eventId: string | null;
  status: string | null;
  from: string | null;
  through: string | null;
  stayDate: string | null;
  basis: string | null;
  page: number;
  pageSize: number;
}
function collectionFilters(key: CollectionKey, params: URLSearchParams): CollectionFilters {
  const allowed = new Set(['hotelId', 'roomTypeId', 'roomId', 'eventId', 'status', 'from', 'to', 'stayDate', 'page', 'pageSize', 'basis']);
  for (const name of params.keys()) if (!allowed.has(name))
    throw new ApiProblemError(400, 'INVALID_FILTER', `Unsupported filter: ${name}.`);
  const id = (name: string, max = 64): string | null => {
    const value = params.get(name);
    if (value && value.length > max) throw new ApiProblemError(400, 'INVALID_FILTER', `Choose a valid ${name}.`);
    return value || null;
  };
  const date = (name: string): string | null => {
    const value = params.get(name);
    if (!params.has(name)) return null;
    const parsed = value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !value.startsWith('0000-')
      ? Date.parse(`${value}T12:00:00Z`) : NaN;
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value)
      throw new ApiProblemError(400, 'INVALID_RANGE', 'Use valid dates in YYYY-MM-DD format.');
    return value;
  };
  const from = date('from'), through = date('to'), stayDate = date('stayDate');
  if (!!from !== !!through || (from && through && from > through))
    throw new ApiProblemError(400, 'INVALID_RANGE', 'Provide a valid inclusive from and to range.');
  const integer = (name: string, fallback: number, max: number) => {
    const value = params.get(name);
    if (value === null) return fallback;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > max)
      throw new ApiProblemError(400, 'INVALID_PAGINATION', `Choose a valid ${name}.`);
    return Number(value);
  };
  const basis = params.get('basis');
  if (basis && !(key === 'roomRates' && basis === 'canonical'))
    throw new ApiProblemError(400, 'INVALID_FILTER', 'Unsupported reporting basis.');
  return { hotelId: id('hotelId'), roomTypeId: id('roomTypeId'), roomId: id('roomId'), eventId: id('eventId'),
    status: id('status', 32), from, through, stayDate, basis,
    page: integer('page', 1, 100000), pageSize: integer('pageSize', 50, 1000) };
}

function filterPredicates(key: CollectionKey): string[] {
  const predicates: string[] = [];
  if (key === 'hotels') predicates.push('(@HotelId IS NULL OR q.id COLLATE Latin1_General_100_BIN2=@HotelId)');
  else if (key === 'events') predicates.push(`(@HotelId IS NULL OR EXISTS (SELECT 1 FROM juyo.EventHotelAssessment a
    WHERE a.EventId=q.id AND a.HotelId COLLATE Latin1_General_100_BIN2=@HotelId))`);
  else if (key !== 'reportingPeriods') predicates.push('(@HotelId IS NULL OR q.hotelId COLLATE Latin1_General_100_BIN2=@HotelId)');
  const fields = {
    roomTypeId: ['roomRates', 'rooms', 'reservations'],
    roomId: ['dailyRoomStates', 'reservations', 'reservationNights'],
    eventId: ['eventHotelImpacts'],
    status: ['hotels', 'reservations'],
  } satisfies Record<string, CollectionKey[]>;
  for (const [field, keys] of Object.entries(fields)) {
    const parameter = field.charAt(0).toUpperCase() + field.slice(1);
    if (field === 'roomTypeId' && (key === 'dailyRoomStates' || key === 'reservationNights')) {
      predicates.push(`(@RoomTypeId IS NULL OR EXISTS (SELECT 1 FROM juyo.Room typeRoom
        WHERE typeRoom.RoomId=q.roomId AND typeRoom.RoomTypeId COLLATE Latin1_General_100_BIN2=@RoomTypeId))`);
      continue;
    }
    predicates.push((keys as CollectionKey[]).includes(key)
      ? `(@${parameter} IS NULL OR q.${field} COLLATE Latin1_General_100_BIN2=@${parameter})`
      : `@${parameter} IS NULL`);
  }
  const dates: Partial<Record<CollectionKey, string>> = { roomRates: 'date', rooms: 'date', dailyPerformance: 'date',
    bookingPositions: 'stayDate', dailyRoomStates: 'date', dailyCosts: 'date', dailyChannels: 'date',
    reservationNights: 'date', dailyFacilityActivity: 'date' };
  if (dates[key]) predicates.push(`(@From IS NULL OR q.[${dates[key]}] BETWEEN @From AND @Through)`);
  if (key === 'costs' || key === 'channels') predicates.push(`(@From IS NULL OR q.period BETWEEN CONVERT(char(7),@From,126) AND CONVERT(char(7),@Through,126))`);
  if (key === 'reservations') predicates.push('(@From IS NULL OR (q.arrival<=@Through AND q.departure>@From))',
    '(@StayDate IS NULL OR (q.arrival<=@StayDate AND q.departure>@StayDate))');
  if (key === 'events') predicates.push('(@From IS NULL OR (q.startDate<=@Through AND q.endDate>=@From))');
  return predicates;
}

function effectiveRoomRates(query: string): string {
  return `SELECT canonical.hotelId,canonical.roomTypeId,canonical.[date],
    COALESCE(currentRate.NightlyRate,canonical.nightlyRate) AS nightlyRate,canonical.currency
    FROM (${query}) AS canonical OUTER APPLY (
      SELECT TOP (1) u.NightlyRate FROM juyo_api.RateUpdate u WHERE u.RoomTypeId=canonical.roomTypeId
        AND canonical.[date] BETWEEN u.StartDate AND u.EndDate ORDER BY u.AppliedSequence DESC
    ) currentRate`;
}

function withAmenities(types: FlatRoomType[], rows: Amenity[]): RoomType[] {
  const amenityIndex = new Map<string, Amenity['amenity'][]>();
  for (const { roomTypeId, amenity } of rows) {
    if (!ENUM_OPTIONS.roomFacility.includes(amenity)) throw new Error('Unsupported room amenity.');
    const amenities = amenityIndex.get(roomTypeId) ?? [];
    amenities.push(amenity);
    amenityIndex.set(roomTypeId, amenities);
  }
  return types.map((type) => ({ ...type, facilities: (amenityIndex.get(type.id) ?? []).sort((a, b) =>
    ENUM_OPTIONS.roomFacility.indexOf(a) - ENUM_OPTIONS.roomFacility.indexOf(b)) }));
}

function reportingRange(startDate: string, endDate: string): ReportingRange {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const format = (date: Date, withYear: boolean) => new Intl.DateTimeFormat('en-GB', {
    month: 'long', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC',
  }).format(date);
  const sameMonth = startDate.slice(0, 7) === endDate.slice(0, 7);
  const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
  return {
    startDate, endDate, days: Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1,
    label: sameMonth ? format(start, true) : `${format(start, !sameYear)}–${format(end, true)}`,
  };
}
