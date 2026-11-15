import { TestBed } from '@angular/core/testing';
import { TuiDay } from '@taiga-ui/cdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DatePickerComponent } from './date-picker.component';

describe('DatePickerComponent logic', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({}).overrideComponent(DatePickerComponent, {
      set: { template: '', imports: [] },
    });
  });

  function createPicker(disabled = false) {
    const fixture = TestBed.createComponent(DatePickerComponent);
    fixture.componentRef.setInput('value', '2026-11-14');
    fixture.componentRef.setInput('min', '2026-11-14');
    fixture.componentRef.setInput('max', '2026-11-20');
    fixture.componentRef.setInput('label', 'From');
    fixture.componentRef.setInput('disabled', disabled);
    fixture.detectChanges();
    return { fixture, picker: fixture.componentInstance };
  }

  it('formats its value and allows both inclusive endpoints, closing after a pick', () => {
    const { picker } = createPicker();
    const change = vi.fn();
    picker.valueChange.subscribe(change);
    expect(picker.displayValue()).toBe('14 Nov 2026');
    expect(picker.accessibleLabel()).toBe('From, 14 Nov 2026');

    picker.onOpenChange(true);
    picker.chooseDay(new TuiDay(2026, 10, 14));
    expect(change).toHaveBeenNthCalledWith(1, '2026-11-14');
    expect(picker.open()).toBe(false);

    picker.onOpenChange(true);
    picker.chooseDay(new TuiDay(2026, 10, 20));
    expect(change).toHaveBeenNthCalledWith(2, '2026-11-20');
    expect(picker.open()).toBe(false);
  });

  it('refuses calendar dates outside its bounds even when called directly', () => {
    const { picker } = createPicker();
    const change = vi.fn();
    picker.valueChange.subscribe(change);
    picker.onOpenChange(true);

    picker.chooseDay(new TuiDay(2026, 10, 13));
    picker.chooseDay(new TuiDay(2026, 10, 21));

    expect(change).not.toHaveBeenCalled();
    expect(picker.open()).toBe(true);
    expect(picker.value()).toBe('2026-11-14');
  });

  it('closes when disabled and does not reopen or emit changes', () => {
    const { fixture, picker } = createPicker();
    const change = vi.fn();
    picker.valueChange.subscribe(change);
    picker.onOpenChange(true);
    expect(picker.open()).toBe(true);
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();
    expect(picker.open()).toBe(false);
    picker.draftText.set('18/11/2026');

    picker.onOpenChange(true);
    picker.chooseDay(new TuiDay(2026, 10, 18));
    picker.apply();

    expect(picker.open()).toBe(false);
    expect(change).not.toHaveBeenCalled();
  });

  it('keeps invalid typed dates unpublished and applies a valid one-day interval', () => {
    const { fixture, picker } = createPicker();
    const change = vi.fn();
    picker.valueChange.subscribe(change);
    picker.onOpenChange(true);
    picker.draftText.set('31/11/2026');
    picker.apply();
    expect(picker.validation()).toBe('Enter a valid date as DD/MM/YYYY.');
    expect(picker.showError()).toBe(true);
    expect(change).not.toHaveBeenCalled();

    picker.draftText.set('21/11/2026');
    picker.apply();
    expect(picker.validation()).toBe('Use a date from 14 Nov 2026 to 20 Nov 2026.');
    expect(change).not.toHaveBeenCalled();

    fixture.componentRef.setInput('max', '2026-11-14');
    fixture.detectChanges();
    picker.draftText.set('14112026');
    picker.blurField();
    expect(picker.draftText()).toBe('14/11/2026');
    picker.apply();
    expect(picker.validation()).toBe('');
    expect(change).toHaveBeenCalledExactlyOnceWith('2026-11-14');
    expect(picker.open()).toBe(false);
  });
});
