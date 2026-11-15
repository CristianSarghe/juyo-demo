import type { DateRange, HotelId, HousekeepingState, Room, RoomOccupancy } from './network.models';
import type { ReportingMonth, PropertyScope } from './network.models';

export type ManagedRoomStatus = RoomOccupancy | 'reserved';
export type RoomOperationAction =
  | 'clean'
  | 'dirty'
  | 'reserve'
  | 'out_of_service'
  | 'available'
  | 'reset';

export interface ManagedRoom extends Room {
  readonly status: ManagedRoomStatus;
  readonly hasChanges: boolean;
}

export interface RoomOperationChange {
  readonly roomId: string;
  readonly date: string;
  readonly housekeeping?: HousekeepingState;
  readonly status?: 'available' | 'reserved' | 'out_of_service';
  readonly appliedAt: string;
}

/** An event is optional context, never a prerequisite or a date boundary. */
export interface RoomRateUpdateRequest extends DateRange {
  readonly hotelId: HotelId;
  readonly roomTypeId: string;
  readonly nightlyRate: number;
  readonly eventId?: string | null;
  readonly reason?: string;
}

export interface RoomRateChange extends RoomRateUpdateRequest {
  readonly id: string;
  readonly appliedAt: string;
}

export interface RoomRateDay {
  readonly date: string;
  readonly nightlyRate: number;
  readonly seedRate: number;
  readonly availableRooms: number;
  readonly sellableRooms: number;
  readonly bookedRooms: number;
  readonly heldRooms: number;
  readonly eventId?: string;
  readonly reason?: string;
  readonly updated: boolean;
}

export interface CreateConversationRequest {
  readonly title: string;
  readonly propertyId: PropertyScope;
  readonly month: ReportingMonth;
  readonly roomDate: string;
}
export interface SendMessageRequest {
  readonly content: string;
  readonly context?: {
    readonly propertyId: PropertyScope;
    readonly startDate: string;
    readonly endDate: string;
  };
}
