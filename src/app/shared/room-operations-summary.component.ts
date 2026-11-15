import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

export type RoomQueue = 'available' | 'dirty' | 'out_of_service' | 'reserved';

export interface RoomOperationsCounts {
  readonly available: number;
  readonly dirty: number;
  readonly outOfService: number;
  readonly reserved: number;
}

@Component({
  selector: 'app-room-operations-summary',
  templateUrl: './room-operations-summary.component.html',
  styleUrl: './room-operations-summary.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RoomOperationsSummaryComponent {
  readonly counts = input.required<RoomOperationsCounts>();
  readonly active = input<RoomQueue | null>(null);
  readonly selectQueue = output<RoomQueue>();
  readonly cards: readonly {
    queue: RoomQueue;
    count: keyof RoomOperationsCounts;
    title: string;
    action: string;
    accessibleAction: string;
  }[] = [
    {
      queue: 'available',
      count: 'available',
      title: 'Available',
      action: 'View rooms',
      accessibleAction: 'View available rooms',
    },
    {
      queue: 'dirty',
      count: 'dirty',
      title: 'Needs cleaning',
      action: 'View cleaning',
      accessibleAction: 'View rooms needing cleaning',
    },
    {
      queue: 'out_of_service',
      count: 'outOfService',
      title: 'Out of service',
      action: 'View rooms',
      accessibleAction: 'View out-of-service rooms',
    },
    {
      queue: 'reserved',
      count: 'reserved',
      title: 'Reserved',
      action: 'View rooms',
      accessibleAction: 'View manually reserved rooms',
    },
  ];
}
