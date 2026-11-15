import type {
  RateUpdateReviewItem,
  RoomRateChange,
  RoomRateDay,
  RoomRateUpdateRequest,
} from '../mutation.models';
import { mockBatchChangeIds, mockRateVersion, validMockRateUpdates } from './mock-rate-batch';
import { EVENTS, REPORTING_DATES, ROOM_RATES, ROOM_TYPES } from '../../network.data';
import type { DateRange, HotelId } from '../../network.models';
import { validateDateRange } from './fixture-selectors';
import { MockRoomOperationsRepository } from './mock-room-operations.repository';

const STORAGE_KEY = 'juyo.room-rates.v1';
const LEGACY_KEY = 'juyo.event-rate-plans.v1';
const seedRates = new Map(
  ROOM_RATES.map((rate) => [`${rate.roomTypeId}/${rate.date}`, rate.nightlyRate]),
);

function dates(range: DateRange): string[] {
  const checked = validateDateRange(range);
  return REPORTING_DATES.filter((date) => date >= checked.startDate && date <= checked.endDate);
}

function requestError(value: unknown): string {
  if (!value || typeof value !== 'object') return 'Choose a hotel and room type.';
  const request = value as Partial<RoomRateUpdateRequest>;
  if (
    !ROOM_TYPES.some((type) => type.id === request.roomTypeId && type.hotelId === request.hotelId)
  )
    return 'Choose a valid hotel and room type.';
  if (typeof request.startDate !== 'string' || typeof request.endDate !== 'string')
    return 'Choose valid start and end dates.';
  try {
    validateDateRange({ startDate: request.startDate, endDate: request.endDate });
  } catch {
    return 'Choose an interval from 1 Oct to 31 Dec 2026, with the end on or after the start.';
  }
  if (
    typeof request.nightlyRate !== 'number' ||
    !Number.isFinite(request.nightlyRate) ||
    request.nightlyRate <= 0 ||
    request.nightlyRate > 10_000 ||
    Math.abs(request.nightlyRate * 100 - Math.round(request.nightlyRate * 100)) > 1e-7
  )
    return 'Enter a rate between €0.01 and €10,000, with up to 2 decimals.';
  if (
    request.eventId !== undefined &&
    request.eventId !== null &&
    (typeof request.eventId !== 'string' || !EVENTS.some((event) => event.id === request.eventId))
  )
    return 'Choose a valid event or leave the event empty.';
  if (
    request.reason !== undefined &&
    (typeof request.reason !== 'string' || request.reason.length > 240)
  )
    return 'Keep the reason within 240 characters.';
  return '';
}

function normalized(request: RoomRateUpdateRequest): RoomRateUpdateRequest {
  return {
    hotelId: request.hotelId,
    roomTypeId: request.roomTypeId,
    startDate: request.startDate,
    endDate: request.endDate,
    nightlyRate: Math.round(request.nightlyRate * 100) / 100,
    ...(request.eventId ? { eventId: request.eventId } : {}),
    ...(request.reason?.trim() ? { reason: request.reason.trim() } : {}),
  };
}

function restoredChanges(): RoomRateChange[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      const stored: unknown = JSON.parse(raw);
      if (
        !stored ||
        typeof stored !== 'object' ||
        !('version' in stored) ||
        stored.version !== 1 ||
        !('updates' in stored) ||
        !Array.isArray(stored.updates)
      )
        return [];
      return stored.updates.flatMap((value: unknown) => {
        if (requestError(value)) return [];
        const row = value as RoomRateChange;
        if (
          typeof row.id !== 'string' ||
          !row.id ||
          typeof row.appliedAt !== 'string' ||
          !Number.isFinite(Date.parse(row.appliedAt))
        )
          return [];
        return [{ ...normalized(row), id: row.id, appliedAt: row.appliedAt }];
      });
    }
    const legacy: unknown = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? '[]');
    if (!Array.isArray(legacy)) return [];
    // Old proposals were event-bound. Import them once as dated rate updates in
    // timestamp order; stable source order breaks ties. The original key remains.
    return legacy
      .flatMap((value: unknown, index: number) => {
        if (requestError(value)) return [];
        const row = value as RoomRateUpdateRequest & { savedAt?: unknown; currency?: unknown };
        if (
          row.currency !== 'EUR' ||
          typeof row.savedAt !== 'string' ||
          !Number.isFinite(Date.parse(row.savedAt))
        )
          return [];
        return [{ ...normalized(row), id: `legacy-${index}`, appliedAt: row.savedAt }];
      })
      .sort((left, right) => Date.parse(left.appliedAt) - Date.parse(right.appliedAt));
  } catch {
    return [];
  }
}

