import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { BookingPaceDay } from '../../core/network.models';
import { CHART_COLORS } from '../../shared/chart-colors';
import { ChartComponent } from '../../shared/chart.component';
import type { AppChartOption } from '../../shared/echarts';

const shortDate = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const fullDate = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const percentage = new Intl.NumberFormat('en-GB', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const date = (value: string, formatter = shortDate): string =>
  formatter.format(new Date(`${value}T12:00:00Z`));

@Component({
  selector: 'app-occupancy-trend',
  imports: [ChartComponent],
  template: `<app-chart [option]="option()" [height]="80" [ariaLabel]="description()" />`,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OccupancyTrendComponent {
  readonly rows = input.required<readonly BookingPaceDay[]>();
  readonly periodLabel = input.required<string>();
  private readonly points = computed(() =>
    this.rows().map((row) => ({
      ...row,
      occupancy: row.roomsAvailable > 0 ? (row.securedRooms / row.roomsAvailable) * 100 : null,
    })),
  );
  readonly description = computed(() => {
    const points = this.points();
    if (!points.length) return `No daily occupancy data for ${this.periodLabel()}.`;
    const context = `Daily occupancy for ${this.periodLabel()}. ${points.length} selected ${points.length === 1 ? 'day' : 'days'}. Purple shows stayed occupancy; light purple shows existing booked occupancy.`;
    if (points.length !== 1) return context;
    const point = points[0];
    return `${context} ${date(point.date, fullDate)}: ${point.occupancy === null ? 'no sellable rooms' : `${percentage.format(point.occupancy)}%, ${point.securedRooms} of ${point.roomsAvailable} sellable rooms ${point.state === 'past' ? 'stayed' : 'booked'}`}.`;
  });
  readonly option = computed<AppChartOption>(() => {
    const points = this.points();
    const firstBooked = points.findIndex((point) => point.state !== 'past');
    const middle = Math.floor((points.length - 1) / 2);
    return {
      animationDuration: 220,
      animationDurationUpdate: 180,
      grid: { left: 34, right: 7, top: 12, bottom: 26 },
      // Finite piece bounds keep ECharts' line gradient valid, including one-point views.
      visualMap: points.length
        ? {
            type: 'piecewise',
            show: false,
            selectedMode: false,
            dimension: 0,
            seriesIndex: 0,
            pieces:
              firstBooked < 0
                ? [{ gte: 0, lte: points.length - 1, color: CHART_COLORS.brand }]
                : firstBooked === 0
                  ? [{ gte: 0, lte: points.length - 1, color: CHART_COLORS.booked }]
                  : [
                      { gte: 0, lt: firstBooked, color: CHART_COLORS.brand },
                      { gte: firstBooked, lte: points.length - 1, color: CHART_COLORS.booked },
                    ],
          }
        : undefined,
      tooltip: {
        trigger: 'axis',
        renderMode: 'html',
        appendTo: 'body',
        confine: true,
        transitionDuration: 0,
        backgroundColor: '#ffffff',
        borderColor: '#e7eae7',
        borderWidth: 1,
        padding: [11, 13],
        extraCssText:
          'border-radius:10px;box-shadow:0 6px 24px #1b211f12;max-width:calc(100vw - 24px);',
        textStyle: { fontFamily: 'DM Sans, sans-serif', fontSize: 11, color: '#1b211f' },
        axisPointer: {
          type: 'line',
          lineStyle: { color: '#c9bef6', width: 1, type: 'dashed' },
        },
        formatter: (params: unknown) => {
          const first = Array.isArray(params) ? params[0] : params;
          const value =
            first && typeof first === 'object' && 'axisValue' in first
              ? String(first.axisValue)
              : '';
          const point = points.find((point) => point.date === value);
          if (!point) return '';
          const occupancy =
            point.occupancy === null ? '—' : `${percentage.format(point.occupancy)}%`;
          return `<div style="font-size:12px;font-weight:600;margin-bottom:8px">${date(point.date, fullDate)}</div><div style="display:flex;align-items:baseline;justify-content:space-between;gap:20px"><span style="color:#69716c">${point.state === 'past' ? 'Stayed' : 'Booked'} occupancy</span><strong style="color:${CHART_COLORS.brandInk};font-size:15px;font-variant-numeric:tabular-nums">${occupancy}</strong></div><div style="color:#69716c;font-size:10px;margin-top:5px">${point.roomsAvailable ? `${point.securedRooms} / ${point.roomsAvailable} sellable rooms` : 'No sellable rooms'}</div>`;
        },
      },
      xAxis: {
        type: 'category',
        boundaryGap: points.length === 1,
        data: points.map((point) => point.date),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: '#69716c',
          fontSize: 9,
          margin: 10,
          hideOverlap: true,
          showMinLabel: true,
          showMaxLabel: true,
          interval: (index: number) =>
            index === 0 || index === middle || index === points.length - 1,
          formatter: (value: string) => date(value),
        },
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: 100,
        interval: 50,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: '#69716c', fontSize: 9, margin: 7, formatter: '{value}%' },
        splitLine: { lineStyle: { color: '#eef0ee', type: 'dashed' } },
      },
      series: [
        {
          name: 'Occupancy',
          type: 'line',
          data: points.map((point) => point.occupancy),
          smooth: 0.2,
          smoothMonotone: 'x',
          connectNulls: false,
          showSymbol: points.length === 1,
          symbol: 'circle',
          symbolSize: 6,
          // Keep the stroke unset so the visual map colors one continuous curve.
          lineStyle: { width: 2.5, cap: 'round', join: 'round' },
          areaStyle: { opacity: 0.2 },
          emphasis: { scale: false },
          clip: false,
        },
      ],
    };
  });
}
