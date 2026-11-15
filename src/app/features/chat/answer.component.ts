import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { Message } from '../../core/models';
import { IconComponent } from '../../shared/icon.component';
import { BrandMarkComponent } from '../../shared/brand-mark.component';
import { ChartComponent } from '../../shared/chart.component';
import type { AppChartOption } from '../../shared/echarts';
import { CHART_COLORS } from '../../shared/chart-colors';

@Component({
  selector: 'app-answer',
  imports: [IconComponent, BrandMarkComponent, ChartComponent],
  template: `
    <article class="answer" animate.enter="answer-enter">
      <div class="answer-identity"><app-brand-mark /><span>Kassandra</span></div>
      @if (message().insight; as insight) {
        <h2>{{ insight.title }}</h2>
        <p class="summary">{{ insight.summary }}</p>
        <dl class="metrics">
          @for (metric of insight.metrics; track metric.label) {
            <div>
              <dt>{{ metric.label }}</dt>
              <dd>{{ metric.value }}</dd>
              <span>{{ metric.change }}</span>
            </div>
          }
        </dl>
        @if (insight.chart; as chart) {
          <figure class="chart">
            <figcaption>{{ chartMeta().title }}</figcaption>
            <app-chart [option]="chartOption()" [height]="220" [ariaLabel]="chartDescription()" />
          </figure>
        }
        <div class="next-move">
          <span class="next-label">Next step</span>
          <p>{{ insight.recommendation }}</p>
        </div>
      } @else {
        <p class="context">{{ message().content }}</p>
      }
      <div class="answer-actions">
        <button
          class="quiet-button"
          type="button"
          (click)="copy()"
          [attr.aria-label]="copied() ? 'Answer copied' : 'Copy answer'"
        >
          <app-icon [name]="copied() ? 'check' : 'copy'" />{{ copied() ? 'Copied' : 'Copy' }}
        </button>
        @if (message().insight?.chart?.length) {
          <button
            class="quiet-button source-button"
            type="button"
            (click)="sourcesOpen.set(!sourcesOpen())"
            [attr.aria-expanded]="sourcesOpen()"
          >
            <app-icon name="source" />Chart data<app-icon name="down" />
          </button>
        }
      </div>
      @if (copyFailed()) {
        <p class="copy-feedback" role="status">Select the answer text to copy it.</p>
      }
      @if (sourcesOpen() && message().insight?.chart; as chart) {
        <div class="source-details">
          <table>
            <caption>
              {{
                chartMeta().title
              }}
            </caption>
            <thead>
              <tr>
                <th scope="col">Period</th>
                <th scope="col">{{ chartMeta().valueLabel }}</th>
                <th scope="col">{{ chartMeta().comparisonLabel }}</th>
              </tr>
            </thead>
            <tbody>
              @for (point of chart; track point.label) {
                <tr>
                  <th scope="row">{{ point.label }}</th>
                  <td>{{ formatChartValue(point.value) }}</td>
                  <td>{{ formatChartValue(point.comparison) }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
      <span class="sr-only" role="status">{{ copied() ? 'Answer copied to clipboard' : '' }}</span>
    </article>
  `,
  styleUrl: './answer.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AnswerComponent {
  readonly message = input.required<Message>();
  readonly sourcesOpen = signal(false);
  readonly copied = signal(false);
  readonly copyFailed = signal(false);
  readonly chartMeta = computed(() => {
    const insight = this.message().insight;
    return {
      title: insight?.chartTitle ?? 'Occupancy',
      unit: insight?.chartUnit ?? 'percent',
      valueLabel: insight?.chartSeries?.value ?? 'Actual',
      comparisonLabel: insight?.chartSeries?.comparison ?? 'Budget',
    };
  });
  readonly chartDescription = computed(() => {
    const meta = this.chartMeta();
    return `${meta.title}. ${meta.valueLabel} compared with ${meta.comparisonLabel}. Exact values are available in Chart data.`;
  });
  readonly chartOption = computed<AppChartOption>(() => {
    const points = this.message().insight?.chart ?? [];
    const meta = this.chartMeta();
    return {
      animationDuration: 350,
      animationDurationUpdate: 250,
      color: [CHART_COLORS.brand, '#dde3de'],
      grid: { top: 42, left: 0, right: 6, bottom: 0, containLabel: true },
      legend: {
        top: 12,
        right: 0,
        data: [meta.valueLabel, meta.comparisonLabel],
        selectedMode: false,
        itemWidth: 10,
        itemHeight: 7,
        itemGap: 16,
        icon: 'roundRect',
        textStyle: { color: '#69716b', fontSize: 10 },
      },
      tooltip: {
        trigger: 'axis',
        confine: true,
        axisPointer: { type: 'shadow' },
        valueFormatter: (value) => this.formatChartValue(Number(value)),
        borderWidth: 0,
        backgroundColor: '#fff',
        extraCssText: 'box-shadow:0 3px 18px #1b211f12;border-radius:8px;',
        textStyle: { fontSize: 12, color: '#27302a' },
      },
      xAxis: {
        type: 'category',
        data: points.map((point) => point.label),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: '#69716b', fontSize: 10, margin: 12, interval: 0 },
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: meta.unit === 'percent' ? 100 : undefined,
        splitNumber: 2,
        axisLabel: {
          color: '#69716b',
          fontSize: 10,
          formatter: (value: number) =>
            meta.unit === 'percent'
              ? `${value}%`
              : `€${new Intl.NumberFormat('en', { notation: 'compact' }).format(value)}`,
        },
        splitLine: { lineStyle: { color: '#e8ece9', type: [2, 5] } },
      },
      series: [
        {
          name: meta.valueLabel,
          type: 'bar',
          data: points.map((point) => point.value),
          barMaxWidth: 20,
          barGap: '25%',
          itemStyle: { borderRadius: [4, 4, 0, 0] },
        },
        {
          name: meta.comparisonLabel,
          type: 'bar',
          data: points.map((point) => point.comparison),
          barMaxWidth: 20,
          itemStyle: { borderRadius: [4, 4, 0, 0] },
        },
      ],
    };
  });

  formatChartValue(value: number): string {
    return this.chartMeta().unit === 'currency'
      ? new Intl.NumberFormat('en-GB', {
          style: 'currency',
          currency: 'EUR',
          minimumFractionDigits: 0,
          maximumFractionDigits: 2,
        }).format(value)
      : `${value}%`;
  }

  async copy(): Promise<void> {
    const message = this.message();
    const insight = message.insight;
    const text = (
      insight
        ? [
            insight.title,
            insight.summary,
            ...insight.metrics.map((m) => `${m.label}: ${m.value} (${m.change})`),
            ...(insight.chart
              ? [
                  this.chartMeta().title,
                  ...insight.chart.map(
                    (point) =>
                      `${point.label}: ${this.formatChartValue(point.value)} ${this.chartMeta().valueLabel}, ${this.formatChartValue(point.comparison)} ${this.chartMeta().comparisonLabel}`,
                  ),
                ]
              : []),
            `Next step: ${insight.recommendation}`,
            `Sources: ${insight.sources.join(', ')}`,
          ]
        : [message.content]
    ).join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(true);
      this.copyFailed.set(false);
    } catch {
      this.copyFailed.set(true);
    }
  }
}
