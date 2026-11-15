import { ChangeDetectionStrategy, Component, computed, inject, linkedSignal } from '@angular/core';
import { HotelScopeService } from '../../core/hotel-scope.service';
import { NetworkService } from '../../core/network.service';
import type { HotelId } from '../../core/network.models';

const euro = new Intl.NumberFormat('en-IE', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 0,
});
const shortDate = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});

@Component({
  selector: 'app-reservations',
  templateUrl: './reservations.component.html',
  styleUrl: './reservations.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReservationsComponent {
  private readonly network = inject(NetworkService);
  private readonly hotels = inject(HotelScopeService);
  readonly date = this.network.bookingSnapshot.asOf;
  readonly pageSize = 12;
  private readonly requestedPage = linkedSignal({
    source: this.hotels.scope,
    computation: () => 0,
  });
  private readonly cities = computed(
    () => new Map(this.network.hotels.map((hotel) => [hotel.id, hotel.city])),
  );
  private readonly types = computed(
    () => new Map(this.network.data.roomTypes.map((type) => [type.id, type.name])),
  );
  private readonly roomNumbers = computed(
    () => new Map(this.network.data.rooms.map((room) => [room.id, room.number])),
  );
  readonly reservations = computed(() => {
    const scope = this.hotels.scope();
    return this.network.data.reservations.filter(
      (reservation) =>
        (scope === 'portfolio' || reservation.hotelId === scope) &&
        reservation.arrival <= this.date &&
        reservation.departure > this.date,
    );
  });
  readonly pageCount = computed(() =>
    Math.max(1, Math.ceil(this.reservations().length / this.pageSize)),
  );
  readonly page = computed(() => Math.max(0, Math.min(this.requestedPage(), this.pageCount() - 1)));
  readonly pageReservations = computed(() =>
    this.reservations().slice(this.page() * this.pageSize, (this.page() + 1) * this.pageSize),
  );
  readonly firstRow = computed(() =>
    this.reservations().length ? this.page() * this.pageSize + 1 : 0,
  );
  readonly lastRow = computed(() => this.page() * this.pageSize + this.pageReservations().length);

  turnPage(delta: number): void {
    this.requestedPage.set(Math.max(0, Math.min(this.page() + delta, this.pageCount() - 1)));
  }
  city(id: HotelId): string {
    return this.cities().get(id) ?? 'Unknown hotel';
  }
  roomTypeName(id: string): string {
    return this.types().get(id) ?? 'Unknown type';
  }
  assignedRoom(id: string | null): string {
    const number = id ? this.roomNumbers().get(id) : undefined;
    return number ? `Room ${number}` : 'Unassigned';
  }
  reference(id: string): string {
    return id.replace(
      /^dev-([a-z]{3})-reservation-(\d+)$/,
      (_, city: string, number: string) => `${city.toUpperCase()}-R${number.padStart(4, '0')}`,
    );
  }
  label(value: string): string {
    return value.replace(/_/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
  }
  formatDate(value: string): string {
    return shortDate.format(new Date(`${value}T12:00:00Z`));
  }
  money(value: number): string {
    return euro.format(value);
  }
}
