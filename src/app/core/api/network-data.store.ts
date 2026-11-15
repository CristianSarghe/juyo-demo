import { Injectable, inject } from '@angular/core';
import { patchState, signalState } from '@ngrx/signals';
import { firstValueFrom, forkJoin, of, Subject, takeUntil, type Observable } from 'rxjs';
import type { DateRange, HotelDaySummary, HotelNetwork, PropertyScope } from '../network.models';
import type { BookingRateHistoryDay } from '../room-price-history';
import { createNetworkSelectors } from '../network.selectors';
import { applyRoomChange } from '../room-operation-state';
import { ApiError } from './api-client.service';
import { ReferenceDataService } from './reference-data.service';
import { ResourceQueryStore } from './resource-query.store';
import { pageRequestKey, type PageRequest } from './page-data.models';
import type { ApiQuery, ReferenceDataDto } from './api.models';

const PAGE_TTL_MS = 60_000;
const DAY_TTL_MS = 30_000;
interface PageResult {
  readonly data: HotelNetwork;
  readonly history: BookingRateHistoryDay[];
  readonly roomTypeId: string | null;
}
interface DayEntry {
  readonly value: HotelDaySummary;
  readonly expiresAt: number;
}

/** Page read models are explicitly partial. Unrequested collections are never fetched. */
export function emptyPageData(reference: ReferenceDataDto): HotelNetwork {
  return {
    meta: reference.meta,
    bookingSnapshot: reference.bookingSnapshot,
    hotels: reference.hotels,
    reportingPeriods: reference.reportingPeriods,
    events: [],
    eventHotelImpacts: [],
    roomTypes: [],
    roomRates: [],
    rooms: [],
    facilities: [],
    restaurants: [],
    costs: [],
    unitCosts: [],
    channels: [],
    dailyPerformance: [],
    reservations: [],
    bookingPositions: [],
    dailyRoomStates: [],
    dailyCosts: [],
    dailyChannels: [],
    reservationNights: [],
    dailyFacilityActivity: [],
  };
}

const scopeQuery = (scope: PropertyScope): ApiQuery =>
  scope === 'portfolio' ? {} : { hotelId: scope };
const dateQuery = (range: DateRange): ApiQuery => ({ from: range.startDate, to: range.endDate });
const dayKey = (scope: PropertyScope, date: string): string => JSON.stringify([scope, date]);

/** Atomic active-page state plus small, keyed drill-downs. Reference metadata has its own store. */
@Injectable({ providedIn: 'root' })
export class NetworkDataStore {
  private readonly queries = inject(ResourceQueryStore);
  private readonly reference = inject(ReferenceDataService);
  private readonly state = signalState<{
    value: HotelNetwork | null;
    activeKey: string | null;
    expiresAt: number;
    loading: boolean;
    error: string;
    resolvedRoomTypeId: string | null;
    priceHistory: BookingRateHistoryDay[];
    days: Readonly<Record<string, DayEntry>>;
    revision: number;
    dayRevision: number;
  }>({
    value: null,
    activeKey: null,
    expiresAt: 0,
    loading: false,
    error: '',
    resolvedRoomTypeId: null,
    priceHistory: [],
    days: {},
    revision: 0,
    dayRevision: 0,
  });
  readonly loading = this.state.loading;
  readonly error = this.state.error;
  readonly snapshot = this.state.value;
  readonly activeKey = this.state.activeKey;
  readonly resolvedRoomTypeId = this.state.resolvedRoomTypeId;
  readonly priceHistory = this.state.priceHistory;
  readonly revision = this.state.revision;
  readonly dayRevision = this.state.dayRevision;
  private pending?: { key: string; promise: Promise<void> };
  private lastRequest?: PageRequest;
  private generation = 0;
  private readonly cancelPage = new Subject<void>();
  private readonly cancelDay = new Subject<void>();
  private dayGeneration = 0;
  private pendingDay?: { key: string; promise: Promise<HotelDaySummary> };

  get dates(): string[] {
    return this.reference.data.dates;
  }
  get data(): HotelNetwork {
    const data = this.state.value();
    if (!data) throw new Error('Page data must load before opening this view.');
    return data;
  }

