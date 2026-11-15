import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyNetworkData, hotel, referenceData } from '../../../testing/fixtures';
import type { DailyRoomState, DateRange, HotelNetwork, Room, RoomType } from '../network.models';
import type { BookingRateHistoryDay } from '../room-price-history';
import type { ApiQuery, CollectionKey } from './api.models';
import { NetworkDataStore } from './network-data.store';
import { ReferenceDataService } from './reference-data.service';
import { ResourceQueryStore } from './resource-query.store';

const classic: RoomType = {
  id: 'berlin-classic',
  hotelId: hotel.id,
  name: 'Classic',
  inventory: 2,
  maxAdults: 2,
  maxChildren: 0,
  areaM2: 20,
  baseRate: 150,
  facilities: [],
};
const suite: RoomType = { ...classic, id: 'berlin-suite', name: 'Suite', baseRate: 220 };
const room: Room = {
  id: 'berlin-101',
  hotelId: hotel.id,
  roomTypeId: classic.id,
  number: '101',
  floor: 1,
  occupancy: 'available',
  housekeeping: 'clean',
  maintenance: 'none',
  maintenanceNote: null,
  date: referenceData.bookingSnapshot.asOf,
  basis: 'scheduled',
};
const stateFor = (room: Room): DailyRoomState => ({
  roomId: room.id,
  hotelId: room.hotelId,
  date: room.date,
  occupancy: room.occupancy,
  housekeeping: room.housekeeping,
  maintenance: room.maintenance,
  maintenanceNote: room.maintenanceNote,
  basis: room.basis,
});

describe('NetworkDataStore page loading', () => {
  let store: NetworkDataStore;
  let data: HotelNetwork;
  let history: BookingRateHistoryDay[];
  let queries: {
    list: ReturnType<typeof vi.fn>;
    priceHistory: ReturnType<typeof vi.fn>;
  };
  let reference: {
    data: typeof referenceData;
    load: ReturnType<typeof vi.fn>;
    validateDateRange: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    data = emptyNetworkData();
    history = [];
    queries = {
      list: vi.fn((collection: CollectionKey, query: ApiQuery = {}) => {
        if (collection === 'rooms' && query.roomTypeId)
          return of(data.rooms.filter((value) => value.roomTypeId === query.roomTypeId));
        if (collection === 'roomRates' && query.roomTypeId)
          return of(data.roomRates.filter((value) => value.roomTypeId === query.roomTypeId));
        return of(data[collection]);
      }),
      priceHistory: vi.fn(() => of(history)),
    };
    reference = {
      data: referenceData,
      load: vi.fn(async () => {}),
      validateDateRange: vi.fn((range: DateRange) => ({ ...range })),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: ResourceQueryStore, useValue: queries },
        { provide: ReferenceDataService, useValue: reference },
      ],
    });
    store = TestBed.inject(NetworkDataStore);
  });

  it('loads only reference metadata while rooms or configuration awaits a hotel selection', async () => {
    for (const view of ['rooms', 'configuration'] as const) {
      await store.load({
        view,
        scope: 'portfolio',
        range: { startDate: '2026-11-14', endDate: '2026-11-20' },
      });
      expect(store.data).toEqual(emptyNetworkData());
      expect(store.dates).toEqual(referenceData.dates);
      expect(store.loading()).toBe(false);
    }
    expect(reference.load).toHaveBeenCalled();
    expect(queries.list).not.toHaveBeenCalled();
    expect(queries.priceHistory).not.toHaveBeenCalled();
  });

  it('loads the selected hotel inventory for the business date independently of analytics dates', async () => {
    data.roomTypes = [classic];
    data.rooms = [room];
    data.dailyRoomStates = [stateFor(room)];
    data.roomRates = [
      {
        hotelId: hotel.id,
        roomTypeId: classic.id,
        date: referenceData.bookingSnapshot.asOf,
        nightlyRate: 165,
        currency: 'EUR',
      },
    ];
    await store.load({
      view: 'rooms',
      section: 'inventory',
      scope: hotel.id,
      range: { startDate: '2026-12-10', endDate: '2026-12-13' },
    });

    const current = {
      hotelId: hotel.id,
      from: referenceData.bookingSnapshot.asOf,
      to: referenceData.bookingSnapshot.asOf,
    };
    expect(queries.list).toHaveBeenCalledWith('roomTypes', { hotelId: hotel.id });
    expect(queries.list).toHaveBeenCalledWith('rooms', { hotelId: hotel.id });
    expect(queries.list).toHaveBeenCalledWith('dailyRoomStates', current);
    expect(queries.list).toHaveBeenCalledWith('roomRates', { ...current, basis: 'canonical' });
    expect(queries.list).toHaveBeenCalledTimes(4);
    expect(store.data.rooms).toEqual([room]);
    expect(store.data.dailyRoomStates).toEqual(data.dailyRoomStates);
    expect(store.data.roomRates).toEqual(data.roomRates);
    expect(store.data.reservations).toEqual([]);
    expect(store.loading()).toBe(false);
  });

  it('loads the selected type and booked price history over the full enclosing months', async () => {
    const selectedRoom: Room = { ...room, id: 'berlin-201', number: '201', roomTypeId: suite.id };
    data.roomTypes = [classic, suite];
    data.rooms = [room, selectedRoom];
    data.dailyRoomStates = [stateFor(room), stateFor(selectedRoom)];
    history = [
      {
        date: '2026-11-29',
        weightedRate: 225,
        bookedRoomNights: 2,
        bookedRevenue: 450,
        rateCount: 1,
        priceBuckets: [{ nightlyRate: 225, roomNights: 2 }],
      },
    ];

    await store.load({
      view: 'rooms',
      section: 'prices',
      scope: hotel.id,
      roomTypeId: suite.id,
      range: { startDate: '2026-11-28', endDate: '2026-12-02' },
    });

    const months = { startDate: '2026-11-01', endDate: '2026-12-31' };
    const scope = { hotelId: hotel.id, from: months.startDate, to: months.endDate };
    expect(queries.list).toHaveBeenCalledWith('rooms', { hotelId: hotel.id, roomTypeId: suite.id });
    expect(queries.list).toHaveBeenCalledWith('dailyRoomStates', scope);
    expect(queries.list).toHaveBeenCalledWith('roomRates', {
      ...scope,
      roomTypeId: suite.id,
      basis: 'canonical',
    });
    expect(queries.priceHistory).toHaveBeenCalledWith(suite.id, months);
    expect(store.resolvedRoomTypeId()).toBe(suite.id);
    expect(store.data.rooms).toEqual([selectedRoom]);
    expect(store.data.dailyRoomStates.map((state) => state.roomId)).toEqual([selectedRoom.id]);
    expect(store.getPriceHistory(hotel.id, suite.id)).toEqual(history);
    expect(store.loading()).toBe(false);
  });
});
