import { Injectable, computed, inject } from '@angular/core';
import { patchState, signalState } from '@ngrx/signals';
import { firstValueFrom } from 'rxjs';
import { ApiClient } from './api/api-client.service';
import { NetworkDataStore } from './api/network-data.store';
import type { PropertyScope } from './network.models';
import { createNetworkSelectors } from './network.selectors';
import { applyRoomChange } from './room-operation-state';
import type { ManagedRoom, RoomOperationAction, RoomOperationChange } from './api/mutation.models';
export type {
  ManagedRoom,
  ManagedRoomStatus,
  RoomOperationAction,
  RoomOperationChange,
} from './api/mutation.models';

/** API-backed operational overlay; accepted reservations remain immutable. */
@Injectable({ providedIn: 'root' })
export class RoomOperationsService {
  private readonly api = inject(ApiClient);
  private readonly network = inject(NetworkDataStore);
  private readonly selectors = computed(() => createNetworkSelectors(this.network.data));
  private readonly state = signalState<{
    changes: readonly RoomOperationChange[];
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
  /** Reconcile changes applied elsewhere without temporarily emptying the room inventory. */
  refresh(): Promise<void> {
    const generation = this.generation;
    return (this.loading ??= this.load()).then(() => {
      if (generation === this.generation) this.network.invalidateDayDetails();
    });
  }
  private async load(): Promise<void> {
    const generation = this.generation;
    try {
      const changes = await firstValueFrom(
        this.api.get<RoomOperationChange[]>('/room-state-changes'),
      );
      if (generation !== this.generation) return;
      patchState(this.state, { changes, error: '' });
      this.initialized = true;
    } finally {
      if (generation === this.generation) this.loading = undefined;
    }
  }
  rooms(
    scope: PropertyScope = 'portfolio',
    date = this.network.data.bookingSnapshot.asOf,
  ): ManagedRoom[] {
    this.selectors().validateDateRange({ startDate: date, endDate: date });
    const rooms = this.selectors().hotelInventory(scope, date);
    if (date !== this.network.data.bookingSnapshot.asOf)
      return rooms.map((room) => applyRoomChange(room));
    const changes = new Map(this.changes().map((change) => [change.roomId, change]));
    return rooms.map((room) => applyRoomChange(room, changes.get(room.id)));
  }
  async update(roomId: string, action: RoomOperationAction): Promise<boolean> {
    if (this.pending()) return false;
    const generation = this.generation;
    patchState(this.state, { pending: true, error: '' });
    try {
      await this.initialize();
      if (generation !== this.generation) return false;
      const path = `/rooms/${encodeURIComponent(roomId)}/state`;
      const changes = await firstValueFrom(
        action === 'reset'
          ? this.api.delete<RoomOperationChange[]>(path)
          : this.api.patch<RoomOperationChange[]>(path, { action }),
      );
      if (generation !== this.generation) return false;
      patchState(this.state, { changes });
      this.network.invalidateDayDetails();
      return true;
    } catch (error) {
      if (generation === this.generation)
        patchState(this.state, {
          error: error instanceof Error ? error.message : 'Could not update the room. Try again.',
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
