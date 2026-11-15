import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  linkedSignal,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { TuiAutoFocus, tuiGenerateId } from '@taiga-ui/cdk';
import { TuiDataList, TuiDropdown } from '@taiga-ui/core';
import { HotelScopeService } from '../core/hotel-scope.service';
import { ReferenceDataService } from '../core/api/reference-data.service';
import { NotificationsStore } from '../core/api/notifications.store';
import { AssistantUiStore } from '../core/assistant-ui.store';
import { repairHelpPrompt } from '../core/repair-assistance';
import { eventPricingPrompt } from '../core/event-pricing-assistance';
import type { EventHotelImpact, RoomWarning, UpcomingHotelEvent } from '../core/network.models';
import { IconComponent } from './icon.component';
import { EventLocationMapComponent } from './event-location-map.component';
import { BrandMarkComponent } from './brand-mark.component';
import { KassandraNoteComponent } from './kassandra-note.component';
import { SpinnerComponent } from './spinner.component';
import { SkeletonComponent } from './skeleton.component';

type NotificationKind = 'warnings' | 'events';
type Detail = { kind: 'event'; id: string } | { kind: 'warning'; id: string };
const fullDate = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const shortDate = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const number = new Intl.NumberFormat('en-GB');
const distance = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });

@Component({
  selector: 'app-hotel-notifications',
  imports: [
    IconComponent,
    BrandMarkComponent,
    KassandraNoteComponent,
    TuiAutoFocus,
    TuiDataList,
    TuiDropdown,
    EventLocationMapComponent,
    SpinnerComponent,
    SkeletonComponent,
  ],
  templateUrl: './hotel-notifications.component.html',
  styleUrl: './hotel-notifications.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HotelNotificationsComponent {
  readonly opened = output<void>();
  readonly hotels = inject(HotelScopeService);
  readonly notifications = inject(NotificationsStore);
  private readonly reference = inject(ReferenceDataService);
  private readonly assistant = inject(AssistantUiStore);
  readonly id = tuiGenerateId();
  readonly asOf = this.reference.data.bookingSnapshot.asOf;
  readonly warnings = computed(() => this.notifications.warningsFor(this.hotels.scope()));
  readonly events = computed(() => this.notifications.eventsFor(this.hotels.scope()));
  readonly totalWarnings = computed(() => this.notifications.warnings()?.length ?? 0);
  readonly hasWarningsElsewhere = computed(
    () =>
      this.hotels.scope() !== 'portfolio' && !this.warnings().length && this.totalWarnings() > 0,
  );
  readonly totalEvents = computed(() => this.notifications.events()?.length ?? 0);
  readonly warningCount = computed(() =>
    this.hotels.scope() === 'portfolio'
      ? String(this.totalWarnings())
      : `${this.warnings().length} / ${this.totalWarnings()}`,
  );
  readonly eventCount = computed(() =>
    this.hotels.scope() === 'portfolio'
      ? String(this.totalEvents())
      : `${this.events().length} / ${this.totalEvents()}`,
  );
  readonly context = computed(() =>
    this.hotels.scope() === 'portfolio'
      ? `All ${this.reference.data.hotels.length} hotels`
      : (this.reference.data.hotels.find((hotel) => hotel.id === this.hotels.scope())?.name ??
        'Selected hotel'),
  );
  readonly warningDescription = computed(() =>
    this.notifications.warnings() === null
      ? this.notifications.warningsError()
        ? 'Warnings unavailable'
        : 'Warnings, loading'
      : this.hotels.scope() === 'portfolio'
        ? `Warnings, ${this.totalWarnings()} across all hotels`
        : `Warnings, ${this.warnings().length} at ${this.context()}, ${this.totalWarnings()} across all hotels`,
  );
  readonly eventDescription = computed(() =>
    this.notifications.events() === null
      ? this.notifications.eventsError()
        ? 'Upcoming events unavailable'
        : 'Upcoming events, loading'
      : this.hotels.scope() === 'portfolio'
        ? `Upcoming events, ${this.totalEvents()} across all hotels`
        : `Upcoming events, ${this.events().length} for ${this.context()}, ${this.totalEvents()} across all hotels`,
  );
  readonly active = signal<NotificationKind | null>(null);
  readonly detail = signal<Detail | null>(null);
  readonly selectedEvent = computed(() => {
    const detail = this.detail();
    return detail?.kind === 'event'
      ? (this.events().find((item) => item.event.id === detail.id) ?? null)
      : null;
  });
  readonly selectedWarning = computed(() => {
    const detail = this.detail();
    return detail?.kind === 'warning'
      ? (this.warnings().find((item) => item.room.id === detail.id) ?? null)
      : null;
  });
  readonly mapHotelId = linkedSignal<string | null>(
    () => this.selectedEvent()?.impacts[0]?.hotelId ?? null,
  );
  readonly pricingHotel = computed(() => {
    const item = this.selectedEvent();
    return (
      item?.impacts.find((impact) => impact.hotelId === this.mapHotelId()) ??
      item?.impacts[0] ??
      null
    );
  });
  readonly pricingTargets = computed(() => {
    const item = this.selectedEvent();
    if (!item) return [];
    return this.hotels.scope() === 'portfolio'
      ? item.impacts
      : item.impacts.filter((impact) => impact.hotelId === this.hotels.scope());
  });
  readonly pricingTargetLabel = computed(() => {
    const targets = this.pricingTargets();
    return targets.length === 1 ? targets[0].hotel.name : `all ${targets.length} relevant hotels`;
  });
  readonly pricingAssistantBusy = computed(
    () =>
      this.assistant.requestPending() ||
      this.assistant.responding() ||
      !!this.assistant.pendingAction(),
  );
  readonly rateEstimates = computed(
    () => this.notifications.estimates()[this.selectedEvent()?.event.id ?? ''] ?? {},
  );
  readonly warningsButton = viewChild<ElementRef<HTMLButtonElement>>('warningsButton');
  readonly eventsButton = viewChild<ElementRef<HTMLButtonElement>>('eventsButton');
  private readonly detailDialog = viewChild<ElementRef<HTMLDialogElement>>('detailDialog');
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private opener: HTMLButtonElement | null = null;

  constructor() {
    this.notifications.initialize();
    effect(() => {
      const item = this.selectedEvent();
      untracked(() => {
        if (item) void this.notifications.loadEstimates(item);
        else this.notifications.cancelDetails();
      });
    });
    inject(DestroyRef).onDestroy(() => this.closeAll());
  }
  onPopoverChange(kind: NotificationKind, open: boolean): void {
    if (open) {
      this.active.set(kind);
      this.opened.emit();
    } else if (this.active() === kind) this.active.set(null);
  }
  openEvent(item: UpcomingHotelEvent): void {
    this.openDetail({ kind: 'event', id: item.event.id }, this.eventsButton()?.nativeElement);
  }
  openWarning(item: RoomWarning): void {
    void this.notifications.loadWarningDetails(item);
    this.openDetail({ kind: 'warning', id: item.room.id }, this.warningsButton()?.nativeElement);
  }
  showAllWarnings(): void {
    if (!this.hasWarningsElsewhere()) return;
    this.hotels.select('portfolio');
    this.onPopoverChange('warnings', true);
  }
  close(): void {
    this.detailDialog()?.nativeElement.close();
  }
  /** Navigation owns the next focus destination. */
  closeAll(): void {
    this.notifications.cancelDetails();
    this.opener = null;
    this.active.set(null);
    this.detail.set(null);
    this.detailDialog()?.nativeElement.close();
  }
  onClosed(): void {
    if (this.detailDialog()?.nativeElement.open) return;
    this.detail.set(null);
    const opener = this.opener;
    this.opener = null;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  }
  onBackdrop(event: MouseEvent): void {
    const dialog = this.detailDialog()?.nativeElement;
    if (!dialog || event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    )
      this.close();
  }
  helpFix(warning: RoomWarning): void {
    const prompt = repairHelpPrompt([
      {
        hotelId: warning.hotel.id,
        hotelName: warning.hotel.name,
        city: warning.hotel.city,
        country: warning.hotel.country,
        roomNumber: warning.room.number,
        issue:
          warning.room.maintenanceNote ||
          'Technical issue; confirm the maintenance details before recommending a provider.',
      },
    ]);
    const trigger = this.warningsButton()?.nativeElement;
    this.closeAll();
    afterNextRender(
      () => {
        trigger?.focus({ preventScroll: true });
        this.assistant.open({ kind: 'warning', label: 'Repairs' });
        this.assistant.setDraft(prompt);
      },
      { injector: this.injector },
    );
  }
  async viewRoom(warning: RoomWarning): Promise<void> {
    this.closeAll();
    this.hotels.select(warning.hotel.id);
    await this.router.navigate(['/network'], {
      queryParams: { view: 'rooms', room: warning.room.id },
    });
    afterNextRender(() => document.getElementById('room-search')?.focus(), {
      injector: this.injector,
    });
  }
  async openRoomPrices(item: UpcomingHotelEvent): Promise<void> {
    const hotelId = this.mapHotelId() ?? item.impacts[0]?.hotelId;
    this.closeAll();
    if (hotelId) this.hotels.select(hotelId);
    await this.router.navigate(['/network'], {
      queryParams: {
        view: 'rooms',
        section: 'prices',
        event: item.event.id,
        from: item.event.startDate < this.asOf ? this.asOf : item.event.startDate,
        through: item.event.endDate,
      },
    });
    afterNextRender(() => document.getElementById('room-prices-title')?.focus(), {
      injector: this.injector,
    });
  }
  askForEventPrices(item: UpcomingHotelEvent): void {
    const targets = this.pricingTargets();
    if (!targets.length || this.pricingAssistantBusy()) return;
    const startDate = item.event.startDate < this.asOf ? this.asOf : item.event.startDate;
    if (startDate > item.event.endDate) return;
    const prompt = eventPricingPrompt({
      eventName: item.event.name,
      hotelNames: targets.map((impact) => impact.hotel.name),
      startDate,
      endDate: item.event.endDate,
    });
    const trigger = this.eventsButton()?.nativeElement;
    this.closeAll();
    afterNextRender(
      () => {
        trigger?.focus({ preventScroll: true });
        void this.assistant.ask(prompt, { kind: 'event', label: 'Event pricing' });
      },
      { injector: this.injector },
    );
  }
  assessment(impact: EventHotelImpact): string {
    const reason = impact.reason.charAt(0).toLowerCase() + impact.reason.slice(1);
    const lead =
      impact.importance === 'important'
        ? 'We think this event is important'
        : impact.importance === 'medium'
          ? 'We think this event could increase demand'
          : 'We think this event has a limited impact';
    const startsWithPlace = /^(Brussels|Amsterdam|Berlin|Porto)/.test(impact.reason);
    return `${lead} because ${startsWithPlace ? impact.reason : reason}`;
  }
  roomType(id: string): string {
    return this.notifications.roomTypeNames()[id] ?? 'Room';
  }
  label(value: string): string {
    return value.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase());
  }
  date(value: string): string {
    return fullDate.format(new Date(`${value}T12:00:00Z`));
  }
  dateRange(start: string, end: string, compact = false): string {
    if (start === end)
      return compact ? shortDate.format(new Date(`${start}T12:00:00Z`)) : this.date(start);
    const from = new Date(`${start}T12:00:00Z`);
    const to = new Date(`${end}T12:00:00Z`);
    const endLabel = (compact ? shortDate : fullDate).format(to);
    return start.slice(0, 7) === end.slice(0, 7)
      ? `${from.getUTCDate()}–${endLabel}`
      : `${shortDate.format(from)}–${endLabel}`;
  }
  isOngoing(start: string, end: string): boolean {
    return start <= this.asOf && end >= this.asOf;
  }
  count(value: number): string {
    return number.format(value);
  }
  distance(value: number): string {
    return `${distance.format(value)} km`;
  }
  private openDetail(detail: Detail, opener?: HTMLButtonElement): void {
    this.assistant.close();
    this.active.set(null);
    this.opener = opener ?? null;
    this.detail.set(detail);
    this.opened.emit();
    afterNextRender(
      () => {
        if (this.detail() !== detail) return;
        const dialog = this.detailDialog()?.nativeElement;
        if (dialog && !dialog.open) {
          dialog.showModal();
          dialog.scrollTop = 0;
        }
      },
      { injector: this.injector },
    );
  }
}
