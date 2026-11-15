import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DashboardComponent } from './dashboard.component';
import { NetworkComponent } from './network.component';

@Component({
  selector: 'app-dashboard-page',
  imports: [DashboardComponent],
  template: `
    @if (workspace.pageReady() && workspace.view() === 'overview') {
      <app-dashboard
        [scope]="workspace.scope()"
        [range]="workspace.reporting.dashboardRange()"
        (selectHotel)="workspace.setScope($event)"
        [initialDrillDate]="workspace.inspectedDay()"
        (inspectDay)="workspace.inspectedDay.set($event)"
      />
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DashboardPageComponent {
  readonly workspace = inject(NetworkComponent);
}