  load(request: PageRequest): Promise<void> {
    const key = pageRequestKey(request);
    if (this.pending?.key === key) return this.pending.promise;
    if (this.state.activeKey() === key && this.state.expiresAt() > Date.now()) {
      // A -> B (pending) -> A must cancel B before reusing the already published A page.
      if (this.pending) {
        this.cancelPage.next();
        this.generation++;
        this.pending = undefined;
      }
      this.lastRequest = { ...request, range: { ...request.range } };
      patchState(this.state, { loading: false, error: '' });
      return Promise.resolve();
    }
    this.cancelDayLoad();
    this.cancelPage.next();
    const generation = ++this.generation;
    const selection = { ...request, range: { ...request.range } };
    this.lastRequest = selection;
    patchState(this.state, { loading: true, error: '' });
    const promise = this.readPage(selection, generation)
      .then((result) => {
        this.assertCurrent(generation);
        patchState(this.state, {
          value: result.data,
          priceHistory: result.history,
          resolvedRoomTypeId: result.roomTypeId,
          activeKey: key,
          expiresAt: Date.now() + PAGE_TTL_MS,
          loading: false,
          error: '',
        });
      })
      .catch((error: unknown) => {
        if (generation !== this.generation) throw this.cancelled();
        patchState(this.state, {
          loading: false,
          error: error instanceof Error ? error.message : 'Could not load this page. Please retry.',
        });
        throw error;
      })
      .finally(() => {
        if (generation === this.generation) this.pending = undefined;
      });
    this.pending = { key, promise };
    return promise;
  }

  /** Leave a view without deleting reusable session metadata or scoped resource caches. */
  deactivate(): void {
    this.cancelPage.next();
    this.generation++;
    this.pending = undefined;
    this.lastRequest = undefined;
    this.cancelDay.next();
    this.dayGeneration++;
    this.pendingDay = undefined;
    patchState(this.state, { activeKey: null, loading: false, error: '', expiresAt: 0 });
  }

  /** Confirmed mutations invalidate shared queries; the host reacts to revision and reloads its key. */
  invalidate(): void {
    this.cancelPage.next();
    this.generation++;
    this.pending = undefined;
    this.cancelDay.next();
    this.dayGeneration++;
    this.pendingDay = undefined;
    this.queries.clear();
    patchState(this.state, {
      days: {},
      expiresAt: 0,
      loading: false,
      error: '',
      revision: this.state.revision() + 1,
      dayRevision: this.state.dayRevision() + 1,
    });
  }

  /** Operational overlays affect daily facts, not the canonical page ledger or its mounted controls. */
  invalidateDayDetails(): void {
    this.cancelDay.next();
    this.dayGeneration++;
    this.pendingDay = undefined;
    this.queries.invalidateRoomChanges();
    patchState(this.state, { days: {}, dayRevision: this.state.dayRevision() + 1 });
  }

  refresh(): Promise<void> {
    const request = this.lastRequest;
    this.invalidate();
    return request ? this.load(request) : Promise.resolve();
  }

  clear(): void {
    this.invalidate();
    this.lastRequest = undefined;
    patchState(this.state, {
      value: null,
      activeKey: null,
      priceHistory: [],
      resolvedRoomTypeId: null,
    });
    this.reference.clear();
  }

  getPriceHistory(hotelId: string, roomTypeId: string): BookingRateHistoryDay[] {
    if (
      roomTypeId !== this.state.resolvedRoomTypeId() ||
      !this.state
        .value()
        ?.roomTypes.some((type) => type.hotelId === hotelId && type.id === roomTypeId)
    )
      return [];
    return this.state.priceHistory();
  }

  getDaySummary(scope: PropertyScope, date: string): HotelDaySummary | null {
    const entry = this.state.days()[dayKey(scope, date)];
    return entry && entry.expiresAt > Date.now() ? entry.value : null;
  }

  loadDay(scope: PropertyScope, date: string): Promise<HotelDaySummary> {
    const key = dayKey(scope, date);
    const cached = this.getDaySummary(scope, date);
    if (cached) {
      if (this.pendingDay && this.pendingDay.key !== key) {
        this.cancelDay.next();
        this.dayGeneration++;
        this.pendingDay = undefined;
      }
      return Promise.resolve(cached);
    }
    if (this.pendingDay?.key === key) return this.pendingDay.promise;
    this.cancelDay.next();
    const generation = ++this.dayGeneration;
    const promise = this.readDay(scope, date, generation)
      .then((value) => {
        if (generation !== this.dayGeneration) throw this.cancelled();
        const days = { ...this.state.days(), [key]: { value, expiresAt: Date.now() + DAY_TTL_MS } };
        const oldest = Object.keys(days).sort(
          (left, right) => days[left].expiresAt - days[right].expiresAt,
        );
        while (oldest.length > 24) delete days[oldest.shift()!];
        patchState(this.state, { days });
        return value;
      })
      .catch((error: unknown) => {
        if (generation !== this.dayGeneration) throw this.cancelled();
        throw error;
      })
      .finally(() => {
        if (generation === this.dayGeneration) this.pendingDay = undefined;
      });
    this.pendingDay = { key, promise };
    return promise;
  }

