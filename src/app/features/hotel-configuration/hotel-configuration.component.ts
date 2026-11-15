import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { HotelScopeService } from '../../core/hotel-scope.service';
import { NetworkService } from '../../core/network.service';

const currency = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 0,
});

@Component({
  selector: 'app-hotel-configuration',
  templateUrl: './hotel-configuration.component.html',
  styleUrl: './hotel-configuration.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HotelConfigurationComponent {
  private readonly hotels = inject(HotelScopeService);
  private readonly network = inject(NetworkService);
  readonly portfolio = computed(() => this.hotels.scope() === 'portfolio');
  readonly hotel = computed(() => this.network.hotels.find((hotel) => hotel.id === this.hotels.scope()));
  readonly roomTypes = computed(() =>
    this.network.data.roomTypes.filter(
      (type) => this.portfolio() || type.hotelId === this.hotels.scope(),
    ),
  );
  readonly roomCount = computed(() =>
    this.roomTypes().reduce((total, type) => total + type.inventory, 0),
  );

  hotelName(id: string): string {
    return this.network.hotels.find((hotel) => hotel.id === id)?.name ?? id;
  }
  money(value: number): string {
    return currency.format(value);
  }
  facilityLabel(value: string): string {
    return value === 'wifi'
      ? 'Wi-Fi'
      : value.replace(/_/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
  }
}
