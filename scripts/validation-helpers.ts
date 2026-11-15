import assert from 'node:assert/strict';

export { assert };
export const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);
export const cents = (value: number): number => Math.round(value * 100);
export const sumCents = (values: readonly number[]): number => sum(values.map(cents));
export const percent = (part: number, total: number): number =>
  total ? Math.round((part / total) * 10_000) / 100 : 0;
export const rateCents = (revenueCents: number, nights: number): number =>
  nights ? Math.round(revenueCents / nights) : 0;
export const validDate = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;

export function datesBetween(start: string, endExclusive: string): string[] {
  assert.ok(
    validDate(start) && validDate(endExclusive),
    `Invalid calendar range ${start}–${endExclusive}`,
  );
  const dates: string[] = [];
  for (let date = Date.parse(start); date < Date.parse(endExclusive); date += 86_400_000)
    dates.push(new Date(date).toISOString().slice(0, 10));
  return dates;
}

export function unique(values: readonly string[], context: string): void {
  assert.equal(new Set(values).size, values.length, `${context}: duplicate key`);
}

export function money(value: number, context: string): void {
  assert.ok(
    Number.isFinite(value) && Math.abs(value * 100 - cents(value)) < 1e-7,
    `${context}: finite exact-cent amount required`,
  );
}

export function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const value = key(row);
    const group = groups.get(value);
    if (group) group.push(row);
    else groups.set(value, [row]);
  }
  return groups;
}
