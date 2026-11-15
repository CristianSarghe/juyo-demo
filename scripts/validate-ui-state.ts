import '@angular/compiler';
import assert from 'node:assert/strict';
import { getState } from '@ngrx/signals';
import {
  createEnvironmentInjector,
  EnvironmentInjector,
  Injector,
  runInInjectionContext,
  signal,
} from '@angular/core';
import { ReferenceDataService } from '../src/app/core/api/reference-data.service';
import { NETWORK_DATA, REPORTING_DATES } from '../src/app/core/network.data';
import { AppUiStore } from '../src/app/core/app-ui.store';
import { HotelScopeService } from '../src/app/core/hotel-scope.service';
import { ReportingScopeService } from '../src/app/core/reporting-scope.service';

const key = 'juyo.ui-context.v1';
const storage = new Map<string, string>();
let storageBlocked = false;
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (name: string) => {
      if (storageBlocked) throw new Error('Storage blocked');
      return storage.get(name) ?? null;
    },
    setItem: (name: string, value: string) => {
      if (storageBlocked) throw new Error('Storage blocked');
      storage.set(name, value);
    },
  },
});

const referenceSnapshot = signal<ReferenceDataService['data']>({
  meta: NETWORK_DATA.meta,
  bookingSnapshot: NETWORK_DATA.bookingSnapshot,
  reportingPeriods: NETWORK_DATA.reportingPeriods,
  dates: REPORTING_DATES,
  hotels: NETWORK_DATA.hotels,
});
const environment = createEnvironmentInjector(
  [
    {
      provide: ReferenceDataService,
      useValue: {
        get data() {
          return referenceSnapshot();
        },
        validateDateRange: ReferenceDataService.prototype.validateDateRange,
      },
    },
  ],
  Injector.NULL as EnvironmentInjector,
);
const createStore = () => runInInjectionContext(environment, () => new AppUiStore());
const store = createStore();
const toolbar = new HotelScopeService(store);
const page = new HotelScopeService(store);
const reporting = new ReportingScopeService(store);
assert.equal(toolbar.scope(), 'portfolio');
assert.equal(toolbar.select('dev-ber'), true);
assert.equal(page.scope(), 'dev-ber', 'All facades share the same root store context');
assert.equal(new HotelScopeService(store).scope(), 'dev-ber', 'Recreated pages keep selection');
assert.equal(createStore().hotelScope(), 'dev-ber', 'Reload restores the selected hotel');
const committed = getState(store);
assert.equal(page.select('unknown-hotel'), false);
assert.deepEqual(getState(store), committed, 'Invalid hotel cannot replace committed context');

const custom = { startDate: '2026-10-28', endDate: '2026-11-16' };
assert.equal(reporting.selectDashboardRange(custom), true);
assert.equal(reporting.month(), '2026-11');
assert.equal(reporting.date(), '2026-11-14');
assert.equal(toolbar.select('dev-bru'), true);
assert.deepEqual(reporting.dashboardRange(), custom, 'Hotel changes preserve applied dates');
assert.equal(reporting.selectMonth('2026-12'), true);
assert.equal(reporting.date(), '2026-12-01');
assert.deepEqual(reporting.dashboardRange(), { startDate: '2026-12-01', endDate: '2026-12-31' });
assert.equal(reporting.selectDate('2026-10-15'), true);
assert.equal(reporting.date(), '2026-10-15');
assert.deepEqual(reporting.dashboardRange(), { startDate: '2026-10-01', endDate: '2026-10-31' });
assert.equal(
  reporting.selectDashboardRange({ startDate: '2026-10-15', endDate: '2026-10-15' }),
  true,
);
assert.equal(reporting.selectMonth('2026-10'), true);
assert.deepEqual(
  reporting.dashboardRange(),
  { startDate: '2026-10-15', endDate: '2026-10-15' },
  'Reselecting the same month preserves the custom range, matching the existing service contract',
);
assert.equal(
  reporting.selectDashboardRange({ startDate: '2026-10-01', endDate: '2026-10-31' }),
  true,
);
assert.deepEqual(reporting.dashboardRange(), { startDate: '2026-10-01', endDate: '2026-10-31' });
const dates = getState(store);
assert.equal(reporting.selectMonth('2027-01'), false);
assert.equal(reporting.selectDate('2026-11-31'), false);
assert.equal(
  reporting.selectDashboardRange({ startDate: '2026-11-22', endDate: '2026-11-11' }),
  false,
);
assert.deepEqual(getState(store), dates, 'Rejected dates leave the full shared context unchanged');

