/** Offline/read-only integration check. Fixture JSON is used only as an oracle here. */
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { readEnvironment } from '../src/config.js';
import { createDatabase } from '../src/database.js';
import { SqlNetworkRepository } from '../src/data/sql-network.repository.js';
import type { HotelNetwork } from '../src/domain/network.models.js';
import type { CollectionKey } from '../src/domain/api.models.js';
import { resourceRows } from '../src/rest-data.js';

function normalize(value: unknown, path = ''): unknown {
  if (Array.isArray(value)) {
    const normalized = value.map((item, index) => normalize(item, `${path}[${index}]`));
    // Notes are ordered source text. Every other array represents a relational
    // collection/set; the normalized database intentionally stores no UI ordering.
    return path.endsWith('.notes') ? normalized : normalized.sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, normalize(item, `${path}.${key}`)]),
  );
  return value;
}

function difference(actual: unknown, expected: unknown, path = 'network'): string | undefined {
  if (Object.is(actual, expected)) return undefined;
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) return `${path}: ${actual.length} rows, expected ${expected.length}`;
    for (let index = 0; index < actual.length; index++) {
      const mismatch = difference(actual[index], expected[index], `${path}[${index}]`);
      if (mismatch) return mismatch;
    }
    return undefined;
  }
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
    const actualObject = actual as Record<string, unknown>;
    const expectedObject = expected as Record<string, unknown>;
    if (Object.keys(actualObject).join() !== Object.keys(expectedObject).join()) return `${path}: field names differ`;
    for (const key of Object.keys(actualObject)) {
      const mismatch = difference(actualObject[key], expectedObject[key], `${path}.${key}`);
      if (mismatch) return mismatch;
    }
    return undefined;
  }
  return `${path}: ${JSON.stringify(actual)?.slice(0, 100)}; expected ${JSON.stringify(expected)?.slice(0, 100)}`;
}

class ValidationMismatch extends Error {}
let close: (() => Promise<void>) | undefined;
try {
  const fixture = JSON.parse(await readFile(new URL('../../public/data/hotel-network.json', import.meta.url), 'utf8')) as HotelNetwork;
  const database = createDatabase(readEnvironment());
  close = () => database.close();
  await database.connect();
  const started = performance.now();
  const repository = new SqlNetworkRepository(database.pool, process.env['SQL_ORGANIZATION_ID']);
  const actual = await repository.load();
  const elapsedMs = Math.round(performance.now() - started);
  const mismatch = difference(normalize(actual), normalize(fixture));
  if (mismatch) {
    console.error(`SQL adapter verification failed: ${mismatch}`);
    process.exitCode = 1;
  } else {
    const counts = Object.fromEntries(Object.entries(actual).filter(([, value]) => Array.isArray(value))
      .map(([key, value]) => [key, (value as unknown[]).length]));
    const reference = await repository.loadReference();
    const dates = Array.from({ length: fixture.meta.reportingPeriod.days }, (_, index) =>
      new Date(Date.parse(`${fixture.meta.reportingPeriod.startDate}T00:00:00Z`) + index * 86_400_000).toISOString().slice(0, 10));
    const referenceMismatch = difference(normalize(reference), normalize({meta: fixture.meta, bookingSnapshot: fixture.bookingSnapshot,
      hotels: fixture.hotels, reportingPeriods: fixture.reportingPeriods, dates}), 'reference');
    if (referenceMismatch) throw new ValidationMismatch(referenceMismatch);
    let verifiedPages = 0;
    const readPages = async (key: CollectionKey, query: URLSearchParams): Promise<unknown[]> => {
      const result: unknown[] = [];
      query.set('pageSize', '500');
      let total: number | undefined;
      for (let page = 1; ; page++) {
        query.set('page', String(page));
        const response = await repository.readCollection(key, query);
        verifiedPages++;
        if (response.page !== page || response.pageSize !== 500 || (total !== undefined && response.total !== total))
          throw new ValidationMismatch(`${key}: pagination metadata differs`);
        total = response.total;
        result.push(...response.items);
        if (result.length >= total) break;
        if (!response.items.length) throw new ValidationMismatch(`${key}: pagination stopped early`);
      }
      return result;
    };
    for (const key of Object.keys(counts) as CollectionKey[]) {
      const params = new URLSearchParams(key === 'roomRates' ? { basis: 'canonical' } : {});
      const result = await readPages(key, params);
      const mismatch = difference(normalize(result), normalize(fixture[key]), key);
      if (mismatch) throw new ValidationMismatch(mismatch);
    }
    const scopedParams = new URLSearchParams({hotelId: fixture.hotels[0].id, from: '2026-11-11', to: '2026-11-22'});
    for (const key of ['events', 'reservations', 'dailyRoomStates', 'dailyPerformance', 'channels', 'reportingPeriods'] as CollectionKey[]) {
      const result = await readPages(key, new URLSearchParams(scopedParams));
      const mismatch = difference(normalize(result), normalize(resourceRows(fixture, key, scopedParams)), `${key}.filtered`);
      if (mismatch) throw new ValidationMismatch(mismatch);
    }
    for (const params of [new URLSearchParams({pageSize: '1001'}), new URLSearchParams({from: '2026-11-31', to: '2026-12-01'}),
      new URLSearchParams({hotelId: 'not-a-hotel'}), new URLSearchParams({from: '2026-09-01', to: '2026-10-01'})]) {
      let rejected = false;
      try { await repository.readCollection('hotels', params); }
      catch (error) { rejected = !!error && typeof error === 'object' && 'status' in error && error.status === 400; }
      if (!rejected) throw new ValidationMismatch('Invalid collection filter was not rejected.');
    }
    console.log(JSON.stringify({ verified: true, source: 'normalized SQL Server tables and reporting views',
      properties: Object.keys(actual).length, collections: Object.keys(counts).length, counts, elapsedMs,
      nativeReference: true, verifiedPages, filteredCollections: 6, rejectedInvalidQueries: 4,
      totalElapsedMs: Math.round(performance.now() - started) }, null, 2));
  }
} catch (error) {
  // Driver errors can contain connection/query details. Return only the safe code.
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : 'VALIDATION_FAILED';
  console.error(error instanceof ValidationMismatch ? `SQL adapter verification failed: ${error.message}` : `SQL adapter verification failed (${code}).`);
  process.exitCode = 1;
} finally {
  await close?.();
}
