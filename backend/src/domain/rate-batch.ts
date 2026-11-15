import { createHash } from 'node:crypto';
import type { RoomRateUpdateRequest } from './mutation.models';

export const MAX_RATE_BATCH_UPDATES = 20;

/** Grounded selling quotes shown in the review; the version guards the eventual Apply. */
export interface RateUpdateReviewItem extends RoomRateUpdateRequest {
  readonly hotelName: string;
  readonly roomTypeName: string;
  readonly currentMinRate: number;
  readonly currentMaxRate: number;
  readonly expectedRateVersion: string;
}

const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const identifier = (value: unknown): value is string => text(value, 64) && value === value.trim();
const date = (value: unknown): value is string => {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number(value.slice(0, 4)) < 1
  )
    return false;
  const timestamp = Date.parse(`${value}T12:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
};
const amount = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0.01 &&
  value <= 10_000 &&
  Math.abs(value * 100 - Math.round(value * 100)) <= 0.000001;

export function isRateUpdateRequest(value: unknown): value is RoomRateUpdateRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    identifier(row.hotelId) &&
    identifier(row.roomTypeId) &&
    date(row.startDate) &&
    date(row.endDate) &&
    row.startDate <= row.endDate &&
    amount(row.nightlyRate) &&
    (row.eventId == null || identifier(row.eventId)) &&
    (row.reason === undefined || (typeof row.reason === 'string' && row.reason.length <= 240))
  );
}

export function isRateUpdateReviewItem(value: unknown): value is RateUpdateReviewItem {
  if (!isRateUpdateRequest(value)) return false;
  const row = value as unknown as Record<string, unknown>;
  return (
    text(row.hotelName, 200) &&
    text(row.roomTypeName, 200) &&
    amount(row.currentMinRate) &&
    amount(row.currentMaxRate) &&
    row.currentMinRate <= row.currentMaxRate &&
    typeof row.expectedRateVersion === 'string' &&
    /^[a-f0-9]{64}$/.test(row.expectedRateVersion)
  );
}

/** Conflicting inclusive intervals are rejected rather than relying on row application order. */
export function isRateUpdateBatch(value: unknown): value is RateUpdateReviewItem[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_RATE_BATCH_UPDATES ||
    !value.every(isRateUpdateReviewItem)
  )
    return false;
  for (let index = 0; index < value.length; index++) {
    const row = value[index];
    for (const other of value.slice(0, index)) {
      if (
        row.hotelId === other.hotelId &&
        row.roomTypeId === other.roomTypeId &&
        row.startDate <= other.endDate &&
        row.endDate >= other.startDate
      )
        return false;
    }
  }
  return true;
}

/** Exact dated quotes, not just their displayed min/max; stable across SQL and MCP ordering. */
export function rateVersion(rates: readonly { date: string; nightlyRate: number }[]): string {
  if (
    !rates.length ||
    rates.some((row) => !date(row.date) || !amount(row.nightlyRate)) ||
    new Set(rates.map((row) => row.date)).size !== rates.length
  )
    throw new RangeError('Expected unique dated selling quotes with finite EUR cents.');
  const input = [...rates]
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((row) => `${row.date}=${row.nightlyRate.toFixed(2)}`)
    .join('|');
  return createHash('sha256').update(input).digest('hex');
}
