import type { HotelNetwork, Room, RoomType } from '../app/core/network.models';
import { emptyNetworkData, hotel, referenceData, secondHotel } from './fixtures';

export const roomType: RoomType = {
  id: 'ber-classic',
  hotelId: hotel.id,
  name: 'Classic',
  inventory: 4,
  maxAdults: 2,
  maxChildren: 0,
  areaM2: 24,
  baseRate: 150,
  facilities: ['wifi'],
};

/** Small independent inventory: two free rooms, one booked, one blocked, plus another hotel. */
export function roomNetwork(): HotelNetwork {
  const data = emptyNetworkData();
  const date = referenceData.bookingSnapshot.asOf;
  const room = (number: string, values: Partial<Room> = {}): Room => ({
    id: `ber-room-${number}`,
    hotelId: hotel.id,
    roomTypeId: roomType.id,
    number,
    floor: 1,
    occupancy: 'available',
    housekeeping: 'dirty',
    maintenance: 'none',
    maintenanceNote: null,
    date,
    basis: 'scheduled',
    ...values,
  });
  data.roomTypes = [structuredClone(roomType)];
  data.rooms = [
    room('101'),
    room('102', { occupancy: 'occupied', housekeeping: 'clean' }),
    room('103', { housekeeping: 'inspected' }),
    room('104', {
      occupancy: 'out_of_service',
      maintenance: 'in_progress',
      maintenanceNote: 'Ventilation repair',
    }),
    room('201', {
      id: 'ams-room-201',
      hotelId: secondHotel.id,
      roomTypeId: 'ams-classic',
      housekeeping: 'clean',
    }),
  ];
  const dates = ['2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16'];
  data.dailyRoomStates = dates.flatMap((stayDate) =>
    data.rooms.map((physical) => ({
      roomId: physical.id,
      hotelId: physical.hotelId,
      date: stayDate,
      occupancy: physical.occupancy,
      housekeeping: physical.housekeeping,
      maintenance: physical.maintenance,
      maintenanceNote: physical.maintenanceNote,
      basis: stayDate < date ? ('actual' as const) : ('scheduled' as const),
    })),
  );
  data.roomRates = dates.map((stayDate, index) => ({
    hotelId: hotel.id,
    roomTypeId: roomType.id,
    date: stayDate,
    nightlyRate: 145 + index * 5,
    currency: 'EUR',
  }));
  return data;
}
