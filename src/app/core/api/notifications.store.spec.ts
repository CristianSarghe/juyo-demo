import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hotel, referenceData, secondHotel } from '../../../testing/fixtures';
import { roomNetwork } from '../../../testing/room-fixtures';
import type { RoomWarning, UpcomingHotelEvent } from '../network.models';
import { RoomOperationsService } from '../room-operations.service';
import { RoomRateService } from '../room-rate.service';
import { ApiClient } from './api-client.service';
import { NetworkApiService } from './network-api.service';
import { NotificationsStore } from './notifications.store';
import { ReferenceDataService } from './reference-data.service';

describe('NotificationsStore', () => {
  let store: NotificationsStore;
  let listAll: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    listAll = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiClient, useValue: { listAll } },
        { provide: NetworkApiService, useValue: {} },
        { provide: ReferenceDataService, useValue: { data: referenceData } },
        { provide: RoomOperationsService, useValue: { changes: signal([]) } },
        { provide: RoomRateService, useValue: { changes: signal([]) } },
      ],
    });
    store = TestBed.inject(NotificationsStore);
  });

  it('loads warnings once for the business date and filters the shared list by hotel', async () => {
    const warnings: RoomWarning[] = [
      { room: roomNetwork().rooms[3], hotel },
      { room: { ...roomNetwork().rooms[4], occupancy: 'out_of_service' }, hotel: secondHotel },
    ];
    const response = new Subject<RoomWarning[]>();
    listAll.mockReturnValue(response);
    const load = store.loadWarnings();
    expect(store.loadWarnings()).toBe(load);
    expect(store.warningsLoading()).toBe(true);

    response.next(warnings);
    response.complete();
    await load;
    await store.loadWarnings();

    expect(listAll).toHaveBeenCalledExactlyOnceWith('/warnings', { date: '2026-11-14' });
    expect(store.warningsFor(hotel.id)).toEqual([warnings[0]]);
    expect(store.warningsFor('portfolio')).toEqual(warnings);
    expect(store.warningsLoading()).toBe(false);
    expect(store.warningsError()).toBe('');
  });

  it('shows only relevant event impacts and uses their local importance', async () => {
    const event: UpcomingHotelEvent = {
      event: {
        id: 'test-fair',
        name: 'Travel fair',
        category: 'trade_fair',
        startDate: '2026-11-20',
        endDate: '2026-11-22',
        venue: 'Demo hall',
        city: 'Berlin',
        country: 'Germany',
        coordinates: hotel.coordinates,
        expectedAttendance: 5000,
      },
      importance: 'important',
      impacts: [
        {
          eventId: 'test-fair',
          hotelId: hotel.id,
          hotel,
          importance: 'important',
          distanceKm: 2,
          reason: 'Nearby venue',
          source: 'fixture',
          assessedAt: '2026-11-14',
        },
        {
          eventId: 'test-fair',
          hotelId: secondHotel.id,
          hotel: secondHotel,
          importance: 'mild',
          distanceKm: 600,
          reason: 'Limited local impact',
          source: 'fixture',
          assessedAt: '2026-11-14',
        },
      ],
    };
    listAll.mockReturnValue(of([event]));
    await store.loadEvents();

    expect(listAll).toHaveBeenCalledExactlyOnceWith('/events/upcoming', { date: '2026-11-14' });
    expect(store.eventsFor(secondHotel.id)).toEqual([
      { ...event, importance: 'mild', impacts: [event.impacts[1]] },
    ]);
    expect(store.eventsFor('portfolio')).toEqual([event]);
    expect(store.eventsFor('another-hotel')).toEqual([]);
  });

  it('treats empty lists as loaded and reloads after clearing the session', async () => {
    listAll.mockReturnValue(of([]));
    await Promise.all([store.loadWarnings(), store.loadEvents()]);
    await Promise.all([store.loadWarnings(), store.loadEvents()]);
    expect(listAll).toHaveBeenCalledTimes(2);
    expect(store.warnings()).toEqual([]);
    expect(store.events()).toEqual([]);
    expect(store.warningsError()).toBe('');
    expect(store.eventsError()).toBe('');

    store.clear();
    expect(store.warnings()).toBeNull();
    expect(store.events()).toBeNull();
    await Promise.all([store.loadWarnings(), store.loadEvents()]);
    expect(listAll).toHaveBeenCalledTimes(4);
  });
});