/** Local selling rates. Booked reservations and financial ledgers stay immutable. */
export class MockRoomRatesRepository {
  private currentChanges: readonly RoomRateChange[] = restoredChanges();
  private currentError = '';
  private currentErrorStatus = 422;
  readonly changes = () => this.currentChanges;
  readonly error = () => this.currentError;
  readonly errorStatus = () => this.currentErrorStatus;

  constructor(
    private readonly operations: MockRoomOperationsRepository = new MockRoomOperationsRepository(),
  ) {}

  rows(hotelId: HotelId, roomTypeId: string, range: DateRange): RoomRateDay[] {
    if (!ROOM_TYPES.some((type) => type.id === roomTypeId && type.hotelId === hotelId))
      throw new RangeError('Choose a valid hotel and room type.');
    const selectedDates = dates(range);
    const changes = this.changes().filter(
      (change) => change.hotelId === hotelId && change.roomTypeId === roomTypeId,
    );
    return selectedDates.map((date) => {
      const seedRate = seedRates.get(`${roomTypeId}/${date}`);
      if (seedRate === undefined)
        throw new Error(`Missing canonical selling rate for ${roomTypeId}/${date}.`);
      let change: RoomRateChange | undefined;
      for (let index = changes.length - 1; index >= 0; index--) {
        if (changes[index].startDate <= date && changes[index].endDate >= date) {
          change = changes[index];
          break;
        }
      }
      const rooms = this.operations
        .rooms(hotelId, date)
        .filter((room) => room.roomTypeId === roomTypeId);
      const availableRooms = rooms.filter((room) => room.status === 'available').length;
      const sellableRooms = rooms.filter((room) => room.status !== 'out_of_service').length;
      return {
        date,
        seedRate,
        nightlyRate: change?.nightlyRate ?? seedRate,
        availableRooms,
        sellableRooms,
        bookedRooms: rooms.filter((room) => room.status === 'occupied').length,
        heldRooms: rooms.filter((room) => room.status === 'reserved').length,
        ...(change?.eventId ? { eventId: change.eventId } : {}),
        ...(change?.reason ? { reason: change.reason } : {}),
        updated: !!change,
      };
    });
  }

  update(request: RoomRateUpdateRequest, proposalId?: string): boolean {
    const invalid = requestError(request);
    if (invalid) return this.reject(invalid);
    if (proposalId !== undefined && !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(proposalId))
      return this.reject('Choose a valid proposal.', 422);
    const value = normalized(request);
    const previous = proposalId && this.changes().find((change) => change.id === proposalId);
    if (previous) {
      if (JSON.stringify(normalized(previous)) !== JSON.stringify(value))
        return this.reject('This proposal was already applied with different details.', 409);
      this.currentError = '';
      this.currentErrorStatus = 422;
      return true;
    }
    const change: RoomRateChange = {
      ...value,
      id: proposalId ?? crypto.randomUUID(),
      appliedAt: new Date().toISOString(),
    };
    // Array order is authoritative: a later application wins on every overlapping
    // date. Do not trim this history, which could discard an older effective day.
    return this.persist([...this.changes(), change]);
  }

  /** One storage write publishes every quoted change, with recoverable proposal IDs. */
  updateBatch(updates: readonly RateUpdateReviewItem[], proposalId: string): boolean {
    if (
      !validMockRateUpdates(updates) ||
      !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(proposalId)
    )
      return this.reject('Review a valid batch of up to 20 non-overlapping price changes.');
    const ids = mockBatchChangeIds(proposalId, updates.length);
    const previous = ids.map((id) => this.changes().find((change) => change.id === id));
    const persistedBatch = this.changes().filter((change) =>
      change.id.startsWith(proposalId.slice(0, 24)),
    );
    if (persistedBatch.length) {
      if (
        persistedBatch.length !== updates.length ||
        !previous.every(
          (change, index) =>
            change &&
            JSON.stringify(normalized(change)) === JSON.stringify(normalized(updates[index])),
        )
      )
        return this.reject('This batch was already handled with different details.', 409);
      this.currentError = '';
      return true;
    }
    for (const update of updates) {
      const current = this.rows(update.hotelId, update.roomTypeId, update);
      if (mockRateVersion(current) !== update.expectedRateVersion)
        return this.reject('Rates changed since this proposal. Ask Kassandra to refresh it.', 409);
    }
    const appliedAt = new Date().toISOString();
    const changes = updates.map((update, index) => ({
      ...normalized(update),
      id: ids[index],
      appliedAt,
    }));
    return this.persist([...this.changes(), ...changes]);
  }

  private persist(next: readonly RoomRateChange[]): boolean {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, updates: next }));
      this.currentChanges = next;
      this.currentError = '';
      this.currentErrorStatus = 422;
      return true;
    } catch {
      return this.reject(
        'Could not save on this device. Check browser storage and try again.',
        503,
      );
    }
  }

  private reject(message: string, status = 422): false {
    this.currentError = message;
    this.currentErrorStatus = status;
    return false;
  }
}
