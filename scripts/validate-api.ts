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
  HttpClient,
  HttpErrorResponse,
  HttpRequest,
  HttpResponse,
  provideHttpClient,
  withInterceptors,
  withNoXsrfProtection,
  type HttpEvent,
} from '@angular/common/http';
import { defer, finalize, firstValueFrom, map, of, throwError, timer, type Observable } from 'rxjs';
import { API_CONFIG, type ApiConfig } from '../src/app/core/api/api.config';
import { ApiClient, ApiError } from '../src/app/core/api/api-client.service';
import type { Page, ReferenceDataDto, SchemaDto } from '../src/app/core/api/api.models';
import type {
  ManagedRoom,
  RoomOperationChange,
  RoomRateChange,
} from '../src/app/core/api/mutation.models';
import { mockApiInterceptor } from '../src/app/core/api/mock-api.interceptor';
import { handleMockRequest } from '../src/app/core/api/mock/mock-api.backend';
import { ReferenceDataService } from '../src/app/core/api/reference-data.service';
import { NetworkDataStore } from '../src/app/core/api/network-data.store';
import { NETWORK_DATA } from '../src/app/core/network.data';
import { createNetworkSelectors } from '../src/app/core/network.selectors';

class TestStorage {
  private readonly values = new Map<string, string>();
  blocked = false;
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.blocked) throw new Error('Storage blocked');
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    if (this.blocked) throw new Error('Storage blocked');
    this.values.delete(key);
  }
}
const local = new TestStorage();
const session = new TestStorage();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: local });
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: session });
const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const selectors = createNetworkSelectors(NETWORK_DATA);
const asOf = NETWORK_DATA.bookingSnapshot.asOf;
const baseUrl = '/api/v1';
const config: ApiConfig = { mode: 'mock', baseUrl, timeoutMs: 2_000, mockLatencyMs: 1 };
const delegated: HttpRequest<unknown>[] = [];
function environment(
  value: ApiConfig = config,
  backend: (request: HttpRequest<unknown>) => Observable<HttpEvent<unknown>> = (request) => {
    delegated.push(request);
    return of(new HttpResponse({ status: 200, body: { transport: 'real-backend' } }));
  },
): EnvironmentInjector {
  return createEnvironmentInjector(
    [
      // There is no application bootstrap in this headless contract test. Mark this
      // isolated environment as the root so Angular's HttpClient pending-task services resolve.
      { provide: ɵINJECTOR_SCOPE, useValue: 'root' },
      provideZonelessChangeDetection(),
      provideHttpClient(withInterceptors([mockApiInterceptor]), withNoXsrfProtection()),
      { provide: API_CONFIG, useValue: value },
      { provide: HttpBackend, useValue: { handle: backend } },
    ],
    Injector.NULL as EnvironmentInjector,
  );
}
async function rejectsHttp(
  work: Promise<unknown>,
  status: number,
  code?: string,
  allow?: string,
): Promise<void> {
  await assert.rejects(work, (error: unknown) => {
    assert(error instanceof HttpErrorResponse);
    assert.equal(error.status, status);
    assert.equal(error.error.status, status);
    assert.equal(error.headers.get('Content-Type'), 'application/problem+json');
    if (code) assert.equal(error.error.code, code);
    if (allow) assert.equal(error.headers.get('Allow'), allow);
    return true;
  });
}
async function main(): Promise<void> {
  const env = environment();
  const http = env.get(HttpClient);
  const api = env.get(ApiClient);
  const cache = env.get(NetworkDataStore);
  const get = <T>(path: string) => firstValueFrom(http.get<T>(`${baseUrl}${path}`));
  const post = <T>(path: string, body: unknown) =>
    firstValueFrom(http.post<T>(`${baseUrl}${path}`, body));
  const patch = <T>(path: string, body: unknown) =>
    firstValueFrom(http.patch<T>(`${baseUrl}${path}`, body));
  const remove = <T>(path: string) => firstValueFrom(http.delete<T>(`${baseUrl}${path}`));
  try {
    assert.throws(
      () =>
        handleMockRequest(
          new HttpRequest('GET', 'http://localhost/api/v1/sessions/current/?locale=en'),
          'http://localhost/api/v1/',
        ),
      (error: unknown) =>
        error instanceof HttpErrorResponse &&
        error.status === 401 &&
        error.error.code === 'UNAUTHENTICATED',
      'The full mock backend must preserve shared session errors after URL normalization',
    );
    assert.throws(
      () => handleMockRequest(new HttpRequest('GET', '/api/v1/sessions/?locale=en'), '/api/v1/'),
      (error: unknown) =>
        error instanceof HttpErrorResponse &&
        error.status === 405 &&
        error.headers.get('Allow') === 'POST',
    );
    await rejectsHttp(get('/sessions'), 405, 'METHOD_NOT_ALLOWED', 'POST');
    await rejectsHttp(post('/sessions/current', {}), 405, 'METHOD_NOT_ALLOWED', 'GET, DELETE');
    await rejectsHttp(get('/reference-data'), 401, 'UNAUTHENTICATED');
    await rejectsHttp(get('/sessions/current'), 401, 'UNAUTHENTICATED');
    await assert.rejects(env.get(ReferenceDataService).load(), ApiError);
    assert.equal(cache.loading(), false);
    assert.throws(() => cache.data, /must load/);
    await rejectsHttp(post('/sessions', { email: 'invalid', password: 'short' }), 422);
    const login = await firstValueFrom(
      http.post<{ user: { email: string } }>(
        `${baseUrl}/sessions`,
        {
          email: ' API.Test@example.com ',
          password: 'LocalContract2026',
        },
        { observe: 'response' },
      ),
    );
    assert.equal(login.status, 201);
    assert.equal(login.headers.get('Location'), '/api/v1/sessions/current');
    assert.equal(login.body!.user.email, 'api.test@example.com');
    const directSession = handleMockRequest(
      new HttpRequest('GET', '/api/v1/sessions/current/?locale=en'),
      'http://localhost/api/v1/',
    );
    assert.deepEqual(
      directSession.body,
      login.body,
      'Direct and intercepted session routing share one handler',
    );
    assert.equal(directSession.headers.get('Content-Type'), 'application/json');
    assert(
      !JSON.stringify([
        ...['juyo.demo.user'].map((key) => local.getItem(key) ?? session.getItem(key)),
      ]).includes('LocalContract2026'),
    );

    const reference = await get<ReferenceDataDto>('/reference-data');
    assert.deepEqual(reference.hotels, NETWORK_DATA.hotels);
    reference.hotels[0].name = 'Changed response';
    assert.equal(
      (await get<ReferenceDataDto>('/reference-data')).hotels[0].name,
      NETWORK_DATA.hotels[0].name,
    );
    assert.equal(NETWORK_DATA.hotels[0].name, 'Meridian Brussels');
    const filtered = await get<Page<{ hotelId: string; roomTypeId: string; date: string }>>(
      '/room-rates?hotelId=dev-bru&roomTypeId=dev-bru-type-1&from=2026-11-10&to=2026-11-14&page=2&pageSize=2&basis=canonical',
    );
    assert.equal(filtered.page, 2);
    assert.equal(filtered.pageSize, 2);
    assert.equal(filtered.total, 5);
    assert.deepEqual(
      filtered.items.map((row) => row.date),
      ['2026-11-12', '2026-11-13'],
    );
    assert(
      filtered.items.every(
        (row) => row.hotelId === 'dev-bru' && row.roomTypeId === 'dev-bru-type-1',
      ),
    );
    const reservations = await get<
      Page<{ hotelId: string; arrival: string; departure: string; status: string }>
    >(`/reservations?hotelId=dev-bru&stayDate=${asOf}&status=confirmed&pageSize=1000`);
    assert(
      reservations.items.every(
        (row) =>
          row.hotelId === 'dev-bru' &&
          row.status === 'confirmed' &&
          row.arrival <= asOf &&
          row.departure > asOf,
      ),
    );
    const selectedType = 'dev-bru-type-1';
    const typeRooms = new Set(
      NETWORK_DATA.rooms.filter((room) => room.roomTypeId === selectedType).map((room) => room.id),
    );
    for (const [path, rows] of [
      ['/room-states', NETWORK_DATA.dailyRoomStates],
      ['/reservation-nights', NETWORK_DATA.reservationNights],
    ] as const) {
      const result = await get<Page<{ roomId: string; date: string }>>(
        `${path}?hotelId=dev-bru&roomTypeId=${selectedType}&from=2026-11-10&to=2026-11-14&page=2&pageSize=2`,
      );
      const expected = rows.filter(
        (row) => typeRooms.has(row.roomId) && row.date >= '2026-11-10' && row.date <= '2026-11-14',
      );
      assert.equal(result.total, expected.length, `${path} filters room membership before paging.`);
      assert.equal(result.items.length, 2);
      assert(result.items.every((row) => typeRooms.has(row.roomId)));
    }
    await rejectsHttp(get('/hotels/unknown'), 404, 'NOT_FOUND');
    await rejectsHttp(get('/unknown-resource'), 404, 'NOT_FOUND');
    await rejectsHttp(post('/hotels', {}), 405, 'METHOD_NOT_ALLOWED', 'GET');
    await rejectsHttp(post('/schema', {}), 405, 'METHOD_NOT_ALLOWED', 'GET');
    await rejectsHttp(get('/reservations?hotelId=unknown'), 400, 'INVALID_HOTEL');
    await rejectsHttp(get('/rooms?page=0'), 400, 'INVALID_PAGINATION');
    await rejectsHttp(get('/rooms?surprise=true'), 400, 'INVALID_FILTER');
    for (const query of [
      'from=2026-11-31&to=2026-12-01',
      'from=2026-11-14',
      'from=2026-11-20&to=2026-11-10',
    ])
      await rejectsHttp(get(`/reservations?${query}`), 400);
    assert.deepEqual(
      await get('/hotels/dev-ams'),
      NETWORK_DATA.hotels.find((hotel) => hotel.id === 'dev-ams'),
    );
    const schema = await get<SchemaDto>('/schema');
    assert.equal(schema.dataDictionary.find((row) => row.key === 'rooms')!.rowCount, 88);
    assert.deepEqual(await get('/exports/network'), NETWORK_DATA);

    const free = selectors.hotelInventory().find((room) => room.occupancy === 'available')!;
    const occupied = selectors.hotelInventory().find((room) => room.occupancy === 'occupied')!;
    const statePath = `/rooms/${free.id}/state`;
    await rejectsHttp(post(statePath, {}), 405, 'METHOD_NOT_ALLOWED', 'GET, PATCH, DELETE');
    await patch(statePath, { action: 'reserve' });
    assert.equal((await get<ManagedRoom>(statePath)).status, 'reserved');
    await patch(statePath, { action: 'out_of_service' });
    assert.equal((await get<ManagedRoom>(statePath)).status, 'out_of_service');
    const warnings = await get<Page<{ room: { id: string } }>>(`/warnings?hotelId=${free.hotelId}`);
    assert(warnings.items.some((warning) => warning.room.id === free.id));
    await rejectsHttp(
      patch(`/rooms/${occupied.id}/state`, { action: 'available' }),
      409,
      'ROOM_STATE_CONFLICT',
    );
    await rejectsHttp(patch(statePath, { action: 'unknown' }), 422, 'INVALID_ROOM_ACTION');
    await remove(statePath);
    assert.equal((await get<ManagedRoom>(statePath)).status, free.occupancy);
    const persistedRooms = local.getItem('juyo.room-operations.v1');
    const beforeRoomFailure = await get<RoomOperationChange[]>('/room-state-changes');
    local.blocked = true;
    await rejectsHttp(patch(statePath, { action: 'reserve' }), 503, 'PERSISTENCE_UNAVAILABLE');
    local.blocked = false;
    assert.deepEqual(await get('/room-state-changes'), beforeRoomFailure);
    assert.equal(local.getItem('juyo.room-operations.v1'), persistedRooms);
    await rejectsHttp(
      patch(`/rooms/${occupied.id}/state`, { action: 'available' }),
      409,
      'ROOM_STATE_CONFLICT',
    );

    const type = NETWORK_DATA.roomTypes[0];
    const pricePath = `/room-rates?hotelId=${type.hotelId}&roomTypeId=${type.id}&from=${asOf}&to=${asOf}`;
    const historyBefore = await get(
      `/room-types/${type.id}/price-history?from=2026-11-10&to=2026-11-20`,
    );
    const ledgerBefore = JSON.stringify(NETWORK_DATA.reservationNights);
    const request = {
      hotelId: type.hotelId,
      roomTypeId: type.id,
      startDate: asOf,
      endDate: asOf,
      nightlyRate: 321.45,
      reason: 'Manual pricing review',
    };
    const changed = await firstValueFrom(
      http.post<RoomRateChange>(`${baseUrl}/rate-updates`, request, { observe: 'response' }),
    );
    assert.equal(changed.status, 201);
    assert(changed.headers.get('Location')!.startsWith('/api/v1/rate-updates/'));
    assert.deepEqual(
      await get(`/rate-updates/${encodeURIComponent(changed.body!.id)}`),
      changed.body,
      'A newly created rate update must be retrievable at its Location',
    );
    assert.equal(
      (await get<Page<{ nightlyRate: number }>>(pricePath)).items[0].nightlyRate,
      request.nightlyRate,
    );
    assert.deepEqual(
      await get(`/room-types/${type.id}/price-history?from=2026-11-10&to=2026-11-20`),
      historyBefore,
    );
    assert.equal(JSON.stringify(NETWORK_DATA.reservationNights), ledgerBefore);
    Object.assign(changed.body!, { reason: 'Changed response' });
    assert.equal((await get<RoomRateChange[]>('/rate-updates')).at(-1)!.reason, request.reason);
    request.reason = 'Changed original request';
    assert.notEqual(
      (await get<RoomRateChange[]>('/rate-updates')).at(-1)!.reason,
      request.reason,
      'Persisted changes must not retain a request-body alias',
    );
    const beforeInvalid = await get<RoomRateChange[]>('/rate-updates');
    await rejectsHttp(
      post('/rate-updates', { ...request, nightlyRate: -1 }),
      422,
      'INVALID_RATE_UPDATE',
    );
    assert.deepEqual(await get('/rate-updates'), beforeInvalid);
    const persistedRates = local.getItem('juyo.room-rates.v1');
    local.blocked = true;
    await rejectsHttp(
      post('/rate-updates', { ...request, nightlyRate: 322.45 }),
      503,
      'PERSISTENCE_UNAVAILABLE',
    );
    local.blocked = false;
    assert.deepEqual(await get('/rate-updates'), beforeInvalid);
    assert.equal(local.getItem('juyo.room-rates.v1'), persistedRates);
    await rejectsHttp(
      post('/rate-updates', { ...request, nightlyRate: 0 }),
      422,
      'INVALID_RATE_UPDATE',
    );

    // Loading after a selling-rate mutation must still obtain canonical ledger data.
    await env.get(ReferenceDataService).load();
    await cache.load({
      view: 'rooms',
      section: 'inventory',
      scope: type.hotelId,
      range: { startDate: asOf, endDate: asOf },
    });
    assert.equal(cache.loading(), false);
    assert.equal(cache.error(), '');
    assert(cache.data.rooms.every((room) => room.hotelId === type.hotelId));
    assert(cache.data.dailyRoomStates.every((state) => state.date === asOf));
    assert.notEqual(
      cache.data.roomRates.find((rate) => rate.roomTypeId === type.id && rate.date === asOf)!
        .nightlyRate,
      request.nightlyRate,
    );
    assert.equal(delegated.length, 0, 'Mock API requests must never escape to a network backend');
    await firstValueFrom(http.get('/assets/local-check'));
    assert.equal(delegated.length, 1, 'Non-API requests must delegate normally');

    const cancellationEnv = environment({ ...config, mockLatencyMs: 80 });
    const cancellationHttp = cancellationEnv.get(HttpClient);
    const beforeCancel = await get('/room-state-changes');
    const subscription = cancellationHttp
      .patch(`${baseUrl}${statePath}`, { action: 'reserve' })
      .subscribe({
        error: (error) => {
          throw error;
        },
      });
    await delay(5);
    subscription.unsubscribe();
    await delay(110);
    assert.deepEqual(
      await get('/room-state-changes'),
      beforeCancel,
      'Unsubscribing before mock latency must prevent mutation',
    );
    cancellationEnv.destroy();

    await remove('/sessions/current');
    await rejectsHttp(get('/reference-data'), 401);
    const liveRequests: HttpRequest<unknown>[] = [];
    const live = environment(
      { ...config, mode: 'http', baseUrl: 'http://localhost:8787/api/v1' },
      (request) => {
        liveRequests.push(request);
        return of(new HttpResponse({ status: 200, body: { source: 'actual-api' } }));
      },
    );
    assert.deepEqual(
      await firstValueFrom(live.get(ApiClient).get('/reference-data', { hotelId: 'dev-bru' })),
      { source: 'actual-api' },
    );
    assert.equal(
      liveRequests[0].urlWithParams,
      'http://localhost:8787/api/v1/reference-data?hotelId=dev-bru',
    );
    assert.equal(liveRequests[0].withCredentials, false);
    assert.equal(liveRequests[0].headers.get('Accept'), 'application/json');
    await assert.rejects(
      firstValueFrom(live.get(ApiClient).get('//other.example')),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_PATH',
    );
    assert.equal(liveRequests.length, 1);
    live.destroy();

    for (const status of [0, 502, 503, 504]) {
      let attempts = 0;
      const transient = environment({ ...config, mode: 'http' }, () =>
        ++attempts === 1
          ? throwError(() => new HttpErrorResponse({ status }))
          : of(new HttpResponse({ status: 200, body: { recovered: true } })),
      );
      assert.deepEqual(await firstValueFrom(transient.get(ApiClient).get('/hotels')), {
        recovered: true,
      });
      assert.equal(attempts, 2, `Transient GET ${status} retries after backoff.`);
      transient.destroy();
    }
    for (const status of [400, 401, 403, 404, 409, 422, 429, 500, 503]) {
      let attempts = 0;
      const failure = environment({ ...config, mode: 'http' }, () => {
        attempts++;
        return throwError(() => new HttpErrorResponse({ status }));
      });
      await assert.rejects(firstValueFrom(failure.get(ApiClient).get('/hotels')), ApiError);
      assert.equal(
        attempts,
        status === 503 ? 3 : 1,
        'Only eligible transient GET failures receive at most two retries.',
      );
      failure.destroy();
    }
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      let attempts = 0;
      const noWriteRetry = environment({ ...config, mode: 'http' }, () => {
        attempts++;
        return throwError(() => new HttpErrorResponse({ status: 503 }));
      });
      const client = noWriteRetry.get(ApiClient);
      const write =
        method === 'POST'
          ? client.post('/rate-updates', {})
          : method === 'PATCH'
            ? client.patch('/rooms/example/state', {})
            : client.delete('/rooms/example/state');
      await assert.rejects(firstValueFrom(write), ApiError);
      assert.equal(attempts, 1, `${method} must never be retried automatically.`);
      noWriteRetry.destroy();
    }

    let changedPages = 0;
    const changing = environment({ ...config, mode: 'http' }, (request) => {
      changedPages++;
      const page = Number(request.params.get('page'));
      return of(
        new HttpResponse({
          status: 200,
          body: {
            page,
            pageSize: 1000,
            total: page === 1 ? 1001 : 1002,
            items: page === 1 ? Array.from({ length: 1000 }, (_, index) => index) : [1000],
          },
        }),
      );
    });
    await assert.rejects(
      firstValueFrom(changing.get(ApiClient).listAll('/hotels')),
      (error: unknown) => error instanceof ApiError && error.code === 'SNAPSHOT_CHANGED',
    );
    assert.equal(changedPages, 2);
    changing.destroy();

    const pageRequests: HttpRequest<unknown>[] = [];
    const paginated = environment({ ...config, mode: 'http' }, (request) => {
      pageRequests.push(request);
      return of(handleMockRequest(request, baseUrl));
    });
    await firstValueFrom(
      paginated.get(ApiClient).post('/sessions', {
        email: 'pagination.contract@example.com',
        password: 'x'.repeat(22),
      }),
    );
    pageRequests.length = 0;
    const monthlyStates = await firstValueFrom(
      paginated.get(ApiClient).listAll('/room-states', { from: '2026-11-01', to: '2026-11-30' }),
    );
    const expectedStates = NETWORK_DATA.dailyRoomStates.filter(
      (state) => state.date >= '2026-11-01' && state.date <= '2026-11-30',
    );
    assert(expectedStates.length > 1000, 'This fixture must exercise multiple 1000-row pages.');
    assert.deepEqual(monthlyStates, expectedStates);
    assert.equal(pageRequests.length, Math.ceil(expectedStates.length / 1000));
    assert.deepEqual(
      pageRequests.map((request) => request.params.get('page')),
      pageRequests.map((_, index) => String(index + 1)),
    );
    assert(pageRequests.every((request) => request.params.get('pageSize') === '1000'));
    paginated.destroy();

    let referenceRequests = 0;
    const referenceEnv = environment({ ...config, mode: 'http' }, () => {
      const sequence = ++referenceRequests;
      const payload = structuredClone({
        ...reference,
        hotels: NETWORK_DATA.hotels.map((hotel, index) =>
          index === 0 ? { ...hotel, name: `Response ${sequence}` } : hotel,
        ),
      });
      return timer(sequence === 1 ? 40 : 5).pipe(
        map(() => new HttpResponse({ status: 200, body: payload })),
      );
    });
    const referenceService = referenceEnv.get(ReferenceDataService);
    const staleReference = assert.rejects(
      referenceService.load(),
      (error: unknown) => error instanceof ApiError && error.code === 'CANCELLED',
    );
    referenceService.clear();
    await referenceService.load();
    assert.equal(referenceService.data.hotels[0].name, 'Response 2');
    await staleReference;
    assert.equal(
      referenceService.data.hotels[0].name,
      'Response 2',
      'A cleared request must never overwrite a newer session',
    );
    referenceEnv.destroy();

    console.log(
      'Validated actual HttpClient mock REST roundtrips: auth, errors, paging/filtering, immutable responses, scoped page cache/retry, room/rate writes and storage failures, cancellation, exports and real-mode delegation.',
    );
  } finally {
    local.blocked = false;
    env.destroy();
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
