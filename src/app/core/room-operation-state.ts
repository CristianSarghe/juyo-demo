import type { Room } from './network.models';
import type { ManagedRoom, RoomOperationChange } from './api/mutation.models';

export function applyRoomChange(room: Room, change?: RoomOperationChange): ManagedRoom {
  const status = change?.status ?? room.occupancy;
  return {
    ...room,
    occupancy: status === 'reserved' ? 'available' : status,
    status,
    housekeeping: change?.housekeeping ?? room.housekeeping,
    maintenance: change?.status
      ? change.status === 'out_of_service'
        ? 'reported'
        : 'none'
      : room.maintenance,
    maintenanceNote: change?.status
      ? change.status === 'out_of_service'
        ? 'Set out of service manually.'
        : null
      : room.maintenanceNote,
    hasChanges: !!change,
  };
}
