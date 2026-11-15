import { TestBed } from '@angular/core/testing';
import { TuiDay } from '@taiga-ui/cdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { referenceData } from '../../testing/fixtures';
import { ReferenceDataService } from '../core/api/reference-data.service';
import { DateRangePickerComponent } from './date-range-picker.component';

describe('DateRangePickerComponent logic', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [{ provide: ReferenceDataService, useValue: { data: referenceData } }],
    }).overrideComponent(DateRangePickerComponent, { set: { template: '', imports: [] } });
  });

  function createPicker() {
    const fixture = TestBed.createComponent(DateRangePickerComponent);
    fixture.componentRef.setInput('value', {
      startDate: '2026-11-01',
      endDate: '2026-11-30',
    });
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  it('labels a full month and emits Today as a one-day interval', () => {
    const picker = createPicker();
    const change = vi.fn();
    picker.valueChange.subscribe(change);
    expect(picker.label()).toBe('November 2026');

    picker.chooseToday();

    expect(change).toHaveBeenCalledExactlyOnceWith({
      startDate: '2026-11-14',
      endDate: '2026-11-14',
    });
    expect(picker.open()).toBe(false);
  });

  it('sorts calendar endpoints and applies a custom interval', () => {
    const picker = createPicker();
    const change = vi.fn();
    picker.valueChange.subscribe(change);
    picker.onOpenChange(true);
    picker.toggleCustom();

    picker.chooseDay(new TuiDay(2026, 10, 20));
    picker.chooseDay(new TuiDay(2026, 10, 11));
    picker.apply();

    expect(change).toHaveBeenCalledExactlyOnceWith({
      startDate: '2026-11-11',
      endDate: '2026-11-20',
    });
    expect(picker.custom()).toBe(false);
  });

  it('supports applying a single calendar day and discards an uncommitted draft', () => {
    const picker = createPicker();
    const change = vi.fn();
    picker.valueChange.subscribe(change);
    picker.onOpenChange(true);
    picker.chooseDay(new TuiDay(2026, 10, 18));
    picker.apply();
    expect(change).toHaveBeenCalledExactlyOnceWith({
      startDate: '2026-11-18',
      endDate: '2026-11-18',
    });

    // The parent still owns the applied filter until it accepts valueChange.
    picker.onOpenChange(true);
    picker.chooseDay(new TuiDay(2026, 10, 25));
    picker.close();
    expect(picker.startText()).toBe('01/11/2026');
    expect(picker.endText()).toBe('30/11/2026');
    expect(change).toHaveBeenCalledTimes(1);
  });

  it('keeps invalid typed dates in the popup without changing the applied filter', () => {
    const picker = createPicker();
    const change = vi.fn();
    picker.valueChange.subscribe(change);
    picker.onOpenChange(true);
    picker.startText.set('31/11/2026');
    picker.apply();

    expect(picker.validation()).toBe('Enter valid dates as DD/MM/YYYY.');
    expect(picker.startInvalid()).toBe(true);
    expect(picker.open()).toBe(true);
    expect(change).not.toHaveBeenCalled();
  });
});