  /** Back/navigation stops drill requests while retaining completed day entries. */
  cancelDayLoad(): void {
    this.cancelDay.next();
    this.dayGeneration++;
    this.pendingDay = undefined;
  }

  private cancelled(): ApiError {
    return new ApiError(0, 'CANCELLED', 'The data request was cancelled.');
  }
  private assertCurrent(generation: number): void {
    if (generation !== this.generation) throw this.cancelled();
  }
  private validateScope(scope: PropertyScope): void {
    if (scope !== 'portfolio' && !this.reference.data.hotels.some((hotel) => hotel.id === scope))
      throw new ApiError(400, 'INVALID_HOTEL', 'Choose a valid hotel.');
  }
  private enclosingMonths(range: DateRange): DateRange {
    const periods = this.reference.data.reportingPeriods;
    const first = periods.find(
      (period) => period.startDate <= range.startDate && period.endDate >= range.startDate,
    );
    const last = periods.find(
      (period) => period.startDate <= range.endDate && period.endDate >= range.endDate,
    );
    if (!first || !last) throw new ApiError(400, 'INVALID_RANGE', 'Choose valid reporting dates.');
    return { startDate: first.startDate, endDate: last.endDate };
  }
  private pageRead<T>(request: Observable<T>, generation: number): Promise<T> {
    this.assertCurrent(generation);
    return firstValueFrom(request.pipe(takeUntil(this.cancelPage)));
  }

  private async readPage(request: PageRequest, generation: number): Promise<PageResult> {
    await this.reference.load();
    this.assertCurrent(generation);
    this.validateScope(request.scope);
    const reference = this.reference.data;
    const data = emptyPageData(reference);
    const result = (
      roomTypeId: string | null = null,
      history: BookingRateHistoryDay[] = [],
    ): PageResult => ({ data, history, roomTypeId });
    if (
      (request.view === 'configuration' || request.view === 'rooms') &&
      request.scope === 'portfolio'
    )
      return result();
    const scope = scopeQuery(request.scope);
    const current = {
      startDate: reference.bookingSnapshot.asOf,
      endDate: reference.bookingSnapshot.asOf,
    };
    if (request.view === 'configuration') {
      data.roomTypes = await this.pageRead(this.queries.list('roomTypes', scope), generation);
      return result();
    }
    if (request.view === 'overview') {
      const range = this.reference.validateDateRange(request.range);
      const context = range.startDate === range.endDate ? range : this.enclosingMonths(range);
      const rows = await this.pageRead(
        forkJoin({
          roomTypes: this.queries.list('roomTypes', scope),
          selectedPositions: this.queries.list('bookingPositions', {
            ...scope,
            ...dateQuery(context),
          }),
          organizationPositions:
            request.scope === 'portfolio'
              ? of([])
              : this.queries.list('bookingPositions', dateQuery(range)),
          reservationNights: this.queries.list('reservationNights', {
            ...scope,
            ...dateQuery(range),
          }),
        }),
        generation,
      );
      data.roomTypes = rows.roomTypes;
      data.reservationNights = rows.reservationNights;
      data.bookingPositions = [
        ...new Map(
          [...rows.organizationPositions, ...rows.selectedPositions].map((position) => [
            `${position.hotelId}/${position.stayDate}`,
            position,
          ]),
        ).values(),
      ];
      return result();
    }
    if (request.view === 'reservations') {
      const rows = await this.pageRead(
        forkJoin({
          roomTypes: this.queries.list('roomTypes', scope),
          rooms: this.queries.list('rooms', scope),
          reservations: this.queries.list('reservations', {
            ...scope,
            stayDate: current.startDate,
          }),
        }),
        generation,
      );
      Object.assign(data, rows);
      return result();
    }
    if (request.view !== 'rooms') throw new ApiError(400, 'INVALID_PAGE', 'Choose a valid page.');
    if (request.section !== 'prices') {
      const rows = await this.pageRead(
        forkJoin({
          roomTypes: this.queries.list('roomTypes', scope),
          rooms: this.queries.list('rooms', scope),
          dailyRoomStates: this.queries.list('dailyRoomStates', {
            ...scope,
            ...dateQuery(current),
          }),
          roomRates: this.queries.list('roomRates', {
            ...scope,
            ...dateQuery(current),
            basis: 'canonical',
          }),
        }),
        generation,
      );
      Object.assign(data, rows);
      return result();
    }
    const range = this.enclosingMonths(this.reference.validateDateRange(request.range));
    data.roomTypes = await this.pageRead(this.queries.list('roomTypes', scope), generation);
    this.assertCurrent(generation);
    const type =
      data.roomTypes.find((candidate) => candidate.id === request.roomTypeId) ?? data.roomTypes[0];
    if (!type) return result();
    const rows = await this.pageRead(
      forkJoin({
        rooms: this.queries.list('rooms', { ...scope, roomTypeId: type.id }),
        dailyRoomStates: this.queries.list('dailyRoomStates', { ...scope, ...dateQuery(range) }),
        roomRates: this.queries.list('roomRates', {
          ...scope,
          ...dateQuery(range),
          roomTypeId: type.id,
          basis: 'canonical',
        }),
        history: this.queries.priceHistory(type.id, range),
      }),
      generation,
    );
    data.rooms = rows.rooms;
    const roomIds = new Set(rows.rooms.map((room) => room.id));
    data.dailyRoomStates = rows.dailyRoomStates.filter((state) => roomIds.has(state.roomId));
    data.roomRates = rows.roomRates;
    return result(type.id, rows.history);
  }

