import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { NetworkComponent } from '../network/network.component';
import { HotelConfigurationComponent } from './hotel-configuration.component';

@Component({
  selector: 'app-hotel-configuration-page',
  imports: [HotelConfigurationComponent],
  template: `
    @if (workspace.pageReady() && workspace.view() === 'configuration') {
      <app-hotel-configuration />
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HotelConfigurationPageComponent {
  readonly workspace = inject(NetworkComponent);
}
