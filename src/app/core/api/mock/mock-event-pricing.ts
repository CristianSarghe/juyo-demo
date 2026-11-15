import type { ChatAction, Message } from '../../models';
import type { RateUpdateReviewItem } from '../mutation.models';
import { mockRateVersion } from './mock-rate-batch';
import { NETWORK_DATA } from '../../network.data';
import { createNetworkSelectors } from '../../network.selectors';
import { suggestEventRate } from '../../event-rate-plan.service';
import type { MockRoomRatesRepository } from './mock-room-rates.repository';
import { MockRepositoryError } from './mock-repository-error';

const selectors = createNetworkSelectors(NETWORK_DATA);
const prefix = 'Please prepare a room-price update for this event.';
const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0, 100);
const uuid = (value: unknown) =>
  typeof value === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);

/** Local fixture parity for the generated event command, not a general language parser. */
export function mockEventPricingReply(
  prompt: string,
  scope: string,
  rates: MockRoomRatesRepository,
): Pick<Message, 'content' | 'action' | 'sources'> | null {
  if (!prompt.startsWith(prefix + '\n')) return null;
  const lines = prompt.split('\n');
  const values = (key: string) =>
    lines.filter((line) => line.startsWith(key)).map((line) => line.slice(key.length).trim());
  const one = (key: string) => (values(key).length === 1 ? values(key)[0] : '');
  const event = NETWORK_DATA.events.find((item) => normalize(item.name) === one('Event: '));
  const names = values('Hotel: ');
  const hotels = names.map((name) =>
    NETWORK_DATA.hotels.find((item) => normalize(item.name) === name),
  );
  const interval = one('Stay dates: ').match(
    /^(\d{4}-\d{2}-\d{2}) through (\d{4}-\d{2}-\d{2}) \(inclusive\)$/,
  );
  if (
    !event ||
    !interval ||
    !hotels.length ||
    hotels.length > NETWORK_DATA.hotels.length ||
    new Set(names).size !== names.length ||
    hotels.some(
      (hotel) =>
        !hotel ||
        (scope !== 'portfolio' && hotel.id !== scope) ||
        !NETWORK_DATA.eventHotelImpacts.some(
          (impact) => impact.eventId === event.id && impact.hotelId === hotel.id,
        ),
    )
  )
    throw new MockRepositoryError(
      422,
      'INVALID_EVENT_PRICING',
      'Choose relevant hotels, an event and a valid stay interval.',
    );
  const requested = { startDate: interval[1], endDate: interval[2] };
  try {
    selectors.validateDateRange(requested);
  } catch {
    throw new MockRepositoryError(
      422,
      'INVALID_EVENT_PRICING',
      'Choose valid event dates inside the available calendar.',
    );
  }
  if (requested.startDate < event.startDate || requested.endDate > event.endDate)
    throw new MockRepositoryError(
      422,
      'INVALID_EVENT_PRICING',
      'The stay interval must fall within this event.',
    );
  const range = {
    startDate:
      requested.startDate < NETWORK_DATA.bookingSnapshot.asOf
        ? NETWORK_DATA.bookingSnapshot.asOf
        : requested.startDate,
    endDate: requested.endDate,
  };
  try {
    selectors.validateDateRange(range);
  } catch {
    throw new MockRepositoryError(
      422,
      'INVALID_EVENT_PRICING',
      'Choose current or future dates inside the available calendar.',
    );
  }
  if (range.startDate < event.startDate || range.endDate > event.endDate)
    throw new MockRepositoryError(
      422,
      'INVALID_EVENT_PRICING',
      'The stay interval must fall within this event.',
    );
  const updates: RateUpdateReviewItem[] = [];
  const skippedHotels: string[] = [];
  for (const hotel of hotels) {
    if (!hotel) continue;
    const impact = NETWORK_DATA.eventHotelImpacts.find(
      (item) => item.hotelId === hotel.id && item.eventId === event.id,
    )!;
    const previousCount = updates.length;
    let hotelAvailableRoomNights = 0;
    for (const type of NETWORK_DATA.roomTypes.filter((type) => type.hotelId === hotel.id)) {
      const days = rates.rows(hotel.id, type.id, range);
      const availableRoomNights = days.reduce((sum, day) => sum + day.availableRooms, 0);
      hotelAvailableRoomNights += availableRoomNights;
      const bookedRoomNights = days.reduce((sum, day) => sum + day.bookedRooms, 0);
      const sellableRoomNights = days.reduce((sum, day) => sum + day.sellableRooms, 0);
      const baseRate = days.reduce((sum, day) => sum + day.nightlyRate, 0) / days.length;
      const suggestion = suggestEventRate(
        {
          ...range,
          nights: days.length,
          availableRoomNights,
          bookedRoomNights,
          sellableRoomNights,
          bookedOccupancy: sellableRoomNights ? (bookedRoomNights / sellableRoomNights) * 100 : 0,
          baseRate,
        },
        impact.importance,
      );
      if (
        !availableRoomNights ||
        suggestion.nightlyRate > 10_000 ||
        Math.abs(suggestion.nightlyRate - baseRate) < 0.005
      )
        continue;
      const currentMaxRate = Math.max(...days.map((day) => day.nightlyRate));
      // The offline rule uses one band per type; its uplift must never reduce an existing peak quote.
      const nightlyRate = Math.max(suggestion.nightlyRate, currentMaxRate);
      updates.push({
        hotelId: hotel.id,
        roomTypeId: type.id,
        hotelName: hotel.name,
        roomTypeName: type.name,
        ...range,
        nightlyRate,
        currentMinRate: Math.min(...days.map((day) => day.nightlyRate)),
        currentMaxRate,
        expectedRateVersion: mockRateVersion(days),
        eventId: event.id,
        reason: `Event pricing: ${event.name}`.slice(0, 240),
      });
    }
    if (updates.length === previousCount)
      skippedHotels.push(
        hotelAvailableRoomNights
          ? `Kept current prices at ${hotel.name}: booked occupancy and the event's ${impact.importance} relevance do not support an increase within the allowed price limit.`
          : `Kept current prices at ${hotel.name}: no rooms are available to sell for this interval.`,
      );
  }
  const exclusions = skippedHotels.length ? ` ${skippedHotels.join(' ')}` : '';
  if (!updates.length)
    return {
      content: `The event and available inventory do not justify a price change for this interval. No changes were proposed.${exclusions}`,
    };
  if (updates.length > 20)
    throw new MockRepositoryError(
      422,
      'BATCH_LIMIT',
      'Choose fewer hotels or room types for one review.',
    );
  return {
    content: `Prepared ${updates.length} price ${updates.length === 1 ? 'change' : 'changes'} for ${event.name}, ${range.startDate} through ${range.endDate} (inclusive). The estimates use current selling rates, available rooms, booked occupancy and the stored event assessment. Review the current and proposed prices below before applying. Existing bookings keep their accepted rates.${exclusions}`,
    action: {
      id: crypto.randomUUID(),
      kind: 'rate_batch_update',
      status: 'pending',
      summary: `Review ${updates.length} event price ${updates.length === 1 ? 'change' : 'changes'}`,
      details: { updates },
    },
    sources: [
      `Current selling rates and availability · ${range.startDate}–${range.endDate}`,
      `Stored event assessment · ${event.name}`,
    ],
  };
}

