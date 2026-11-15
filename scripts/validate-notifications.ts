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
import { defer, finalize, firstValueFrom, map, throwError, timer } from 'rxjs';
import { ApiClient } from '../src/app/core/api/api-client.service';
import { NetworkApiService } from '../src/app/core/api/network-api.service';
import { NotificationsStore } from '../src/app/core/api/notifications.store';
import { ReferenceDataService } from '../src/app/core/api/reference-data.service';
import { ResourceQueryStore } from '../src/app/core/api/resource-query.store';
import type { ApiQuery, CollectionKey } from '../src/app/core/api/api.models';
import type { RoomOperationChange, RoomRateChange } from '../src/app/core/api/mutation.models';
import { NETWORK_DATA, REPORTING_DATES } from '../src/app/core/network.data';
import { createNetworkSelectors } from '../src/app/core/network.selectors';
import { RoomOperationsService } from '../src/app/core/room-operations.service';
import { RoomRateService } from '../src/app/core/room-rate.service';

async function main() {
  const realNow = Date.now;
  let clockOffset = 0;
  Date.now = () => realNow() + clockOffset;
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
          roomChanges() {
            return response('/room-state-changes', {}, roomChanges());
          },
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

    const queries = injector.get(ResourceQueryStore);
    const warning = selectors.roomWarnings()[0];
    const beforeWarningDetail = calls.length;
    const pageTypes = firstValueFrom(queries.list('roomTypes', { hotelId: warning.hotel.id }));
    const warningDetail = store.loadWarningDetails(warning);
    const repeatedWarningDetail = store.loadWarningDetails(warning);
    await Promise.all([pageTypes, warningDetail, repeatedWarningDetail]);
    assert.equal(
      calls.length,
      beforeWarningDetail + 1,
      'Page and repeated warning-label reads share one hotel-scoped request.',
    );
    assert(store.roomTypeNames()[warning.room.roomTypeId]);

    const otherHotel = NETWORK_DATA.hotels.find((hotel) => hotel.id !== warning.hotel.id)!;
    const otherType = NETWORK_DATA.roomTypes.find((type) => type.hotelId === otherHotel.id)!;
    latency = 50;
    const cancelledWarning = store.loadWarningDetails({
      ...warning,
      hotel: otherHotel,
      room: { ...warning.room, roomTypeId: otherType.id },
    });
    store.cancelDetails();
    await cancelledWarning;
    assert.equal(active, 0, 'Closing warning detail cancels its unused type-label request.');
    assert.equal(store.roomTypeNames()[otherType.id], undefined);
    latency = 2;

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

    await Promise.all([store.loadWarnings(), store.loadEvents()]);
    assert.equal(calls.length, count, 'Fresh notification lists use their session cache.');
    const oldWarnings = calls.filter((call) => call.path === '/warnings').length;
    const oldEvents = calls.filter((call) => call.path === '/events/upcoming').length;
    clockOffset += 60_001;
    await Promise.all([store.loadWarnings(), store.loadEvents()]);
    assert.equal(calls.filter((call) => call.path === '/warnings').length, oldWarnings + 1);
    assert.equal(calls.filter((call) => call.path === '/events/upcoming').length, oldEvents + 1);
    const oldRateReads = calls.filter((call) => call.path === 'roomRates').length;
    await store.loadEstimates(shared);
    assert.equal(
      calls.filter((call) => call.path === 'roomRates').length,
      oldRateReads + shared.impacts.length,
      'Expired estimates reload effective selling rates for each displayed hotel.',
    );

    latency = 0;
    for (let index = 0; index < 50; index++) {
      clockOffset++;
      await store.loadEstimates({
        ...shared,
        event: { ...shared.event, id: `estimate-cache-${index}` },
        impacts: [shared.impacts[0]],
      });
    }
    assert(Object.keys(store.estimates()).length < 50, 'Estimate entries have a finite bound.');
    assert(store.estimates()['estimate-cache-49'], 'The most recent estimate remains cached.');
    await store.loadEstimates(shared);
    latency = 2;

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
    const rateReadsBeforeChange = calls.filter((call) => call.path === 'roomRates').length;
    const canonicalReadsBeforeChange = calls.filter((call) =>
      ['roomTypes', 'rooms', 'dailyRoomStates'].includes(call.path),
    ).length;
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
    assert.equal(
      calls.filter((call) => call.path === 'roomRates').length,
      rateReadsBeforeChange + shared.impacts.length,
      'A confirmed rate change bypasses cached effective rates.',
    );
    assert.equal(
      calls.filter((call) => ['roomTypes', 'rooms', 'dailyRoomStates'].includes(call.path)).length,
      canonicalReadsBeforeChange,
      'A confirmed rate change reuses canonical hotel and room-state resources.',
    );

    const ongoing = {
      ...shared,
      event: {
        ...shared.event,
        id: 'ongoing-shared-event',
        startDate: NETWORK_DATA.bookingSnapshot.asOf,
      },
    };
    queries.invalidateRoomChanges();
    const overlaysBeforeDetail = calls.filter((call) => call.path === '/room-state-changes').length;
    await Promise.all([
      firstValueFrom(queries.roomChanges()),
      store.loadEstimates(ongoing),
    ]);
    assert.equal(
      calls.filter((call) => call.path === '/room-state-changes').length,
      overlaysBeforeDetail + 1,
      'A day read and every ongoing-event hotel share one global room-overlay request.',
    );

    // The real RoomOperationsService invalidates merged day details after a confirmed edit.
    queries.invalidateRoomChanges();
    roomChanges.set([
      { ...roomChanges()[0], appliedAt: '2026-11-14T10:02:00Z' },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      calls.filter((call) => call.path === '/room-state-changes').length,
      overlaysBeforeDetail + 2,
      'A confirmed room edit forces one fresh shared overlay read for active event estimates.',
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

    const completedWarning = store.loadWarningDetails(warning);
    store.cancelDetails();
    await completedWarning;
    assert.deepEqual(
      store.roomTypeNames(),
      {},
      'A synchronously cached label response cannot publish after its detail closes.',
    );

    latency = 1;
    failWarnings = true;
    await store.loadWarnings();
    assert.equal(store.warnings(), null);
    assert.equal(store.warningsError(), 'Warnings unavailable');
    await store.loadWarnings();
    assert.equal(store.warningsError(), '');
    assert.equal(store.warnings()?.length, 2);
    console.log(
      'Validated notification-only startup, scoped detail sharing, finite cache freshness/bounds, mutation refresh, close cancellation, teardown and retry.',
    );
  } finally {
    Date.now = realNow;
    injector.destroy();
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
