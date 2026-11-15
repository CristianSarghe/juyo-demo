import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hotel, secondHotel } from '../../../testing/fixtures';
import type { Hotel } from '../network.models';
import { NetworkApiService } from './network-api.service';
import { ResourceQueryStore } from './resource-query.store';

describe('ResourceQueryStore', () => {
  let store: ResourceQueryStore;
  let api: { list: ReturnType<typeof vi.fn>; roomChanges: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    api = { list: vi.fn(), roomChanges: vi.fn().mockReturnValue(of([])) };
    TestBed.configureTestingModule({ providers: [{ provide: NetworkApiService, useValue: api }] });
    store = TestBed.inject(ResourceQueryStore);
  });
  afterEach(() => vi.useRealTimers());

  it('shares a pending request and reuses its cached result regardless of query key order', () => {
    const response = new Subject<Hotel[]>();
    api.list.mockReturnValue(response);
    const first = vi.fn();
    const second = vi.fn();
    store.list('hotels', { hotelId: hotel.id, active: true }).subscribe(first);
    store.list('hotels', { active: true, hotelId: hotel.id }).subscribe(second);
    expect(api.list).toHaveBeenCalledTimes(1);

    response.next([hotel]);
    response.complete();
    expect(first).toHaveBeenCalledExactlyOnceWith([hotel]);
    expect(second).toHaveBeenCalledExactlyOnceWith([hotel]);
    store.list('hotels', { hotelId: hotel.id, active: true }).subscribe(first);
    expect(first).toHaveBeenLastCalledWith([hotel]);
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it('keeps hotel scopes separate and refreshes expired reads', () => {
    vi.useFakeTimers();
    api.list
      .mockReturnValueOnce(of([hotel]))
      .mockReturnValueOnce(of([secondHotel]))
      .mockReturnValue(of([hotel]));
    store.list('hotels', { hotelId: hotel.id }).subscribe();
    store.list('hotels', { hotelId: secondHotel.id }).subscribe();
    expect(api.list).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(60_001);
    store.list('hotels', { hotelId: hotel.id }).subscribe();
    expect(api.list).toHaveBeenCalledTimes(3);
  });

  it('invalidates room changes separately and clears remaining reads at the session boundary', () => {
    api.list.mockReturnValue(of([hotel]));
    store.list('hotels').subscribe();
    store.roomChanges().subscribe();
    store.invalidateRoomChanges();
    store.roomChanges().subscribe();
    store.list('hotels').subscribe();
    expect(api.roomChanges).toHaveBeenCalledTimes(2);
    expect(api.list).toHaveBeenCalledTimes(1);

    store.clear();
    store.list('hotels').subscribe();
    expect(api.list).toHaveBeenCalledTimes(2);
  });
});
