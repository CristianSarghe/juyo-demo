import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { TuiAutoFocus } from '@taiga-ui/cdk';
import { TuiDataList, TuiDropdown } from '@taiga-ui/core';
import type { ManagedRoom, RoomOperationAction } from '../core/room-operations.service';
import { SpinnerComponent } from './spinner.component';

interface RoomActionItem {
  readonly value: RoomOperationAction;
  readonly label: string;
  readonly note?: string;
  readonly disabled?: boolean;
}

@Component({
  selector: 'app-room-actions',
  imports: [TuiAutoFocus, TuiDataList, TuiDropdown, SpinnerComponent],
  templateUrl: './room-actions.component.html',
  styleUrl: './room-actions.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RoomActionsComponent {
  readonly room = input.required<ManagedRoom>();
  readonly hotelName = input.required<string>();
  readonly disabled = input(false);
  readonly pending = input(false);
  readonly action = output<RoomOperationAction>();
  readonly open = signal(false);
  readonly occupied = computed(() => this.room().status === 'occupied');
  readonly items = computed<readonly RoomActionItem[]>(() => {
    const room = this.room();
    const items: RoomActionItem[] = [];
    if (room.housekeeping !== 'clean') items.push({ value: 'clean', label: 'Mark clean' });
    if (room.housekeeping !== 'dirty') items.push({ value: 'dirty', label: 'Mark dirty' });
    if (room.status !== 'reserved')
      items.push({
        value: 'reserve',
        label: 'Reserve room',
        note:
          room.status === 'out_of_service' ? 'Return to service first.' : 'Manual hold, no booking',
        disabled: this.occupied() || room.status === 'out_of_service',
      });
    if (room.status !== 'out_of_service')
      items.push({
        value: 'out_of_service',
        label: 'Out of service',
        disabled: this.occupied(),
      });
    if (room.status === 'reserved' || room.status === 'out_of_service')
      items.push({
        value: 'available',
        label: room.status === 'out_of_service' ? 'Return to service' : 'Make available',
      });
    if (room.hasChanges) items.push({ value: 'reset', label: 'Reset changes' });
    return items;
  });

  choose(item: RoomActionItem): void {
    if (this.disabled() || item.disabled) return;
    this.open.set(false);
    this.action.emit(item.value);
  }
}
