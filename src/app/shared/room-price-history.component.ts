import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  linkedSignal,
  signal,
  untracked,
} from '@angular/core';
import { tuiGenerateId } from '@taiga-ui/cdk';
import { NetworkService } from '../core/network.service';
import type { DateRange, HotelId } from '../core/network.models';
import { RoomRateService } from '../core/room-rate.service';
import { formatPriceTooltip } from './room-price-tooltip';
import { CHART_COLORS } from './chart-colors';
import { ChartComponent } from './chart.component';
import type { AppChartOption } from './echarts';
import type { TooltipComponentOption } from 'echarts/components';

const dateLabel = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const monthLabel = new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'UTC' });
const periodLabel = new Intl.DateTimeFormat('en-GB', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const BOOKED_PRICE = CHART_COLORS.booked;
const WEIGHTED_RATE = CHART_COLORS.brandInk;
const OUTSIDE_RATE = '#c9cecb';

@Component({
  selector: 'app-room-price-history',
  imports: [ChartComponent],
  templateUrl: './room-price-history.component.html',
  styleUrl: './room-price-history.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RoomPriceHistoryComponent {
  readonly hotelId = input.required<HotelId>();
  readonly roomTypeId = input.required<string>();
  readonly selection = input<DateRange | null>(null);
  readonly id = tuiGenerateId();
  private readonly network = inject(NetworkService);
  readonly asOf = this.network.bookingSnapshot.asOf;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly rates = inject(RoomRateService);
  private readonly width = signal(0);
  private readonly validRange = computed(() => {
    const range = this.selection();
    if (!range) return null;
    try {
      return this.network.validateDateRange(range);
    } catch {
      return null;
    }
  });
  readonly rows = computed(() => {
    const range = this.validRange();
    if (!range) return [];
    const bookings = this.network.bookingRateHistory(this.hotelId(), this.roomTypeId());
    const months = this.network.periods.filter(
      (period) => period.endDate >= range.startDate && period.startDate <= range.endDate,
    );
    if (!months.length) return [];
    const calendar = { startDate: months[0].startDate, endDate: months.at(-1)!.endDate };
    const loadedDates = new Set(
      this.network.data.roomRates
        .filter((rate) => rate.roomTypeId === this.roomTypeId())
        .map((rate) => rate.date),
    );
    if (!loadedDates.has(calendar.startDate) || !loadedDates.has(calendar.endDate)) return [];
    const offers = this.rates.rows(this.hotelId(), this.roomTypeId(), calendar);
    const bookedByDate = new Map(bookings.map((row) => [row.date, row]));
    const firstMonth = range.startDate.slice(0, 7);
    const lastMonth = range.endDate.slice(0, 7);
    return offers
      .flatMap((offer) => {
        const booked = bookedByDate.get(offer.date);
        return booked ? [{ ...offer, ...booked }] : [];
      })
      .filter((row) => row.date.slice(0, 7) >= firstMonth && row.date.slice(0, 7) <= lastMonth);
  });
  readonly period = computed(() => {
    const rows = this.rows();
    if (!rows.length) return 'Choose a valid date interval';
    const first = new Date(`${rows[0].date}T12:00:00Z`);
    const last = new Date(`${rows.at(-1)!.date}T12:00:00Z`);
    return first.getUTCMonth() === last.getUTCMonth()
      ? periodLabel.format(first)
      : `${monthLabel.format(first)}–${periodLabel.format(last)}`;
  });
  readonly hasOutsideDates = computed(() => this.rows().some((row) => !this.isSelected(row.date)));
  readonly visibleCount = computed(() => Math.min(10, this.rows().length));
  readonly maxWindowStart = computed(() => Math.max(0, this.rows().length - this.visibleCount()));
  readonly scrollable = computed(() => this.maxWindowStart() > 0);
  private readonly contextKey = computed(() => {
    const range = this.validRange();
    return `${this.hotelId()}/${this.roomTypeId()}/${range?.startDate}/${range?.endDate}`;
  });
  readonly panStart = linkedSignal(() => {
    this.contextKey();
    return untracked(() => {
      const range = this.validRange();
      if (!range) return 0;
      const rows = this.rows();
      const selectedStart = rows.findIndex((row) => row.date === range.startDate);
      const selectedEnd = rows.findIndex((row) => row.date === range.endDate);
      const initialStart =
        selectedEnd - selectedStart + 1 <= this.visibleCount()
          ? Math.floor((selectedStart + selectedEnd) / 2 - (this.visibleCount() - 1) / 2)
          : selectedStart;
      return Math.max(0, Math.min(this.maxWindowStart(), initialStart));
    });
  });
  readonly windowLabel = computed(() => {
    const rows = this.rows();
    const first = rows[this.panStart()];
    const last = rows[this.panStart() + this.visibleCount() - 1];
    return first && last ? `${this.date(first.date)}–${this.date(last.date)}` : 'No chart dates';
  });
  readonly panDescription = computed(
    () => `${this.windowLabel()}, ${this.visibleCount()} of ${this.rows().length} days visible`,
  );
  readonly thumbWidth = computed(() =>
    Math.max(28, (this.width() * this.visibleCount()) / Math.max(1, this.rows().length)),
  );
  readonly description = computed(() =>
    [
      `Room-type price history for ${this.period()}.`,
      'Light purple dots show each distinct nightly price from existing bookings for the selected room type and stay date. The purple line is their average, weighted by the number of booked rooms at each price. A day with one booked price has its average exactly at that dot.',
      'Outside From–Through, the same average booked price continues as a light gray line, with no dots.',
      'Days without bookings have no average booked price. Future values use existing bookings, not a forecast. Today is marked when included in the selection.',
      `${this.panDescription()}. Use the date scrollbar to see other dates.`,
      'Hover for a compact summary above the cursor. Click a date to keep its full price and booking breakdown open. Click outside or press Escape to close it. The same information is available under Daily prices.',
    ].join(' '),
  );
  readonly tooltipDetails: Pick<TooltipComponentOption, 'formatter' | 'position'> = {
    formatter: (params) => this.formatTooltip(params, true),
    position: (point, _params, _dom, _rect, size) =>
      this.tooltipPosition(point, size.contentSize, false),
  };
  readonly option = computed<AppChartOption>(() => {
    const rows = this.rows();
    const values = rows.flatMap((row) => [
      ...(this.isSelected(row.date) ? row.priceBuckets.map((price) => price.nightlyRate) : []),
      ...(row.weightedRate === null ? [] : [row.weightedRate]),
    ]);
    // All displayed month averages set the scale, so context stays visible while panning.
    const minimum = values.length
      ? Math.max(0, Math.floor((Math.min(...values) * 0.9) / 10) * 10)
      : 0;
    const maximum = values.length
      ? Math.max(minimum + 10, Math.ceil((Math.max(...values) * 1.07) / 10) * 10)
      : 100;
    const start = this.panStart();
    const end = start + this.visibleCount() - 1;
    const range = this.validRange();
    const selectedStart = rows.findIndex((row) => row.date === range?.startDate);
    const selectedEnd = rows.findIndex((row) => row.date === range?.endDate);
    return {
      animation: true,
      animationDuration: 250,
      animationDurationUpdate: 0,
      grid: { top: 28, left: 0, right: 8, bottom: 8, containLabel: true },
      // One continuous curve changes color at the selected stay-date points.
      visualMap: {
        type: 'piecewise',
        show: false,
        selectedMode: false,
        dimension: 0,
        seriesIndex: 1,
        pieces: [
          { lt: selectedStart, color: OUTSIDE_RATE },
          { gte: selectedStart, lte: selectedEnd, color: WEIGHTED_RATE },
          { gt: selectedEnd, color: OUTSIDE_RATE },
        ],
        outOfRange: { color: OUTSIDE_RATE },
      },
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
        trigger: 'axis',
        triggerOn: 'mousemove',
        renderMode: 'html',
        appendTo: 'body',
        className: 'juyo-price-tooltip-shell',
        confine: false,
        enterable: false,
        hideDelay: 0,
        transitionDuration: 0,
        backgroundColor: 'transparent',
        borderWidth: 0,
        padding: 0,
        extraCssText: 'box-shadow:none;',
        position: (point, _params, _dom, _rect, size) =>
          this.tooltipPosition(point, size.contentSize, true),
        axisPointer: { type: 'line', lineStyle: { color: '#d7d2e0', type: 'dashed' } },
        formatter: (params) => this.formatTooltip(params, false),
      },
      xAxis: {
        type: 'category',
        boundaryGap: true,
        data: rows.map((row) => row.date),
        axisLine: { lineStyle: { color: '#e7eae7' } },
        axisTick: { show: false },
        axisLabel: {
          color: (value?: string | number) =>
            this.isSelected(String(value ?? '')) ? '#69716c' : '#a2a6a2',
          fontSize: 10,
          hideOverlap: true,
          showMinLabel: true,
          showMaxLabel: true,
          interval: (index: number) =>
            (index - start) % 2 === 0 ||
            index === end ||
            rows[index]?.date === range?.startDate ||
            rows[index]?.date === range?.endDate,
          formatter: (value: string) => this.date(value),
        },
      },
      yAxis: {
        type: 'value',
        min: minimum,
        max: maximum,
        splitNumber: 4,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: '#69716c', fontSize: 10, formatter: (value: number) => `€${value}` },
        splitLine: { lineStyle: { color: '#e7eae7', type: 'dashed' } },
      },
      series: [
        {
          name: 'Booked prices',
          type: 'scatter',
          dimensions: ['stayDate', 'bookedPrice', 'bookedRooms'],
          encode: { x: 'stayDate', y: 'bookedPrice' },
          symbol: 'circle',
          symbolSize: 6,
          itemStyle: { color: BOOKED_PRICE, opacity: 1 },
          emphasis: { disabled: true },
          data: rows.flatMap((row) =>
            this.isSelected(row.date)
              ? row.priceBuckets.map((price) => [row.date, price.nightlyRate, price.roomNights])
              : [],
          ),
          markLine: this.isSelected(this.asOf)
            ? {
                silent: true,
                symbol: 'none',
                animation: false,
                lineStyle: { color: '#b8a7d2', type: 'dashed', width: 1 },
                label: {
                  show: true,
                  formatter: 'Today',
                  color: CHART_COLORS.brandInk,
                  fontSize: 10,
                  position: 'insideEndTop',
                  rotate: 0,
                  distance: 6,
                },
                data: [{ xAxis: this.asOf }],
              }
            : undefined,
          z: 3,
        },
        {
          name: 'Average booked price',
          type: 'line',
          data: rows.map((row) => ({
            value: row.weightedRate,
            symbolSize: this.isSelected(row.date) ? 3 : 0,
          })),
          smooth: 0.3,
          smoothMonotone: 'x',
          showSymbol: true,
          showAllSymbol: true,
          symbol: 'circle',
          symbolSize: 3,
          connectNulls: false,
          // An explicit stroke color would override the visual map's date-based gradient.
          lineStyle: { width: 2.5, cap: 'round', join: 'round' },
          itemStyle: { color: WEIGHTED_RATE },
          z: 4,
        },
      ],
    };
  });

  constructor() {
    const destroy = inject(DestroyRef);
    let observer: ResizeObserver | undefined;
    afterNextRender(() => {
      this.width.set(this.host.nativeElement.clientWidth);
      observer = new ResizeObserver(([entry]) => this.width.set(entry.contentRect.width));
      observer.observe(this.host.nativeElement);
    });
    destroy.onDestroy(() => observer?.disconnect());
  }
  pan(event: Event): void {
    const value = (event.target as HTMLInputElement).valueAsNumber;
    if (Number.isFinite(value))
      this.panStart.set(Math.max(0, Math.min(this.maxWindowStart(), Math.round(value))));
  }
  private formatTooltip(params: unknown, detailed: boolean): string {
    const first = Array.isArray(params) ? params[0] : params;
    const date =
      first && typeof first === 'object' && 'axisValue' in first ? String(first.axisValue) : '';
    const row = this.rows().find((row) => row.date === date);
    return row
      ? formatPriceTooltip(row, {
          today: row.date === this.asOf,
          outside: !this.isSelected(row.date),
          detailed,
        })
      : '';
  }
  private tooltipPosition(point: number[], contentSize: number[], compact: boolean): number[] {
    const bounds = this.host.nativeElement.querySelector('app-chart')?.getBoundingClientRect();
    const view = this.host.nativeElement.ownerDocument.defaultView;
    if (!bounds || !view) return [point[0], point[1] - contentSize[1] - 14];
    const [width, height] = contentSize;
    const left = 12 - bounds.left;
    const right = view.innerWidth - bounds.left - width - 12;
    const top = 12 - bounds.top;
    const bottom = view.innerHeight - bounds.top - height - 12;
    const preferredX = compact
      ? point[0] - width / 2
      : point[0] + 18 <= right
        ? point[0] + 18
        : point[0] - width - 18;
    return [
      Math.max(left, Math.min(right, preferredX)),
      Math.max(top, Math.min(bottom, compact ? point[1] - height - 14 : point[1] - height / 2)),
    ];
  }
  isSelected(date: string): boolean {
    const range = this.validRange();
    return !!range && date >= range.startDate && date <= range.endDate;
  }
  date(value: string): string {
    return dateLabel.format(new Date(`${value}T12:00:00Z`));
  }
}
