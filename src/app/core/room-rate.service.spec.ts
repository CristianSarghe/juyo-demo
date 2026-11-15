import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hotel, referenceData } from '../../testing/fixtures';
import { roomNetwork, roomType } from '../../testing/room-fixtures';
import { ApiClient } from './api/api-client.service';
import { NetworkDataStore } from './api/network-data.store';
import type { ManagedRoom, RoomRateChange, RoomRateUpdateRequest } from './api/mutation.models';
import { RoomOperationsService } from './room-operations.service';
import { RoomRateService } from './room-rate.service';

describe('RoomRateService', () => {
  let service: RoomRateService;
  let data: ReturnType<typeof roomNetwork>;
  let api: { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> };
  const range = { startDate: '2026-11-14', endDate: '2026-11-16' };
  const change = (values: Partial<RoomRateChange> = {}): RoomRateChange => ({
    id: 'confirmed-rate',
    hotelId: hotel.id,
    roomTypeId: roomType.id,
    ...range,
    nightlyRate: 180,
    appliedAt: '2026-11-14T10:00:00Z',
    ...values,
  });
  const rows = () => service.rows(hotel.id, roomType.id, range);

  beforeEach(() => {
    data = roomNetwork();
    api = { get: vi.fn(() => of([])), post: vi.fn() };
    const operations = {
      rooms: vi.fn((hotelId: string, date = referenceData.bookingSnapshot.asOf): ManagedRoom[] =>
        data.rooms
          .filter((room) => room.hotelId === hotelId)
          .map((room) => ({
            ...room,
            date,
            status: room.number === '103' ? 'reserved' : room.occupancy,
            hasChanges: room.number === '103',
          })),
      ),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiClient, useValue: api },
        { provide: NetworkDataStore, useValue: { data, dates: referenceData.dates } },
        { provide: RoomOperationsService, useValue: operations },
      ],
    });
    service = TestBed.inject(RoomRateService);
  });

  it('loads confirmed rate history once and reports inclusive daily rates with actual availability', async () => {
    api.get.mockReturnValue(of([change({ startDate: '2026-11-15', endDate: '2026-11-15' })]));

    await service.initialize();
    await service.initialize();

    expect(api.get).toHaveBeenCalledExactlyOnceWith('/rate-updates');
    expect(rows().map((row) => [row.date, row.nightlyRate, row.updated])).toEqual([
      ['2026-11-14', 150, false],
      ['2026-11-15', 180, true],
      ['2026-11-16', 160, false],
    ]);
    expect(rows()[0]).toMatchObject({
      availableRooms: 1,
      bookedRooms: 1,
      heldRooms: 1,
      sellableRooms: 3,
    });
  });

  it('publishes a price update only after the API confirms it and preserves the original quotes', async () => {
    await service.initialize();
    const confirmation = new Subject<RoomRateChange>();
    api.post.mockReturnValue(confirmation);
    const request: RoomRateUpdateRequest = {
      hotelId: hotel.id,
      roomTypeId: roomType.id,
      ...range,
      nightlyRate: 210,
      reason: 'Manual November rate review',
    };

    const pending = service.update(request);
    await Promise.resolve();

    expect(api.post).toHaveBeenCalledWith('/rate-updates', request);
    expect(service.pending()).toBe(true);
    expect(service.changes()).toEqual([]);
    expect(rows().map((row) => row.nightlyRate)).toEqual([150, 155, 160]);

    const confirmed = change({ ...request, id: 'server-rate-42' });
    confirmation.next(confirmed);
    confirmation.complete();

    expect(await pending).toBe(true);
    expect(service.pending()).toBe(false);
    expect(service.changes()).toEqual([confirmed]);
    expect(rows().map((row) => row.nightlyRate)).toEqual([210, 210, 210]);
    expect(rows().map((row) => row.seedRate)).toEqual([150, 155, 160]);
    expect(
      data.roomRates.filter((rate) => rate.date >= range.startDate).map((rate) => rate.nightlyRate),
    ).toEqual([150, 155, 160]);
  });

  it('uses the latest confirmed update on overlapping dates without changing other days', async () => {
    api.get.mockReturnValue(
      of([
        change({ id: 'earlier-update', nightlyRate: 180 }),
        change({
          id: 'later-update',
          startDate: '2026-11-15',
          nightlyRate: 195,
          appliedAt: '2026-11-14T11:00:00Z',
        }),
      ]),
    );

    await service.initialize();

    expect(rows().map((row) => row.nightlyRate)).toEqual([180, 195, 195]);
    expect(rows().map((row) => row.seedRate)).toEqual([150, 155, 160]);
  });

  it('refreshes externally confirmed prices while keeping published rates until the response arrives', async () => {
    const previous = change({ nightlyRate: 180 });
    api.get.mockReturnValueOnce(of([previous]));
    await service.initialize();
    const confirmation = new Subject<RoomRateChange[]>();
    api.get.mockReturnValueOnce(confirmation);

    const refresh = service.refresh();
    expect(rows().map((row) => row.nightlyRate)).toEqual([180, 180, 180]);

    const latest = change({ id: 'assistant-confirmed-rate', nightlyRate: 205 });
    confirmation.next([previous, latest]);
    confirmation.complete();
    await refresh;

    expect(api.get).toHaveBeenCalledTimes(2);
    expect(service.changes()).toEqual([previous, latest]);
    expect(rows().map((row) => row.nightlyRate)).toEqual([205, 205, 205]);
  });
});
