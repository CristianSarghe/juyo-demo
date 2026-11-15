import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hotel, referenceData } from '../../testing/fixtures';
import { roomNetwork } from '../../testing/room-fixtures';
import { ApiClient } from './api/api-client.service';
import { NetworkDataStore } from './api/network-data.store';
import type { RoomOperationChange } from './api/mutation.models';
import { RoomOperationsService } from './room-operations.service';

describe('RoomOperationsService', () => {
  let service: RoomOperationsService;
  let data: ReturnType<typeof roomNetwork>;
  let invalidateDayDetails: ReturnType<typeof vi.fn>;
  let api: {
    get: ReturnType<typeof vi.fn>;
    patch: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  const change = (
    roomId: string,
    values: Partial<RoomOperationChange> = {},
  ): RoomOperationChange => ({
    roomId,
    date: referenceData.bookingSnapshot.asOf,
    appliedAt: '2026-11-14T10:00:00Z',
    ...values,
  });

  beforeEach(() => {
    data = roomNetwork();
    invalidateDayDetails = vi.fn();
    api = { get: vi.fn(() => of([])), patch: vi.fn(), delete: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiClient, useValue: api },
        { provide: NetworkDataStore, useValue: { data, invalidateDayDetails } },
      ],
    });
    service = TestBed.inject(RoomOperationsService);
  });

  it('loads confirmed operations once and overlays only the current business date', async () => {
    const hold = change('ber-room-103', { status: 'reserved' });
    api.get.mockReturnValue(of([hold]));

    await service.initialize();
    await service.initialize();

    expect(api.get).toHaveBeenCalledExactlyOnceWith('/room-state-changes');
    expect(service.changes()).toEqual([hold]);
    expect(service.rooms(hotel.id)).toHaveLength(4);
    expect(service.rooms(hotel.id).find((room) => room.id === hold.roomId)?.status).toBe(
      'reserved',
    );
    expect(
      service.rooms(hotel.id, '2026-11-13').find((room) => room.id === hold.roomId)?.status,
    ).toBe('available');
  });

  it('marks a room clean after API confirmation and refreshes daily facts', async () => {
    await service.initialize();
    const confirmation = new Subject<RoomOperationChange[]>();
    api.patch.mockReturnValue(confirmation);

    const pending = service.update('ber-room-101', 'clean');
    await Promise.resolve();

    expect(service.pending()).toBe(true);
    expect(service.rooms(hotel.id).find((room) => room.number === '101')?.housekeeping).toBe(
      'dirty',
    );
    expect(api.patch).toHaveBeenCalledWith('/rooms/ber-room-101/state', { action: 'clean' });

    confirmation.next([change('ber-room-101', { housekeeping: 'clean' })]);
    confirmation.complete();

    expect(await pending).toBe(true);
    expect(service.pending()).toBe(false);
    expect(service.rooms(hotel.id).find((room) => room.number === '101')).toMatchObject({
      housekeeping: 'clean',
      hasChanges: true,
    });
    expect(invalidateDayDetails).toHaveBeenCalledOnce();
    expect(data.rooms.find((room) => room.number === '101')?.housekeeping).toBe('dirty');
  });

  it('returns a repaired room to service and clears its previous maintenance block', async () => {
    api.patch.mockReturnValue(of([change('ber-room-104', { status: 'available' })]));

    expect(await service.update('ber-room-104', 'available')).toBe(true);

    expect(service.rooms(hotel.id).find((room) => room.number === '104')).toMatchObject({
      status: 'available',
      maintenance: 'none',
      maintenanceNote: null,
    });
    expect(invalidateDayDetails).toHaveBeenCalledOnce();
  });

  it('resets a manual hold using the confirmed API state and restores the canonical room', async () => {
    api.get.mockReturnValue(of([change('ber-room-103', { status: 'reserved' })]));
    api.delete.mockReturnValue(of([]));
    await service.initialize();

    expect(await service.update('ber-room-103', 'reset')).toBe(true);

    expect(api.delete).toHaveBeenCalledExactlyOnceWith('/rooms/ber-room-103/state');
    expect(service.changes()).toEqual([]);
    expect(service.rooms(hotel.id).find((room) => room.number === '103')).toMatchObject({
      status: 'available',
      hasChanges: false,
    });
    expect(invalidateDayDetails).toHaveBeenCalledOnce();
  });
});
