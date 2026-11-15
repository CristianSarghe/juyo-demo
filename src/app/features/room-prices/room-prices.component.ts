import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { HotelScopeService } from '../../core/hotel-scope.service';
import { NetworkService } from '../../core/network.service';
import { RoomRateService } from '../../core/room-rate.service';
import type { DateRange } from '../../core/network.models';
import { AppSelectComponent } from '../../shared/select.component';
import { IconComponent } from '../../shared/icon.component';
import { RoomPriceHistoryComponent } from '../../shared/room-price-history.component';
import { SpinnerComponent } from '../../shared/spinner.component';
import { DatePickerComponent } from '../../shared/date-picker.component';
import { NetworkDataStore } from '../../core/api/network-data.store';
import { NotificationsStore } from '../../core/api/notifications.store';

const money = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 2,
});
const shortDate = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
interface RatePeriod {
  startDate: string;
  endDate: string;
  nights: number;
  nightlyRate: number;
}

@Component({
  selector: 'app-room-prices',
  imports: [
    AppSelectComponent,
    IconComponent,
    RoomPriceHistoryComponent,
    SpinnerComponent,
    DatePickerComponent,
  ],
  templateUrl: './room-prices.component.html',
  styleUrl: './room-prices.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RoomPricesComponent {
  readonly dateChange = output<keyof DateRange>();
  readonly restoreDateFocus = input<keyof DateRange | null>(null);
  readonly dateFocusRestored = output<void>();
  private readonly fromDate = viewChild<DatePickerComponent>('fromDate');
  private readonly throughDate = viewChild<DatePickerComponent>('throughDate');
  readonly network = inject(NetworkService);
  private readonly pageData = inject(NetworkDataStore);
  private readonly notifications = inject(NotificationsStore);
  readonly hotels = inject(HotelScopeService);
  readonly rates = inject(RoomRateService);
  private readonly destroyRef = inject(DestroyRef);
  readonly saving = signal(false);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly query = toSignal(this.route.queryParamMap);
  readonly minDate = this.network.periods[0].startDate;
  readonly maxDate = this.network.periods[this.network.periods.length - 1].endDate;
  readonly roomTypes = computed(() =>
    this.network.data.roomTypes.filter(
      (type) => this.hotels.scope() === 'portfolio' || type.hotelId === this.hotels.scope(),
    ),
  );
  readonly typeOptions = computed(() =>
    this.roomTypes().map((type) => ({
      value: type.id,
      label:
        this.hotels.scope() === 'portfolio'
          ? `${this.network.hotels.find((hotel) => hotel.id === type.hotelId)!.city} · ${type.name}`
          : type.name,
    })),
  );
  readonly roomTypeId = linkedSignal(() => {
    const requested = this.query()?.get('type');
    return (
      this.roomTypes().find((type) => type.id === requested)?.id ??
      this.pageData.resolvedRoomTypeId() ??
      this.roomTypes()[0].id
    );
  });
  readonly roomType = computed(
    () => this.roomTypes().find((type) => type.id === this.roomTypeId()) ?? this.roomTypes()[0],
  );
  readonly hotelId = computed(() => this.roomType().hotelId);
  readonly hotelName = computed(
    () => this.network.hotels.find((hotel) => hotel.id === this.hotelId())!.name,
  );
  readonly range = linkedSignal<DateRange>(() => {
    const query = this.query();
    const today = this.network.bookingSnapshot.asOf;
    const weekEnd = new Date(Date.parse(`${today}T12:00:00Z`) + 6 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const fallback = {
      startDate: today,
      endDate: weekEnd > this.maxDate ? this.maxDate : weekEnd,
    };
    try {
      return this.network.validateDateRange({
        startDate: query?.get('from') ?? fallback.startDate,
        endDate: query?.get('through') ?? fallback.endDate,
      });
    } catch {
      // Match the page loader's fallback before passing dates into calendar controls.
      return fallback;
    }
  });
  readonly rangeError = computed(() => {
    try {
      this.network.validateDateRange(this.range());
      return '';
    } catch {
      return `Choose valid dates from ${this.date(this.minDate)} to ${this.date(this.maxDate)} ${this.maxDate.slice(0, 4)}.`;
    }
  });
  readonly days = computed(() =>
    this.rangeError() || !this.loadedRange()
      ? []
      : this.rates.rows(this.roomType().hotelId, this.roomType().id, this.range()),
  );
  private readonly loadedRange = computed(() => {
    const typeId = this.roomType().id;
    const dates = new Set(
      this.network.data.roomRates
        .filter((rate) => rate.roomTypeId === typeId)
        .map((rate) => rate.date),
    );
    return dates.has(this.range().startDate) && dates.has(this.range().endDate);
  });
  readonly periods = computed(() => {
    const periods: RatePeriod[] = [];
    for (const day of this.days()) {
      const previous = periods.at(-1);
      if (previous?.nightlyRate === day.nightlyRate) {
        previous.endDate = day.date;
        previous.nights++;
      } else
        periods.push({
          startDate: day.date,
          endDate: day.date,
          nights: 1,
          nightlyRate: day.nightlyRate,
        });
    }
    return periods;
  });
  readonly currentRate = computed(() => {
    const values = this.days().map((day) => day.nightlyRate);
    if (!values.length) return '—';
    const min = Math.min(...values);
    const max = Math.max(...values);
    return min === max ? this.money(min) : `${this.money(min)}–${this.money(max)}`;
  });
  readonly available = computed(() =>
    this.days().reduce((sum, day) => sum + day.availableRooms, 0),
  );
  readonly nightlyRate = linkedSignal<number | null>(() => {
    this.contextKey();
    return untracked(() => {
      const days = this.days();
      return days.length && days.every((day) => day.nightlyRate === days[0].nightlyRate)
        ? days[0].nightlyRate
        : null;
    });
  });
  readonly touched = linkedSignal({ source: () => this.contextKey(), computation: () => false });
  readonly rateError = computed(() => {
    const value = this.nightlyRate();
    return value === null ||
      !Number.isFinite(value) ||
      value <= 0 ||
      value > 10000 ||
      Math.abs(value * 100 - Math.round(value * 100)) > 1e-7
      ? 'Enter a rate from €0.01 to €10,000, with up to 2 decimals.'
      : '';
  });
  readonly changed = computed(
    () => !this.rateError() && this.days().some((day) => day.nightlyRate !== this.nightlyRate()),
  );
  readonly eventOptions = computed(() => [
    { value: '', label: 'No event' },
    ...this.notifications
      .eventsFor(this.hotelId())
      .map((item) => ({ value: item.event.id, label: item.event.name })),
  ]);
  readonly eventId = linkedSignal(() => {
    const requested = this.query()?.get('event');
    return this.eventOptions().some((option) => option.value === requested) ? requested! : '';
  });
  readonly reason = signal('');
  readonly reasonOpen = signal(false);
  private readonly contextKey = computed(
    () =>
      `${this.hotelId()}/${this.roomTypeId()}/${this.range().startDate}/${this.range().endDate}`,
  );
  readonly feedback = linkedSignal({ source: this.contextKey, computation: () => '' });
  readonly saveError = linkedSignal({ source: this.contextKey, computation: () => '' });

  constructor() {
    effect(() => {
      if (this.eventId()) this.reasonOpen.set(true);
    });
    // A scoped data reload remounts these controls. Return focus once the new view exists.
    afterNextRender(() => {
      const field = this.restoreDateFocus();
      if (!field) return;
      const picker = field === 'startDate' ? this.fromDate() : this.throughDate();
      const trigger = picker?.trigger()?.nativeElement;
      // A user who moved elsewhere while loading keeps that focus.
      if (trigger && trigger.ownerDocument.activeElement === trigger.ownerDocument.body)
        trigger.focus({ preventScroll: true });
      this.dateFocusRestored.emit();
    });
  }
  selectType(value: string): void {
    if (value === this.roomTypeId() || !this.roomTypes().some((type) => type.id === value)) return;
    this.roomTypeId.set(value);
    this.writeContext();
  }
  changeDate(field: keyof DateRange, value: string): void {
    if (this.saving() || this.range()[field] === value) return;
    const next = { ...this.range(), [field]: value };
    // Keep the routed interval valid even when a change bypasses the calendar UI.
    try {
      this.network.validateDateRange(next);
    } catch {
      return;
    }
    this.range.set(next);
    this.feedback.set('');
    this.dateChange.emit(field);
    this.writeContext();
  }
  selectEvent(value: string): void {
    if (!this.eventOptions().some((option) => option.value === value)) return;
    this.eventId.set(value);
    // A reason does not change the queried prices or reset an in-progress rate draft.
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { event: value || null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
  changeRate(event: Event): void {
    const raw = (event.target as HTMLInputElement).value;
    this.nightlyRate.set(raw === '' ? null : Number(raw));
    this.touched.set(true);
    this.feedback.set('');
    this.saveError.set('');
  }
  async update(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (this.saving()) return;
    this.touched.set(true);
    if (this.rangeError() || this.rateError() || !this.changed()) return;
    const context = this.contextKey();
    const nights = this.days().length;
    const nightlyRate = this.nightlyRate()!;
    this.feedback.set('');
    this.saveError.set('');
    this.saving.set(true);
    let saved = false;
    try {
      saved = await this.rates.update({
        hotelId: this.roomType().hotelId,
        roomTypeId: this.roomType().id,
        ...this.range(),
        nightlyRate: this.nightlyRate()!,
        ...(this.eventId() ? { eventId: this.eventId() } : {}),
        ...(this.reason().trim() ? { reason: this.reason().trim() } : {}),
      });
    } catch {
      if (!this.destroyRef.destroyed && this.contextKey() === context)
        this.saveError.set('Could not save rates. Try again.');
      return;
    } finally {
      this.saving.set(false);
    }
    if (this.destroyRef.destroyed || this.contextKey() !== context) return;
    this.saveError.set(saved ? '' : this.rates.error() || 'Could not save rates. Try again.');
    if (saved)
      this.feedback.set(
        `Updated ${nights} ${nights === 1 ? 'night' : 'nights'} to ${this.money(nightlyRate)}.`,
      );
  }
  money(value: number): string {
    return money.format(value);
  }
  date(value: string): string {
    return shortDate.format(new Date(`${value}T12:00:00Z`));
  }
  dates(start: string, end: string): string {
    return start === end ? this.date(start) : `${this.date(start)}–${this.date(end)}`;
  }
  private writeContext(): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        view: 'rooms',
        section: 'prices',
        from: this.range().startDate,
        through: this.range().endDate,
        type: this.roomTypeId(),
        rateHotel: this.hotels.scope() === 'portfolio' ? this.hotelId() : null,
        event: this.eventId() || null,
      },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
}
