import { randomUUID } from 'node:crypto';
import sql from 'mssql';
import type { Conversation, Message } from '../domain/models.js';
import { decodeMessagePayload, encodeMessagePayload, isChatAction } from '../domain/chat.models.js';
import {
  isRateUpdateBatch,
  isRateUpdateRequest,
  rateVersion,
  type RateUpdateReviewItem,
} from '../domain/rate-batch.js';
import type {
  CreateConversationRequest,
  RoomOperationAction,
  RoomOperationChange,
  RoomRateChange,
  RoomRateUpdateRequest,
} from '../domain/mutation.models.js';
import { RepositoryError } from './repository-error.js';
import { withSqlTextParameters } from './sql-text-parameters.js';

const SETTINGS = `
SET ANSI_NULLS ON; SET ANSI_PADDING ON; SET ANSI_WARNINGS ON; SET ARITHABORT ON;
SET CONCAT_NULL_YIELDS_NULL ON; SET QUOTED_IDENTIFIER ON; SET NUMERIC_ROUNDABORT OFF;
SET XACT_ABORT ON; SET NOCOUNT ON;`;
const MAX_HISTORY = 20_000;
const MAX_CONVERSATIONS = 30;
const MAX_MESSAGES = 100;
const roomColumns = `RoomId AS roomId, CONVERT(char(10), StayDate, 23) AS date,
HousekeepingCode AS housekeeping, StatusCode AS status, AppliedAt AS appliedAt`;
const rateColumns = `u.Id AS id, t.HotelId AS hotelId, u.RoomTypeId AS roomTypeId,
CONVERT(char(10), u.StartDate, 23) AS startDate, CONVERT(char(10), u.EndDate, 23) AS endDate,
u.NightlyRate AS nightlyRate, u.EventId AS eventId, u.Reason AS reason, u.AppliedAt AS appliedAt`;
const conversationColumns = `c.Id AS id, c.Title AS title, c.HotelId AS hotelId,
c.ReportingMonth AS month, CONVERT(char(10), c.RoomDate, 23) AS roomDate,
c.DataVersion AS dataVersion, c.UpdatedAt AS updatedAt`;
type Row = Record<string, any>;
const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const uuid = (value: string): boolean =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const validId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 64;
function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T12:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function reject(status: number, code: string, message: string): never {
  throw new RepositoryError(status, code, message);
}
function roomChange(row: Row): RoomOperationChange {
  return {
    roomId: row.roomId,
    date: row.date,
    appliedAt: iso(row.appliedAt),
    ...(row.housekeeping == null ? {} : { housekeeping: row.housekeeping }),
    ...(row.status == null ? {} : { status: row.status }),
  };
}
function rateChange(row: Row): RoomRateChange {
  return {
    id: String(row.id).toLowerCase(),
    hotelId: row.hotelId,
    roomTypeId: row.roomTypeId,
    startDate: row.startDate,
    endDate: row.endDate,
    nightlyRate: row.nightlyRate,
    appliedAt: iso(row.appliedAt),
    ...(row.eventId ? { eventId: row.eventId } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
  };
}
function conversation(row: Row, messages: Message[]): Conversation {
  return {
    id: String(row.id).toLowerCase(),
    title: row.title,
    propertyId: row.hotelId ?? 'portfolio',
    month: row.month,
    roomDate: row.roomDate,
    updatedAt: iso(row.updatedAt),
    ...(row.dataVersion ? { dataVersion: row.dataVersion } : {}),
    messages,
  };
}
function message(row: Row): Message {
  return {
    id: String(row.id).toLowerCase(),
    role: row.role,
    content: row.content,
    createdAt: iso(row.createdAt),
    ...decodeMessagePayload(row.insightJson ?? null, row.content),
  };
}

/** Durable API state. Canonical juyo facts are referenced, never modified. */
export class SqlWorkspaceRepository {
  constructor(private readonly pool: sql.ConnectionPool) {}

  private async transaction<T>(work: (tx: sql.Transaction) => Promise<T>): Promise<T> {
    const tx = new sql.Transaction(this.pool);
    await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      await tx.request().query(SETTINGS);
      const result = await work(tx);
      await tx.commit();
      return result;
    } catch (error) {
      try {
        await tx.rollback();
      } catch {
        /* XACT_ABORT may already have rolled back. */
      }
      throw error;
    }
  }

  async listRoomChanges(date?: string): Promise<RoomOperationChange[]> {
    if (date !== undefined && !validDate(date))
      reject(422, 'INVALID_DATE', 'Choose a valid room-state date.');
    const result = await this.pool.request().input('date', sql.Date, date ?? null).query(`
SELECT TOP (${MAX_HISTORY + 1}) ${roomColumns} FROM juyo_api.RoomOperationChange
WHERE StayDate = COALESCE(@date, (SELECT TOP (1) AsOfDate FROM juyo.SourceImport ORDER BY ImportedAtUtc DESC, ImportId))
ORDER BY RoomId;`);
    if (result.recordset.length > MAX_HISTORY)
      reject(413, 'HISTORY_LIMIT', 'The room-state history exceeds the supported workspace size.');
    return result.recordset.map(roomChange);
  }

  private async lockedRoom(tx: sql.Transaction, roomId: string, expectedDate?: string) {
    if (!validId(roomId)) reject(404, 'ROOM_NOT_FOUND', 'Room not found.');
    const result = await tx.request().input('roomId', sql.VarChar(64), roomId).query(`
DECLARE @AsOf date = (SELECT TOP (1) AsOfDate FROM juyo.SourceImport ORDER BY ImportedAtUtc DESC, ImportId);
SELECT r.RoomId AS roomId, CONVERT(char(10), @AsOf, 23) AS date,
 s.HousekeepingCode AS housekeeping, s.IsOutOfService AS outOfService,
 s.MaintenanceCode AS maintenance, s.MaintenanceNote AS maintenanceNote,
 CAST(CASE WHEN EXISTS (
   SELECT 1 FROM juyo.ReservationRoomAssignment a
   JOIN juyo.Reservation v ON v.ReservationId = a.ReservationId
   JOIN juyo.ReservationNight n ON n.ReservationId = v.ReservationId
   WHERE a.RoomId = r.RoomId AND n.StayDate = @AsOf
     AND v.StatusCode IN ('confirmed','checked_in','checked_out') AND v.BookedOn <= @AsOf
     AND (v.CancelledOn IS NULL OR v.CancelledOn > @AsOf)
 ) THEN 1 ELSE 0 END AS bit) AS booked
FROM juyo.Room r WITH (UPDLOCK, HOLDLOCK)
JOIN juyo.RoomDailyState s ON s.RoomId = r.RoomId AND s.StayDate = @AsOf
WHERE r.RoomId = @roomId;
SELECT ${roomColumns} FROM juyo_api.RoomOperationChange WITH (UPDLOCK, HOLDLOCK)
WHERE RoomId = @roomId AND StayDate = @AsOf;`);
    const sets = result.recordsets as sql.IRecordSet<Row>[];
    const base = sets[0]?.[0];
    if (!base) reject(404, 'ROOM_NOT_FOUND', 'Room not found in the current business snapshot.');
    if (expectedDate !== undefined && expectedDate !== base.date)
      reject(409, 'STALE_BUSINESS_DATE', 'Room changes apply to the current business date only.');
    return { base, previous: sets[1]?.[0] ? roomChange(sets[1][0]) : undefined };
  }

  private async writeRoom(
    tx: sql.Transaction,
    roomId: string,
    date: string,
    value: Pick<RoomOperationChange, 'housekeeping' | 'status'> | undefined,
    userId: string,
    action: string,
  ): Promise<void> {
    await tx
      .request()
      .input('roomId', sql.VarChar(64), roomId)
      .input('date', sql.Date, date)
      .input('housekeeping', sql.VarChar(32), value?.housekeeping ?? null)
      .input('status', sql.VarChar(32), value?.status ?? null)
      .input('userId', sql.UniqueIdentifier, userId)
      .input('action', sql.VarChar(32), action).query(`
DECLARE @AppliedAt datetime2(3) = SYSUTCDATETIME();
IF @housekeeping IS NULL AND @status IS NULL
  DELETE juyo_api.RoomOperationChange WHERE RoomId = @roomId AND StayDate = @date;
ELSE
BEGIN
  UPDATE juyo_api.RoomOperationChange
  SET HousekeepingCode = @housekeeping, StatusCode = @status, AppliedAt = @AppliedAt, AppliedBy = @userId
  WHERE RoomId = @roomId AND StayDate = @date;
  IF @@ROWCOUNT = 0
    INSERT juyo_api.RoomOperationChange(RoomId,StayDate,HousekeepingCode,StatusCode,AppliedAt,AppliedBy)
    VALUES (@roomId,@date,@housekeeping,@status,@AppliedAt,@userId);
END;
INSERT juyo_api.RoomOperationAudit(RoomId,StayDate,ActionCode,HousekeepingCode,StatusCode,AppliedAt,AppliedBy)
VALUES (@roomId,@date,@action,@housekeeping,@status,@AppliedAt,@userId);`);
  }

  /** Derive actions while holding a per-room lock; parallel requests cannot lose each other's fields. */
  async applyRoomAction(
    roomId: string,
    action: RoomOperationAction,
    userId: string,
  ): Promise<RoomOperationChange[]> {
    if (!['clean', 'dirty', 'reserve', 'out_of_service', 'available', 'reset'].includes(action))
      reject(422, 'INVALID_ROOM_ACTION', 'Choose a valid room action.');
    const date = await this.transaction((tx) =>
      this.applyRoomActionInTransaction(tx, roomId, action, userId),
    );
    // Read overlays after releasing the room lock to avoid locking unrelated rooms.
    return this.listRoomChanges(date);
  }

  private async applyRoomActionInTransaction(
    tx: sql.Transaction,
    roomId: string,
    action: RoomOperationAction,
    userId: string,
    expectedDate?: string,
  ): Promise<string> {
    const { base, previous } = await this.lockedRoom(tx, roomId, expectedDate);
    if (base.booked && ['reserve', 'out_of_service', 'available'].includes(action))
      reject(
        409,
        'ROOM_STATE_CONFLICT',
        'This room has a booking today. Move the booking before changing availability.',
      );
    const currentStatus =
      previous?.status ??
      (base.outOfService ? 'out_of_service' : base.booked ? 'occupied' : 'available');
    if (action === 'reserve' && currentStatus === 'out_of_service')
      reject(409, 'ROOM_STATE_CONFLICT', 'Return this room to service before reserving it.');
    let next: Pick<RoomOperationChange, 'housekeeping' | 'status'> | undefined;
    if (action !== 'reset') {
      const housekeeping =
        action === 'clean' ? 'clean' : action === 'dirty' ? 'dirty' : previous?.housekeeping;
      let status =
        action === 'reserve'
          ? 'reserved'
          : action === 'out_of_service' || action === 'available'
            ? action
            : previous?.status;
      if (
        status === 'available' &&
        !base.booked &&
        !base.outOfService &&
        base.maintenance === 'none'
      )
        status = undefined;
      next = {
        ...(housekeeping !== undefined && housekeeping !== base.housekeeping
          ? { housekeeping }
          : {}),
        ...(status !== undefined ? { status } : {}),
      };
    }
    await this.writeRoom(tx, roomId, base.date, next, userId, action);
    return base.date as string;
  }

  /** Validated replacement; prefer applyRoomAction for user actions. */
  async setRoomChange(change: RoomOperationChange, userId: string): Promise<void> {
    if (
      !validDate(change.date) ||
      (change.housekeeping !== undefined &&
        !['clean', 'dirty', 'inspected'].includes(change.housekeeping)) ||
      (change.status !== undefined &&
        !['available', 'reserved', 'out_of_service'].includes(change.status))
    )
      reject(422, 'INVALID_ROOM_CHANGE', 'Choose a valid room change.');
    await this.transaction(async (tx) => {
      const { base } = await this.lockedRoom(tx, change.roomId, change.date);
      if (base.booked && change.status !== undefined)
        reject(
          409,
          'ROOM_STATE_CONFLICT',
          'This room has a booking today. Move the booking before changing availability.',
        );
      await this.writeRoom(tx, change.roomId, change.date, change, userId, 'replace');
    });
  }

  async resetRoomChange(roomId: string, date: string, userId: string): Promise<void> {
    await this.transaction(async (tx) => {
      const { base } = await this.lockedRoom(tx, roomId, date);
      await this.writeRoom(tx, roomId, base.date, undefined, userId, 'reset');
    });
  }

  async listRateUpdates(): Promise<RoomRateChange[]> {
    const result = await this.pool.request().query(`
SELECT TOP (${MAX_HISTORY + 1}) ${rateColumns}
FROM juyo_api.RateUpdate u JOIN juyo.RoomType t ON t.RoomTypeId = u.RoomTypeId ORDER BY u.AppliedSequence;`);
    if (result.recordset.length > MAX_HISTORY)
      reject(413, 'HISTORY_LIMIT', 'The rate-update history exceeds the supported workspace size.');
    return result.recordset.map(rateChange);
  }

  async getRateUpdate(id: string): Promise<RoomRateChange | null> {
    if (!uuid(id)) return null;
    const result = await this.pool.request().input('id', sql.UniqueIdentifier, id).query(`
SELECT ${rateColumns} FROM juyo_api.RateUpdate u
JOIN juyo.RoomType t ON t.RoomTypeId = u.RoomTypeId WHERE u.Id = @id;`);
    return result.recordset[0] ? rateChange(result.recordset[0]) : null;
  }

  async createRateUpdate(request: RoomRateUpdateRequest, userId: string): Promise<RoomRateChange> {
    if (!isRateUpdateRequest(request))
      reject(
        422,
        'INVALID_RATE_UPDATE',
        'Choose a valid interval and nightly rate between €0.01 and €10,000.',
      );
    return this.transaction((tx) => this.createRateUpdateInTransaction(tx, request, userId));
  }

  private async createRateUpdateInTransaction(
    tx: sql.Transaction,
    request: RoomRateUpdateRequest,
    userId: string,
  ): Promise<RoomRateChange> {
    await this.lockRateType(tx, request.hotelId, request.roomTypeId);
    const id = randomUUID();
    const result = await tx
      .request()
      .input('id', sql.UniqueIdentifier, id)
      .input('hotelId', sql.VarChar(64), request.hotelId)
      .input('roomTypeId', sql.VarChar(64), request.roomTypeId)
      .input('from', sql.Date, request.startDate)
      .input('through', sql.Date, request.endDate)
      .input('rate', sql.Decimal(19, 2), request.nightlyRate)
      .input('eventId', sql.VarChar(64), request.eventId ?? null)
      .input('reason', sql.NVarChar(240), request.reason?.trim() || null)
      .input('userId', sql.UniqueIdentifier, userId)
      .query(
        `
IF NOT EXISTS (SELECT 1 FROM juyo.RoomType WHERE RoomTypeId = @roomTypeId AND HotelId = @hotelId)
  THROW 51001, 'Choose a valid hotel and room type.', 1;
IF NOT EXISTS (SELECT 1 FROM juyo.SourceImport WHERE @from >= PeriodStartDate AND @through <= PeriodEndDate)
  THROW 51001, 'Choose dates within the reporting calendar.', 1;
IF @eventId IS NOT NULL AND NOT EXISTS (SELECT 1 FROM juyo.HotelEvent WHERE EventId = @eventId)
  THROW 51001, 'Choose a valid optional event.', 1;
INSERT juyo_api.RateUpdate(Id,RoomTypeId,StartDate,EndDate,NightlyRate,EventId,Reason,AppliedBy)
VALUES (@id,@roomTypeId,@from,@through,@rate,@eventId,@reason,@userId);
SELECT ${rateColumns} FROM juyo_api.RateUpdate u
JOIN juyo.RoomType t ON t.RoomTypeId = u.RoomTypeId WHERE u.Id = @id;`,
      )
      .catch((error) => {
        if (error?.number === 51001) reject(422, 'INVALID_RATE_UPDATE', error.message);
        throw error;
      });
    return rateChange(result.recordset[0]);
  }

  /** All writers take the same type lock, including direct manual updates. */
  private async lockRateType(
    tx: sql.Transaction,
    hotelId: string,
    roomTypeId: string,
  ): Promise<void> {
    const result = await tx
      .request()
      .input('hotelId', sql.VarChar(64), hotelId)
      .input('roomTypeId', sql.VarChar(64), roomTypeId).query(`
SELECT RoomTypeId FROM juyo.RoomType WITH (UPDLOCK,HOLDLOCK)
WHERE RoomTypeId=@roomTypeId AND HotelId=@hotelId
  AND RoomTypeId COLLATE Latin1_General_100_BIN2=@roomTypeId
  AND HotelId COLLATE Latin1_General_100_BIN2=@hotelId;`);
    if (!result.recordset.length)
      reject(422, 'INVALID_RATE_UPDATE', 'Choose a valid hotel and room type.');
  }

  /** Validate every reviewed quote before inserting any row; one transaction owns the decision. */
  private async applyRateBatchInTransaction(
    tx: sql.Transaction,
    updates: RateUpdateReviewItem[],
    userId: string,
  ): Promise<void> {
    if (!isRateUpdateBatch(updates))
      reject(422, 'INVALID_RATE_BATCH', 'Choose up to 20 valid, non-overlapping price changes.');
    // A consistent lock order prevents opposing multi-type batches from deadlocking each other.
    const targets = new Map(
      updates.map((row) => [JSON.stringify([row.roomTypeId, row.hotelId]), row]),
    );
    for (const key of [...targets.keys()].sort()) {
      const row = targets.get(key)!;
      await this.lockRateType(tx, row.hotelId, row.roomTypeId);
    }
    for (const row of updates) {
      const result = await tx
        .request()
        .input('roomTypeId', sql.VarChar(64), row.roomTypeId)
        .input('from', sql.Date, row.startDate)
        .input('through', sql.Date, row.endDate)
        .input('eventId', sql.VarChar(64), row.eventId ?? null)
        .query(
          `
IF NOT EXISTS (SELECT 1 FROM juyo.SourceImport WHERE @from>=PeriodStartDate AND @through<=PeriodEndDate)
  THROW 51001, 'Choose dates within the reporting calendar.', 1;
IF @eventId IS NOT NULL AND NOT EXISTS (SELECT 1 FROM juyo.HotelEvent WHERE EventId=@eventId)
  THROW 51001, 'Choose a valid optional event.', 1;
SELECT CONVERT(char(10), q.StayDate, 23) AS date,
  COALESCE(currentRate.NightlyRate,q.NightlyRate) AS nightlyRate
FROM juyo.RoomDailyRate q OUTER APPLY (
  SELECT TOP (1) u.NightlyRate FROM juyo_api.RateUpdate u
  WHERE u.RoomTypeId=q.RoomTypeId AND q.StayDate BETWEEN u.StartDate AND u.EndDate
  ORDER BY u.AppliedSequence DESC
) currentRate
WHERE q.RoomTypeId=@roomTypeId AND q.StayDate BETWEEN @from AND @through ORDER BY q.StayDate;`,
        )
        .catch((error) => {
          if (error?.number === 51001) reject(422, 'INVALID_RATE_UPDATE', error.message);
          throw error;
        });
      const rates = result.recordset as { date: string; nightlyRate: number }[];
      const expectedDays =
        Math.round((Date.parse(row.endDate) - Date.parse(row.startDate)) / 86_400_000) + 1;
      if (
        rates.length !== expectedDays ||
        rateVersion(rates) !== row.expectedRateVersion ||
        Math.min(...rates.map((rate) => rate.nightlyRate)) !== row.currentMinRate ||
        Math.max(...rates.map((rate) => rate.nightlyRate)) !== row.currentMaxRate
      )
        reject(
          409,
          'STALE_RATE_PROPOSAL',
          'Rates changed since this proposal was prepared. Ask Kassandra to prepare it again.',
        );
    }
    for (const row of updates) await this.createRateUpdateInTransaction(tx, row, userId);
  }

  private async lockUser(tx: sql.Transaction, userId: string): Promise<void> {
    const result = await tx.request().input('userId', sql.UniqueIdentifier, userId).query(`
SELECT Id FROM juyo_api.ApiUser WITH (UPDLOCK,HOLDLOCK) WHERE Id = @userId AND Disabled = 0;`);
    if (!result.recordset.length) reject(401, 'UNAUTHENTICATED', 'Sign in to continue.');
  }

  async listConversations(userId: string): Promise<Conversation[]> {
    return this.transaction(async (tx) => {
      await this.lockUser(tx, userId);
      const result = await tx.request().input('userId', sql.UniqueIdentifier, userId).query(`
SELECT TOP (${MAX_CONVERSATIONS}) ${conversationColumns}
FROM juyo_api.Conversation c WHERE c.UserId = @userId ORDER BY c.UpdatedAt DESC,c.Id;
SELECT m.ConversationId AS conversationId,m.Id AS id,m.RoleCode AS role,m.Content AS content,
 m.InsightJson AS insightJson,m.CreatedAt AS createdAt
FROM juyo_api.Message m JOIN (
 SELECT TOP (${MAX_CONVERSATIONS}) Id FROM juyo_api.Conversation
 WHERE UserId = @userId ORDER BY UpdatedAt DESC,Id
) c ON c.Id = m.ConversationId ORDER BY m.ConversationId,m.Ordinal;`);
      const sets = result.recordsets as sql.IRecordSet<Row>[];
      const grouped = new Map<string, Message[]>();
      for (const row of sets[1]) {
        const key = String(row.conversationId).toLowerCase();
        const values = grouped.get(key) ?? [];
        values.push(message(row));
        grouped.set(key, values);
      }
      return sets[0].map((row) =>
        conversation(row, grouped.get(String(row.id).toLowerCase()) ?? []),
      );
    });
  }

  private async readConversation(
    tx: sql.Transaction,
    userId: string,
    id: string,
  ): Promise<Conversation | null> {
    const result = await tx
      .request()
      .input('userId', sql.UniqueIdentifier, userId)
      .input('id', sql.UniqueIdentifier, id).query(`
SELECT ${conversationColumns} FROM juyo_api.Conversation c WHERE c.Id = @id AND c.UserId = @userId;
SELECT m.Id AS id,m.RoleCode AS role,m.Content AS content,m.InsightJson AS insightJson,m.CreatedAt AS createdAt
FROM juyo_api.Message m JOIN juyo_api.Conversation c ON c.Id = m.ConversationId
WHERE c.Id = @id AND c.UserId = @userId ORDER BY m.Ordinal;`);
    const sets = result.recordsets as sql.IRecordSet<Row>[];
    return sets[0][0] ? conversation(sets[0][0], sets[1].map(message)) : null;
  }

  async getConversation(userId: string, id: string): Promise<Conversation | null> {
    if (!uuid(id)) return null;
    return this.transaction(async (tx) => {
      await this.lockUser(tx, userId);
      return this.readConversation(tx, userId, id);
    });
  }

  async createConversation(
    userId: string,
    request: CreateConversationRequest,
  ): Promise<Conversation> {
    if (
      !request ||
      typeof request.title !== 'string' ||
      !request.title.trim() ||
      request.title.length > 100 ||
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(request.month) ||
      !validDate(request.roomDate) ||
      typeof request.propertyId !== 'string' ||
      !request.propertyId ||
      request.propertyId.length > 64
    )
      reject(422, 'INVALID_CONVERSATION', 'Choose a valid hotel and reporting context.');
    return this.transaction(async (tx) => {
      await this.lockUser(tx, userId);
      const id = randomUUID();
      await tx
        .request()
        .input('id', sql.UniqueIdentifier, id)
        .input('userId', sql.UniqueIdentifier, userId)
        .input('title', sql.NVarChar(100), request.title.trim())
        .input(
          'hotelId',
          sql.VarChar(64),
          request.propertyId === 'portfolio' ? null : request.propertyId,
        )
        .input('month', sql.Char(7), request.month)
        .input('roomDate', sql.Date, request.roomDate)
        .query(
          `
IF @hotelId IS NOT NULL AND NOT EXISTS (SELECT 1 FROM juyo.Hotel WHERE HotelId = @hotelId)
  THROW 51002, 'Choose a valid hotel.', 1;
IF NOT EXISTS (SELECT 1 FROM juyo.CalendarDate WHERE [Date] = @roomDate)
 OR NOT EXISTS (SELECT 1 FROM juyo.CalendarDate WHERE CONVERT(char(7),[Date],120) = @month)
  THROW 51002, 'Choose a valid reporting context.', 1;
INSERT juyo_api.Conversation(Id,UserId,Title,HotelId,ReportingMonth,RoomDate,DataVersion)
SELECT @id,@userId,@title,@hotelId,@month,@roomDate,SchemaVersion
FROM (SELECT TOP (1) SchemaVersion FROM juyo.SourceImport ORDER BY ImportedAtUtc DESC,ImportId) source;
DECLARE @Old TABLE(Id uniqueidentifier PRIMARY KEY);
INSERT @Old SELECT Id FROM juyo_api.Conversation WHERE UserId = @userId AND Id <> @id
ORDER BY UpdatedAt DESC,Id OFFSET ${MAX_CONVERSATIONS - 1} ROWS;
DELETE m FROM juyo_api.Message m JOIN @Old old ON old.Id = m.ConversationId;
DELETE c FROM juyo_api.Conversation c JOIN @Old old ON old.Id = c.Id;`,
        )
        .catch((error) => {
          if (error?.number === 51002) reject(422, 'INVALID_CONVERSATION', error.message);
          throw error;
        });
      return (await this.readConversation(tx, userId, id))!;
    });
  }

  async deleteConversation(userId: string, id: string): Promise<boolean> {
    if (!uuid(id)) return false;
    return this.transaction(async (tx) => {
      await this.lockUser(tx, userId);
      const result = await tx
        .request()
        .input('userId', sql.UniqueIdentifier, userId)
        .input('id', sql.UniqueIdentifier, id).query(`
DELETE m FROM juyo_api.Message m JOIN juyo_api.Conversation c ON c.Id = m.ConversationId
WHERE c.Id = @id AND c.UserId = @userId;
DELETE juyo_api.Conversation WHERE Id = @id AND UserId = @userId;
SELECT @@ROWCOUNT AS deleted;`);
      return result.recordset[0].deleted === 1;
    });
  }

  /** The decision and its room/rate write commit together; retries cannot apply a proposal twice. */
  async confirmChatAction(
    userId: string,
    conversationId: string,
    actionId: string,
    decision: 'apply' | 'cancel',
  ): Promise<Conversation> {
    if (!uuid(conversationId) || !uuid(actionId))
      reject(404, 'CHAT_ACTION_NOT_FOUND', 'This proposed change was not found.');
    if (decision !== 'apply' && decision !== 'cancel')
      reject(422, 'INVALID_CHAT_DECISION', 'Choose Apply or Cancel.');
    return this.transaction(async (tx) => {
      // All conversation mutations take this lock first. Other users cannot access the proposal.
      await this.lockUser(tx, userId);
      const current = await this.readConversation(tx, userId, conversationId);
      if (!current) reject(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found.');
      const proposed = current.messages.find(
        (item) => item.role === 'assistant' && item.action?.id === actionId,
      );
      if (!proposed?.action)
        reject(404, 'CHAT_ACTION_NOT_FOUND', 'This proposed change was not found.');
      const action = proposed.action;
      const status = decision === 'apply' ? 'applied' : 'cancelled';
      if (action.status === status) return current;
      if (action.status !== 'pending')
        reject(409, 'CHAT_ACTION_ALREADY_DECIDED', 'This proposed change was already handled.');
      if (decision === 'apply') {
        if (action.kind === 'rate_batch_update')
          await this.applyRateBatchInTransaction(tx, action.details.updates, userId);
        else if (action.kind === 'rate_update')
          await this.createRateUpdateInTransaction(tx, action.details, userId);
        else
          await this.applyRoomActionInTransaction(
            tx,
            action.details.roomId,
            action.details.action,
            userId,
            action.details.date,
          );
      }
      const payload = encodeMessagePayload({
        ...proposed,
        action: { ...action, status },
      });
      await withSqlTextParameters(tx, { payload }, (request, text) =>
        request
          .input('userId', sql.UniqueIdentifier, userId)
          .input('conversationId', sql.UniqueIdentifier, conversationId)
          .input('messageId', sql.UniqueIdentifier, proposed.id).query(`
UPDATE m SET InsightJson = ${text.payload}
FROM juyo_api.Message m JOIN juyo_api.Conversation c ON c.Id = m.ConversationId
WHERE m.Id = @messageId AND c.Id = @conversationId AND c.UserId = @userId;
UPDATE juyo_api.Conversation SET UpdatedAt = SYSUTCDATETIME()
WHERE Id = @conversationId AND UserId = @userId;`),
      );
      return (await this.readConversation(tx, userId, conversationId))!;
    });
  }

  /** Server-generated question/answer pairs are committed and trimmed atomically. */
  async appendMessages(
    userId: string,
    id: string,
    messages: readonly Message[],
  ): Promise<Conversation> {
    if (!uuid(id)) reject(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found.');
    if (
      messages.length !== 2 ||
      messages[0].role !== 'user' ||
      messages[1].role !== 'assistant' ||
      messages.some(
        (item) =>
          !uuid(item.id) ||
          typeof item.content !== 'string' ||
          item.content.length > 10_000 ||
          !Number.isFinite(Date.parse(item.createdAt)) ||
          (item.action !== undefined &&
            (item.role !== 'assistant' ||
              !isChatAction(item.action) ||
              item.action.status !== 'pending')) ||
          Buffer.byteLength(encodeMessagePayload(item) ?? '', 'utf16le') > 262144,
      )
    )
      reject(
        422,
        'INVALID_MESSAGE',
        'A message must contain a valid question and assistant response.',
      );
    return this.transaction(async (tx) => {
      await this.lockUser(tx, userId);
      const current = await this.readConversation(tx, userId, id);
      if (!current) reject(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found.');
      if (
        messages.some(
          (item) =>
            item.action && current.messages.some((saved) => saved.action?.id === item.action!.id),
        )
      )
        reject(
          409,
          'DUPLICATE_CHAT_ACTION',
          'This proposed change is already in the conversation.',
        );
      for (const item of messages) {
        await withSqlTextParameters(
          tx,
          { content: item.content, insight: encodeMessagePayload(item) },
          (request, text) =>
            request
              .input('id', sql.UniqueIdentifier, item.id)
              .input('conversationId', sql.UniqueIdentifier, id)
              .input('role', sql.VarChar(16), item.role)
              .input('createdAt', sql.DateTime2(3), new Date(item.createdAt)).query(`
INSERT juyo_api.Message(Id,ConversationId,Ordinal,RoleCode,Content,InsightJson,CreatedAt)
SELECT @id,@conversationId,COALESCE(MAX(Ordinal),0)+1,@role,${text.content},${text.insight},@createdAt
FROM juyo_api.Message WHERE ConversationId = @conversationId;`),
        );
      }
      await tx.request().input('id', sql.UniqueIdentifier, id).query(`
DELETE FROM juyo_api.Message WHERE ConversationId = @id
AND Ordinal <= (SELECT MAX(Ordinal)-${MAX_MESSAGES} FROM juyo_api.Message WHERE ConversationId = @id);
UPDATE juyo_api.Conversation SET UpdatedAt = SYSUTCDATETIME() WHERE Id = @id;`);
      return (await this.readConversation(tx, userId, id))!;
    });
  }
}
