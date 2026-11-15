import { reportingDatesFor } from './network.selectors';
import type { HotelId, HotelNetwork, Reservation, ReservationNight } from './network.models';

export interface BookingRatePriceBucket {
  readonly nightlyRate: number;
  readonly roomNights: number;
}

export interface BookingRateHistoryDay {
  readonly date: string;
  /** Accepted room-night revenue / accepted room nights, rounded to EUR cents. */
  readonly weightedRate: number | null;
  readonly bookedRoomNights: number;
  readonly bookedRevenue: number;
  readonly rateCount: number;
  readonly priceBuckets: readonly BookingRatePriceBucket[];
}

export interface BookingRateHistorySource {
  readonly reservations: readonly Reservation[];
  readonly nights: readonly ReservationNight[];
  readonly dates: readonly string[];
  readonly asOf: string;
}

const acceptedStatuses = new Set<Reservation['status']>(['confirmed', 'checked_in', 'checked_out']);

/**
 * By stay date, not booking date. Every accepted room night carries one weight,
 * so a price with three booked rooms contributes three times a price with one.
 * Future dates contain existing bookings only; an empty date has no rate.
 * Selling-rate changes never rewrite this immutable reservation-night ledger.
 */
export function aggregateBookingRateHistory(
  hotelId: HotelId,
  roomTypeId: string,
  source: BookingRateHistorySource,
): BookingRateHistoryDay[] {
  const selectedDates = new Set(source.dates);
  const accepted = new Map(
    source.reservations
      .filter(
        (reservation) =>
          reservation.hotelId === hotelId &&
          reservation.roomTypeId === roomTypeId &&
          reservation.roomId !== null &&
          acceptedStatuses.has(reservation.status) &&
          reservation.bookedOn <= source.asOf &&
          (!reservation.cancelledOn || reservation.cancelledOn > source.asOf),
      )
      .map((reservation) => [reservation.id, reservation]),
  );
  const totals = new Map<string, { cents: number; nights: number; prices: Map<number, number> }>();
  for (const night of source.nights) {
    const reservation = accepted.get(night.reservationId);
    if (
      !reservation ||
      night.hotelId !== hotelId ||
      night.roomId !== reservation.roomId ||
      !selectedDates.has(night.date) ||
      night.date < reservation.arrival ||
      night.date >= reservation.departure
    )
      continue;
    const cents = Math.round(night.roomRevenue * 100);
    const total = totals.get(night.date) ?? { cents: 0, nights: 0, prices: new Map() };
    total.cents += cents;
    total.nights++;
    total.prices.set(cents, (total.prices.get(cents) ?? 0) + 1);
    totals.set(night.date, total);
  }
  return source.dates.map((date) => {
    const total = totals.get(date);
    return {
      date,
      weightedRate: total ? Math.round(total.cents / total.nights) / 100 : null,
      bookedRoomNights: total?.nights ?? 0,
      bookedRevenue: (total?.cents ?? 0) / 100,
      rateCount: total?.prices.size ?? 0,
      priceBuckets: [...(total?.prices ?? new Map<number, number>())]
        .sort(([left], [right]) => left - right)
        .map(([cents, roomNights]) => ({ nightlyRate: cents / 100, roomNights })),
    };
  });
}

/** Bind accepted-price history to one API snapshot, independent of edit dates. */
export function createBookingRateHistory(data: HotelNetwork) {
  const source: BookingRateHistorySource = {
    reservations: data.reservations,
    nights: data.reservationNights,
    dates: reportingDatesFor(data.meta.reportingPeriod),
    asOf: data.bookingSnapshot.asOf,
  };
  return (hotelId: HotelId, roomTypeId: string): BookingRateHistoryDay[] => {
    if (!data.roomTypes.some((type) => type.hotelId === hotelId && type.id === roomTypeId))
      throw new RangeError('Choose a valid hotel and room type.');
    return aggregateBookingRateHistory(hotelId, roomTypeId, source);
  };
}
