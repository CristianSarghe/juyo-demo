import { Injectable, effect, inject } from '@angular/core';
import { patchState, signalState } from '@ngrx/signals';
import { firstValueFrom, forkJoin, of, Subject, takeUntil } from 'rxjs';
import type {
  EventHotelImpact,
  PropertyScope,
  RoomWarning,
  UpcomingHotelEvent,
} from '../network.models';
import { suggestEventRate } from '../event-rate-plan.service';
import { applyRoomChange } from '../room-operation-state';
import { RoomOperationsService } from '../room-operations.service';
import { RoomRateService } from '../room-rate.service';
import { ApiClient, ApiError } from './api-client.service';
import { NetworkApiService } from './network-api.service';
import { ReferenceDataService } from './reference-data.service';
import { ResourceQueryStore } from './resource-query.store';
import type { RoomOperationChange } from './mutation.models';

const CACHE_TTL_MS = 60_000;
const MAX_ESTIMATE_ENTRIES = 48;

const initial = () => ({
  warnings: null as readonly RoomWarning[] | null,
  events: null as readonly UpcomingHotelEvent[] | null,
  warningsLoading: false,
  eventsLoading: false,
  warningsError: '',
  eventsError: '',
  warningsExpiresAt: 0,
  eventsExpiresAt: 0,
  roomTypeNames: {} as Readonly<Record<string, string>>,
  estimates: {} as Readonly<Record<string, Readonly<Record<string, string>>>>,
  estimateExpiresAt: {} as Readonly<Record<string, number>>,
  estimateEventId: null as string | null,
  estimateLoading: false,
  estimateError: '',
});

/** Small cross-page notification cache. Detail pricing never enters the active page ledger. */
@Injectable({ providedIn: 'root' })
export class NotificationsStore {
  private readonly api = inject(ApiClient);
  private readonly resources = inject(NetworkApiService);
  private readonly queries = inject(ResourceQueryStore);
  private readonly reference = inject(ReferenceDataService);
  private readonly operations = inject(RoomOperationsService);
  private readonly rates = inject(RoomRateService);
  private readonly state = signalState(initial());
  readonly warnings = this.state.warnings;
  readonly events = this.state.events;
  readonly warningsLoading = this.state.warningsLoading;
  readonly eventsLoading = this.state.eventsLoading;
  readonly warningsError = this.state.warningsError;
  readonly eventsError = this.state.eventsError;
  readonly roomTypeNames = this.state.roomTypeNames;
  readonly estimates = this.state.estimates;
  readonly estimateEventId = this.state.estimateEventId;
  readonly estimateLoading = this.state.estimateLoading;
  readonly estimateError = this.state.estimateError;
  private generation = 0;
  private warningRun = 0;
  private estimateRun = 0;
  private warningDetailRun = 0;
  private warningPending?: Promise<void>;
  private eventPending?: Promise<void>;
  private activeEstimate?: UpcomingHotelEvent;
  private readonly cancel = new Subject<void>();
  private readonly cancelWarnings = new Subject<void>();
  private readonly cancelEstimate = new Subject<void>();
  private readonly cancelWarningDetails = new Subject<void>();

  constructor() {
    let roomChanges = this.operations.changes();
    let rateChanges = this.rates.changes();
    effect(() => {
      const rooms = this.operations.changes();
      const rates = this.rates.changes();
      const roomsChanged = rooms !== roomChanges && (rooms.length > 0 || roomChanges.length > 0);
      const ratesChanged = rates !== rateChanges && (rates.length > 0 || rateChanges.length > 0);
      roomChanges = rooms;
      rateChanges = rates;
      if (!roomsChanged && !ratesChanged) return;
      const activeEstimate = this.activeEstimate;
      this.cancelDetails();
      patchState(this.state, { estimates: {}, estimateExpiresAt: {} });
      if (roomsChanged && (this.state.warnings() !== null || this.warningPending))
        void this.loadWarnings(true);
      if (activeEstimate) void this.loadEstimates(activeEstimate);
    });
  }