  private async readDay(
    scopeValue: PropertyScope,
    date: string,
    generation: number,
  ): Promise<HotelDaySummary> {
    await this.reference.load();
    if (generation !== this.dayGeneration) throw this.cancelled();
    this.validateScope(scopeValue);
    const range = this.reference.validateDateRange({ startDate: date, endDate: date });
    const previous = new Date(Date.parse(`${date}T12:00:00Z`) - 86_400_000)
      .toISOString()
      .slice(0, 10);
    const from =
      previous < this.reference.data.meta.reportingPeriod.startDate
        ? this.reference.data.meta.reportingPeriod.startDate
        : previous;
    const scope = scopeQuery(scopeValue);
    const current = date === this.reference.data.bookingSnapshot.asOf;
    const rows = await firstValueFrom(
      forkJoin({
        rooms: this.queries.list('rooms', scope),
        dailyRoomStates: this.queries.list('dailyRoomStates', { ...scope, ...dateQuery(range) }),
        bookingPositions: this.queries.list('bookingPositions', { ...scope, ...dateQuery(range) }),
        // Overlap the previous night as well, otherwise departures on this date disappear.
        reservations: this.queries.list('reservations', { ...scope, from, to: date }),
        changes: current ? this.queries.roomChanges() : of([]),
      }).pipe(takeUntil(this.cancelDay)),
    );
    if (generation !== this.dayGeneration) throw this.cancelled();
    const data = Object.assign(emptyPageData(this.reference.data), rows);
    const selectors = createNetworkSelectors(data);
    const summary = selectors.hotelDaySummary(scopeValue, date);
    if (!current) return summary;
    const changes = new Map(
      rows.changes
        .filter((change) => change.date === date)
        .map((change) => [change.roomId, change]),
    );
    const rooms = selectors
      .hotelInventory(scopeValue, date)
      .map((room) => applyRoomChange(room, changes.get(room.id)));
    const occupiedRooms = rooms.filter((room) => room.status === 'occupied').length;
    const outOfOrderRooms = rooms.filter((room) => room.status === 'out_of_service').length;
    const sellableRooms = rooms.length - outOfOrderRooms;
    return {
      ...summary,
      occupiedRooms,
      outOfOrderRooms,
      sellableRooms,
      roomsToSell: rooms.filter((room) => room.status === 'available').length,
      occupancy: sellableRooms ? Math.round((occupiedRooms / sellableRooms) * 10_000) / 100 : 0,
    };
  }
}
