import { Injectable, computed, inject } from '@angular/core';
import { patchState, signalState } from '@ngrx/signals';
import { firstValueFrom } from 'rxjs';
import { ApiClient } from './api/api-client.service';
import { NetworkDataStore } from './api/network-data.store';
import type { DateRange, HotelId } from './network.models';
import { createNetworkSelectors } from './network.selectors';
import { RoomOperationsService } from './room-operations.service';
import type { RoomRateChange, RoomRateDay, RoomRateUpdateRequest } from './api/mutation.models';
export type { RoomRateChange, RoomRateDay, RoomRateUpdateRequest } from './api/mutation.models';

/** Selling-rate history comes from the API; existing booked prices are independent. */
@Injectable({ providedIn: 'root' })
export class RoomRateService {
  private readonly api = inject(ApiClient);
  private readonly network = inject(NetworkDataStore);
  private readonly operations = inject(RoomOperationsService);
  private readonly selectors = computed(() => createNetworkSelectors(this.network.data));
  private readonly seedRates = computed(
    () =>
      new Map(
        this.network.data.roomRates.map((rate) => [
          `${rate.roomTypeId}/${rate.date}`,
          rate.nightlyRate,
        ]),
      ),
  );
  private readonly state = signalState<{
    changes: readonly RoomRateChange[];
    error: string;
    pending: boolean;
  }>({ changes: [], error: '', pending: false });
  readonly changes = this.state.changes;
  readonly error = this.state.error;
  readonly pending = this.state.pending;
  private initialized = false;
  private generation = 0;
  private loading?: Promise<void>;

  initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    return (this.loading ??= this.load());
  }
  /** Reconcile confirmed assistant changes while preserving the published rates on failure. */
  refresh(): Promise<void> {
    return (this.loading ??= this.load());
  }
  private async load(): Promise<void> {
    const generation = this.generation;
    try {
      const changes = await firstValueFrom(this.api.get<RoomRateChange[]>('/rate-updates'));
      if (generation !== this.generation) return;
      patchState(this.state, { changes, error: '' });
      this.initialized = true;
    } finally {
      if (generation === this.generation) this.loading = undefined;
    }
  }
  rows(hotelId: HotelId, roomTypeId: string, range: DateRange): RoomRateDay[] {
    if (
      !this.network.data.roomTypes.some(
        (type) => type.id === roomTypeId && type.hotelId === hotelId,
      )
    )
      throw new RangeError('Choose a valid hotel and room type.');
    const checked = this.selectors().validateDateRange(range);
    const dates = this.network.dates.filter(
      (date) => date >= checked.startDate && date <= checked.endDate,
    );
    const changes = this.changes().filter(
      (change) => change.hotelId === hotelId && change.roomTypeId === roomTypeId,
    );
    return dates.map((date) => {
      const seedRate = this.seedRates().get(`${roomTypeId}/${date}`);
      if (seedRate === undefined)
        throw new Error(`Missing selling rate for ${roomTypeId}/${date}.`);
      let change: RoomRateChange | undefined;
      for (let index = changes.length - 1; index >= 0; index--) {
        if (changes[index].startDate <= date && changes[index].endDate >= date) {
          change = changes[index];
          break;
        }
      }
      const rooms = this.operations
        .rooms(hotelId, date)
        .filter((room) => room.roomTypeId === roomTypeId);
      return {
        date,
        seedRate,
        nightlyRate: change?.nightlyRate ?? seedRate,
        availableRooms: rooms.filter((room) => room.status === 'available').length,
        sellableRooms: rooms.filter((room) => room.status !== 'out_of_service').length,
        bookedRooms: rooms.filter((room) => room.status === 'occupied').length,
        heldRooms: rooms.filter((room) => room.status === 'reserved').length,
        ...(change?.eventId ? { eventId: change.eventId } : {}),
        ...(change?.reason ? { reason: change.reason } : {}),
        updated: !!change,
      };
    });
  }
  async update(request: RoomRateUpdateRequest): Promise<boolean> {
    if (this.pending()) return false;
    const generation = this.generation;
    patchState(this.state, { pending: true, error: '' });
    try {
      await this.initialize();
      if (generation !== this.generation) return false;
      const change = await firstValueFrom(this.api.post<RoomRateChange>('/rate-updates', request));
      if (generation !== this.generation) return false;
      patchState(this.state, { changes: [...this.changes(), change] });
      return true;
    } catch (error) {
      if (generation === this.generation)
        patchState(this.state, {
          error: error instanceof Error ? error.message : 'Could not update room rates. Try again.',
        });
      return false;
    } finally {
      if (generation === this.generation) patchState(this.state, { pending: false });
    }
  }
  clear(): void {
    this.generation++;
    this.initialized = false;
    this.loading = undefined;
    patchState(this.state, { changes: [], error: '', pending: false });
  }
}