  initialize(): void {
    void this.loadWarnings();
    void this.loadEvents();
  }
  warningsFor(scope: PropertyScope): RoomWarning[] {
    return (this.warnings() ?? []).filter(
      (warning) => scope === 'portfolio' || warning.hotel.id === scope,
    );
  }
  eventsFor(scope: PropertyScope): UpcomingHotelEvent[] {
    if (scope === 'portfolio') return [...(this.events() ?? [])];
    const importance = { mild: 0, medium: 1, important: 2 } as const;
    return (this.events() ?? []).flatMap((item) => {
      const impacts = item.impacts.filter((impact) => impact.hotelId === scope);
      if (!impacts.length) return [];
      return [
        {
          ...item,
          impacts,
          importance: impacts.reduce(
            (best, impact) =>
              importance[impact.importance] > importance[best] ? impact.importance : best,
            impacts[0].importance,
          ),
        },
      ];
    });
  }
  loadWarnings(force = false): Promise<void> {
    if (!force && this.warnings() !== null && this.state.warningsExpiresAt() > Date.now())
      return Promise.resolve();
    if (!force && this.warningPending) return this.warningPending;
    if (force) this.cancelWarnings.next();
    const generation = this.generation;
    const run = ++this.warningRun;
    patchState(this.state, { warningsLoading: true, warningsError: '' });
    const pending = firstValueFrom(
      this.api
        .listAll<RoomWarning>('/warnings', { date: this.reference.data.bookingSnapshot.asOf })
        .pipe(takeUntil(this.cancel), takeUntil(this.cancelWarnings)),
    )
      .then((warnings) => {
        if (generation === this.generation && run === this.warningRun)
          patchState(this.state, { warnings, warningsExpiresAt: Date.now() + CACHE_TTL_MS });
      })
      .catch((error: unknown) => {
        if (generation === this.generation && run === this.warningRun)
          patchState(this.state, { warningsError: message(error, 'Could not load warnings.') });
      })
      .finally(() => {
        if (generation === this.generation && run === this.warningRun) {
          this.warningPending = undefined;
          patchState(this.state, { warningsLoading: false });
        }
      });
    this.warningPending = pending;
    return pending;
  }
  loadEvents(): Promise<void> {
    if (this.events() !== null && this.state.eventsExpiresAt() > Date.now())
      return Promise.resolve();
    if (this.eventPending) return this.eventPending;
    const generation = this.generation;
    patchState(this.state, { eventsLoading: true, eventsError: '' });
    return (this.eventPending = firstValueFrom(
      this.api
        .listAll<UpcomingHotelEvent>('/events/upcoming', {
          date: this.reference.data.bookingSnapshot.asOf,
        })
        .pipe(takeUntil(this.cancel)),
    )
      .then((events) => {
        if (generation === this.generation)
          patchState(this.state, { events, eventsExpiresAt: Date.now() + CACHE_TTL_MS });
      })
      .catch((error: unknown) => {
        if (generation === this.generation)
          patchState(this.state, {
            eventsError: message(error, 'Could not load upcoming events.'),
          });
      })
      .finally(() => {
        if (generation === this.generation) {
          this.eventPending = undefined;
          patchState(this.state, { eventsLoading: false });
        }
      }));
  }
  async loadWarningDetails(warning: RoomWarning): Promise<void> {
    const generation = this.generation;
    const run = this.warningDetailRun;
    try {
      const types = await firstValueFrom(
        this.queries
          .list('roomTypes', { hotelId: warning.hotel.id })
          .pipe(takeUntil(this.cancel), takeUntil(this.cancelWarningDetails)),
      );
      if (generation !== this.generation || run !== this.warningDetailRun) return;
      patchState(this.state, {
        roomTypeNames: {
          ...this.roomTypeNames(),
          ...Object.fromEntries(types.map((type) => [type.id, type.name])),
        },
      });
    } catch {
      // The warning remains usable with its room number when the optional type label is unavailable.
    }
  }
  async loadEstimates(item: UpcomingHotelEvent): Promise<void> {
    this.cancelEstimate.next();
    const run = ++this.estimateRun;
    const generation = this.generation;
    this.activeEstimate = item;
    this.pruneEstimates();
    const cached = this.estimates()[item.event.id] ?? {};
    if (item.impacts.every((impact) => cached[impact.hotelId])) {
      patchState(this.state, {
        estimateEventId: item.event.id,
        estimateLoading: false,
        estimateError: '',
      });
      return;
    }
    patchState(this.state, {
      estimateEventId: item.event.id,
      estimateLoading: true,
      estimateError: '',
    });
    const results: Record<string, string> = { ...cached };
    try {
      for (const impact of item.impacts) {
        if (results[impact.hotelId]) continue;
        results[impact.hotelId] = await this.estimate(item, impact);
        if (generation !== this.generation || run !== this.estimateRun) return;
      }
      patchState(this.state, {
        estimates: { ...this.estimates(), [item.event.id]: results },
        estimateExpiresAt: {
          ...this.state.estimateExpiresAt(),
          [item.event.id]: this.state.estimateExpiresAt()[item.event.id] ?? Date.now() + CACHE_TTL_MS,
        },
      });
      this.pruneEstimates();
    } catch (error) {
      if (generation === this.generation && run === this.estimateRun)
        patchState(this.state, {
          estimateError: message(error, 'Could not load the price estimate.'),
        });
    } finally {
      if (generation === this.generation && run === this.estimateRun)
        patchState(this.state, { estimateLoading: false });
    }
  }
  cancelDetails(): void {
    this.activeEstimate = undefined;
    this.estimateRun++;
    this.warningDetailRun++;
    this.cancelEstimate.next();
    this.cancelWarningDetails.next();
    patchState(this.state, { estimateEventId: null, estimateLoading: false, estimateError: '' });
  }
  clear(): void {
    this.generation++;
    this.warningRun++;
    this.estimateRun++;
    this.warningDetailRun++;
    this.cancel.next();
    this.cancelWarnings.next();
    this.cancelEstimate.next();
    this.cancelWarningDetails.next();
    this.warningPending = undefined;
    this.eventPending = undefined;
    this.activeEstimate = undefined;
    patchState(this.state, initial());
  }

