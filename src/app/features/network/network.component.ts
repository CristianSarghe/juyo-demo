import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { NetworkService } from '../../core/network.service';
import { ApiError } from '../../core/api/api-client.service';
import { HotelScopeService } from '../../core/hotel-scope.service';
import { ReportingScopeService } from '../../core/reporting-scope.service';
import {
  RoomOperationsService,
  type ManagedRoom,
  type ManagedRoomStatus,
  type RoomOperationAction,
} from '../../core/room-operations.service';
import { ENUM_OPTIONS, type HousekeepingState, type DateRange } from '../../core/network.models';
import { AppSelectComponent } from '../../shared/select.component';
import { DateRangePickerComponent } from '../../shared/date-range-picker.component';
import { DashboardComponent } from './dashboard.component';
import { RoomPricesComponent } from '../room-prices/room-prices.component';
import { ReservationsComponent } from '../reservations/reservations.component';
import { HotelConfigurationComponent } from '../hotel-configuration/hotel-configuration.component';
import {
  RoomOperationsSummaryComponent,
  type RoomQueue,
} from '../../shared/room-operations-summary.component';
import { RoomActionsComponent } from '../../shared/room-actions.component';
import { HotelSelectionComponent } from '../../shared/hotel-selection.component';
import { AssistantUiStore } from '../../core/assistant-ui.store';
import { RoomRateService } from '../../core/room-rate.service';
import { repairHelpPrompt } from '../../core/repair-assistance';
import { KassandraNoteComponent } from '../../shared/kassandra-note.component';
import { NetworkDataStore } from '../../core/api/network-data.store';
import { pageRequestKey, type PageRequest } from '../../core/api/page-data.models';
import { PageSkeletonComponent } from '../../shared/page-skeleton.component';

type DataView = 'overview' | 'rooms' | 'reservations' | 'configuration';
const euro = new Intl.NumberFormat('en-IE', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 0,
});

