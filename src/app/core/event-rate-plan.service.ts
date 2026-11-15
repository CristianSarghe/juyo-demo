import {
  DateRange,
  HotelEvent,
  HotelNetwork,
  RoomType,
  UpcomingHotelEvent,
} from './network.models';
import { createNetworkSelectors } from './network.selectors';

const dayMs = 86_400_000;

export interface EventRateContext {
  startDate: string;
  endDate: string;
  nights: number;
  availableRoomNights: number;
  bookedRoomNights: number;
  sellableRoomNights: number;
  bookedOccupancy: number;
  baseRate: number;
}

/** Bind event-demand calculations to the current API snapshot. */
export function createEventRateContext(data: HotelNetwork) {
  const BOOKING_SNAPSHOT = data.bookingSnapshot;
  const { hotelInventory, validateDateRange } = createNetworkSelectors(data);
  /** Event-demand context only. Selling-rate updates belong to RoomRateService. */
  function eventRateContext(
    event: HotelEvent,
    type: RoomType,
    selection?: DateRange,
  ): EventRateContext | null {
    const firstDate =
      event.startDate < BOOKING_SNAPSHOT.asOf ? BOOKING_SNAPSHOT.asOf : event.startDate;
    if (firstDate > event.endDate) return null;
    const range = validateDateRange(selection ?? { startDate: firstDate, endDate: event.endDate });
    if (range.startDate < firstDate || range.endDate > event.endDate) {
      throw new RangeError('Rate dates must fall within the current or future event nights.');
    }
    let availableRoomNights = 0;
    let bookedRoomNights = 0;
    let sellableRoomNights = 0;
    const start = Date.parse(`${range.startDate}T12:00:00Z`);
    const end = Date.parse(`${range.endDate}T12:00:00Z`);
    for (let timestamp = start; timestamp <= end; timestamp += dayMs) {
      const date = new Date(timestamp).toISOString().slice(0, 10);
      for (const room of hotelInventory(type.hotelId, date)) {
        if (room.roomTypeId !== type.id || room.occupancy === 'out_of_service') continue;
        sellableRoomNights++;
        if (room.occupancy === 'available') availableRoomNights++;
        else bookedRoomNights++;
      }
    }
    return {
      ...range,
      nights: Math.round((end - start) / dayMs) + 1,
      availableRoomNights,
      bookedRoomNights,
      sellableRoomNights,
      bookedOccupancy: sellableRoomNights ? (bookedRoomNights / sellableRoomNights) * 100 : 0,
      baseRate: type.baseRate,
    };
  }

  return eventRateContext;
}

/** Deliberately transparent local rule, not a live AI revenue-management model. */
export function suggestEventRate(
  context: EventRateContext,
  importance: UpcomingHotelEvent['importance'],
): { nightlyRate: number; explanation: string } {
  const eventAdjustment = { mild: 0, medium: 4, important: 8 }[importance];
  const demandAdjustment =
    context.bookedOccupancy >= 85 ? 4 : context.bookedOccupancy < 55 ? -4 : 0;
  const increase = Math.max(0, eventAdjustment + demandAdjustment);
  const nightlyRate =
    increase === 0 ? context.baseRate : Math.round(context.baseRate * (1 + increase / 100));
  return {
    nightlyRate,
    explanation: `Rule-based suggestion: ${importance} event, ${Math.round(context.bookedOccupancy)}% booked. ${increase ? `${increase}% above` : 'Keep'} the base rate.`,
  };
}
