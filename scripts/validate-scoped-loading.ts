import '@angular/compiler';
import assert from 'node:assert/strict';
import {
  createEnvironmentInjector,
  Injector,
  provideZonelessChangeDetection,
  ɵINJECTOR_SCOPE,
  type EnvironmentInjector,
} from '@angular/core';
import {
  HttpBackend,
  HttpErrorResponse,
  HttpResponse,
  provideHttpClient,
  withNoXsrfProtection,
  type HttpRequest,
} from '@angular/common/http';
import { defer, finalize, firstValueFrom, map, timer } from 'rxjs';
import { API_CONFIG } from '../src/app/core/api/api.config';
import { ApiClient, ApiError } from '../src/app/core/api/api-client.service';
import { NetworkDataStore } from '../src/app/core/api/network-data.store';
import { ReferenceDataService } from '../src/app/core/api/reference-data.service';
import { ResourceQueryStore } from '../src/app/core/api/resource-query.store';
import { pageRequestKey, type PageRequest } from '../src/app/core/api/page-data.models';
import { handleMockRequest } from '../src/app/core/api/mock/mock-api.backend';
import { NETWORK_DATA } from '../src/app/core/network.data';
import { createNetworkSelectors } from '../src/app/core/network.selectors';
import { createBookingRateHistory } from '../src/app/core/room-price-history';

class Storage {
  private readonly values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new Storage() });
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: new Storage() });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const requests: URL[] = [];
let active = 0;
let latency = 3;
let failNext = false;
let malformedNext = false;
const env = createEnvironmentInjector(
  [
    { provide: ɵINJECTOR_SCOPE, useValue: 'root' },
    provideZonelessChangeDetection(),
    provideHttpClient(withNoXsrfProtection()),
    {
      provide: API_CONFIG,
      useValue: { mode: 'http', baseUrl: '/api/v1', timeoutMs: 2_000, mockLatencyMs: 0 },
    },
    {
      provide: HttpBackend,
      useValue: {
        handle: (request: HttpRequest<unknown>) =>
          defer(() => {
            requests.push(new URL(request.urlWithParams, 'http://localhost'));
            active++;
            return timer(latency).pipe(
              map(() => {
                if (failNext) {
                  failNext = false;
                  throw new HttpErrorResponse({ status: 500 });
                }
                if (malformedNext) {
                  malformedNext = false;
                  return new HttpResponse({
                    status: 200,
                    body: { items: [null], page: 1, pageSize: 1000, total: 1 },
                  });
                }
                return handleMockRequest(request, '/api/v1');
              }),
              finalize(() => active--),
            );
          }),
      },
    },
  ],
  Injector.NULL as EnvironmentInjector,
);

const asOf = NETWORK_DATA.bookingSnapshot.asOf;
const scope = 'dev-ams';
const range = { startDate: '2026-11-11', endDate: '2026-11-22' };
const overview: PageRequest = { view: 'overview', scope, range };
const paths = (from = 0) =>
  requests.slice(from).map((request) => request.pathname.replace('/api/v1', ''));
const noExport = () =>
  assert(
    !paths().some((path) => path.includes('/exports/')),
    'Page loading must never fetch the full network export.',
  );

