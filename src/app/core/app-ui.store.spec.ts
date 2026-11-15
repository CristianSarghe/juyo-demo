import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hotel, referenceData, secondHotel } from '../../testing/fixtures';
import { ApiClient } from './api/api-client.service';
import { ReferenceDataService } from './api/reference-data.service';
import { AppUiStore } from './app-ui.store';
import { HotelScopeService } from './hotel-scope.service';
import { ReportingScopeService } from './reporting-scope.service';

describe('AppUiStore', () => {
  beforeEach(async () => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [{ provide: ApiClient, useValue: { get: vi.fn(() => of(referenceData)) } }],
    });
    await TestBed.inject(ReferenceDataService).load();
  });

  afterEach(() => localStorage.clear());

  it('restores the selected hotel and starts on the business month and date', () => {
    localStorage.setItem(
      'juyo.ui-context.v1',
      JSON.stringify({ version: 1, hotelScope: hotel.id }),
    );

    const store = TestBed.inject(AppUiStore);

    expect(store.hotelScope()).toBe(hotel.id);
    expect(store.month()).toBe('2026-11');
    expect(store.date()).toBe('2026-11-14');
    expect(store.dashboardRange()).toEqual({ startDate: '2026-11-01', endDate: '2026-11-30' });
    expect(store.dates()).toHaveLength(30);
  });

  it('shares and persists hotel selection through the common facade', () => {
    const store = TestBed.inject(AppUiStore);
    const hotels = TestBed.inject(HotelScopeService);

    expect(hotels.select(secondHotel.id)).toBe(true);
    expect(store.hotelScope()).toBe(secondHotel.id);
    expect(JSON.parse(localStorage.getItem('juyo.ui-context.v1')!)).toEqual({
      version: 1,
      hotelScope: secondHotel.id,
    });

    store.selectHotel(hotel.id);
    expect(hotels.scope()).toBe(hotel.id);
  });

  it('keeps a custom dashboard interval independent and synchronizes an exact month selection', () => {
    const store = TestBed.inject(AppUiStore);
    const reporting = TestBed.inject(ReportingScopeService);
    const custom = { startDate: '2026-11-11', endDate: '2026-11-22' };

    expect(reporting.selectDashboardRange(custom)).toBe(true);
    expect(store.dashboardRange()).toEqual(custom);
    expect(reporting.month()).toBe('2026-11');
    expect(reporting.date()).toBe('2026-11-14');

    expect(reporting.selectDashboardRange({ startDate: '2026-10-01', endDate: '2026-10-31' })).toBe(
      true,
    );
    expect(store.month()).toBe('2026-10');
    expect(store.date()).toBe('2026-10-31');
    expect(reporting.period().key).toBe('2026-10');
    expect(reporting.dates()).toHaveLength(31);
  });

  it('keeps month, selected date and full-month dashboard context aligned during calendar navigation', () => {
    const store = TestBed.inject(AppUiStore);
    const reporting = TestBed.inject(ReportingScopeService);

    expect(reporting.selectDate('2026-12-07')).toBe(true);
    expect(store.month()).toBe('2026-12');
    expect(reporting.date()).toBe('2026-12-07');
    expect(reporting.dashboardRange()).toEqual({ startDate: '2026-12-01', endDate: '2026-12-31' });

    expect(reporting.selectMonth('2026-11')).toBe(true);
    expect(store.date()).toBe(referenceData.bookingSnapshot.asOf);
    expect(store.dashboardRange()).toEqual({ startDate: '2026-11-01', endDate: '2026-11-30' });
  });
});
