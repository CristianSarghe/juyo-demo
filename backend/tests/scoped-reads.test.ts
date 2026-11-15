import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type sql from 'mssql';
import { handleApi, type ApiDependencies } from '../src/app.js';
import { SqlNetworkRepository } from '../src/data/sql-network.repository.js';
import type { CollectionItem, CollectionKey, Page, ReferenceDataDto } from '../src/domain/api.models.js';
import type { HotelNetwork } from '../src/domain/network.models.js';
import type { RoomOperationChange } from '../src/domain/mutation.models.js';
import type { SqlWorkspaceRepository } from '../src/persistence/sql-workspace.repository.js';
import { page, resourceRows } from '../src/rest-data.js';
import { reportingDatesFor } from '../src/domain/network.selectors.js';
import { ApiProblemError } from '../src/problem.js';

const data = JSON.parse(readFileSync(new URL('../../public/data/hotel-network.json', import.meta.url), 'utf8')) as HotelNetwork;
const reference: ReferenceDataDto = {
  meta: data.meta, bookingSnapshot: data.bookingSnapshot, hotels: data.hotels,
  reportingPeriods: data.reportingPeriods, dates: reportingDatesFor(data.meta.reportingPeriod),
};

/** Exercise real scoped-loading orchestration over the existing in-memory REST
 * adapter. SQL predicate behavior is covered separately by opt-in integration. */
class FixtureRepository extends SqlNetworkRepository {
  readonly reads: { key: CollectionKey; query: URLSearchParams }[] = [];
  referenceReads = 0;
  constructor() { super({} as sql.ConnectionPool); }
  override async loadReference(): Promise<ReferenceDataDto> {
    this.referenceReads++;
    return reference;
  }
  override async readCollection<K extends CollectionKey>(key: K, query: URLSearchParams): Promise<Page<CollectionItem<K>>> {
    this.reads.push({ key, query: new URLSearchParams(query) });
    return page(resourceRows(data, key, query), query) as Page<CollectionItem<K>>;
  }
}

const heldRoom = data.rooms.find((room) => room.occupancy === 'available')!;
const changes: RoomOperationChange[] = [{
  roomId: heldRoom.id, date: data.bookingSnapshot.asOf, status: 'out_of_service',
  appliedAt: '2026-11-14T12:00:00Z',
}];

function dependencies(repository?: FixtureRepository): ApiDependencies {
  return {
    env: { SQL_SERVER: 'unused', SQL_DATABASE: 'unused', SQL_USER: 'unused', SQL_PASSWORD: 'unit-test' },
    sessions: {
      authenticate: async () => ({ id: 'test-user', name: 'Test user', email: 'test@example.invalid' }),
      login: async () => { throw new Error('Not used.'); },
      logout: async () => {},
    },
    workspace: {
      listRoomChanges: async (date: string) => changes.filter((change) => change.date === date),
    } as unknown as SqlWorkspaceRepository,
    loadNetwork: async () => {
      assert.equal(repository, undefined, 'Scoped routes must never load the full network.');
      return data;
    },
    ...(repository ? {
      loadWarningsData: (query: URLSearchParams) => repository.loadWarningsData(query),
      loadUpcomingEventsData: (query: URLSearchParams) => repository.loadUpcomingEventsData(query),
      loadPriceHistoryData: (id: string, query: URLSearchParams) => repository.loadPriceHistoryData(id, query),
    } : {}),
  };
}
const request = (path: string) => new Request(`https://hotel.example.invalid/api/v1${path}`);

test('warnings and upcoming events retain full-snapshot responses using only relevant scoped collections', async () => {
  for (const route of ['warnings', 'events/upcoming']) {
    for (const scope of ['', `hotelId=${data.hotels[0].id}&`]) {
      for (const date of [data.bookingSnapshot.asOf, reference.dates[0]]) {
        const path = `/${route}?${scope}date=${date}&pageSize=2`;
        const repository = new FixtureRepository();
        const scoped = await handleApi(request(path), dependencies(repository));
        const original = await handleApi(request(path), dependencies());
        assert.equal(scoped.status, 200);
        assert.deepEqual(await scoped.json(), await original.json(), path);
        assert.equal(repository.referenceReads, 1);
        assert.deepEqual(repository.reads.map((read) => read.key), route === 'warnings'
          ? ['rooms', 'dailyRoomStates'] : ['events', 'eventHotelImpacts']);
        for (const read of repository.reads) {
          assert.equal(read.query.get('hotelId'), scope ? data.hotels[0].id : null);
          if (read.key === 'dailyRoomStates') {
            assert.equal(read.query.get('from'), date);
            assert.equal(read.query.get('to'), date);
          }
        }
      }
    }
  }
});

