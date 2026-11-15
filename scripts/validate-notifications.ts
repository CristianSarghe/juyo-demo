import '@angular/compiler';
import assert from 'node:assert/strict';
import {
  createEnvironmentInjector,
  Injector,
  provideZonelessChangeDetection,
  signal,
  ɵINJECTOR_SCOPE,
  type EnvironmentInjector,
} from '@angular/core';
import { defer, finalize, map, throwError, timer } from 'rxjs';
import { ApiClient } from '../src/app/core/api/api-client.service';
import { NetworkApiService } from '../src/app/core/api/network-api.service';
import { NotificationsStore } from '../src/app/core/api/notifications.store';
import { ReferenceDataService } from '../src/app/core/api/reference-data.service';
import type { ApiQuery, CollectionKey } from '../src/app/core/api/api.models';
import type { RoomOperationChange, RoomRateChange } from '../src/app/core/api/mutation.models';
import { NETWORK_DATA, REPORTING_DATES } from '../src/app/core/network.data';
import { createNetworkSelectors } from '../src/app/core/network.selectors';
import { RoomOperationsService } from '../src/app/core/room-operations.service';
import { RoomRateService } from '../src/app/core/room-rate.service';

async function main() {
  const selectors = createNetworkSelectors(NETWORK_DATA);
  const allEvents = selectors.upcomingEvents();
  const calls: { path: string; query: ApiQuery }[] = [];
  let latency = 2;
  let active = 0;
  let failWarnings = false;
  const roomChanges = signal<readonly RoomOperationChange[]>([]);
  const rateChanges = signal<readonly RoomRateChange[]>([]);
  const response = <T>(path: string, query: ApiQuery, value: T) =>
    defer(() => {
      calls.push({ path, query });
      active++;
      return timer(latency).pipe(
        map(() => value),
        finalize(() => active--),
      );
    });
  const injector = createEnvironmentInjector(
    [
      { provide: ɵINJECTOR_SCOPE, useValue: 'root' },
      provideZonelessChangeDetection(),
      {
        provide: ApiClient,
        useValue: {
          listAll(path: string, query: ApiQuery) {
            if (path === '/warnings' && failWarnings) {
              failWarnings = false;
              return throwError(() => new Error('Warnings unavailable'));
            }
            assert(
              ['/warnings', '/events/upcoming'].includes(path),
              'Only shared notification lists load.',
            );
            return response(
              path,
              query,
              path === '/warnings' ? selectors.roomWarnings() : allEvents,
            );
          },
          get(path: string) {
            assert.equal(path, '/room-state-changes');
            return response(path, {}, []);
          },
        },
      },
      {
        provide: NetworkApiService,
        useValue: {
          list(key: CollectionKey, query: ApiQuery) {
            assert(['roomTypes', 'rooms', 'dailyRoomStates', 'roomRates'].includes(key));
            assert(query.hotelId, 'Event details must always scope resources to a hotel.');
            const rows = (NETWORK_DATA[key] as { hotelId?: string; date?: string }[]).filter(
              (row) =>
                row.hotelId === query.hotelId &&
                (!row.date ||
                  !query.from ||
                  (row.date >= String(query.from) && row.date <= String(query.to))),
            );
            return response(key, query, rows);
          },
        },
      },
      {
        provide: ReferenceDataService,
        useValue: {
          data: { ...NETWORK_DATA, dates: REPORTING_DATES },
          validateDateRange: selectors.validateDateRange,
        },
      },
      {
        provide: RoomOperationsService,
        useValue: { changes: roomChanges },
      },
      { provide: RoomRateService, useValue: { changes: rateChanges } },
    ],
    Injector.NULL as EnvironmentInjector,
  );
  try {
    const store = injector.get(NotificationsStore);
    store.initialize();
    await Promise.all([store.loadWarnings(), store.loadEvents()]);
    assert.equal(
      calls.length,
      2,
      'Header startup fetches two small lists, without page-ledger resources.',
    );
    assert.equal(store.warningsFor('dev-ams').length, 0);
    assert.equal(store.warnings()?.length, 2);
    const scopedEvents = store.eventsFor('dev-ams');
    assert(
      scopedEvents.every((item) => item.impacts.every((impact) => impact.hotelId === 'dev-ams')),
    );
    store.eventsFor('dev-ber');
    store.warningsFor('portfolio');
    assert.equal(
      calls.length,
      2,
      'Changing selected hotel derives counts from the shared small cache.',
    );

    const shared = allEvents.find((item) => item.impacts.length > 1)!;
    assert(shared, 'The fixture includes a multi-hotel event.');
    await store.loadEstimates({ ...shared, impacts: [shared.impacts[0]] });
    assert(store.estimates()[shared.event.id][shared.impacts[0].hotelId]);
    assert.equal(Object.keys(store.estimates()[shared.event.id]).length, 1);
    await store.loadEstimates(shared);
    assert.equal(
      Object.keys(store.estimates()[shared.event.id]).length,
      shared.impacts.length,
      'Opening portfolio detail after one-hotel detail loads missing hotel estimates.',
    );
    const detailCalls = calls.filter((call) =>
      ['dailyRoomStates', 'roomRates'].includes(call.path),
    );
    for (const call of detailCalls) {
      assert(shared.impacts.some((impact) => impact.hotelId === call.query.hotelId));
      assert.equal(
        call.query.from,
        shared.event.startDate < NETWORK_DATA.bookingSnapshot.asOf
          ? NETWORK_DATA.bookingSnapshot.asOf
          : shared.event.startDate,
      );
      assert.equal(call.query.to, shared.event.endDate);
    }
    const count = calls.length;
    store.cancelDetails();
    await store.loadEstimates(shared);
    assert.equal(
      calls.length,
      count,
      'Reopening unchanged event detail uses its scoped estimate cache.',
    );

    const warningsBeforeChange = calls.filter((call) => call.path === '/warnings').length;
    roomChanges.set([
      {
        roomId: NETWORK_DATA.rooms[0].id,
        date: NETWORK_DATA.bookingSnapshot.asOf,
        status: 'out_of_service',
        appliedAt: '2026-11-14T10:00:00Z',
      },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      calls.filter((call) => call.path === '/warnings').length,
      warningsBeforeChange + 1,
      'A confirmed room change refreshes shared warnings.',
    );
    const requestsAfterRoomChange = calls.length;
    rateChanges.set([
      {
        id: 'rate-change-test',
        hotelId: shared.impacts[0].hotelId,
        roomTypeId: NETWORK_DATA.roomTypes.find(
          (type) => type.hotelId === shared.impacts[0].hotelId,
        )!.id,
        startDate: shared.event.startDate,
        endDate: shared.event.endDate,
        nightlyRate: 200,
        appliedAt: '2026-11-14T10:01:00Z',
      },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert(
      calls.length > requestsAfterRoomChange,
      'A confirmed rate change refreshes only active event estimates.',
    );

    store.clear();
    latency = 50;
    const cancelled = store.loadEstimates(shared);
    store.cancelDetails();
    await cancelled;
    assert.equal(active, 0, 'Closing detail unsubscribes its scoped resource requests.');
    assert.deepEqual(store.estimates(), {});
    store.initialize();
    store.clear();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(active, 0, 'Session teardown unsubscribes notification requests.');
    assert.equal(store.warnings(), null);
    assert.equal(store.events(), null);
    assert.equal(store.warningsLoading(), false);
    assert.equal(store.eventsLoading(), false);

    latency = 1;
    failWarnings = true;
    await store.loadWarnings();
    assert.equal(store.warnings(), null);
    assert.equal(store.warningsError(), 'Warnings unavailable');
    await store.loadWarnings();
    assert.equal(store.warningsError(), '');
    assert.equal(store.warnings()?.length, 2);
    console.log(
      'Validated shared notification-only startup, hotel counts, scoped event pricing, cache reuse, cancellation, teardown and retry.',
    );
  } finally {
    injector.destroy();
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
