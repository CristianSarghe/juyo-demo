import { init, use, type EChartsType } from 'echarts/core';
import { BarChart, CustomChart, GaugeChart, LineChart, ScatterChart } from 'echarts/charts';
import {
  AriaComponent,
  DataZoomInsideComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapPiecewiseComponent,
} from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import type { EChartsOption } from 'echarts';

use([
  BarChart,
  CustomChart,
  GaugeChart,
  LineChart,
  ScatterChart,
  AriaComponent,
  DataZoomInsideComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapPiecewiseComponent,
  SVGRenderer,
]);

export type AppChartOption = EChartsOption;

export function createChart(element: HTMLElement): EChartsType {
  return init(element, undefined, { renderer: 'svg' });
}

export type { EChartsType };