async function main() {
  try {
    await firstValueFrom(
      env.get(ApiClient).post('/sessions', {
        email: 'scoped.contract@example.com',
        password: 'x'.repeat(18),
      }),
    );
    requests.length = 0;
    const store = env.get(NetworkDataStore);
    const load = store.load(overview);
    assert.equal(store.load(overview), load, 'Concurrent loads of the same page coalesce.');
    assert.equal(
      store.snapshot(),
      null,
      'No partial page is published while its requests are loading.',
    );
    await load;
    assert.equal(store.activeKey(), pageRequestKey(overview));
    assert.equal(store.loading(), false);
    assert.deepEqual(
      new Set(paths()),
      new Set([
        '/reference-data',
        '/room-types',
        '/analytics/booking-positions',
        '/reservation-nights',
      ]),
    );
    assert.equal(paths().filter((path) => path === '/analytics/booking-positions').length, 2);
    assert(
      store.data.reservationNights.every(
        (row) => row.hotelId === scope && row.date >= range.startDate && row.date <= range.endDate,
      ),
    );
    assert(store.data.roomTypes.every((row) => row.hotelId === scope));
    assert.equal(store.data.rooms.length, 0);
    assert.equal(store.data.reservations.length, 0);
    assert.equal(store.data.dailyCosts.length, 0);
    const expected = createNetworkSelectors(NETWORK_DATA);
    const scoped = createNetworkSelectors(store.data);
    assert.deepEqual(scoped.bookingOutlook(scope, range), expected.bookingOutlook(scope, range));
    for (const hotel of NETWORK_DATA.hotels)
      assert.deepEqual(
        scoped.bookingOutlook(hotel.id, range),
        expected.bookingOutlook(hotel.id, range),
        'Compact organization positions keep every hotel outlook correct.',
      );
    assert.deepEqual(scoped.bookingSources(scope, range), expected.bookingSources(scope, range));
    assert.equal(scoped.bookingChartContext(scope, range).rows.length, 30);
    const beforeHit = requests.length;
    await store.load(overview);
    assert.equal(
      requests.length,
      beforeHit,
      'Navigating to an already loaded page does not refetch.',
    );

    await store.load({ view: 'configuration', scope, range });
    assert.equal(
      requests.length,
      beforeHit,
      'Shared hotel room types are reused by configuration.',
    );
    assert(store.data.roomTypes.length > 0);
    assert.equal(store.data.bookingPositions.length, 0);
    const configurationStart = requests.length;
    await store.load({ view: 'configuration', scope: 'dev-bru', range });
    assert.deepEqual(paths(configurationStart), ['/room-types']);
    assert.equal(requests.at(-1)!.searchParams.get('hotelId'), 'dev-bru');

    const reservationsStart = requests.length;
    await store.load({ view: 'reservations', scope, range });
    assert.deepEqual(new Set(paths(reservationsStart)), new Set(['/rooms', '/reservations']));
    assert(
      store.data.reservations.every(
        (row) => row.hotelId === scope && row.arrival <= asOf && row.departure > asOf,
      ),
    );
    assert.equal(store.data.dailyRoomStates.length, 0);
    const inventoryStart = requests.length;
    await store.load({ view: 'rooms', scope, range });
    assert.deepEqual(new Set(paths(inventoryStart)), new Set(['/room-states', '/room-rates']));
    assert(store.data.dailyRoomStates.every((row) => row.hotelId === scope && row.date === asOf));
    assert(store.data.roomRates.every((row) => row.hotelId === scope && row.date === asOf));

    const type = store.data.roomTypes[0];
    const pricesStart = requests.length;
    await store.load({ view: 'rooms', section: 'prices', scope, range, roomTypeId: type.id });
    assert.equal(store.resolvedRoomTypeId(), type.id);
    assert.deepEqual(
      new Set(paths(pricesStart)),
      new Set(['/rooms', '/room-states', '/room-rates', `/room-types/${type.id}/price-history`]),
    );
    assert(store.data.rooms.every((room) => room.roomTypeId === type.id));
    const stateRequests = requests
      .slice(pricesStart)
      .filter((request) => request.pathname.endsWith('/room-states'));
    assert(stateRequests.length > 0);
    assert(
      stateRequests.every((request) => request.searchParams.get('roomTypeId') === type.id),
      'Pricing filters room states by the selected type at the API boundary.',
    );
    const selectedRooms = new Set(store.data.rooms.map((room) => room.id));
    assert(
      store.data.dailyRoomStates.length > 0 &&
        store.data.dailyRoomStates.every((state) => selectedRooms.has(state.roomId)),
      'Selected-type availability has only that room type’s dated states.',
    );
    assert(
      store.data.roomRates.every(
        (rate) =>
          rate.roomTypeId === type.id && rate.date >= '2026-11-01' && rate.date <= '2026-11-30',
      ),
    );
    assert.equal(
      store.data.reservationNights.length,
      0,
      'Price history uses its aggregate, not raw booking-night history.',
    );
    assert.equal(store.data.reservations.length, 0);
    assert.deepEqual(
      store.getPriceHistory(scope, type.id),
      createBookingRateHistory(NETWORK_DATA)(scope, type.id).filter((day) =>
        day.date.startsWith('2026-11'),
      ),
    );
    const second = store.data.roomTypes[1];
    await store.load({ view: 'rooms', section: 'prices', scope, range, roomTypeId: second.id });
    assert.equal(store.resolvedRoomTypeId(), second.id);
    assert(store.data.rooms.every((room) => room.roomTypeId === second.id));
    assert.deepEqual(
      store.getPriceHistory(scope, type.id),
      [],
      'Changing type cannot expose the previous type history.',
    );

    const activeKey = store.activeKey();
    const day = await store.loadDay(scope, asOf);
    assert.deepEqual(day, expected.hotelDaySummary(scope, asOf));
    assert.equal(
      store.activeKey(),
      activeKey,
      'A drill-down never replaces the applied page request.',
    );
    const dayRequests = requests.length;
    await store.loadDay(scope, asOf);
    assert.equal(requests.length, dayRequests, 'A repeated day drill reuses its scoped facts.');
    assert(
      requests.some(
        (request) =>
          request.pathname.endsWith('/reservations') &&
          request.searchParams.get('from') === '2026-11-13' &&
          request.searchParams.get('to') === asOf,
      ),
      'Daily reservations overlap the previous night so departures are included.',
    );
    const pageRevision = store.revision();
    const dayRevision = store.dayRevision();
    store.invalidateDayDetails();
    assert.equal(store.getDaySummary(scope, asOf), null);
    assert.equal(store.revision(), pageRevision);
    assert.equal(store.dayRevision(), dayRevision + 1);
    assert.equal(
      store.activeKey(),
      activeKey,
      'Room mutation reconciliation does not unmount the active page.',
    );

    latency = 25;
    const unloadedDay = '2026-11-19';
    const leavingDay = store.loadDay('dev-ber', unloadedDay);
    const leavingDayRejection = assert.rejects(
      leavingDay,
      (error: unknown) => error instanceof ApiError && error.code === 'CANCELLED',
    );
    await wait(2);
    assert(active > 0, 'The day drill has active scoped HTTP reads before Back.');
    store.cancelDayLoad();
    await leavingDayRejection;
    assert.equal(active, 0, 'Back cancels the active day HTTP reads.');
    assert.equal(store.activeKey(), activeKey, 'Back preserves the applied page key.');
    await wait(30);
    assert.equal(
      store.getDaySummary('dev-ber', unloadedDay),
      null,
      'An abandoned day cannot publish a late summary.',
    );

    const changingPageDay = store.loadDay('dev-ber', unloadedDay);
    const changingPageDayRejection = assert.rejects(
      changingPageDay,
      (error: unknown) => error instanceof ApiError && error.code === 'CANCELLED',
    );
    await wait(2);
    assert(active > 0);
    const replacingPage: PageRequest = { view: 'configuration', scope: 'dev-bru', range };
    await store.load(replacingPage);
    await changingPageDayRejection;
    assert.equal(active, 0, 'A new page cancels pending day reads.');
    assert.equal(store.activeKey(), pageRequestKey(replacingPage));
    assert.equal(store.getDaySummary('dev-ber', unloadedDay), null);

    store.invalidate();
    const old = store.load({ view: 'configuration', scope: 'dev-bru', range });
    const cancelled = assert.rejects(old);
    await wait(2);
    const current = store.load({ view: 'configuration', scope: 'dev-ber', range });
    await cancelled;
    await current;
    assert.equal(
      store.activeKey(),
      pageRequestKey({ view: 'configuration', scope: 'dev-ber', range }),
    );
    assert(
      store.data.roomTypes.every((row) => row.hotelId === 'dev-ber'),
      'A stale hotel request never overwrites the current page.',
    );
    assert.equal(active, 0);

    const returnTarget: PageRequest = { view: 'configuration', scope: 'dev-ber', range };
    const pendingOther = store.load({ view: 'configuration', scope: 'dev-bru', range });
    const pendingOtherRejection = assert.rejects(pendingOther);
    await wait(2);
    await store.load(returnTarget);
    await pendingOtherRejection;
    assert.equal(
      store.activeKey(),
      pageRequestKey(returnTarget),
      'Returning to ready A cancels pending B before reusing A.',
    );
    assert.equal(store.loading(), false);
    assert.equal(active, 0);

    store.invalidate();
    const abandoned = store.load(overview);
    const abandonedRejection = assert.rejects(abandoned);
    await wait(2);
    store.deactivate();
    await abandonedRejection;
    assert.equal(active, 0, 'Leaving a page cancels its active HTTP reads.');
    assert.equal(store.loading(), false);
    assert.equal(store.activeKey(), null);
    latency = 1;
    failNext = true;
    await assert.rejects(store.load({ view: 'configuration', scope: 'dev-bru', range }), ApiError);
    assert(store.error());
    assert.equal(store.loading(), false);
    await store.load({ view: 'configuration', scope: 'dev-bru', range });
    assert.equal(store.error(), '');
    store.invalidate();
    malformedNext = true;
    await assert.rejects(
      store.load({ view: 'configuration', scope: 'dev-bru', range }),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    );
    const afterMalformed = requests.length;
    await store.load({ view: 'configuration', scope: 'dev-bru', range });
    assert.equal(
      requests.length,
      afterMalformed + 1,
      'Malformed rows never poison the reusable resource cache.',
    );

    const realNow = Date.now;
    const beforeExpiry = requests.length;
    try {
      Date.now = () => realNow() + 61_000;
      await store.load({ view: 'configuration', scope: 'dev-bru', range });
    } finally {
      Date.now = realNow;
    }
    assert.equal(requests.length, beforeExpiry + 1, 'Expired page/resource data is fetched again.');
    assert.equal(env.get(ReferenceDataService).data.hotels.length, 4);
    for (const selection of [
      { startDate: '2026-11-01', endDate: '2026-11-30' },
      { startDate: asOf, endDate: asOf },
    ]) {
      store.invalidate();
      const start = requests.length;
      await store.load({ view: 'overview', scope, range: selection });
      const positions = requests
        .slice(start)
        .filter((request) => request.pathname.endsWith('/analytics/booking-positions'));
      assert.equal(
        positions.length,
        1,
        'Exact month/day overview reuses organization positions instead of fetching a duplicate hotel subset.',
      );
      assert.equal(positions[0].searchParams.has('hotelId'), false);
      assert.deepEqual(
        createNetworkSelectors(store.data).bookingOutlook(scope, selection),
        expected.bookingOutlook(scope, selection),
      );
      const dayStart = requests.length;
      await store.loadDay(scope, asOf);
      assert(
        requests
          .slice(dayStart)
          .every((request) => !request.pathname.endsWith('/analytics/booking-positions')),
        'Daily facts reuse complete positions already published by the active overview.',
      );
    }
    const expiredDayStart = requests.length;
    try {
      Date.now = () => realNow() + 61_000;
      await store.loadDay(scope, asOf);
    } finally {
      Date.now = realNow;
    }
    assert(
      requests
        .slice(expiredDayStart)
        .some((request) => request.pathname.endsWith('/analytics/booking-positions')),
      'An expired overview cannot supply stale positions to a fresh day read.',
    );
    noExport();
    store.clear();
    assert.equal(store.snapshot(), null);
    assert.equal(store.activeKey(), null);
    assert.throws(() => env.get(ReferenceDataService).data, /must load/);
    env.get(ResourceQueryStore).clear();
    console.log(
      'Validated scoped page queries, shared NgRx cache/TTL, atomic publication, coalescing, stale-request cancellation, selected room-type history, day drill/departures, mutation invalidation and retry without startup exports.',
    );
  } finally {
    env.destroy();
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
