import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  untracked,
} from '@angular/core';
import type { CustomSeriesRenderItem } from 'echarts';
import type { BookingPaceDay, DateRange } from '../core/network.models';
import { ChartComponent } from './chart.component';
import type { AppChartOption } from './echarts';
import { CHART_COLORS } from './chart-colors';
import { formatRevenueTooltip } from './booking-revenue-tooltip';

const ACTUAL = CHART_COLORS.brand;
const ON_BOOKS = CHART_COLORS.booked;
const REMAINING = '#e6eae7';
const TODAY = CHART_COLORS.brandInk;
const compactCurrency = new Intl.NumberFormat('en-IE', {
  style: 'currency',
  currency: 'EUR',
  notation: 'compact',
  maximumFractionDigits: 1,
});
const dayLabel = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const periodLabel = new Intl.DateTimeFormat('en-GB', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const axisDateLabel = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const BAR_MAX_WIDTH = 16;

@Component({
  selector: 'app-booking-revenue-chart',
  imports: [ChartComponent],
  template: `
    <app-chart
      [option]="option()"
      [height]="height()"
      [ariaLabel]="description()"
      [interactive]="true"
      (categorySelected)="selectIndex($event)"
    />
    @if (scrollable()) {
      <div class="chart-pan">
        <input
          type="range"
          min="0"
          step="1"
          aria-label="Scroll visible chart dates"
          [max]="maxWindowStart()"
          [value]="panStart()"
          [attr.aria-valuetext]="windowLabel()"
          [title]="windowLabel()"
          [style.--pan-thumb-width.px]="panThumbWidth()"
          (input)="pan($event)"
        />
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
      width: 100%;
      min-width: 0;
    }
    .chart-pan {
      padding-top: 5px;
    }
    .chart-pan input {
      display: block;
      appearance: none;
      -webkit-appearance: none;
      width: 100%;
      height: 24px;
      margin: 0;
      padding: 0;
      border: 0;
      background: transparent;
      cursor: grab;
    }
    .chart-pan input:active {
      cursor: grabbing;
    }
    .chart-pan input:focus-visible {
      outline: 2px solid var(--brand-ink);
      outline-offset: 2px;
      border-radius: 8px;
    }
    .chart-pan input::-webkit-slider-runnable-track {
      height: 8px;
      background: #ecebef;
      border-radius: 8px;
    }
    .chart-pan input::-webkit-slider-thumb {
      appearance: none;
      -webkit-appearance: none;
      height: 8px;
      width: var(--pan-thumb-width, 40px);
      border: 0;
      border-radius: 8px;
      background: #b8adcf;
    }
    .chart-pan input::-moz-range-track {
      height: 8px;
      background: #ecebef;
      border-radius: 8px;
    }
    .chart-pan input::-moz-range-thumb {
      width: var(--pan-thumb-width, 40px);
      height: 8px;
      border: 0;
      border-radius: 8px;
      background: #b8adcf;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BookingRevenueChartComponent {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly rows = input.required<readonly BookingPaceDay[]>();
  readonly range = input.required<DateRange>();
  readonly windowStart = input(0);
  readonly windowSize = input(30);
  readonly asOf = input.required<string>();
  readonly selectedDate = input<string | null>(null);
  readonly height = input(270);
  readonly selectDate = output<string>();
  private readonly pulseEnabled = signal(false);
  private readonly trackWidth = signal(0);
  readonly visibleCount = computed(() =>
    Math.min(this.rows().length, Math.max(1, Math.round(this.windowSize()))),
  );
  readonly maxWindowStart = computed(() => Math.max(0, this.rows().length - this.visibleCount()));
  readonly scrollable = computed(() => this.maxWindowStart() > 0);
  private readonly viewportKey = computed(
    () =>
      `${this.rows()[0]?.date}/${this.rows().at(-1)?.date}/${this.range().startDate}/${this.range().endDate}/${this.visibleCount()}`,
  );
  readonly panStart = linkedSignal(() => {
    this.viewportKey();
    return Math.max(0, Math.min(this.maxWindowStart(), Math.round(this.windowStart())));
  });
  readonly panThumbWidth = computed(() =>
    Math.max(24, (this.trackWidth() * this.visibleCount()) / Math.max(1, this.rows().length)),
  );
  readonly windowLabel = computed(() => {
    const rows = this.rows();
    const first = rows[this.panStart()];
    const last = rows[this.panStart() + this.visibleCount() - 1];
    return first && last
      ? `${this.formatDate(first.date)} to ${this.formatDate(last.date)}, ${this.visibleCount()} of ${rows.length} days visible`
      : 'No chart dates';
  });

  readonly description = computed(() => {
    const context = this.rows();
    const rows = context.filter((row) => this.isSelected(row.date));
    const first = this.range().startDate;
    const last = this.range().endDate;
    let period = 'the selected period';
    if (first && last) {
      const lastDayOfMonth = new Date(
        Date.UTC(Number(first.slice(0, 4)), Number(first.slice(5, 7)), 0),
      ).getUTCDate();
      const fullMonth =
        first.slice(0, 7) === last.slice(0, 7) &&
        first.endsWith('-01') &&
        Number(last.slice(-2)) === lastDayOfMonth &&
        rows.length === lastDayOfMonth;
      period = fullMonth
        ? periodLabel.format(new Date(`${first}T12:00:00Z`))
        : first === last
          ? this.formatDate(first)
          : `${this.formatDate(first)} to ${this.formatDate(last)}`;
    }
    const descriptions = [
      `Daily room revenue for selected dates ${period}, as of ${this.formatDate(this.asOf())}.`,
    ];
    if (context[0] && context.at(-1))
      descriptions.push(
        `Calendar context runs from ${this.formatDate(context[0].date)} to ${this.formatDate(context.at(-1)!.date)}. Dates outside the selection show only hatched target-height context, with no revenue values or date selection.`,
      );
    if (rows.some((row) => row.state === 'past')) {
      descriptions.push('Purple bars show final actual revenue for past days.');
    }
    if (rows.some((row) => row.state !== 'past')) {
      descriptions.push(
        'Light purple shows confirmed revenue on books. Light gray shows the remaining revenue target, not a forecast.',
      );
    }
    if (rows.some((row) => row.date === this.asOf() && row.state === 'today')) {
      descriptions.push('Today is marked with an outline.');
    }
    descriptions.push('Select a bar to inspect that day’s revenue and occupancy.');
    if (this.scrollable())
      descriptions.push(
        `The chart shows ${this.visibleCount()} days at a time. Use the scrollbar to view other dates; arrow keys, Home and End pan the fixed window.`,
      );
    return descriptions.join(' ');
  });

  readonly option = computed<AppChartOption>(() => {
    const rows = this.rows();
    const start = this.panStart();
    const end = start + this.visibleCount() - 1;
    const spansMonths = rows[0]?.date.slice(0, 7) !== rows.at(-1)?.date.slice(0, 7);
    const maxTicks = spansMonths ? 7 : 8;
    const tickStep =
      this.visibleCount() <= 7 ? 1 : Math.ceil((this.visibleCount() - 1) / (maxTicks - 1));
    const selectedDate = this.selectedDate();
    const todayIndex = rows.findIndex(
      (row) => row.date === this.asOf() && row.state === 'today' && this.isSelected(row.date),
    );
    const today = todayIndex >= start && todayIndex <= end ? rows[todayIndex] : undefined;
    const pulse = this.pulseEnabled() && !!today;
    const todayOutline: CustomSeriesRenderItem = (_params, api) => {
      const index = Number(api.value(0));
      const revenue = Number(api.value(1));
      const top = api.coord([index, revenue]);
      const bottom = api.coord([index, 0]);
      const bandSize = api.size?.([1, 0]);
      const bandWidth = Array.isArray(bandSize) ? Math.abs(bandSize[0]) : Number(bandSize ?? 0);
      const width = Math.min(BAR_MAX_WIDTH, bandWidth * 0.58);
      const hasRevenue = revenue > 0;
      return {
        type: 'rect',
        silent: true,
        shape: {
          x: top[0] - width / 2 - 2,
          y: top[1] - (hasRevenue ? 2 : 0),
          width: width + 4,
          height: bottom[1] - top[1] + (hasRevenue ? 4 : 0),
          r: hasRevenue ? 3 : 0,
        },
        style: { fill: 'none', stroke: TODAY, lineWidth: 1.5, opacity: pulse ? 0.3 : 0.65 },
        keyframeAnimation: pulse
          ? {
              duration: 2200,
              loop: true,
              easing: 'sinusoidalInOut',
              keyframes: [
                { percent: 0, shape: {}, style: { opacity: 0.3 } },
                { percent: 0.5, shape: {}, style: { opacity: 0.95 } },
                { percent: 1, shape: {}, style: { opacity: 0.3 } },
              ],
            }
          : undefined,
      };
    };

    return {
      animation: true,
      grid: { top: 32, left: 0, right: 8, bottom: 4, containLabel: true },
      dataZoom: this.scrollable()
        ? [
            {
              type: 'inside',
              xAxisIndex: 0,
              disabled: true,
              zoomLock: true,
              filterMode: 'none',
              rangeMode: ['value', 'value'],
              startValue: start,
              endValue: end,
              minValueSpan: this.visibleCount() - 1,
              maxValueSpan: this.visibleCount() - 1,
            },
          ]
        : [],
      tooltip: {
        // Item tooltips let silent context bars remain completely non-interactive.
        trigger: 'item',
        triggerOn: 'mousemove',
        renderMode: 'html',
        appendTo: 'body',
        confine: false,
        enterable: true,
        hideDelay: 120,
        transitionDuration: 0,
        borderWidth: 0,
        backgroundColor: 'transparent',
        padding: 0,
        extraCssText: 'box-shadow:none;',
        position: (point, _params, _dom, _rect, size) =>
          this.tooltipPosition(point, size.contentSize),
        formatter: (params) => {
          const points = Array.isArray(params) ? params : [params];
          const point = points.find((item) => item.seriesType === 'bar');
          const row = point ? rows[point.dataIndex] : undefined;
          return row && this.isSelected(row.date) ? formatRevenueTooltip(row) : '';
        },
      },
      xAxis: {
        type: 'category',
        data: rows.map((row) => row.date),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: '#69716c',
          fontSize: 10,
          margin: 12,
          interval: (index: number) => (index - start) % tickStep === 0 || index === end,
          showMinLabel: true,
          showMaxLabel: true,
          hideOverlap: true,
          formatter: (value: string) =>
            spansMonths
              ? axisDateLabel.format(new Date(`${value}T12:00:00Z`))
              : String(Number(value.slice(-2))),
        },
      },
      yAxis: {
        type: 'value',
        min: 0,
        splitNumber: 4,
        axisLabel: {
          color: '#69716c',
          fontSize: 10,
          formatter: (value: number) => compactCurrency.format(value),
        },
        splitLine: { lineStyle: { color: '#e8ece9', type: [2, 5] } },
      },
      series: [
        {
          name: 'Actual / on books',
          type: 'bar',
          stack: 'revenue',
          animation: false,
          cursor: 'pointer',
          barWidth: '58%',
          barMaxWidth: BAR_MAX_WIDTH,
          emphasis: { disabled: true },
          data: rows.map((row) => ({
            value: this.isSelected(row.date) ? row.securedRevenue : null,
            itemStyle: {
              color: row.state === 'past' ? ACTUAL : ON_BOOKS,
              borderColor: row.date === selectedDate ? CHART_COLORS.brandDark : 'transparent',
              borderWidth: row.date === selectedDate ? 1.25 : 0,
              borderRadius:
                row.state === 'past' || row.remainingTargetRevenue === 0 ? [3, 3, 0, 0] : 0,
            },
          })),
          markLine: today
            ? {
                silent: true,
                animation: false,
                symbol: 'none',
                lineStyle: { color: CHART_COLORS.brandBorder, width: 1, type: 'dashed' },
                label: {
                  show: true,
                  position: 'end',
                  formatter: 'Today',
                  rotate: 0,
                  color: TODAY,
                  fontSize: 10,
                  fontWeight: 600,
                  distance: 8,
                },
                data: [{ xAxis: today.date }],
              }
            : undefined,
        },
        {
          name: 'Remaining target',
          type: 'bar',
          stack: 'revenue',
          animation: false,
          cursor: 'pointer',
          barWidth: '58%',
          barMaxWidth: BAR_MAX_WIDTH,
          itemStyle: { color: REMAINING, borderRadius: [3, 3, 0, 0] },
          emphasis: { disabled: true },
          data: rows.map((row) =>
            !this.isSelected(row.date) || row.state === 'past' ? null : row.remainingTargetRevenue,
          ),
        },
        {
          name: 'Outside selection',
          type: 'bar',
          stack: 'revenue',
          animation: false,
          silent: true,
          barWidth: '58%',
          barMaxWidth: BAR_MAX_WIDTH,
          tooltip: { show: false },
          emphasis: { disabled: true },
          itemStyle: {
            color: '#f1f1f3',
            borderRadius: [3, 3, 0, 0],
            decal: {
              symbol: 'rect',
              symbolSize: 1,
              dashArrayX: [1, 0],
              dashArrayY: [2, 3],
              rotation: -Math.PI / 4,
              color: '#d3d2d8',
              backgroundColor: '#f1f1f3',
            },
          },
          data: rows.map((row) => (this.isSelected(row.date) ? null : row.targetRevenue)),
        },
        {
          name: 'Today highlight',
          type: 'custom',
          coordinateSystem: 'cartesian2d',
          renderItem: todayOutline,
          data: today ? [[todayIndex, today.securedRevenue]] : [],
          encode: { x: 0, y: 1 },
          silent: true,
          clip: false,
          tooltip: { show: false },
          animation: pulse,
          z: 10,
        },
      ],
    };
  });

  constructor() {
    const host = this.host;
    const destroyRef = inject(DestroyRef);
    let observer: IntersectionObserver | undefined;
    let sizeObserver: ResizeObserver | undefined;
    let motion: MediaQueryList | undefined;
    let inView = false;
    const updatePulse = () =>
      this.pulseEnabled.set(inView && document.visibilityState === 'visible' && !motion?.matches);

    // Panning is free. Only a changed inspector date may bring its bar into view.
    let previousDate: string | null | undefined;
    let previousViewport: string | undefined;
    effect(() => {
      const date = this.selectedDate();
      const viewport = this.viewportKey();
      if (viewport !== previousViewport) {
        previousViewport = viewport;
        previousDate = date;
        return;
      }
      if (date === previousDate) return;
      previousDate = date;
      untracked(() => {
        if (!date || !this.isSelected(date)) return;
        const index = this.rows().findIndex((row) => row.date === date);
        const start = this.panStart();
        const size = this.visibleCount();
        if (index >= 0 && (index < start || index >= start + size))
          this.panStart.set(
            Math.max(0, Math.min(this.maxWindowStart(), index < start ? index : index - size + 1)),
          );
      });
    });

    afterNextRender(() => {
      this.trackWidth.set(host.nativeElement.clientWidth);
      sizeObserver = new ResizeObserver(([entry]) => this.trackWidth.set(entry.contentRect.width));
      sizeObserver.observe(host.nativeElement);
      motion = window.matchMedia('(prefers-reduced-motion: reduce)');
      motion.addEventListener('change', updatePulse);
      document.addEventListener('visibilitychange', updatePulse);
      if (typeof IntersectionObserver === 'undefined') {
        inView = true;
        updatePulse();
      } else {
        observer = new IntersectionObserver(([entry]) => {
          inView = entry.isIntersecting;
          updatePulse();
        });
        observer.observe(host.nativeElement);
      }
    });

    destroyRef.onDestroy(() => {
      observer?.disconnect();
      sizeObserver?.disconnect();
      motion?.removeEventListener('change', updatePulse);
      document.removeEventListener('visibilitychange', updatePulse);
    });
  }

  selectIndex(index: number): void {
    const row = this.rows()[index];
    if (row && this.isSelected(row.date)) this.selectDate.emit(row.date);
  }

  pan(event: Event): void {
    const value = (event.target as HTMLInputElement).valueAsNumber;
    if (Number.isFinite(value))
      this.panStart.set(Math.max(0, Math.min(this.maxWindowStart(), Math.round(value))));
  }

  private isSelected(date: string): boolean {
    return date >= this.range().startDate && date <= this.range().endDate;
  }

  private formatDate(value: string): string {
    return dayLabel.format(new Date(`${value}T12:00:00Z`));
  }

  private tooltipPosition(point: number[], contentSize: number[]): number[] {
    const bounds = this.host.nativeElement.querySelector('app-chart')?.getBoundingClientRect();
    const view = this.host.nativeElement.ownerDocument.defaultView;
    const [width, height] = contentSize;
    if (!bounds || !view) return [point[0] - width / 2, point[1] - height - 14];
    const left = 12 - bounds.left;
    const right = view.innerWidth - bounds.left - width - 12;
    const top = 12 - bounds.top;
    const bottom = view.innerHeight - bounds.top - height - 12;
    const above = point[1] - height - 14;
    return [
      Math.max(left, Math.min(right, point[0] - width / 2)),
      Math.max(top, Math.min(bottom, above >= top ? above : point[1] + 18)),
    ];
  }
}
