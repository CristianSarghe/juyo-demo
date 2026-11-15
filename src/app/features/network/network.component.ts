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
import { ActivatedRoute, NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { NetworkService } from '../../core/network.service';
import { ApiError } from '../../core/api/api-client.service';
import { HotelScopeService } from '../../core/hotel-scope.service';
import { ReportingScopeService } from '../../core/reporting-scope.service';
import { RoomOperationsService } from '../../core/room-operations.service';
import type { DateRange } from '../../core/network.models';
import { DateRangePickerComponent } from '../../shared/date-range-picker.component';
import { HotelSelectionComponent } from '../../shared/hotel-selection.component';
import { RoomRateService } from '../../core/room-rate.service';
import { NetworkDataStore } from '../../core/api/network-data.store';
import { pageRequestKey, type PageRequest, type PageView } from '../../core/api/page-data.models';
import { PageSkeletonComponent } from '../../shared/page-skeleton.component';

interface WorkspaceRoute {
  readonly view: PageView;
  readonly section: 'inventory' | 'prices';
  readonly path: string;
}

/** Shared page frame and scoped data lifecycle. Angular owns the active leaf page. */
@Component({
  selector: 'app-network',
  imports: [DateRangePickerComponent, HotelSelectionComponent, RouterOutlet, PageSkeletonComponent],
  templateUrl: './network.component.html',
  styleUrl: './network.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NetworkComponent {
  readonly network = inject(NetworkService);
  readonly pageData = inject(NetworkDataStore);
  readonly reporting = inject(ReportingScopeService);
  private readonly hotelScope = inject(HotelScopeService);
  private readonly roomOperations = inject(RoomOperationsService);
  private readonly rates = inject(RoomRateService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly query = toSignal(this.route.queryParamMap);
  private readonly activeRoute = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map(() => this.readRoute()),
    ),
    { initialValue: this.readRoute() },
  );
  private readonly pageLoadError = signal('');
  private readonly overlaysReady = signal('');
  private pageLoadGeneration = 0;
  readonly inspectedDay = signal<string | null>(null);
  // Keep a date control's focus through scoped pricing-data remounts.
  readonly priceDateFocus = signal<keyof DateRange | null>(null);
  readonly meta = this.network.meta;
  readonly view = computed(() => this.activeRoute().view);
  readonly roomSection = computed(() => this.activeRoute().section);
  readonly pageTitle = computed(
    () =>
      ({
        overview: 'Overview',
        rooms: 'Room management',
        reservations: 'Reservations',
        configuration: 'Hotel configuration',
      })[this.view()],
  );
  readonly scope = this.hotelScope.scope;
  readonly needsHotel = computed(
    () => this.scope() === 'portfolio' && ['rooms', 'configuration'].includes(this.view()),
  );
  readonly managementDate = this.network.bookingSnapshot.asOf;
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

  constructor() {
    effect(() => {
      if (this.view() !== 'rooms' || this.roomSection() !== 'prices') this.priceDateFocus.set(null);
    });
    this.destroyRef.onDestroy(() => {
      this.pageLoadGeneration++;
      this.pageData.deactivate();
    });
    effect(() => {
      const hotel = this.query()?.get('hotel');
      if (!hotel) return;
      untracked(() => this.hotelScope.select(hotel));
    });
    effect(() => {
      if (this.router.currentNavigation()) return;
      const completedUrl = this.router.lastSuccessfulNavigation()?.finalUrl;
      if (!completedUrl) return;
      const hotel = completedUrl.queryParamMap.get('hotel');
      if (hotel === null) return;
      untracked(() => {
        this.hotelScope.select(hotel);
        // Include initial navigation completed before the authenticated outlet mounts.
        // Clone the completed URL so its path, filters and fragment stay intact.
        const url = this.router.parseUrl(this.router.serializeUrl(completedUrl));
        delete url.queryParams['hotel'];
        void this.router.navigateByUrl(url, { replaceUrl: true });
      });
    });
    effect(() => {
      const request = this.request();
      this.pageData.revision();
      const needsHotel = this.needsHotel();
      untracked(() => {
        if (needsHotel) {
          this.pageLoadGeneration++;
          this.pageLoadError.set('');
          this.overlaysReady.set('');
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
    let previousPath: string | undefined;
    effect(() => {
      const path = this.activeRoute().path;
      if (path === previousPath) return;
      previousPath = path;
      this.host.nativeElement.scrollTop = 0;
      afterNextRender(
        () => this.host.nativeElement.querySelector<HTMLElement>('#network-page-title')?.focus(),
        { injector: this.injector },
      );
    });
    effect(() => {
      this.scope();
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
  private readRoute(): WorkspaceRoute {
    let route = this.route.snapshot;
    while (route.firstChild) route = route.firstChild;
    const value: unknown = route.data['view'];
    return {
      view:
        value === 'rooms' || value === 'reservations' || value === 'configuration'
          ? value
          : 'overview',
      section: route.data['section'] === 'prices' ? 'prices' : 'inventory',
      path: this.router.url.split(/[?#]/, 1)[0],
    };
  }
  setDashboardRange(value: DateRange): void {
    if (this.reporting.selectDashboardRange(value)) this.scrollOverviewToTop();
  }
  setScope(value: string): void {
    this.hotelScope.select(value);
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
  date(value: string): string {
    return new Date(`${value}T12:00:00Z`).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    });
  }
}
