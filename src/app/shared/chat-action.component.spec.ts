import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAction } from '../core/models';
import type { RateUpdateReviewItem } from '../core/api/mutation.models';
import {
  ChatActionComponent,
  formatChatActionRange,
  groupRateUpdates,
  priceChangeNights,
} from './chat-action.component';

const row = (overrides: Partial<RateUpdateReviewItem> = {}): RateUpdateReviewItem => ({
  hotelId: 'dev-ber',
  hotelName: 'Spreehof Berlin',
  roomTypeId: 'dev-ber-type-1',
  roomTypeName: 'Classic',
  startDate: '2026-11-19',
  endDate: '2026-11-20',
  nightlyRate: 220,
  currentMinRate: 190,
  currentMaxRate: 205,
  expectedRateVersion: 'a'.repeat(64),
  ...overrides,
});
const batch = (
  updates: readonly RateUpdateReviewItem[],
  status: ChatAction['status'] = 'pending',
): ChatAction => ({
  id: 'batch-test',
  kind: 'rate_batch_update',
  status,
  summary: 'Review November prices',
  details: { updates },
});

function render(action: unknown) {
  const fixture = TestBed.createComponent(ChatActionComponent);
  fixture.componentRef.setInput('action', action);
  fixture.detectChanges();
  return { fixture, element: fixture.nativeElement as HTMLElement };
}