/** Validate restored proposals before they can reach a mutation boundary. */
export function isMockEventRateAction(
  value: unknown,
): value is Extract<ChatAction, { kind: 'rate_update' }> {
  if (!value || typeof value !== 'object') return false;
  const action = value as Partial<ChatAction>;
  if (
    action.kind !== 'rate_update' ||
    !uuid(action.id) ||
    !['pending', 'applied', 'cancelled'].includes(action.status ?? '') ||
    typeof action.summary !== 'string' ||
    action.summary.length > 400 ||
    !action.details
  )
    return false;
  const d = action.details;
  const type = NETWORK_DATA.roomTypes.find(
    (item) => item.id === d.roomTypeId && item.hotelId === d.hotelId,
  );
  const event = NETWORK_DATA.events.find((item) => item.id === d.eventId);
  if (
    !type ||
    !event ||
    !NETWORK_DATA.eventHotelImpacts.some(
      (item) => item.eventId === event.id && item.hotelId === d.hotelId,
    ) ||
    typeof d.nightlyRate !== 'number' ||
    !Number.isFinite(d.nightlyRate) ||
    d.nightlyRate < 0.01 ||
    d.nightlyRate > 10_000 ||
    Math.abs(d.nightlyRate * 100 - Math.round(d.nightlyRate * 100)) > 1e-7 ||
    d.hotelName !== NETWORK_DATA.hotels.find((hotel) => hotel.id === d.hotelId)?.name ||
    d.roomTypeName !== type.name ||
    (d.reason !== undefined && (typeof d.reason !== 'string' || d.reason.length > 240))
  )
    return false;
  try {
    selectors.validateDateRange(d);
  } catch {
    return false;
  }
  return (
    d.startDate >= event.startDate &&
    d.startDate >= NETWORK_DATA.bookingSnapshot.asOf &&
    d.endDate <= event.endDate
  );
}
