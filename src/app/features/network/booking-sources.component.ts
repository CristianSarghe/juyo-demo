import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { BookingSourceSummary } from '../../core/network.selectors';
import { ChartComponent } from '../../shared/chart.component';
import { CHART_COLORS } from '../../shared/chart-colors';
import type { AppChartOption } from '../../shared/echarts';
import { IconComponent } from '../../shared/icon.component';

const number = new Intl.NumberFormat('en-GB');
const percentage = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });
const currency = new Intl.NumberFormat('en-IE', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 0,
});
const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );

@Component({
  selector: 'app-booking-sources',
  imports: [ChartComponent, IconComponent],
  template: `
    @if (total(); as count) {
      <p class="booking-total">
        <strong>{{ format(count) }}</strong
        ><span>bookings</span>
      </p>
      <div class="source-comparison">
        <app-chart [option]="option()" [height]="168" [ariaLabel]="description()" />
        <dl class="source-labels">
          @for (row of sortedRows(); track row.channel) {
            <div>
              <dt>{{ row.label }}</dt>
              <dd>
                <strong>{{ format(row.bookings) }}</strong
                ><span>{{ share(row.share) }}%</span>
              </dd>
            </div>
          }
        </dl>
      </div>
    } @else {
      <div class="sources-empty" role="status">
        <app-icon name="source" />
        <h3>No bookings</h3>
        <p>No accepted bookings for the selected hotels and stay dates.</p>
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    .booking-total {
      display: flex;
      align-items: baseline;
      gap: 7px;
      margin: 16px 0 20px;
    }
    .booking-total strong {
      font-size: 28px;
      font-weight: 600;
      line-height: 1;
      letter-spacing: -1px;
      font-variant-numeric: tabular-nums;
    }
    .booking-total > span {
      color: var(--muted);
      font-size: 10px;
    }
    .source-comparison {
      position: relative;
    }
    .source-labels {
      position: absolute;
      inset: 0;
      display: grid;
      grid-template-rows: repeat(4, 1fr);
      margin: 0;
      pointer-events: none;
    }
    .source-labels > div {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 10px;
    }
    dt {
      color: var(--ink);
      font-size: 11px;
    }
    dd {
      display: flex;
      gap: 10px;
      align-items: baseline;
      margin: 0;
      font-size: 11px;
      font-variant-numeric: tabular-nums;
    }
    dd strong {
      font-weight: 500;
    }
    dd span {
      min-width: 35px;
      color: var(--muted);
      font-size: 10px;
      text-align: right;
    }
    .sources-empty {
      display: flex;
      min-height: 225px;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      text-align: center;
      padding: 24px 8px;
    }
    .sources-empty app-icon {
      width: 27px;
      height: 27px;
      color: var(--brand-ink);
      margin-bottom: 14px;
    }
    .sources-empty h3 {
      margin: 0;
      color: var(--ink);
      font-size: 13px;
      font-weight: 500;
    }
    .sources-empty p {
      max-width: 210px;
      margin: 7px 0 0;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.6;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BookingSourcesComponent {
  readonly rows = input.required<readonly BookingSourceSummary[]>();
  readonly periodLabel = input.required<string>();
  readonly sortedRows = computed(() => [...this.rows()].sort((a, b) => b.bookings - a.bookings));
  readonly total = computed(() => this.rows().reduce((sum, row) => sum + row.bookings, 0));
  readonly description = computed(
    () =>
      `Booking sources for stays in ${this.periodLabel()}. ${this.total()} accepted bookings. ` +
      this.sortedRows()
        .map(
          (row) =>
            `${row.label}: ${row.bookings} bookings, ${this.share(row.share)}%, ${row.roomNights} room nights, ${currency.format(row.roomRevenue)} room revenue.`,
        )
        .join(' '),
  );
  readonly option = computed<AppChartOption>(() => ({
    animationDuration: 220,
    animationDurationUpdate: 180,
    grid: { left: 0, right: 0, top: 7, bottom: -7 },
    xAxis: { type: 'value', min: 0, max: 100, show: false },
    yAxis: {
      type: 'category',
      inverse: true,
      data: this.sortedRows().map((row) => row.channel),
      show: false,
    },
    tooltip: {
      trigger: 'item',
      appendTo: 'body',
      confine: true,
      backgroundColor: '#fff',
      borderColor: '#e7eae7',
      borderWidth: 1,
      padding: [11, 13],
      extraCssText: 'border-radius:10px;box-shadow:0 6px 24px #1b211f12;',
      textStyle: { color: '#1b211f', fontSize: 11 },
      formatter: (params: unknown) => {
        const item =
          params && typeof params === 'object' && 'dataIndex' in params
            ? this.sortedRows()[Number(params.dataIndex)]
            : undefined;
        if (!item) return '';
        return `<strong>${escapeHtml(item.label)}</strong><div style="margin-top:7px;color:#69716c">${number.format(item.bookings)} bookings · ${number.format(item.roomNights)} room nights</div><div style="margin-top:5px;color:${CHART_COLORS.brandInk};font-weight:600">${currency.format(item.roomRevenue)} room revenue</div>`;
      },
    },
    series: [
      {
        type: 'bar',
        name: 'Share of bookings',
        data: this.sortedRows().map((row) => row.share),
        barWidth: 7,
        showBackground: true,
        backgroundStyle: { color: '#f0eef6', borderRadius: 4 },
        itemStyle: { color: CHART_COLORS.brand, borderRadius: 4 },
        emphasis: { itemStyle: { color: CHART_COLORS.brandInk } },
      },
    ],
  }));
  format(value: number): string {
    return number.format(value);
  }
  share(value: number): string {
    return percentage.format(value);
  }
}
