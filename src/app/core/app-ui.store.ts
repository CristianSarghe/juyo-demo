import { computed, inject } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';
import { ReferenceDataService } from './api/reference-data.service';
import type { DateRange, PropertyScope, ReportingMonth } from './network.models';

const STORAGE_KEY = 'juyo.ui-context.v1';

interface AppUiState {
  hotelScope: PropertyScope;
  month: ReportingMonth;
  date: string;
  dashboardRange: DateRange;
}

type ReferenceData = ReferenceDataService['data'];

function isHotelScope(value: unknown, reference: ReferenceData): value is PropertyScope {
  return value === 'portfolio' || reference.hotels.some((hotel) => hotel.id === value);
}

function restoredHotelScope(reference: ReferenceData): PropertyScope {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (
      stored &&
      typeof stored === 'object' &&
      'version' in stored &&
      stored.version === 1 &&
      'hotelScope' in stored &&
      isHotelScope(stored.hotelScope, reference)
    ) {
      return stored.hotelScope;
    }
  } catch {
    // The current session remains usable when browser storage is unavailable.
  }
  return 'portfolio';
}

function initialState(): AppUiState {
  const reference = inject(ReferenceDataService).data;
  const period =
    reference.reportingPeriods.find((candidate) =>
      reference.bookingSnapshot.asOf.startsWith(candidate.key),
    ) ?? reference.reportingPeriods[0];
  return {
    hotelScope: restoredHotelScope(reference),
    month: period.key,
    date: reference.dates.includes(reference.bookingSnapshot.asOf)
      ? reference.bookingSnapshot.asOf
      : period.startDate,
    dashboardRange: { startDate: period.startDate, endDate: period.endDate },
  };
}

function monthChanges(
  state: Pick<AppUiState, 'month' | 'date'>,
  month: ReportingMonth,
  reference: ReferenceData,
) {
  const period = reference.reportingPeriods.find((candidate) => candidate.key === month)!;
  const asOf = reference.bookingSnapshot.asOf;
  const date = state.date.startsWith(month)
    ? state.date
    : asOf.startsWith(month)
      ? asOf
      : period.endDate < asOf
        ? period.endDate
        : period.startDate;
  return {
    month,
    date,
    ...(state.month !== month
      ? { dashboardRange: { startDate: period.startDate, endDate: period.endDate } }
      : {}),
  };
}

/** Shared application context. Dropdown drafts and transient popovers stay in their components. */
export const AppUiStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),
  withComputed(({ month }) => {
    const references = inject(ReferenceDataService);
    return {
      period: computed(
        () => references.data.reportingPeriods.find((period) => period.key === month())!,
      ),
      dates: computed(() => references.data.dates.filter((date) => date.startsWith(month()))),
    };
  }),
  withMethods((store) => {
    const references = inject(ReferenceDataService);
    return {
      /** A new session may expose a different hotel catalog or reporting calendar. */
      reconcileReferenceContext(): void {
        const reference = references.data;
        const hotelScope = isHotelScope(store.hotelScope(), reference)
          ? store.hotelScope()
          : 'portfolio';
        const month = reference.reportingPeriods.find((period) => period.key === store.month());
        let validCalendar =
          !!month && reference.dates.includes(store.date()) && store.date().startsWith(month.key);
        try {
          references.validateDateRange(store.dashboardRange());
        } catch {
          validCalendar = false;
        }
        const fallback =
          reference.reportingPeriods.find((period) =>
            reference.bookingSnapshot.asOf.startsWith(period.key),
          ) ?? reference.reportingPeriods[0];
        patchState(store, {
          hotelScope,
          ...(!validCalendar
            ? {
                month: fallback.key,
                date: reference.dates.includes(reference.bookingSnapshot.asOf)
                  ? reference.bookingSnapshot.asOf
                  : fallback.startDate,
                dashboardRange: { startDate: fallback.startDate, endDate: fallback.endDate },
              }
            : {}),
        });
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, hotelScope }));
        } catch {
          // Session changes remain usable without browser storage.
        }
      },
      selectHotel(value: string): boolean {
        const reference = references.data;
        if (!isHotelScope(value, reference)) return false;
        patchState(store, { hotelScope: value });
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, hotelScope: value }));
        } catch {
          // Selection still applies across pages for this session.
        }
        return true;
      },
      selectMonth(value: string): boolean {
        const reference = references.data;
        const period = reference.reportingPeriods.find((period) => period.key === value);
        if (!period) return false;
        patchState(
          store,
          monthChanges({ month: store.month(), date: store.date() }, period.key, reference),
        );
        return true;
      },
      selectDate(value: string): boolean {
        const reference = references.data;
        if (!reference.dates.includes(value)) return false;
        const period = reference.reportingPeriods.find((period) => value.startsWith(period.key))!;
        patchState(store, {
          ...monthChanges({ month: store.month(), date: store.date() }, period.key, reference),
          date: value,
        });
        return true;
      },
      selectDashboardRange(value: DateRange): boolean {
        const reference = references.data;
        let range: DateRange;
        try {
          range = references.validateDateRange(value);
        } catch {
          return false;
        }
        const period = reference.reportingPeriods.find(
          (period) => period.startDate === range.startDate && period.endDate === range.endDate,
        );
        patchState(store, {
          ...(period
            ? monthChanges({ month: store.month(), date: store.date() }, period.key, reference)
            : {}),
          dashboardRange: { startDate: range.startDate, endDate: range.endDate },
        });
        return true;
      },
    };
  }),
);

export type AppUiStore = InstanceType<typeof AppUiStore>;
