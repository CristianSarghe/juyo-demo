import { CurrencyPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { ChatAction } from '../core/models';
import type { RateUpdateReviewItem, RoomOperationAction } from '../core/api/mutation.models';
import { SpinnerComponent } from './spinner.component';
import { BrandMarkComponent } from './brand-mark.component';

const actionDateFormatter = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** ISO stay dates are calendar days, never local-midnight instants. */
export function formatChatActionDate(value: string): string {
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) ? actionDateFormatter.format(timestamp) : '—';
}

/** Compact inclusive ranges keep comparison rows legible in the assistant's narrow panel. */
export function formatChatActionRange(from: string, through: string): string {
  if (from === through) return formatChatActionDate(from);
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${through}T00:00:00.000Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return '—';
  if (from.slice(0, 7) === through.slice(0, 7))
    return `${start.getUTCDate()}–${formatChatActionDate(through)}`;
  if (start.getUTCFullYear() === end.getUTCFullYear()) {
    const label = new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    });
    return `${label.format(start)}–${formatChatActionDate(through)}`;
  }
  return `${formatChatActionDate(from)}–${formatChatActionDate(through)}`;
}

export function priceChangeNights(
  update: Pick<RateUpdateReviewItem, 'startDate' | 'endDate'>,
): number {
  return Math.round((Date.parse(update.endDate) - Date.parse(update.startDate)) / 86_400_000) + 1;
}

export interface RateReviewHotel {
  readonly id: string;
  readonly name: string;
  readonly roomTypes: {
    readonly id: string;
    readonly name: string;
    readonly updates: RateUpdateReviewItem[];
  }[];
}

/** Group by identifiers, so equal room-type names in different hotels never share a heading. */
export function groupRateUpdates(updates: readonly RateUpdateReviewItem[]): RateReviewHotel[] {
  const hotels = new Map<string, RateReviewHotel>();
  for (const update of updates) {
    let hotel = hotels.get(update.hotelId);
    if (!hotel) {
      hotel = { id: update.hotelId, name: update.hotelName, roomTypes: [] };
      hotels.set(update.hotelId, hotel);
    }
    let type = hotel.roomTypes.find((candidate) => candidate.id === update.roomTypeId);
    if (!type) {
      type = { id: update.roomTypeId, name: update.roomTypeName, updates: [] };
      hotel.roomTypes.push(type);
    }
    type.updates.push(update);
  }
  for (const hotel of hotels.values())
    for (const type of hotel.roomTypes)
      type.updates.sort((left, right) => left.startDate.localeCompare(right.startDate));
  return [...hotels.values()];
}

/** Review the exact server-staged change before it can affect hotel operations. */
@Component({
  selector: 'app-chat-action',
  imports: [CurrencyPipe, SpinnerComponent, BrandMarkComponent],
  templateUrl: './chat-action.component.html',
  styleUrl: './chat-action.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatActionComponent {
  readonly formatDate = formatChatActionDate;
  readonly formatRange = formatChatActionRange;
  readonly nights = priceChangeNights;
  readonly action = input.required<ChatAction>();
  readonly busy = input(false);
  readonly disabled = input(false);
  readonly decision = output<'apply' | 'cancel'>();
  readonly batchUpdates = computed(() => {
    const action = this.action();
    return action.kind === 'rate_batch_update' ? action.details.updates : [];
  });
  readonly batchGroups = computed(() => groupRateUpdates(this.batchUpdates()));
  readonly roomTypeCount = computed(() =>
    this.batchGroups().reduce((count, hotel) => count + hotel.roomTypes.length, 0),
  );
  readonly commonReason = computed(() => {
    const updates = this.batchUpdates();
    const reason = updates[0]?.reason?.trim();
    return reason && updates.every((update) => update.reason?.trim() === reason) ? reason : '';
  });

  roomActionLabel(action: RoomOperationAction): string {
    return {
      clean: 'Mark clean',
      dirty: 'Mark dirty',
      reserve: 'Reserve room',
      out_of_service: 'Take out of service',
      available: 'Return to service',
      reset: 'Reset room changes',
    }[action];
  }
}