@Component({
  selector: 'app-network',
  imports: [
    FormsModule,
    KassandraNoteComponent,
    AppSelectComponent,
    DateRangePickerComponent,
    DashboardComponent,
    RoomPricesComponent,
    ReservationsComponent,
    HotelConfigurationComponent,
    RoomOperationsSummaryComponent,
    RoomActionsComponent,
    HotelSelectionComponent,
    RouterLink,
    PageSkeletonComponent,
  ],
  templateUrl: './network.component.html',
  styleUrl: './network.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NetworkComponent {
  readonly network = inject(NetworkService);
  readonly pageData = inject(NetworkDataStore);
  private readonly pageLoadError = signal('');
  private readonly overlaysReady = signal('');
  private pageLoadGeneration = 0;
  readonly inspectedDay = signal<string | null>(null);
  readonly reporting = inject(ReportingScopeService);
  private readonly hotelScope = inject(HotelScopeService);
  private readonly roomOperations = inject(RoomOperationsService);
  private readonly rates = inject(RoomRateService);
  private readonly assistant = inject(AssistantUiStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly meta = this.network.meta;
  private readonly route = inject(ActivatedRoute);
  private readonly query = toSignal(this.route.queryParamMap);
  private readonly router = inject(Router);
  readonly view = computed<DataView>(() => {
    const value = this.query()?.get('view');
    return value === 'rooms' || value === 'reservations' || value === 'configuration'
      ? value
      : 'overview';
  });
  readonly managementView = computed(() =>
    ['rooms', 'reservations', 'configuration'].includes(this.view()),
  );
  readonly roomSection = computed(() =>
    this.query()?.get('section') === 'prices' ? 'prices' : 'inventory',
  );
  readonly pageTitle = computed(
    () =>
      ({
        overview: 'Overview',
        rooms: 'Room management',
        reservations: 'Reservations',
        configuration: 'Hotel configuration',
      })[this.view()],
  );
  readonly occupancyOptions = [
    { value: 'all', label: 'All room states' },
    ...ENUM_OPTIONS.roomOccupancy.map((value) => ({ value, label: this.label(value) })),
    { value: 'reserved', label: 'Reserved manually' },
  ];
  readonly housekeepingOptions = [
    { value: 'all', label: 'All housekeeping' },
    ...ENUM_OPTIONS.housekeeping.map((value) => ({ value, label: this.label(value) })),
  ];
  readonly scope = this.hotelScope.scope;
  readonly needsHotel = computed(
    () => this.scope() === 'portfolio' && ['rooms', 'configuration'].includes(this.view()),
  );
  readonly managementDate = this.network.bookingSnapshot.asOf;
  private readonly effectiveDate = computed(() =>
    this.managementView() ? this.managementDate : this.reporting.date(),
  );
  readonly occupancy = signal<ManagedRoomStatus | 'all'>('all');
  readonly housekeeping = signal<HousekeepingState | 'all'>('all');
  readonly roomSearch = signal('');
  readonly priceDateFocus = signal<keyof DateRange | null>(null);
  readonly roomPage = signal(0);
  readonly roomFeedback = signal('');
  readonly roomActionError = signal('');
  readonly roomSavingId = signal<string | null>(null);
  readonly pageSize = 12;
  readonly selectedHotel = computed(
    () => this.network.hotels.find((hotel) => hotel.id === this.scope()) ?? null,
  );
  readonly request = computed<PageRequest>(() => {
    const today = this.managementDate;
    const query = this.query();
    let range: DateRange =
      this.view() === 'overview'
        ? this.reporting.dashboardRange()
        : { startDate: today, endDate: today };
    if (this.view() === 'rooms' && this.roomSection() === 'prices') {
      const defaultEnd = new Date(Date.parse(`${today}T12:00:00Z`) + 6 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const maxDate = this.network.dates.at(-1)!;
      const draft = {
        startDate: query?.get('from') ?? today,
        endDate: query?.get('through') ?? (defaultEnd > maxDate ? maxDate : defaultEnd),
      };
      try {
        range = this.network.validateDateRange(draft);
      } catch {
        range = { startDate: today, endDate: defaultEnd > maxDate ? maxDate : defaultEnd };
      }
    }
    return {
      view: this.view(),
      scope: this.scope(),
      range,
      ...(this.view() === 'rooms' ? { section: this.roomSection() } : {}),
      ...(this.view() === 'rooms' && this.roomSection() === 'prices' && query?.get('type')
        ? { roomTypeId: query.get('type')! }
        : {}),
      ...(this.view() === 'rooms' && this.roomSection() === 'prices' && query?.get('event')
        ? { eventId: query.get('event')! }
        : {}),
    };
  });
  readonly requestKey = computed(() => pageRequestKey(this.request()));
  readonly pageReady = computed(
    () =>
      !this.needsHotel() &&
      this.pageData.activeKey() === this.requestKey() &&
      !this.pageData.loading() &&
      this.overlaysReady() === this.requestKey(),
  );
  readonly pageError = computed(
    () =>
      this.pageLoadError() ||
      (this.pageData.activeKey() === this.requestKey() ? this.pageData.error() : ''),
  );
  readonly roomCount = computed(() =>
    this.pageReady()
      ? this.network.data.roomTypes
          .filter((type) => this.scope() === 'portfolio' || type.hotelId === this.scope())
          .reduce((sum, type) => sum + type.inventory, 0)
      : null,
  );
  readonly rooms = computed(() => this.network.hotelInventory(this.scope(), this.managementDate));
  readonly roomCounts = computed(() => {
    const rooms = this.rooms();
    return {
      available: rooms.filter((room) => room.status === 'available').length,
      dirty: rooms.filter((room) => room.housekeeping === 'dirty').length,
      outOfService: rooms.filter((room) => room.status === 'out_of_service').length,
      reserved: rooms.filter((room) => room.status === 'reserved').length,
    };
  });
  readonly outOfServiceRooms = computed(() =>
    this.rooms().filter((room) => room.status === 'out_of_service'),
  );
  readonly repairImpact = computed(() => {
    const rooms = this.outOfServiceRooms();
    if (!rooms.length || !this.selectedHotel()) return null;
    const currentRates = new Map<string, number>();
    for (const room of rooms) {
      if (currentRates.has(room.roomTypeId)) continue;
      const day = this.rates.rows(room.hotelId, room.roomTypeId, {
        startDate: this.managementDate,
        endDate: this.managementDate,
      })[0];
      currentRates.set(room.roomTypeId, day.nightlyRate);
    }
    return {
      rooms: rooms.length,
      nightlyRevenue: rooms.reduce((sum, room) => sum + currentRates.get(room.roomTypeId)!, 0),
    };
  });
  readonly activeRoomQueue = computed<RoomQueue | null>(() => {
    if (this.roomSearch().trim()) return null;
    if (this.occupancy() === 'all' && this.housekeeping() === 'dirty') return 'dirty';
    if (this.housekeeping() !== 'all') return null;
    const state = this.occupancy();
    return state === 'available' || state === 'out_of_service' || state === 'reserved'
      ? state
      : null;
  });
  readonly filteredRooms = computed(() =>
    this.rooms().filter(
      (room) =>
        (this.occupancy() === 'all' || room.status === this.occupancy()) &&
        (this.housekeeping() === 'all' || room.housekeeping === this.housekeeping()) &&
        (!this.roomSearch().trim() ||
          `${room.number} ${this.hotelName(room.hotelId)} ${this.roomTypeName(room.roomTypeId)}`
            .toLowerCase()
            .includes(this.roomSearch().trim().toLowerCase())),
    ),
  );
  readonly roomPageCount = computed(() =>
    Math.max(1, Math.ceil(this.filteredRooms().length / this.pageSize)),
  );
  readonly pageRooms = computed(() =>
    this.filteredRooms().slice(
      this.roomPage() * this.pageSize,
      (this.roomPage() + 1) * this.pageSize,
    ),
  );
  constructor() {
    this.destroyRef.onDestroy(() => this.pageData.deactivate());
    effect(() => {
      if (this.view() !== 'rooms' || this.roomSection() !== 'prices') this.priceDateFocus.set(null);
    });
    effect(() => {
      const request = this.request();
      this.pageData.revision();
      const needsHotel = this.needsHotel();
      untracked(() => {
        if (needsHotel) {
          this.pageLoadGeneration++;
          this.pageLoadError.set('');
          this.pageData.deactivate();
          return;
        }
        void this.loadPage(request);
      });
    });
    effect(() => {
      this.reporting.dashboardRange();
      this.inspectedDay.set(null);
    });
    effect(() => {
      const hotel = this.query()?.get('hotel');
      if (!hotel) return;
      // A one-time navigation request must not compete with later toolbar choices.
      this.hotelScope.select(hotel);
      void this.router.navigate([], {
        relativeTo: this.route,
        queryParams: { hotel: null },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      });
    });
    effect(() => {
      const query = this.query();
      if (!this.pageReady()) return;
      const room = this.network.data.rooms.find((room) => room.id === query?.get('room'));
      if (query?.get('view') !== 'rooms' || !room) return;
      this.hotelScope.select(room.hotelId);
      this.roomSearch.set(room.number);
      this.occupancy.set('all');
      this.housekeeping.set('all');
      this.resetRooms();
      // Consume this navigation request so opening the same warning works again.
      void this.router.navigate(['/network'], { queryParams: { view: 'rooms' }, replaceUrl: true });
    });
    effect(() => {
      this.view();
      this.roomSection();
      this.host.nativeElement.scrollTop = 0;
      this.roomFeedback.set('');
      this.roomActionError.set('');
    });
    effect(() => {
      this.scope();
      this.effectiveDate();
      this.resetRooms();
      this.roomFeedback.set('');
      this.roomActionError.set('');
      this.scrollOverviewToTop();
    });
  }

  retryPage(): void {
    void this.loadPage(this.request());
  }
  private async loadPage(request: PageRequest): Promise<void> {
    const generation = ++this.pageLoadGeneration;
    const key = pageRequestKey(request);
    if (
      this.pageData.activeKey() === key &&
      this.overlaysReady() === key &&
      !this.pageData.loading() &&
      !this.pageLoadError()
    )
      return;
    this.pageLoadError.set('');
    this.overlaysReady.set('');
    try {
      await Promise.all([
        this.pageData.load(request),
        ...(request.view === 'rooms'
          ? [this.roomOperations.initialize(), this.rates.initialize()]
          : []),
      ]);
      if (generation !== this.pageLoadGeneration || this.destroyRef.destroyed) return;
      this.overlaysReady.set(key);
    } catch (error) {
      if (generation !== this.pageLoadGeneration || this.destroyRef.destroyed) return;
      if (error instanceof ApiError && error.code === 'CANCELLED') return;
      this.pageLoadError.set(
        error instanceof Error ? error.message : 'Could not load this page. Try again.',
      );
    }
  }

  helpFixRooms(): void {
    const hotel = this.selectedHotel();
    if (!hotel || !this.outOfServiceRooms().length) return;
    const prompt = repairHelpPrompt(
      this.outOfServiceRooms().map((room) => ({
        hotelId: hotel.id,
        hotelName: hotel.name,
        city: hotel.city,
        country: hotel.country,
        roomNumber: room.number,
        issue: room.maintenanceNote || 'Technical issue; maintenance details need confirmation.',
      })),
    );
    this.assistant.open({ kind: 'warning', label: 'Repairs' });
    this.assistant.setDraft(prompt);
  }
  setDashboardRange(value: DateRange): void {
    if (this.reporting.selectDashboardRange(value)) this.scrollOverviewToTop();
  }
  setScope(value: string): void {
    if (!this.hotelScope.select(value)) return;
    this.resetRooms();
  }
  confirmHotel(value: string): void {
    if (!this.hotelScope.select(value)) return;
    afterNextRender(
      () => this.host.nativeElement.querySelector<HTMLElement>('#network-page-title')?.focus(),
      { injector: this.injector },
    );
  }
  private scrollOverviewToTop(): void {
    if (this.view() === 'overview')
      this.host.nativeElement.scrollTo({
        top: 0,
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'instant'
          : 'smooth',
      });
  }
  resetRooms(): void {
    this.roomPage.set(0);
  }
  setRoomState(value: string): void {
    if (!this.occupancyOptions.some((option) => option.value === value)) return;
    this.occupancy.set(value as ManagedRoomStatus | 'all');
    this.resetRooms();
  }
  setHousekeeping(value: string): void {
    this.housekeeping.set(value as HousekeepingState | 'all');
    this.resetRooms();
  }
  clearRoomFilters(): void {
    this.occupancy.set('all');
    this.housekeeping.set('all');
    this.roomSearch.set('');
    this.resetRooms();
  }
  showRoomQueue(queue: RoomQueue): void {
    const clear = this.activeRoomQueue() === queue;
    this.clearRoomFilters();
    if (!clear) {
      if (queue === 'dirty') this.housekeeping.set('dirty');
      else this.occupancy.set(queue);
    }
    afterNextRender(() => this.focusRoomHeading(), { injector: this.injector });
  }
  async manageRoom(room: ManagedRoom, action: RoomOperationAction): Promise<void> {
    if (this.roomSavingId()) return;
    const context = `${this.scope()}/${this.view()}/${this.roomSection()}`;
    this.roomSavingId.set(room.id);
    this.roomFeedback.set('');
    this.roomActionError.set('');
    let saved = false;
    try {
      saved = await this.roomOperations.update(room.id, action);
    } catch {
      if (
        !this.destroyRef.destroyed &&
        context === `${this.scope()}/${this.view()}/${this.roomSection()}`
      )
        this.roomActionError.set('Could not update this room. Try again.');
      return;
    } finally {
      this.roomSavingId.set(null);
    }
    if (
      this.destroyRef.destroyed ||
      context !== `${this.scope()}/${this.view()}/${this.roomSection()}`
    )
      return;
    if (!saved) {
      this.roomActionError.set(this.roomOperations.error());
      return;
    }
    const descriptions: Record<RoomOperationAction, string> = {
      clean: 'marked clean',
      dirty: 'marked dirty',
      reserve: 'reserved manually',
      out_of_service: 'marked out of service',
      available: 'made available',
      reset: 'reset to its original state',
    };
    this.roomFeedback.set(
      `${this.city(room.hotelId)} · Room ${room.number} ${descriptions[action]}.`,
    );
    this.roomPage.update((page) => Math.min(page, this.roomPageCount() - 1));
    afterNextRender(
      () => {
        const button = this.host.nativeElement.querySelector<HTMLButtonElement>(
          `app-room-actions[data-room-id="${room.id}"] button`,
        );
        if (button) button.focus({ preventScroll: true });
        else this.focusRoomHeading();
      },
      { injector: this.injector },
    );
  }
  private focusRoomHeading(): void {
    const heading = this.host.nativeElement.querySelector<HTMLElement>('#room-inventory-title');
    heading?.focus({ preventScroll: true });
    heading?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }
  money(value: number): string {
    return euro.format(value);
  }
  label(value: string): string {
    return value.replace(/_/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
  }
  hotelName(id: string): string {
    return this.network.hotels.find((hotel) => hotel.id === id)?.name ?? id;
  }
  city(id: string): string {
    return this.network.hotels.find((hotel) => hotel.id === id)?.city ?? id;
  }
  roomTypeName(id: string): string {
    return this.network.data.roomTypes.find((type) => type.id === id)?.name ?? id;
  }
  date(value: string): string {
    return new Date(`${value}T12:00:00Z`).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    });
  }
}