  private pruneEstimates(): void {
    const expiresAt = this.state.estimateExpiresAt();
    const now = Date.now();
    const ids = Object.keys(this.estimates())
      .filter((id) => expiresAt[id] > now)
      .sort((left, right) => expiresAt[right] - expiresAt[left])
      .slice(0, MAX_ESTIMATE_ENTRIES);
    patchState(this.state, {
      estimates: Object.fromEntries(ids.map((id) => [id, this.estimates()[id]])),
      estimateExpiresAt: Object.fromEntries(ids.map((id) => [id, expiresAt[id]])),
    });
  }

  private async estimate(item: UpcomingHotelEvent, impact: EventHotelImpact): Promise<string> {
    const today = this.reference.data.bookingSnapshot.asOf;
    const range = this.reference.validateDateRange({
      startDate: item.event.startDate < today ? today : item.event.startDate,
      endDate: item.event.endDate,
    });
    const query = { hotelId: impact.hotelId, from: range.startDate, to: range.endDate };
    const context = await firstValueFrom(
      forkJoin({
        types: this.queries.list('roomTypes', { hotelId: impact.hotelId }),
        rooms: this.queries.list('rooms', { hotelId: impact.hotelId }),
        states: this.queries.list('dailyRoomStates', query),
        rates: this.resources.list('roomRates', query),
        changes:
          range.startDate === today
            ? this.queries.roomChanges()
            : of([] as RoomOperationChange[]),
      }).pipe(takeUntil(this.cancel), takeUntil(this.cancelEstimate)),
    );
    const dates = this.reference.data.dates.filter(
      (date) => date >= range.startDate && date <= range.endDate,
    );
    const states = new Map(context.states.map((state) => [`${state.roomId}/${state.date}`, state]));
    const rateMap = new Map(
      context.rates.map((rate) => [`${rate.roomTypeId}/${rate.date}`, rate.nightlyRate]),
    );
    const changes = new Map(
      context.changes.map((change) => [`${change.roomId}/${change.date}`, change]),
    );
    const candidates = [...context.types]
      .sort((a, b) => b.inventory - a.inventory)
      .flatMap((type) => {
        let availableRoomNights = 0;
        let bookedRoomNights = 0;
        let sellableRoomNights = 0;
        let totalRate = 0;
        for (const date of dates) {
          const rate = rateMap.get(`${type.id}/${date}`);
          if (!Number.isFinite(rate))
            throw new ApiError(502, 'INVALID_RATE_DATA', 'Price data is incomplete. Try again.');
          totalRate += rate!;
          for (const room of context.rooms.filter((room) => room.roomTypeId === type.id)) {
            const state = states.get(`${room.id}/${date}`);
            if (!state)
              throw new ApiError(502, 'INVALID_ROOM_DATA', 'Room data is incomplete. Try again.');
            const managed = applyRoomChange(
              { ...room, ...state },
              date === today ? changes.get(`${room.id}/${date}`) : undefined,
            );
            if (managed.status === 'available') availableRoomNights++;
            if (managed.status === 'occupied') bookedRoomNights++;
            if (managed.status !== 'out_of_service') sellableRoomNights++;
          }
        }
        return availableRoomNights
          ? [
              {
                type,
                context: {
                  ...range,
                  nights: dates.length,
                  availableRoomNights,
                  bookedRoomNights,
                  sellableRoomNights,
                  bookedOccupancy: sellableRoomNights
                    ? (bookedRoomNights / sellableRoomNights) * 100
                    : 0,
                  baseRate: totalRate / dates.length,
                },
              },
            ]
          : [];
      })
      .slice(0, 2);
    if (!candidates.length) return 'No unsold rooms remain for this event period.';
    const increases = candidates.map(({ context }) => {
      const suggestion = suggestEventRate(context, impact.importance);
      return Math.round((suggestion.nightlyRate / context.baseRate - 1) * 100);
    });
    const min = Math.min(...increases);
    const max = Math.max(...increases);
    const names = candidates.map(({ type }) => type.name).join(' and ');
    const format = (date: string) =>
      new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(new Date(`${date}T12:00:00Z`));
    const datesLabel =
      range.startDate === range.endDate
        ? format(range.startDate)
        : `${format(range.startDate)}–${format(range.endDate)}`;
    return max > 0
      ? `We estimate room rates could rise by ${min === max ? max : min === 0 ? `up to ${max}` : `${min}–${max}`}% for ${names} rooms, ${datesLabel}.`
      : `We suggest keeping current rates for ${names} rooms, ${datesLabel}.`;
  }
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
