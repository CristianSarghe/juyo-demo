import type { CollectionKey } from './api.models';
import { ApiError } from './api-client.service';

type Row = Record<string, unknown>;
const object = (value: unknown): value is Row =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const isoDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T12:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
};
const stringFields: Partial<Record<CollectionKey, readonly string[]>> = {
  roomTypes: ['id', 'hotelId', 'name'],
  rooms: [
    'id',
    'hotelId',
    'roomTypeId',
    'number',
    'occupancy',
    'housekeeping',
    'maintenance',
    'basis',
  ],
  dailyRoomStates: ['roomId', 'hotelId', 'occupancy', 'housekeeping', 'maintenance', 'basis'],
  roomRates: ['hotelId', 'roomTypeId', 'currency'],
  bookingPositions: ['hotelId', 'state'],
  reservationNights: ['reservationId', 'hotelId', 'roomId', 'channel'],
  reservations: ['id', 'hotelId', 'roomTypeId', 'guestRef', 'channel', 'status', 'currency'],
};
const dateFields: Partial<Record<CollectionKey, readonly string[]>> = {
  rooms: ['date'],
  dailyRoomStates: ['date'],
  roomRates: ['date'],
  bookingPositions: ['stayDate', 'capturedAsOf'],
  reservationNights: ['date'],
  reservations: ['arrival', 'departure', 'bookedOn'],
};
const numberFields: Partial<Record<CollectionKey, readonly string[]>> = {
  roomTypes: ['inventory', 'maxAdults', 'maxChildren', 'areaM2', 'baseRate'],
  rooms: ['floor'],
  roomRates: ['nightlyRate'],
  bookingPositions: ['roomsAvailable', 'targetRooms', 'targetRevenue'],
  reservationNights: ['roomRevenue'],
  reservations: ['adults', 'children', 'roomRevenue', 'quotedNightlyRate', 'quotedRevenue'],
};
const positionMetrics = [
  'actualRooms',
  'actualRoomRevenue',
  'roomsOnBooks',
  'revenueOnBooks',
  'roomsOnBooks7dAgo',
  'revenueOnBooks7dAgo',
  'pickup7dRoomNights',
  'pickup7dRevenue',
];

/** Validate the fields consumed by page read models before a malformed result can enter a shared cache. */
export function assertCollectionRows(collection: CollectionKey, rows: unknown): void {
  const valid =
    Array.isArray(rows) &&
    rows.length <= 50_000 &&
    rows.every((row: unknown) => {
      if (
        !object(row) ||
        !(stringFields[collection] ?? []).every((key) => text(row[key])) ||
        !(dateFields[collection] ?? []).every((key) => isoDate(row[key])) ||
        !(numberFields[collection] ?? []).every((key) => finite(row[key]))
      )
        return false;
      if (collection === 'roomTypes')
        return Array.isArray(row['facilities']) && row['facilities'].every(text);
      if (collection === 'bookingPositions')
        return positionMetrics.every((key) => row[key] === null || finite(row[key]));
      if (collection === 'reservations')
        return (
          (row['roomId'] === null || text(row['roomId'])) &&
          (row['cancelledOn'] === null || isoDate(row['cancelledOn']))
        );
      return true;
    });
  if (!valid)
    throw new ApiError(
      502,
      'INVALID_RESPONSE',
      'The API returned invalid hotel data. Please retry.',
    );
}