describe('ChatActionComponent batch price review', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [ChatActionComponent] });
  });

  it('groups every interval under the correct hotel and room type, with before and after rates', () => {
    const updates = [
      row({ startDate: '2026-11-24', endDate: '2026-11-24', nightlyRate: 240 }),
      row(),
      row({
        hotelId: 'dev-ams',
        hotelName: 'Canal House Amsterdam',
        roomTypeId: 'dev-ams-type-1',
        currentMinRate: 195,
        currentMaxRate: 195,
      }),
    ];
    const { element } = render(batch(updates));
    expect(element.querySelectorAll('h4')).toHaveLength(1);
    expect(element.querySelector('h4')?.textContent?.trim()).toBe('3 price changes');
    expect(element.querySelector('.batch-counts span')?.textContent?.trim()).toBe(
      '2 room types · 2 hotels',
    );
    expect(element.textContent).not.toContain('Review November prices');
    expect(
      [...element.querySelectorAll('h5')].map((heading) => heading.textContent?.trim()),
    ).toEqual(['Spreehof Berlin', 'Canal House Amsterdam']);
    expect(element.querySelectorAll('h6')).toHaveLength(2);
    expect(element.querySelectorAll('.rate-row')).toHaveLength(3);
    expect(element.textContent).toContain('19–20 Nov 2026');
    expect(element.textContent).toContain('24 Nov 2026');
    expect(element.textContent).toContain('€190.00');
    expect(element.textContent).toContain('€205.00');
    expect(element.textContent).toContain('€220.00');
    expect(element.textContent).not.toContain('a'.repeat(64));
    expect(element.querySelector('.rate-review')?.getAttribute('tabindex')).toBe('0');
    expect(element.textContent).toContain(
      'All changes apply together. Existing bookings keep their rates.',
    );
    expect(updates[0].startDate).toBe('2026-11-24');
  });

  it('submits a single batch decision and disables both decisions while it is saving', () => {
    const { fixture, element } = render(
      batch([row(), row({ roomTypeId: 'dev-ber-type-2', roomTypeName: 'Superior' })]),
    );
    const decision = vi.fn();
    fixture.componentInstance.decision.subscribe(decision);
    const apply = element.querySelector<HTMLButtonElement>('.apply-change')!;
    const cancel = element.querySelector<HTMLButtonElement>('.cancel-change')!;
    expect(apply.textContent).toContain('Apply all changes');
    apply.click();
    expect(decision).toHaveBeenCalledExactlyOnceWith('apply');
    fixture.componentRef.setInput('busy', true);
    fixture.detectChanges();
    expect(apply.disabled).toBe(true);
    expect(cancel.disabled).toBe(true);
    apply.click();
    cancel.click();
    expect(decision).toHaveBeenCalledTimes(1);
  });

  it('shows every long-batch row and one shared reason, and removes controls after a decision', () => {
    const updates = Array.from({ length: 20 }, (_, index) =>
      row({
        startDate: `2026-11-${String(index + 1).padStart(2, '0')}`,
        endDate: `2026-11-${String(index + 1).padStart(2, '0')}`,
        reason: 'Event demand and remaining rooms.',
      }),
    );
    const { fixture, element } = render(batch(updates));
    expect(element.querySelectorAll('.rate-row')).toHaveLength(20);
    expect(element.querySelectorAll('.batch-reason')).toHaveLength(1);
    expect(element.querySelectorAll('.row-reason')).toHaveLength(0);
    fixture.componentRef.setInput('action', batch(updates, 'applied'));
    fixture.detectChanges();
    expect(element.querySelectorAll('button')).toHaveLength(0);
    expect(element.querySelector('[role=status]')?.textContent).toContain(
      '20 price changes applied',
    );
  });

  it('keeps a one-row batch clear, respects a different pending decision, and shows cancellation', () => {
    const { fixture, element } = render(batch([row()]));
    expect(element.querySelector('.confirmation-question')?.textContent).toContain(
      'Apply this price change?',
    );
    expect(element.querySelector('.apply-change')?.textContent).toContain('Apply change');
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();
    expect([...element.querySelectorAll('button')].every((button) => button.disabled)).toBe(true);
    fixture.componentRef.setInput('action', batch([row()], 'cancelled'));
    fixture.detectChanges();
    expect(element.querySelectorAll('button')).toHaveLength(0);
    expect(element.querySelector('[role=status]')?.textContent).toContain('Price change cancelled');
  });

  it('preserves legacy single-rate and room-action confirmation cards', () => {
    const { fixture, element } = render({
      id: 'legacy',
      kind: 'rate_update',
      status: 'pending',
      summary: 'Review Classic prices',
      details: row(),
    });
    expect(element.textContent).toContain('Classic');
    expect(element.textContent).toContain('€220.00');
    expect(element.querySelector('.rate-review')).toBeNull();
    fixture.componentRef.setInput('action', {
      id: 'room',
      kind: 'room_action',
      status: 'cancelled',
      summary: 'Mark room clean',
      details: {
        hotelName: 'Spreehof Berlin',
        roomNumber: '105',
        roomId: 'room-105',
        date: '2026-11-19',
        action: 'clean',
      },
    });
    fixture.detectChanges();
    expect(element.textContent).toContain('Mark clean');
    expect(element.textContent).toContain('Change cancelled');
    expect(element.querySelectorAll('button')).toHaveLength(0);
  });

  it.each([
    { name: 'unknown action', action: { ...batch([row()]), kind: 'future_action' } },
    { name: 'missing details', action: { ...batch([row()]), details: null } },
    { name: 'empty batch', action: batch([]) },
    {
      name: 'missing quote fingerprint',
      action: batch([row({ expectedRateVersion: '' })]),
    },
    { name: 'nonfinite amount', action: batch([row({ nightlyRate: Number.NaN })]) },
    {
      name: 'overlapping inclusive dates',
      action: batch([row(), row({ startDate: '2026-11-20', endDate: '2026-11-22' })]),
    },
  ])('blocks Apply for $name while preserving safe cancellation', ({ action }) => {
    const { fixture, element } = render(action);
    expect(element.querySelector('.apply-change')).toBeNull();
    expect(element.querySelectorAll('.rate-row')).toHaveLength(0);
    expect(element.querySelector('[role=status]')?.textContent).toContain(
      'cannot be reviewed safely',
    );
    const cancel = element.querySelector<HTMLButtonElement>('.cancel-change')!;
    const decision = vi.fn();
    fixture.componentInstance.decision.subscribe(decision);
    cancel.click();
    expect(decision).toHaveBeenCalledExactlyOnceWith('cancel');
  });

  it.each([null, {}, { id: '', status: 'pending' }, { id: 'unknown', status: 'applied' }])(
    'never exposes a decision for an invalid pending envelope: %j',
    (action) => {
      const { element } = render(action);
      expect(element.querySelectorAll('button')).toHaveLength(0);
      expect(element.querySelector('[role=status]')?.textContent).toContain(
        'cannot be reviewed safely',
      );
    },
  );
});

describe('batch review dates and grouping', () => {
  it('counts inclusive nights across months and keeps matching type names in different hotels separate', () => {
    expect(formatChatActionRange('2026-11-30', '2026-12-02')).toBe('30 Nov–2 Dec 2026');
    expect(formatChatActionRange('2026-11-19', '2026-11-19')).toBe('19 Nov 2026');
    expect(priceChangeNights(row({ startDate: '2026-11-30', endDate: '2026-12-02' }))).toBe(3);
    expect(priceChangeNights(row({ startDate: '2026-11-19', endDate: '2026-11-19' }))).toBe(1);
    expect(
      groupRateUpdates([
        row(),
        row({
          hotelId: 'dev-ams',
          hotelName: 'Canal House Amsterdam',
          roomTypeId: 'dev-ams-type-1',
        }),
      ]),
    ).toHaveLength(2);
  });
});
