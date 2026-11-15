import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, Router } from '@angular/router';
import { BehaviorSubject, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hotel } from '../../../testing/fixtures';
import { roomNetwork, roomType } from '../../../testing/room-fixtures';
import { NetworkDataStore } from '../../core/api/network-data.store';
import { NotificationsStore } from '../../core/api/notifications.store';
import { HotelScopeService } from '../../core/hotel-scope.service';
import { NetworkService } from '../../core/network.service';
import { createNetworkSelectors } from '../../core/network.selectors';
import { RoomRateService, type RoomRateDay } from '../../core/room-rate.service';
import { RoomPricesComponent } from './room-prices.component';

describe('RoomPricesComponent logic', () => {
  let rates: {
    rows: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof signal<string>>;
  };
  let navigate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const data = roomNetwork();
    const days: RoomRateDay[] = ['2026-11-14', '2026-11-15', '2026-11-16'].map((date, index) => ({
      date,
      nightlyRate: index < 2 ? 150 : 160,
      seedRate: index < 2 ? 150 : 160,
      availableRooms: 2,
      sellableRooms: 3,
      bookedRooms: 1,
      heldRooms: 0,
      updated: false,
    }));
    rates = {
      rows: vi.fn().mockReturnValue(days),
      update: vi.fn().mockResolvedValue(true),
      error: signal(''),
    };
    navigate = vi.fn().mockResolvedValue(true);
    const queryParamMap = new BehaviorSubject(
      convertToParamMap({
        type: roomType.id,
        from: '2026-11-14',
        through: '2026-11-16',
      }),
    );
    TestBed.configureTestingModule({
      providers: [
        {
          provide: NetworkService,
          useValue: {
            data,
            hotels: data.hotels,
            periods: data.reportingPeriods,
            bookingSnapshot: data.bookingSnapshot,
            validateDateRange: createNetworkSelectors(data).validateDateRange,
          },
        },
        { provide: HotelScopeService, useValue: { scope: signal(hotel.id) } },
        { provide: RoomRateService, useValue: rates },
        { provide: NetworkDataStore, useValue: { resolvedRoomTypeId: signal(roomType.id) } },
        { provide: NotificationsStore, useValue: { eventsFor: () => [] } },
        { provide: ActivatedRoute, useValue: { queryParamMap } },
        { provide: Router, useValue: { navigate } },
      ],
    }).overrideComponent(RoomPricesComponent, { set: { template: '', imports: [] } });
  });

  function createEditor() {
    const fixture = TestBed.createComponent(RoomPricesComponent);
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  it('groups consecutive equal prices and totals availability for the selected interval', () => {
    const editor = createEditor();
    expect(editor.roomTypeId()).toBe(roomType.id);
    expect(editor.range()).toEqual({ startDate: '2026-11-14', endDate: '2026-11-16' });
    expect(editor.periods()).toEqual([
      { startDate: '2026-11-14', endDate: '2026-11-15', nights: 2, nightlyRate: 150 },
      { startDate: '2026-11-16', endDate: '2026-11-16', nights: 1, nightlyRate: 160 },
    ]);
    expect(editor.available()).toBe(6);
    expect(editor.currentRate()).toBe('€150.00–€160.00');
    expect(rates.rows).toHaveBeenCalledWith(hotel.id, roomType.id, editor.range());
  });

  it('keeps a valid date edit in the URL so the page loader can fetch the new interval', () => {
    const editor = createEditor();
    editor.changeDate('endDate', '2026-11-18');

    expect(editor.range()).toEqual({ startDate: '2026-11-14', endDate: '2026-11-18' });
    expect(navigate).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        queryParams: {
          view: 'rooms',
          section: 'prices',
          from: '2026-11-14',
          through: '2026-11-18',
          type: roomType.id,
          rateHotel: null,
          event: null,
        },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      }),
    );
  });

  it('keeps the applied interval when either endpoint would cross the other', () => {
    const editor = createEditor();
    const dateChange = vi.fn();
    editor.dateChange.subscribe(dateChange);
    editor.changeDate('startDate', '2026-11-17');
    editor.changeDate('endDate', '2026-11-13');

    expect(editor.range()).toEqual({ startDate: '2026-11-14', endDate: '2026-11-16' });
    expect(editor.rangeError()).toBe('');
    expect(navigate).not.toHaveBeenCalled();
    expect(dateChange).not.toHaveBeenCalled();
  });

  it('allows an inclusive one-day price interval', () => {
    const editor = createEditor();
    const dateChange = vi.fn();
    editor.dateChange.subscribe(dateChange);
    editor.changeDate('endDate', '2026-11-14');

    expect(editor.range()).toEqual({ startDate: '2026-11-14', endDate: '2026-11-14' });
    expect(editor.rangeError()).toBe('');
    expect(dateChange).toHaveBeenCalledExactlyOnceWith('endDate');
    expect(navigate).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        queryParams: expect.objectContaining({ from: '2026-11-14', through: '2026-11-14' }),
      }),
    );
  });

  it('uses the page loader default dates when an old link contains an invalid interval', () => {
    TestBed.overrideProvider(ActivatedRoute, {
      useValue: {
        queryParamMap: of(
          convertToParamMap({
            type: roomType.id,
            from: 'not-a-date',
            through: '2026-11-13',
          }),
        ),
      },
    });
    const editor = createEditor();

    expect(editor.range()).toEqual({ startDate: '2026-11-14', endDate: '2026-11-20' });
    expect(editor.rangeError()).toBe('');
  });

  it('saves a manual price without requiring an event and reports the confirmed interval', async () => {
    const editor = createEditor();
    editor.nightlyRate.set(175.5);
    editor.reason.set('  Seasonal adjustment  ');
    const event = new Event('submit', { cancelable: true }) as SubmitEvent;
    const pending = editor.update(event);
    expect(editor.saving()).toBe(true);
    await pending;

    expect(event.defaultPrevented).toBe(true);
    expect(rates.update).toHaveBeenCalledExactlyOnceWith({
      hotelId: hotel.id,
      roomTypeId: roomType.id,
      startDate: '2026-11-14',
      endDate: '2026-11-16',
      nightlyRate: 175.5,
      reason: 'Seasonal adjustment',
    });
    expect(editor.feedback()).toBe('Updated 3 nights to €175.50.');
    expect(editor.saveError()).toBe('');
    expect(editor.saving()).toBe(false);
  });

  it('keeps the draft available when saving fails so the user can retry', async () => {
    rates.update.mockResolvedValueOnce(false);
    rates.error.set('Could not update room rates. Try again.');
    const editor = createEditor();
    editor.nightlyRate.set(175);
    await editor.update(new Event('submit') as SubmitEvent);

    expect(editor.nightlyRate()).toBe(175);
    expect(editor.feedback()).toBe('');
    expect(editor.saveError()).toBe('Could not update room rates. Try again.');
    expect(editor.saving()).toBe(false);
  });
});
