import type { CollectionKey, Page } from './domain/api.models';
import type { DateRange, HotelNetwork, PropertyScope } from './domain/network.models';
import type { RoomRateChange } from './domain/mutation.models';
import { createNetworkSelectors } from './domain/network.selectors';
import { reject } from './problem';

export function selectedScope(data: HotelNetwork, params: URLSearchParams): PropertyScope {
  const id = params.get('hotelId');
  if (!id) return 'portfolio';
  if (!data.hotels.some((hotel) => hotel.id === id))
    return reject(400, 'INVALID_HOTEL', 'Choose a valid hotel.');
  return id;
}
export function selectedRange(data: HotelNetwork, params: URLSearchParams): DateRange | undefined {
  if (!params.has('from') && !params.has('to')) return undefined;
  if (!params.get('from') || !params.get('to'))
    return reject(400, 'INVALID_RANGE', 'Provide both from and to dates.');
  return createNetworkSelectors(data).validateDateRange({
    startDate: params.get('from')!,
    endDate: params.get('to')!,
  });
}
export function selectedDate(data: HotelNetwork, params: URLSearchParams, key = 'date'): string {
  const date = params.get(key) ?? data.bookingSnapshot.asOf;
  createNetworkSelectors(data).validateDateRange({ startDate: date, endDate: date });
  return date;
}
export function page<T>(items: T[], params: URLSearchParams): Page<T> {
  const integer = (key: string, fallback: number, max: number) => {
    const raw = params.get(key);
    if (raw === null) return fallback;
    if (
      !/^\d+$/.test(raw) ||
      !Number.isSafeInteger(Number(raw)) ||
      Number(raw) < 1 ||
      Number(raw) > max
    )
      return reject(400, 'INVALID_PAGINATION', `Choose a valid ${key}.`);
    return Number(raw);
  };
  const number = integer('page', 1, 100000),
    size = integer('pageSize', 50, 1000);
  return {
    items: items.slice((number - 1) * size, number * size),
    page: number,
    pageSize: size,
    total: items.length,
  };
}
export function resourceRows(
  data: HotelNetwork,
  key: CollectionKey,
  params: URLSearchParams,
  changes: readonly RoomRateChange[] = [],
): unknown[] {
  const allowed = new Set([
    'hotelId',
    'roomTypeId',
    'roomId',
    'eventId',
    'status',
    'from',
    'to',
    'stayDate',
    'page',
    'pageSize',
    'basis',
  ]);
  for (const field of params.keys())
    if (!allowed.has(field)) reject(400, 'INVALID_FILTER', `Unsupported filter: ${field}.`);
  const scope = selectedScope(data, params),
    selection = selectedRange(data, params);
  if (params.has('stayDate')) selectedDate(data, params, 'stayDate');
  const basis = params.get('basis');
  if (basis && !(key === 'roomRates' && basis === 'canonical'))
    reject(400, 'INVALID_FILTER', 'Unsupported reporting basis.');
  let rows = [...data[key]] as unknown as Record<string, unknown>[];
  if (key === 'roomRates' && basis !== 'canonical')
    rows = rows.map((row) => {
      const change = [...changes]
        .reverse()
        .find(
          (change) =>
            change.roomTypeId === row.roomTypeId &&
            change.startDate <= String(row.date) &&
            change.endDate >= String(row.date),
        );
      return change ? { ...row, nightlyRate: change.nightlyRate } : row;
    });
  const roomTypeId = params.get('roomTypeId');
  const roomTypeRoomIds = roomTypeId && (key === 'dailyRoomStates' || key === 'reservationNights')
    ? new Set(data.rooms.filter((room) => room.roomTypeId === roomTypeId).map((room) => room.id))
    : null;
  return rows.filter((row) => {
    if (
      scope !== 'portfolio' &&
      key !== 'reportingPeriods' &&
      (key === 'hotels'
        ? row.id !== scope
        : key === 'events'
          ? !data.eventHotelImpacts.some(
              (impact) => impact.hotelId === scope && impact.eventId === row.id,
            )
          : row.hotelId !== scope)
    )
      return false;
    for (const field of ['roomTypeId', 'roomId', 'eventId', 'status']) {
      const wanted = params.get(field);
      if (field === 'roomTypeId' && roomTypeRoomIds) {
        if (!roomTypeRoomIds.has(String(row.roomId))) return false;
      } else if (wanted && row[field] !== wanted) return false;
    }
    const stayDate = params.get('stayDate');
    if (
      stayDate &&
      key === 'reservations' &&
      !(String(row.arrival) <= stayDate && String(row.departure) > stayDate)
    )
      return false;
    if (selection) {
      const point = row.date ?? row.stayDate;
      if (typeof point === 'string' && (point < selection.startDate || point > selection.endDate))
        return false;
      if (
        typeof row.period === 'string' &&
        (row.period < selection.startDate.slice(0, 7) || row.period > selection.endDate.slice(0, 7))
      )
        return false;
      if (
        typeof row.arrival === 'string' &&
        !(row.arrival <= selection.endDate && String(row.departure) > selection.startDate)
      )
        return false;
      if (
        key === 'events' &&
        !(String(row.startDate) <= selection.endDate && String(row.endDate) >= selection.startDate)
      )
        return false;
    }
    return true;
  });
}
