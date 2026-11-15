import { Injectable, inject } from '@angular/core';
import { patchState, signalState } from '@ngrx/signals';
import { defer, finalize, of, shareReplay, Subject, takeUntil, tap, type Observable } from 'rxjs';
import type { ApiQuery, CollectionItem, CollectionKey } from './api.models';
import { NetworkApiService } from './network-api.service';
import type { DateRange } from '../network.models';
import type { BookingRateHistoryDay } from '../room-price-history';
import type { RoomOperationChange } from './mutation.models';

interface QueryEntry {
  readonly value: unknown;
  readonly expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
const MAX_ENTRIES = 48;

function queryKey(resource: string, query: ApiQuery): string {
  const filters = Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([resource, filters]);
}

/** Session-only, bounded NgRx cache. Shared reads coalesce; abandoned reads unsubscribe. */
@Injectable({ providedIn: 'root' })
export class ResourceQueryStore {
  private readonly api = inject(NetworkApiService);
  private readonly state = signalState<{ entries: Readonly<Record<string, QueryEntry>> }>({
    entries: {},
  });
  private readonly pending = new Map<
    string,
    { stream: Observable<unknown>; cancel: Subject<void> }
  >();
  private readonly reset = new Subject<void>();
  private generation = 0;

  list<K extends CollectionKey>(
    collection: K,
    query: ApiQuery = {},
  ): Observable<CollectionItem<K>[]> {
    return this.read(queryKey(collection, query), () => this.api.list(collection, query));
  }

  priceHistory(roomTypeId: string, range: DateRange): Observable<BookingRateHistoryDay[]> {
    return this.read(
      queryKey(`price-history/${roomTypeId}`, { from: range.startDate, to: range.endDate }),
      () => this.api.priceHistory(roomTypeId, range),
    );
  }

  roomChanges(): Observable<RoomOperationChange[]> {
    return this.read(queryKey('room-state-changes', {}), () => this.api.roomChanges());
  }

  invalidateRoomChanges(): void {
    const matches = (key: string) => JSON.parse(key)[0] === 'room-state-changes';
    for (const [key, entry] of this.pending) {
      if (!matches(key)) continue;
      entry.cancel.next();
      this.pending.delete(key);
    }
    patchState(this.state, {
      entries: Object.fromEntries(
        Object.entries(this.state.entries()).filter(([key]) => !matches(key)),
      ),
    });
  }

  clear(): void {
    this.generation++;
    this.reset.next();
    this.pending.clear();
    patchState(this.state, { entries: {} });
  }

  private read<T>(key: string, request: () => Observable<T>): Observable<T> {
    return defer(() => {
      const now = Date.now();
      const current = this.state.entries();
      const entries = Object.fromEntries(
        Object.entries(current).filter(([, entry]) => entry.expiresAt > now),
      );
      if (Object.keys(entries).length !== Object.keys(current).length)
        patchState(this.state, { entries });
      const cached = entries[key];
      if (cached) return of(cached.value as T);
      const pending = this.pending.get(key);
      if (pending) return pending.stream as Observable<T>;
      const generation = this.generation;
      const cancel = new Subject<void>();
      const shared = request().pipe(
        takeUntil(this.reset),
        takeUntil(cancel),
        tap((value) => {
          if (generation !== this.generation) return;
          const entries = {
            ...this.state.entries(),
            [key]: { value, expiresAt: Date.now() + CACHE_TTL_MS },
          };
          const oldest = Object.keys(entries).sort(
            (left, right) => entries[left].expiresAt - entries[right].expiresAt,
          );
          while (oldest.length > MAX_ENTRIES) delete entries[oldest.shift()!];
          patchState(this.state, { entries });
        }),
        finalize(() => {
          if (this.pending.get(key)?.stream === shared) this.pending.delete(key);
        }),
        shareReplay({ bufferSize: 1, refCount: true }),
      );
      this.pending.set(key, { stream: shared, cancel });
      return shared;
    });
  }
}
