import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { NetworkComponent } from '../network/network.component';
import { ReservationsComponent } from './reservations.component';

@Component({
  selector: 'app-reservations-page',
  imports: [ReservationsComponent],
  template: `
    @if (workspace.pageReady() && workspace.view() === 'reservations') {
      <app-reservations />
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReservationsPageComponent {
  readonly workspace = inject(NetworkComponent);
}
