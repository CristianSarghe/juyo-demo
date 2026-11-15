import type { ChatAction } from '../../models';
import type { RateUpdateReviewItem } from '../mutation.models';
import { NETWORK_DATA } from '../../network.data';
import { validateDateRange } from './fixture-selectors';

/** Offline change detection only. Live proposals use the server's SHA-256 version. */
export function mockRateVersion(rows: readonly { date: string; nightlyRate: number }[]): string {
  const text = [...rows]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((row) => `${row.date}=${row.nightlyRate.toFixed(2)}`)
    .join('|');
  return Array.from({ length: 8 }, (_, index) => {
    let hash = (2166136261 ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
    for (let offset = 0; offset < text.length; offset++)
      hash = Math.imul(hash ^ text.charCodeAt(offset), 16777619) >>> 0;
    return hash.toString(16).padStart(8, '0');
  }).join('');
}

export function mockBatchChangeIds(proposalId: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => proposalId.slice(0, 24) + index.toString(16).padStart(12, '0'),
  );
}

export function validMockRateUpdates(updates: unknown): updates is RateUpdateReviewItem[] {
  if (!Array.isArray(updates) || !updates.length || updates.length > 20) return false;
  const price = (value: unknown): value is number =>
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0.01 &&
    value <= 10_000 &&
    Math.abs(value * 100 - Math.round(value * 100)) < 0.000001;
  for (const [index, row] of updates.entries()) {
    if (!row || typeof row !== 'object') return false;
    const type = NETWORK_DATA.roomTypes.find(
      (type) => type.id === row.roomTypeId && type.hotelId === row.hotelId,
    );
    const hotel = NETWORK_DATA.hotels.find((hotel) => hotel.id === row.hotelId);
    if (
      !type ||
      !hotel ||
      row.hotelName !== hotel.name ||
      row.roomTypeName !== type.name ||
      !price(row.nightlyRate) ||
      !price(row.currentMinRate) ||
      !price(row.currentMaxRate) ||
      row.currentMinRate > row.currentMaxRate ||
      typeof row.expectedRateVersion !== 'string' ||
      !/^[a-f0-9]{64}$/.test(row.expectedRateVersion) ||
      (row.reason !== undefined && (typeof row.reason !== 'string' || row.reason.length > 240))
    )
      return false;
    if (
      row.eventId != null &&
      !NETWORK_DATA.eventHotelImpacts.some(
        (impact) => impact.eventId === row.eventId && impact.hotelId === row.hotelId,
      )
    )
      return false;
    try {
      validateDateRange(row);
    } catch {
      return false;
    }
    if (
      updates
        .slice(0, index)
        .some(
          (previous) =>
            previous.hotelId === row.hotelId &&
            previous.roomTypeId === row.roomTypeId &&
            previous.startDate <= row.endDate &&
            previous.endDate >= row.startDate,
        )
    )
      return false;
  }
  return true;
}

export function isMockBatchRateAction(
  value: unknown,
): value is Extract<ChatAction, { kind: 'rate_batch_update' }> {
  if (!value || typeof value !== 'object') return false;
  const action = value as Partial<ChatAction>;
  return (
    action.kind === 'rate_batch_update' &&
    typeof action.id === 'string' &&
    /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(action.id) &&
    ['pending', 'applied', 'cancelled'].includes(action.status ?? '') &&
    typeof action.summary === 'string' &&
    !!action.summary.trim() &&
    action.summary.length <= 400 &&
    validMockRateUpdates(action.details?.updates)
  );
}
