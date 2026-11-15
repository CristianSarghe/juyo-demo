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
  input,
  linkedSignal,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { NetworkService } from '../../core/network.service';
import { ApiError } from '../../core/api/api-client.service';
import { HotelId, PropertyScope, BookingPaceDay, DateRange } from '../../core/network.models';
import { BookingRevenueChartComponent } from '../../shared/booking-revenue-chart.component';
import { IconComponent } from '../../shared/icon.component';
import { ChartComponent } from '../../shared/chart.component';
import { CHART_COLORS } from '../../shared/chart-colors';
import type { AppChartOption } from '../../shared/echarts';
import { OccupancyTrendComponent } from './occupancy-trend.component';
import { BookingSourcesComponent } from './booking-sources.component';
import { SpinnerComponent } from '../../shared/spinner.component';

const fraction = (part: number, total: number): number => (total ? (part / total) * 100 : 0);
const dateFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});

@Component({
  selector: 'app-dashboard',
  imports: [
    BookingRevenueChartComponent,
    IconComponent,
    ChartComponent,
    OccupancyTrendComponent,
    BookingSourcesComponent,
    SpinnerComponent,
  ],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DashboardComponent {
  readonly scope = input<PropertyScope>('portfolio');
  readonly range = input.required<DateRange>();
  readonly selectHotel = output<HotelId>();
  readonly initialDrillDate = input<string | null>(null);
  readonly inspectDay = output<string | null>();
  private readonly destroyRef = inject(DestroyRef);
  readonly dailyLoading = signal(false);
  readonly dailyError = signal('');
  private readonly dayRetry = signal(0);
  private dayGeneration = 0;
  readonly network = inject(NetworkService);
  private readonly injector = inject(Injector);
  readonly snapshot = this.network.bookingSnapshot;
  readonly days = computed(() => this.network.bookingPace(this.scope(), this.range()));
  readonly chartContext = computed(() =>
    this.network.bookingChartContext(this.scope(), this.range()),
  );
  readonly hasChartContext = computed(() => this.chartContext().rows.length > this.days().length);
  readonly outlook = computed(() => this.network.bookingOutlook(this.scope(), this.range()));
  readonly period = computed(() => this.outlook().period);
  readonly bookingSources = computed(() => this.network.bookingSources(this.scope(), this.range()));
  readonly actualDays = computed(() => this.days().filter((day) => day.state === 'past'));
  readonly bookedDays = computed(() => this.days().filter((day) => day.state !== 'past'));
  readonly hasActual = computed(() => this.actualDays().length > 0);
  readonly hasBooked = computed(() => this.bookedDays().length > 0);
  readonly isClosed = computed(() => this.hasActual() && !this.hasBooked());
  readonly hasToday = computed(() => this.days().some((day) => day.date === this.snapshot.asOf));
  readonly isSingleDay = computed(() => this.range().startDate === this.range().endDate);
  readonly drillDate = linkedSignal(() => this.initialDrillDate());
  readonly activeDay = computed(() =>
    this.isSingleDay() ? this.range().startDate : this.drillDate(),
  );
  readonly isDailyView = computed(() => this.activeDay() !== null);
  readonly revenueTitle = computed(() =>
    this.isDailyView() ? 'Total revenue for the day' : 'Total revenue for the time interval',
  );
  readonly isDrilldown = computed(() => !this.isSingleDay() && this.drillDate() !== null);
  readonly cardRange = computed(() => {
    const day = this.activeDay();
    return day ? { startDate: day, endDate: day } : this.range();
  });
  readonly cardDays = computed(() =>
    this.days().filter((day) => !this.activeDay() || day.date === this.activeDay()),
  );
  readonly cardOutlook = computed(() =>
    this.network.bookingOutlook(this.scope(), this.cardRange()),
  );
  readonly cardPeriod = computed(() => this.cardOutlook().period);
  readonly cardHasActual = computed(() => this.cardDays().some((day) => day.state === 'past'));
  readonly cardHasBooked = computed(() => this.cardDays().some((day) => day.state !== 'past'));
  readonly cardIsClosed = computed(() => this.cardHasActual() && !this.cardHasBooked());
  readonly daySummary = computed(() => {
    const day = this.activeDay();
    return day ? this.network.hotelDaySummary(this.scope(), day) : null;
  });
  readonly selectedDate = linkedSignal<DateRange, string>({
    source: this.range,
    computation: (range, previous) => {
      if (previous && previous.value >= range.startDate && previous.value <= range.endDate)
        return previous.value;
      return this.snapshot.asOf >= range.startDate && this.snapshot.asOf <= range.endDate
        ? this.snapshot.asOf
        : range.startDate;
    },
  });
  private readonly revenueHeading = viewChild<ElementRef<HTMLElement>>('revenueHeading');
  private readonly periodView = viewChild<ElementRef<HTMLElement>>('periodView');
  readonly selectedDay = computed(
    () => this.days().find((day) => day.date === this.selectedDate()) ?? this.days()[0],
  );
  readonly actualRange = computed(() => this.dateRange(this.actualDays()) || 'Stays not started');
  readonly bookedRange = computed(() => this.dateRange(this.bookedDays()) || 'Period closed');
  readonly hotelRows = computed(() =>
    this.network.hotels.map((hotel) => ({
      hotel,
      outlook: this.network.bookingOutlook(hotel.id, this.range()),
    })),
  );
  readonly targetCoverage = computed(() =>
    fraction(this.cardOutlook().totalSecuredRevenue, this.cardOutlook().targetRevenue),
  );
  readonly targetProgress = computed(() => {
    const outlook = this.cardOutlook();
    const hasTarget = outlook.targetRevenue > 0;
    const earnedPercent = fraction(outlook.realizedRevenue, outlook.targetRevenue);
    const bookedPercent = fraction(outlook.onBooksRevenue, outlook.targetRevenue);
    const earnedWidth = Math.min(100, earnedPercent);
    const bookedWidth = Math.min(100 - earnedWidth, bookedPercent);
    const remaining = Math.max(0, outlook.targetRevenue - outlook.totalSecuredRevenue);
    return {
      hasTarget,
      earnedPercent,
      bookedPercent,
      remainingPercent: fraction(remaining, outlook.targetRevenue),
      earnedWidth,
      bookedWidth,
      remainingWidth: Math.max(0, 100 - earnedWidth - bookedWidth),
      remaining,
      overage: Math.max(0, outlook.totalSecuredRevenue - outlook.targetRevenue),
    };
  });
  readonly targetGapLabel = computed(() => (this.cardIsClosed() ? 'Unmet target' : 'To target'));
  readonly targetProgressDescription = computed(() => {
    const outlook = this.cardOutlook();
    const progress = this.targetProgress();
    return `${this.cardPeriod().label} room revenue. Earned ${this.money(outlook.realizedRevenue, 2)}; booked ${this.money(outlook.onBooksRevenue, 2)}. ${
      progress.hasTarget
        ? `Target ${this.money(outlook.targetRevenue, 2)} is 100% of the bar. ${this.percent(this.targetCoverage())} covered; ${this.money(progress.remaining, 2)} ${this.cardIsClosed() ? 'unmet' : 'to target'}.${progress.overage > 0 ? ` ${this.money(progress.overage, 2)} above target; the bar is capped at 100%.` : ''}`
        : 'No target is set.'
    }`;
  });
  readonly targetProgressChart = computed<AppChartOption>(() => {
    const progress = this.targetProgress();
    const gapLabel = this.targetGapLabel();
    return {
      animationDuration: 240,
      animationDurationUpdate: 240,
      grid: { top: 0, right: 0, bottom: 0, left: 0 },
      xAxis: { type: 'value', min: 0, max: 100, show: false },
      yAxis: { type: 'category', data: ['Selected period target'], show: false },
      tooltip: { show: false },
      series: [
        {
          name: 'Earned',
          type: 'bar',
          stack: 'target',
          data: [progress.earnedWidth],
          barWidth: 12,
          itemStyle: {
            color: CHART_COLORS.brand,
            borderRadius: [
              6,
              progress.earnedWidth === 100 ? 6 : 0,
              progress.earnedWidth === 100 ? 6 : 0,
              6,
            ],
          },
          emphasis: { disabled: true },
        },
        {
          name: 'Booked',
          type: 'bar',
          stack: 'target',
          data: [progress.bookedWidth],
          barWidth: 12,
          itemStyle: {
            color: CHART_COLORS.booked,
            borderRadius: [
              progress.earnedWidth ? 0 : 6,
              progress.remainingWidth ? 0 : 6,
              progress.remainingWidth ? 0 : 6,
              progress.earnedWidth ? 0 : 6,
            ],
          },
          emphasis: { disabled: true },
        },
        {
          name: gapLabel,
          type: 'bar',
          stack: 'target',
          data: [progress.remainingWidth],
          barWidth: 12,
          itemStyle: {
            color: '#e6eae7',
            borderRadius: [
              progress.earnedWidth + progress.bookedWidth ? 0 : 6,
              6,
              6,
              progress.earnedWidth + progress.bookedWidth ? 0 : 6,
            ],
          },
          emphasis: { disabled: true },
        },
      ],
    };
  });
  readonly occupancyTarget = computed(() => {
    const periodDays = this.hasBooked() ? this.bookedDays() : this.actualDays();
    return fraction(
      periodDays.reduce((sum, day) => sum + day.targetRooms, 0),
      periodDays.reduce((sum, day) => sum + day.roomsAvailable, 0),
    );
  });
  readonly opportunityDays = computed(() =>
    this.hasBooked() ? this.bookedDays() : this.actualDays(),
  );
  readonly opportunities = computed(() =>
    this.opportunityDays()
      .filter((day) => day.securedRooms < day.targetRooms)
      .sort(
        (a, b) =>
          fraction(a.securedRooms, a.roomsAvailable) - fraction(b.securedRooms, b.roomsAvailable) ||
          a.date.localeCompare(b.date),
      )
      .slice(0, 3),
  );
  readonly primaryOccupancy = computed(() =>
    this.hasActual() ? this.outlook().realizedOccupancy : this.outlook().onBooksOccupancy,
  );
  constructor() {
    this.destroyRef.onDestroy(() => {
      this.dayGeneration++;
      this.network.cancelDayLoad();
    });
    effect(() => {
      const scope = this.scope();
      const date = this.activeDay();
      this.network.dayRevision();
      this.dayRetry();
      const generation = ++this.dayGeneration;
      untracked(() => {
        this.dailyError.set('');
        this.dailyLoading.set(!!date);
        if (!date) {
          this.network.cancelDayLoad();
          return;
        }
        void this.network
          .loadDay(scope, date)
          .then(() => {
            if (generation === this.dayGeneration && !this.destroyRef.destroyed)
              this.dailyLoading.set(false);
          })
          .catch((error: unknown) => {
            if (generation !== this.dayGeneration || this.destroyRef.destroyed) return;
            if (error instanceof ApiError && error.code === 'CANCELLED') return;
            this.dailyLoading.set(false);
            this.dailyError.set(
              error instanceof Error ? error.message : 'Could not load this day. Try again.',
            );
          });
      });
    });
  }
  retryDay(): void {
    this.dayRetry.update((value) => value + 1);
  }
  openDay(value: string): void {
    if (!this.days().some((day) => day.date === value)) return;
    this.selectedDate.set(value);
    if (!this.isSingleDay()) {
      this.drillDate.set(value);
      this.inspectDay.emit(value);
    }
    afterNextRender(
      () => {
        const heading = this.revenueHeading()?.nativeElement;
        heading?.focus({ preventScroll: true });
        heading?.scrollIntoView({
          block: 'nearest',
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
            ? 'instant'
            : 'smooth',
        });
      },
      { injector: this.injector },
    );
  }
  backToPeriod(): void {
    this.drillDate.set(null);
    this.inspectDay.emit(null);
    afterNextRender(() => this.periodView()?.nativeElement.focus({ preventScroll: true }), {
      injector: this.injector,
    });
  }
  chooseHotel(id: HotelId): void {
    this.selectHotel.emit(id);
  }
  date(value: string): string {
    return dateFormat.format(new Date(`${value}T12:00:00Z`));
  }
  weekday(value: string): string {
    return new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' }).format(
      new Date(`${value}T12:00:00Z`),
    );
  }
  number(value: number, decimals = 0): string {
    return new Intl.NumberFormat('en-IE', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value);
  }
  money(value: number, decimals = 0): string {
    return new Intl.NumberFormat('en-IE', {
      style: 'currency',
      currency: 'EUR',
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value);
  }
  percent(value: number): string {
    return `${this.number(value, 1)}%`;
  }
  occupancy(day: BookingPaceDay): number {
    return fraction(day.securedRooms, day.roomsAvailable);
  }
  private dateRange(days: readonly BookingPaceDay[]): string {
    if (!days.length) return '';
    const first = days[0].date;
    const last = days[days.length - 1].date;
    return first === last
      ? this.date(first)
      : first.slice(0, 7) === last.slice(0, 7)
        ? `${Number(first.slice(-2))}–${this.date(last)}`
        : `${this.date(first)}–${this.date(last)}`;
  }
}
