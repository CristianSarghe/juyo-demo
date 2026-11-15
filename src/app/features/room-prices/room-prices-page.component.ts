import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { NetworkComponent } from '../network/network.component';
import { RoomPricesComponent } from './room-prices.component';

@Component({
  selector: 'app-room-prices-page',
  imports: [RoomPricesComponent],
  template: `
    @if (
      workspace.pageReady() && workspace.view() === 'rooms' && workspace.roomSection() === 'prices'
    ) {
      <app-room-prices
        [restoreDateFocus]="workspace.priceDateFocus()"
        (dateChange)="workspace.priceDateFocus.set($event)"
        (dateFocusRestored)="workspace.priceDateFocus.set(null)"
      />
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RoomPricesPageComponent {
  readonly workspace = inject(NetworkComponent);
}