test('booked-price history retains every bucket and null day with only selected-type/date ledgers', async () => {
  for (const type of data.roomTypes) {
    for (const range of ['', '?from=2026-11-14&to=2026-11-18', '?from=2026-10-31&to=2026-11-01']) {
      const path = `/room-types/${type.id}/price-history${range}`;
      const repository = new FixtureRepository();
      const scoped = await handleApi(request(path), dependencies(repository));
      const original = await handleApi(request(path), dependencies());
      assert.equal(scoped.status, 200);
      assert.deepEqual(await scoped.json(), await original.json(), path);
      assert.deepEqual(repository.reads.map((read) => read.key), ['roomTypes', 'reservations', 'reservationNights']);
      const selected = new URLSearchParams(range.replace(/^\?/, ''));
      for (const read of repository.reads.slice(1)) {
        assert.equal(read.query.get('hotelId'), type.hotelId);
        assert.equal(read.query.get('roomTypeId'), type.id);
        assert.equal(read.query.get('from'), selected.get('from') ?? data.meta.reportingPeriod.startDate);
        assert.equal(read.query.get('to'), selected.get('to') ?? data.meta.reportingPeriod.endDate);
      }
    }
  }
});

test('scoped routes authenticate first and preserve invalid scope/date/type and pagination failures', async () => {
  for (const path of ['/warnings', '/events/upcoming', `/room-types/${data.roomTypes[0].id}/price-history`]) {
    const repository = new FixtureRepository();
    const deps = dependencies(repository);
    deps.sessions.authenticate = async () => { throw new ApiProblemError(401, 'UNAUTHENTICATED', 'Sign in.'); };
    assert.equal((await handleApi(request(path), deps)).status, 401);
    assert.equal(repository.referenceReads, 0);
    assert.equal(repository.reads.length, 0);
  }
  for (const path of [
    '/warnings?hotelId=unknown', '/events/upcoming?date=2026-11-31',
    '/warnings?page=0', '/events/upcoming?pageSize=1001',
    '/room-types/unknown/price-history',
    `/room-types/${data.roomTypes[0].id}/price-history?from=2026-11-14`,
  ]) {
    const scoped = await handleApi(request(path), dependencies(new FixtureRepository()));
    const original = await handleApi(request(path), dependencies());
    assert.equal(scoped.status, original.status, path);
    const scopedError = await scoped.json();
    const originalError = await original.json();
    assert.equal(scopedError.code, originalError.code, path);
  }
});

test('room-type room-state and night filters use room membership before pagination and totals', () => {
  for (const key of ['dailyRoomStates', 'reservationNights'] as const) {
    for (const type of data.roomTypes) {
      const rooms = new Set(data.rooms.filter((room) => room.roomTypeId === type.id).map((room) => room.id));
      const query = new URLSearchParams({ hotelId: type.hotelId, roomTypeId: type.id, from: '2026-11-01', to: '2026-11-30', pageSize: '7' });
      const rows = resourceRows(data, key, query) as { roomId: string; date: string }[];
      assert(rows.length > 0);
      assert(rows.every((row) => rooms.has(row.roomId) && row.date >= '2026-11-01' && row.date <= '2026-11-30'));
      const first = page(rows, query);
      assert.equal(first.total, rows.length);
      assert.equal(first.items.length, Math.min(7, rows.length));
      query.set('page', '2');
      const second = page(rows, query);
      assert.equal(second.total, rows.length);
      assert.deepEqual(second.items, rows.slice(7, 14));
    }
  }
});
