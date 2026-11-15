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
  signal,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { NetworkService } from '../../core/network.service';
import { HotelScopeService } from '../../core/hotel-scope.service';
import {
  RoomOperationsService,
  type ManagedRoom,
  type ManagedRoomStatus,
  type RoomOperationAction,
} from '../../core/room-operations.service';
import { ENUM_OPTIONS, type HousekeepingState } from '../../core/network.models';
import { AppSelectComponent } from '../../shared/select.component';
import {
  RoomOperationsSummaryComponent,
  type RoomQueue,
} from '../../shared/room-operations-summary.component';
import { RoomActionsComponent } from '../../shared/room-actions.component';
import { AssistantUiStore } from '../../core/assistant-ui.store';
import { RoomRateService } from '../../core/room-rate.service';
import { repairHelpPrompt } from '../../core/repair-assistance';
import { KassandraNoteComponent } from '../../shared/kassandra-note.component';
import { NetworkComponent } from './network.component';

const euro = new Intl.NumberFormat('en-IE', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 0,
});

@Component({
  selector: 'app-room-inventory',
  imports: [
    FormsModule,
    KassandraNoteComponent,
    AppSelectComponent,
    RoomOperationsSummaryComponent,
    RoomActionsComponent,
  ],
  templateUrl: './room-inventory.component.html',
  styleUrl: './room-inventory.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RoomInventoryComponent {
  readonly workspace = inject(NetworkComponent);
  private readonly network = inject(NetworkService);
  private readonly hotelScope = inject(HotelScopeService);
  private readonly roomOperations = inject(RoomOperationsService);
  private readonly rates = inject(RoomRateService);
  private readonly assistant = inject(AssistantUiStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly route = inject(ActivatedRoute);
  private readonly query = toSignal(this.route.queryParamMap);
  private readonly router = inject(Router);
  readonly scope = this.hotelScope.scope;
  readonly managementDate = this.network.bookingSnapshot.asOf;
  readonly selectedHotel = this.workspace.selectedHotel;
  readonly occupancyOptions = [
    { value: 'all', label: 'All room states' },
    ...ENUM_OPTIONS.roomOccupancy.map((value) => ({ value, label: this.label(value) })),
    { value: 'reserved', label: 'Reserved manually' },
  ];
  readonly housekeepingOptions = [
    { value: 'all', label: 'All housekeeping' },
    ...ENUM_OPTIONS.housekeeping.map((value) => ({ value, label: this.label(value) })),
  ];
  readonly occupancy = signal<ManagedRoomStatus | 'all'>('all');
  readonly housekeeping = signal<HousekeepingState | 'all'>('all');
  readonly roomSearch = signal('');
  readonly roomPage = signal(0);
  readonly roomFeedback = signal('');
  readonly roomActionError = signal('');
  readonly roomSavingId = signal<string | null>(null);
  readonly pageSize = 12;
  readonly rooms = computed(() => this.network.hotelInventory(this.scope(), this.managementDate));
  readonly roomCounts = computed(() => {
    const rooms = this.rooms();
    return {
      available: rooms.filter((room) => room.status === 'available').length,
      dirty: rooms.filter((room) => room.housekeeping === 'dirty').length,
      outOfService: rooms.filter((room) => room.status === 'out_of_service').length,
      reserved: rooms.filter((room) => room.status === 'reserved').length,
    };
  });
  readonly outOfServiceRooms = computed(() =>
    this.rooms().filter((room) => room.status === 'out_of_service'),
  );
  readonly repairImpact = computed(() => {
    const rooms = this.outOfServiceRooms();
    if (!rooms.length || !this.selectedHotel()) return null;
    const currentRates = new Map<string, number>();
    for (const room of rooms) {
      if (currentRates.has(room.roomTypeId)) continue;
      const day = this.rates.rows(room.hotelId, room.roomTypeId, {
        startDate: this.managementDate,
        endDate: this.managementDate,
      })[0];
      currentRates.set(room.roomTypeId, day.nightlyRate);
    }
    return {
      rooms: rooms.length,
      nightlyRevenue: rooms.reduce((sum, room) => sum + currentRates.get(room.roomTypeId)!, 0),
    };
  });
  readonly activeRoomQueue = computed<RoomQueue | null>(() => {
    if (this.roomSearch().trim()) return null;
    if (this.occupancy() === 'all' && this.housekeeping() === 'dirty') return 'dirty';
    if (this.housekeeping() !== 'all') return null;
    const state = this.occupancy();
    return state === 'available' || state === 'out_of_service' || state === 'reserved'
      ? state
      : null;
  });
  readonly filteredRooms = computed(() =>
    this.rooms().filter(
      (room) =>
        (this.occupancy() === 'all' || room.status === this.occupancy()) &&
        (this.housekeeping() === 'all' || room.housekeeping === this.housekeeping()) &&
        (!this.roomSearch().trim() ||
          `${room.number} ${this.hotelName(room.hotelId)} ${this.roomTypeName(room.roomTypeId)}`
            .toLowerCase()
            .includes(this.roomSearch().trim().toLowerCase())),
    ),
  );
  readonly roomPageCount = computed(() =>
    Math.max(1, Math.ceil(this.filteredRooms().length / this.pageSize)),
  );
  readonly pageRooms = computed(() =>
    this.filteredRooms().slice(
      this.roomPage() * this.pageSize,
      (this.roomPage() + 1) * this.pageSize,
    ),
  );
  constructor() {
    effect(() => {
      this.scope();
      this.resetRooms();
      this.roomFeedback.set('');
      this.roomActionError.set('');
    });
    effect(() => {
      const requestedRoom = this.query()?.get('room');
      if (
        !requestedRoom ||
        !this.workspace.pageReady() ||
        this.workspace.view() !== 'rooms' ||
        this.workspace.roomSection() !== 'inventory'
      )
        return;
      const room = this.network.data.rooms.find((candidate) => candidate.id === requestedRoom);
      if (!room) return;
      this.hotelScope.select(room.hotelId);
      this.roomSearch.set(room.number);
      this.occupancy.set('all');
      this.housekeeping.set('all');
      this.resetRooms();
      const url = this.router.parseUrl(this.router.url);
      delete url.queryParams['room'];
      void this.router.navigateByUrl(url, { replaceUrl: true });
      afterNextRender(() => this.focusRoomHeading(), { injector: this.injector });
    });
  }

  helpFixRooms(): void {
    const hotel = this.selectedHotel();
    if (!hotel || !this.outOfServiceRooms().length) return;
    const prompt = repairHelpPrompt(
      this.outOfServiceRooms().map((room) => ({
        hotelId: hotel.id,
        hotelName: hotel.name,
        city: hotel.city,
        country: hotel.country,
        roomNumber: room.number,
        issue: room.maintenanceNote || 'Technical issue; maintenance details need confirmation.',
      })),
    );
    this.assistant.open({ kind: 'warning', label: 'Repairs' });
    this.assistant.setDraft(prompt);
  }
  resetRooms(): void {
    this.roomPage.set(0);
  }
  setRoomState(value: string): void {
    if (!this.occupancyOptions.some((option) => option.value === value)) return;
    this.occupancy.set(value as ManagedRoomStatus | 'all');
    this.resetRooms();
  }
  setHousekeeping(value: string): void {
    this.housekeeping.set(value as HousekeepingState | 'all');
    this.resetRooms();
  }
  clearRoomFilters(): void {
    this.occupancy.set('all');
    this.housekeeping.set('all');
    this.roomSearch.set('');
    this.resetRooms();
  }
  showRoomQueue(queue: RoomQueue): void {
    const clear = this.activeRoomQueue() === queue;
    this.clearRoomFilters();
    if (!clear) {
      if (queue === 'dirty') this.housekeeping.set('dirty');
      else this.occupancy.set(queue);
    }
    afterNextRender(() => this.focusRoomHeading(), { injector: this.injector });
  }
  async manageRoom(room: ManagedRoom, action: RoomOperationAction): Promise<void> {
    if (this.roomSavingId()) return;
    const context = this.scope();
    this.roomSavingId.set(room.id);
    this.roomFeedback.set('');
    this.roomActionError.set('');
    let saved = false;
    try {
      saved = await this.roomOperations.update(room.id, action);
    } catch {
      if (!this.destroyRef.destroyed && context === this.scope())
        this.roomActionError.set('Could not update this room. Try again.');
      return;
    } finally {
      this.roomSavingId.set(null);
    }
    if (this.destroyRef.destroyed || context !== this.scope()) return;
    if (!saved) {
      this.roomActionError.set(this.roomOperations.error());
      return;
    }
    const descriptions: Record<RoomOperationAction, string> = {
      clean: 'marked clean',
      dirty: 'marked dirty',
      reserve: 'reserved manually',
      out_of_service: 'marked out of service',
      available: 'made available',
      reset: 'reset to its original state',
    };
    this.roomFeedback.set(
      `${this.city(room.hotelId)} · Room ${room.number} ${descriptions[action]}.`,
    );
    this.roomPage.update((page) => Math.min(page, this.roomPageCount() - 1));
    afterNextRender(
      () => {
        const button = this.host.nativeElement.querySelector<HTMLButtonElement>(
          `app-room-actions[data-room-id="${room.id}"] button`,
        );
        if (button) button.focus({ preventScroll: true });
        else this.focusRoomHeading();
      },
      { injector: this.injector },
    );
  }
  private focusRoomHeading(): void {
    const heading = this.host.nativeElement.querySelector<HTMLElement>('#room-inventory-title');
    heading?.focus({ preventScroll: true });
    heading?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }
  money(value: number): string {
    return euro.format(value);
  }
  label(value: string): string {
    return value.replace(/_/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
  }
  hotelName(id: string): string {
    return this.network.hotels.find((hotel) => hotel.id === id)?.name ?? id;
  }
  city(id: string): string {
    return this.network.hotels.find((hotel) => hotel.id === id)?.city ?? id;
  }
  roomTypeName(id: string): string {
    return this.network.data.roomTypes.find((type) => type.id === id)?.name ?? id;
  }
  date(value: string): string {
    return new Date(`${value}T12:00:00Z`).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    });
  }
}
