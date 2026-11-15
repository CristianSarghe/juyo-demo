import { Inject, Injectable } from '@angular/core';
import { AppUiStore } from './app-ui.store';
import type { DateRange } from './network.models';

/** One calendar selection shared by the network views and Kassandra. */
@Injectable({ providedIn: 'root' })
export class ReportingScopeService {
  constructor(@Inject(AppUiStore) private readonly state: AppUiStore) {}

  get month() {
    return this.state.month;
  }
  get date() {
    return this.state.date;
  }
  get period() {
    return this.state.period;
  }
  get dates() {
    return this.state.dates;
  }
  get dashboardRange() {
    return this.state.dashboardRange;
  }

  selectDashboardRange(value: DateRange): boolean {
    return this.state.selectDashboardRange(value);
  }

  selectMonth(value: string): boolean {
    return this.state.selectMonth(value);
  }

  selectDate(value: string): boolean {
    return this.state.selectDate(value);
  }
}