for (const value of [
  '{broken',
  JSON.stringify({ version: 1, hotelScope: 'unknown-hotel' }),
  JSON.stringify({ version: 0, hotelScope: 'dev-ber' }),
  JSON.stringify({ version: 1, hotelScope: { id: 'dev-ber' } }),
]) {
  storage.set(key, value);
  assert.equal(
    createStore().hotelScope(),
    'portfolio',
    'Invalid saved selection falls back safely',
  );
}
storage.set(key, JSON.stringify({ version: 1, hotelScope: 'dev-ams' }));
assert.equal(createStore().hotelScope(), 'dev-ams');
storageBlocked = true;
assert.equal(createStore().hotelScope(), 'portfolio', 'Unavailable storage does not block startup');
assert.equal(toolbar.select('dev-opo'), true);
assert.equal(
  page.scope(),
  'dev-opo',
  'Selection still applies across pages without browser storage',
);
assert.equal(toolbar.select('portfolio'), true);
assert.equal(page.scope(), 'portfolio');
storageBlocked = false;
const unchangedContext = getState(store);
referenceSnapshot.set({ ...referenceSnapshot() });
store.reconcileReferenceContext();
assert.deepEqual(
  getState(store),
  unchangedContext,
  'A new reference snapshot preserves valid selections',
);

const februaryDates = Array.from(
  { length: 28 },
  (_, index) => `2027-02-${String(index + 1).padStart(2, '0')}`,
);
const february = {
  key: '2027-02',
  startDate: '2027-02-01',
  endDate: '2027-02-28',
  days: 28,
  label: 'February 2027',
};
referenceSnapshot.set({
  ...referenceSnapshot(),
  meta: { ...referenceSnapshot().meta, reportingPeriod: february, snapshotDate: '2027-02-14' },
  bookingSnapshot: {
    ...referenceSnapshot().bookingSnapshot,
    asOf: '2027-02-14',
    previousAsOf: '2027-02-07',
    period: february,
  },
  dates: februaryDates,
  reportingPeriods: [february],
  hotels: [{ ...NETWORK_DATA.hotels[0], id: 'next-session-hotel' }],
});
store.reconcileReferenceContext();
assert.equal(toolbar.scope(), 'portfolio', 'A removed hotel cannot leak into another session');
assert.equal(reporting.month(), '2027-02');
assert.equal(reporting.date(), '2027-02-14');
assert.deepEqual(reporting.dashboardRange(), { startDate: '2027-02-01', endDate: '2027-02-28' });
assert.equal(reporting.period().label, 'February 2027');
assert.deepEqual(reporting.dates(), februaryDates);
assert.equal(
  JSON.parse(storage.get(key)!).hotelScope,
  'portfolio',
  'The reconciled hotel scope is persisted',
);
assert.equal(
  toolbar.select('next-session-hotel'),
  true,
  'API-provided hotel IDs require no frontend code changes',
);
const newSessionContext = getState(store);
storageBlocked = true;
store.reconcileReferenceContext();
assert.deepEqual(
  getState(store),
  newSessionContext,
  'Valid new-session selections survive unavailable browser storage',
);

environment.destroy();
console.log(
  'Validated NgRx shared hotel/reporting context, reference changes across sessions, range transitions, persistence and storage failure fallback.',
);
