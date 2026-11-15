import { applyRoomChange } from '../../room-operation-state';
import type { ManagedRoom, RoomOperationAction, RoomOperationChange } from '../mutation.models';
import { BOOKING_SNAPSHOT } from '../../network.data';
import type { PropertyScope } from '../../network.models';
import { hotelInventory, validateDateRange } from './fixture-selectors';

const STORAGE_KEY = 'juyo.room-operations.v1';
const asOf = BOOKING_SNAPSHOT.asOf;
const canonicalRooms = hotelInventory('portfolio', asOf);
const roomById = new Map(canonicalRooms.map((room) => [room.id, room]));
const availabilityStates = ['available', 'reserved', 'out_of_service'] as const;

function restoredChanges(): RoomOperationChange[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (
      !stored ||
      typeof stored !== 'object' ||
      !('version' in stored) ||
      stored.version !== 1 ||
      !('changes' in stored) ||
      !Array.isArray(stored.changes) ||
      stored.changes.length > canonicalRooms.length
    )
      return [];
    const valid = new Map<string, RoomOperationChange>();
    for (const value of stored.changes) {
      if (!value || typeof value !== 'object') continue;
      const row = value as Partial<RoomOperationChange>;
      const room = typeof row.roomId === 'string' ? roomById.get(row.roomId) : undefined;
      if (
        !room ||
        row.date !== asOf ||
        typeof row.appliedAt !== 'string' ||
        !Number.isFinite(Date.parse(row.appliedAt)) ||
        (row.housekeeping !== undefined &&
          !['clean', 'dirty', 'inspected'].includes(row.housekeeping)) ||
        (row.status !== undefined && !availabilityStates.includes(row.status)) ||
        (room.occupancy === 'occupied' && row.status !== undefined) ||
        (row.housekeeping === undefined && row.status === undefined)
      )
        continue;
      valid.set(room.id, {
        roomId: room.id,
        date: asOf,
        appliedAt: row.appliedAt,
        ...(row.housekeeping !== undefined ? { housekeeping: row.housekeeping } : {}),
        ...(row.status !== undefined ? { status: row.status } : {}),
      });
    }
    return [...valid.values()];
  } catch {
    return [];
  }
}

/** Current-day operational changes, separate from accepted reservations and financial history. */
export class MockRoomOperationsRepository {
  private currentChanges: readonly RoomOperationChange[] = restoredChanges();
  private currentError = '';
  private currentErrorStatus = 409;
  readonly changes = () => this.currentChanges;
  readonly error = () => this.currentError;
  readonly errorStatus = () => this.currentErrorStatus;

  rooms(scope: PropertyScope = 'portfolio', date = asOf): ManagedRoom[] {
    validateDateRange({ startDate: date, endDate: date });
    const rooms = hotelInventory(scope, date);
    if (date !== asOf) return rooms.map((room) => applyRoomChange(room));
    const changes = new Map(this.changes().map((change) => [change.roomId, change]));
    return rooms.map((room) => applyRoomChange(room, changes.get(room.id)));
  }

  update(roomId: string, action: RoomOperationAction): boolean {
    const base = roomById.get(roomId);
    if (!base) return this.reject('Choose a valid room.');
    if (!['clean', 'dirty', 'reserve', 'out_of_service', 'available', 'reset'].includes(action))
      return this.reject('Choose a valid room action.');
    const previous = this.changes().find((change) => change.roomId === roomId);
    const current = applyRoomChange(base, previous);
    if (
      base.occupancy === 'occupied' &&
      (action === 'reserve' || action === 'out_of_service' || action === 'available')
    )
      return this.reject(
        'This room has a booking today. Move the booking before changing availability.',
      );
    if (action === 'reserve' && current.status === 'out_of_service')
      return this.reject('Return this room to service before reserving it.');

    let next = this.changes().filter((change) => change.roomId !== roomId);
    if (action !== 'reset') {
      const housekeeping =
        action === 'clean' ? 'clean' : action === 'dirty' ? 'dirty' : previous?.housekeeping;
      const status =
        action === 'reserve'
          ? 'reserved'
          : action === 'out_of_service' || action === 'available'
            ? action
            : previous?.status;
      const proposed: RoomOperationChange = {
        roomId,
        date: asOf,
        appliedAt: new Date().toISOString(),
        ...(housekeeping !== undefined && housekeeping !== base.housekeeping
          ? { housekeeping }
          : {}),
        ...(status !== undefined ? { status } : {}),
      };
      const effective = applyRoomChange(base, proposed);
      const sameAvailability =
        effective.status === base.occupancy &&
        effective.maintenance === base.maintenance &&
        effective.maintenanceNote === base.maintenanceNote;
      const { status: _status, ...withoutStatus } = proposed;
      const change: RoomOperationChange = sameAvailability ? withoutStatus : proposed;
      if (change.housekeeping !== undefined || change.status !== undefined)
        next = [...next, change];
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, changes: next }));
      this.currentChanges = next;
      this.currentError = '';
      this.currentErrorStatus = 409;
      return true;
    } catch {
      return this.reject('Could not save room changes on this device. Try again.', 503);
    }
  }

  private reject(message: string, status = 409): false {
    this.currentError = message;
    this.currentErrorStatus = status;
    return false;
  }
}
