import { describe, expect, it } from 'vitest';
import { hotel, secondHotel } from '../../testing/fixtures';
import { roomType } from '../../testing/room-fixtures';
import type { Reservation, ReservationNight } from './network.models';
import { aggregateBookingRateHistory } from './room-price-history';

const date = '2026-11-18';
function booking(
  id: string,
  nightlyRate: number,
  overrides: Partial<Reservation> = {},
): Reservation {
  return {
    id,
    hotelId: hotel.id,
    roomTypeId: roomType.id,
    roomId: `room-${id}`,
    guestRef: `guest-${id}`,
    channel: 'direct',
    status: 'confirmed',
    arrival: date,
    departure: '2026-11-19',
    adults: 1,
    children: 0,
    roomRevenue: nightlyRate,
    currency: 'EUR',
    bookedOn: '2026-11-10',
    cancelledOn: null,
    quotedNightlyRate: nightlyRate,
    quotedRevenue: nightlyRate,
    ...overrides,
  };
}
function night(reservation: Reservation): ReservationNight {
  return {
    reservationId: reservation.id,
    hotelId: reservation.hotelId,
    roomId: reservation.roomId!,
    date,
    channel: reservation.channel,
    roomRevenue: reservation.quotedNightlyRate,
  };
}
function history(reservations: Reservation[], dates = [date]) {
  return aggregateBookingRateHistory(hotel.id, roomType.id, {
    reservations,
    nights: reservations.map(night),
    dates,
    asOf: '2026-11-14',
  });
}

describe('Booked room-price history', () => {
  it('places the average exactly at the booked price when all sales have one price', () => {
    expect(history([booking('1', 198.9), booking('2', 198.9)])[0]).toEqual({
      date,
      weightedRate: 198.9,
      bookedRoomNights: 2,
      bookedRevenue: 397.8,
      rateCount: 1,
      priceBuckets: [{ nightlyRate: 198.9, roomNights: 2 }],
    });
  });

  it('weights each price by its booked room nights instead of averaging distinct prices', () => {
    const row = history([
      booking('1', 100),
      booking('2', 200),
      booking('3', 200),
      booking('4', 200),
    ])[0];
    expect(row.weightedRate).toBe(175);
    expect(row.bookedRevenue).toBe(700);
    expect(row.bookedRoomNights).toBe(4);
    expect(row.priceBuckets).toEqual([
      { nightlyRate: 100, roomNights: 1 },
      { nightlyRate: 200, roomNights: 3 },
    ]);
  });

  it('scopes accepted bookings to the hotel/type and keeps unbooked dates as gaps', () => {
    const rows = history(
      [
        booking('accepted', 150),
        booking('cancelled', 250, { status: 'cancelled', cancelledOn: '2026-11-12' }),
        booking('other-hotel', 300, { hotelId: secondHotel.id }),
        booking('other-type', 350, { roomTypeId: 'other-type' }),
      ],
      [date, '2026-11-19'],
    );

    expect(rows[0].weightedRate).toBe(150);
    expect(rows[0].bookedRoomNights).toBe(1);
    expect(rows[1]).toEqual({
      date: '2026-11-19',
      weightedRate: null,
      bookedRoomNights: 0,
      bookedRevenue: 0,
      rateCount: 0,
      priceBuckets: [],
    });
  });
});
