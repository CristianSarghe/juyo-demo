import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { createChart, type AppChartOption, type EChartsType } from './echarts';
import type { TooltipComponentOption } from 'echarts/components';

let tooltipSequence = 0;

@Component({
  selector: 'app-chart',
  template: `
    <div
      #chartHost
      class="chart-host"
      role="img"
      [attr.aria-label]="ariaLabel()"
      [attr.aria-hidden]="failed() ? 'true' : null"
    ></div>
    @if (failed()) {
      <p class="chart-fallback" role="status">Chart unavailable.</p>
    }
  `,
  host: { '[style.height.px]': 'height()' },
  styles: `
    :host {
      display: block;
      position: relative;
      width: 100%;
      min-width: 0;
    }
    .chart-host {
      width: 100%;
      height: 100%;
      min-width: 0;
    }
    .chart-fallback {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      margin: 0;
      color: var(--muted);
      background: #fff;
      font-size: 12px;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChartComponent {
  readonly option = input.required<AppChartOption>();
  readonly height = input(260);
  readonly ariaLabel = input.required<string>();
  readonly interactive = input(false);
  readonly tooltipDetails = input<
    Pick<TooltipComponentOption, 'formatter' | 'position'> | undefined
  >();
  readonly categorySelected = output<number>();
  readonly failed = signal(false);

  private readonly chartHost = viewChild.required<ElementRef<HTMLDivElement>>('chartHost');
  private readonly reducedMotion = signal(false);
  private readonly tooltipClass = `app-chart-tooltip-${++tooltipSequence}`;
  private tooltipConfig: AppChartOption['tooltip'];
  private tooltipSuppressed = false;
  private pinnedTooltip?: { index: number; y: number };
  private chart?: EChartsType;

  constructor() {
    const destroyRef = inject(DestroyRef);
    let resizeObserver: ResizeObserver | undefined;
    let resizeFrame = 0;
    let motionQuery: MediaQueryList | undefined;
    let tooltipWindow: Window | undefined;
    let tooltipDocument: Document | undefined;
    let chartElement: HTMLDivElement | undefined;
    const motionChanged = (event: MediaQueryListEvent) => this.reducedMotion.set(event.matches);
    const dismissTooltip = (event: KeyboardEvent) => {
      if (event.key === 'Escape') this.dismissTooltip();
    };
    const restoreTooltip = () => this.restoreTooltip();
    const scrollOutside = (event: Event) => {
      // Body-appended hover details must not remain detached when their page scrolls.
      if (this.pinnedTooltip) return;
      const tooltip = this.tooltipElement();
      if (tooltip && !tooltip.contains(event.target as Node) && this.tooltipVisible(tooltip))
        this.dismissTooltip();
    };
    const outsidePointer = (event: Event) => {
      const target = event.composedPath()[0];
      if (!target || !('nodeType' in target)) return;
      const node = target as Node;
      const tooltip = this.tooltipElement();
      if (tooltip?.contains(node)) return;
      if (!this.pinnedTooltip && chartElement?.contains(node)) return;
      if (tooltip && this.tooltipVisible(tooltip)) this.dismissTooltip();
    };

    effect(() => {
      const option = this.option();
      const label = this.ariaLabel();
      const reducedMotion = this.reducedMotion();
      if (this.chart) this.render(option, label, reducedMotion);
    });

    afterNextRender(() => {
      try {
        motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
        this.reducedMotion.set(motionQuery.matches);
        motionQuery.addEventListener('change', motionChanged);
        chartElement = this.chartHost().nativeElement;
        this.chart = createChart(chartElement);
        tooltipDocument = chartElement.ownerDocument;
        tooltipWindow = tooltipDocument.defaultView ?? undefined;
        tooltipWindow?.addEventListener('keydown', dismissTooltip, true);
        tooltipDocument.addEventListener('pointerdown', outsidePointer, true);
        tooltipDocument.addEventListener('click', outsidePointer, true);
        tooltipDocument.addEventListener('scroll', scrollOutside, true);
        // Restore before ZRender processes the next chart interaction.
        chartElement.addEventListener('pointermove', restoreTooltip, true);
        chartElement.addEventListener('pointerdown', restoreTooltip, true);
        chartElement.addEventListener('click', restoreTooltip, true);
        this.chart.getZr().on('click', (event) => {
          const chart = this.chart;
          if ((!this.interactive() && !this.tooltipDetails()) || !chart) return;
          const point = [event.offsetX, event.offsetY];
          if (!chart.containPixel({ gridIndex: 0 }, point)) return;
          const index = chart.convertFromPixel({ xAxisIndex: 0 }, event.offsetX);
          if (typeof index === 'number' && Number.isFinite(index)) {
            if (this.tooltipDetails()) this.pinTooltip(Math.round(index), point);
            if (this.interactive()) this.categorySelected.emit(Math.round(index));
          }
        });
        this.render(this.option(), this.ariaLabel(), this.reducedMotion());
        resizeObserver = new ResizeObserver(() => {
          cancelAnimationFrame(resizeFrame);
          resizeFrame = requestAnimationFrame(() => {
            this.chart?.resize();
            const pinned = this.pinnedTooltip;
            if (!pinned || !this.chart) return;
            const x = this.chart.convertToPixel({ xAxisIndex: 0 }, pinned.index);
            if (typeof x === 'number' && Number.isFinite(x)) {
              this.chart.dispatchAction({ type: 'showTip', x, y: pinned.y });
            }
          });
        });
        resizeObserver.observe(this.chartHost().nativeElement);
      } catch (error) {
        this.fail(error);
      }
    });

    destroyRef.onDestroy(() => {
      if (resizeFrame) tooltipWindow?.cancelAnimationFrame(resizeFrame);
      resizeObserver?.disconnect();
      motionQuery?.removeEventListener('change', motionChanged);
      tooltipWindow?.removeEventListener('keydown', dismissTooltip, true);
      tooltipDocument?.removeEventListener('pointerdown', outsidePointer, true);
      tooltipDocument?.removeEventListener('click', outsidePointer, true);
      tooltipDocument?.removeEventListener('scroll', scrollOutside, true);
      chartElement?.removeEventListener('pointermove', restoreTooltip, true);
      chartElement?.removeEventListener('pointerdown', restoreTooltip, true);
      chartElement?.removeEventListener('click', restoreTooltip, true);
      this.chart?.dispose();
      this.chart = undefined;
    });
  }

  private render(option: AppChartOption, label: string, reducedMotion: boolean): void {
    try {
      // A changed date window, hotel or series must not leave stale details on screen.
      this.dismissTooltip();
      const identifyTooltip = (tooltip: TooltipComponentOption): TooltipComponentOption => ({
        ...tooltip,
        // Explicit defaults make suppression reversible with ECharts' merging updates.
        show: tooltip.show ?? true,
        triggerOn: tooltip.triggerOn ?? 'mousemove|click|mousewheel',
        alwaysShowContent: tooltip.alwaysShowContent ?? false,
        enterable: tooltip.enterable ?? false,
        hideDelay: tooltip.hideDelay ?? 100,
        className: [tooltip.className, this.tooltipClass].filter(Boolean).join(' '),
      });
      this.tooltipConfig = Array.isArray(option.tooltip)
        ? option.tooltip.map(identifyTooltip)
        : option.tooltip
          ? identifyTooltip(option.tooltip)
          : option.tooltip;
      this.tooltipSuppressed = false;
      const series = option.series;
      const motionSafeSeries = reducedMotion
        ? Array.isArray(series)
          ? series.map((item) => ({ ...item, animation: false }))
          : series
            ? { ...series, animation: false }
            : series
        : series;
      this.chart?.setOption(
        {
          ...option,
          tooltip: this.tooltipConfig,
          textStyle: { fontFamily: 'DM Sans, sans-serif', ...option.textStyle },
          animation: !reducedMotion && option.animation !== false,
          series: motionSafeSeries,
          aria: {
            ...option.aria,
            enabled: true,
            label: { ...option.aria?.label, description: label },
          },
        },
        { notMerge: true },
      );
      this.failed.set(false);
    } catch (error) {
      this.fail(error);
    }
  }

  private tooltipElement(): HTMLElement | null {
    return this.chartHost().nativeElement.ownerDocument.querySelector(`.${this.tooltipClass}`);
  }

  private tooltipVisible(element: HTMLElement): boolean {
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    return !!style && style.visibility !== 'hidden' && style.display !== 'none';
  }

  private dismissTooltip(): void {
    const chart = this.chart;
    if (!chart) return;
    this.pinnedTooltip = undefined;
    const tooltip = this.tooltipElement();
    if (!this.tooltipSuppressed && tooltip && this.tooltipVisible(tooltip)) {
      // hideTip alone is ignored while the pointer is inside an enterable HTML tooltip.
      const suppress = (option: TooltipComponentOption): TooltipComponentOption => ({
        ...option,
        show: false,
        triggerOn: 'none',
        alwaysShowContent: false,
        enterable: false,
        hideDelay: 0,
      });
      const options = this.tooltipConfig;
      chart.setOption(
        {
          tooltip: Array.isArray(options)
            ? options.map(suppress)
            : options
              ? suppress(options)
              : options,
        },
        { silent: true },
      );
      this.tooltipSuppressed = true;
    }
    chart.dispatchAction({ type: 'hideTip' });
  }

  private restoreTooltip(): void {
    if (this.pinnedTooltip || !this.tooltipSuppressed || !this.chart) return;
    this.tooltipSuppressed = false;
    this.chart.setOption({ tooltip: this.tooltipConfig }, { silent: true });
  }

  private pinTooltip(index: number, point: number[]): void {
    const chart = this.chart;
    const details = this.tooltipDetails();
    const base = this.tooltipConfig;
    if (!chart || !details || !base || Array.isArray(base)) return;
    // hideTip clears ECharts' axis formatter cache before replacing the compact content.
    this.dismissTooltip();
    this.pinnedTooltip = { index, y: point[1] };
    this.tooltipSuppressed = false;
    chart.setOption(
      {
        tooltip: {
          ...base,
          ...details,
          show: true,
          triggerOn: 'none',
          alwaysShowContent: true,
          enterable: true,
        },
      },
      { silent: true },
    );
    chart.dispatchAction({ type: 'showTip', x: point[0], y: point[1] });
  }

  private fail(error: unknown): void {
    this.chart?.dispose();
    this.chart = undefined;
    this.failed.set(true);
    console.error('Chart could not be displayed.', error);
  }
}
