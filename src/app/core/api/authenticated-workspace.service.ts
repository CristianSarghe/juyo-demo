import { Injectable, inject } from '@angular/core';
import { NetworkDataStore } from './network-data.store';
import { RoomOperationsService } from '../room-operations.service';
import { RoomRateService } from '../room-rate.service';
import { ReferenceDataService } from './reference-data.service';
import { NotificationsStore } from './notifications.store';

/** Loaded after a valid session; keeps reporting code out of the sign-in bundle. */
@Injectable({ providedIn: 'root' })
export class AuthenticatedWorkspaceService {
  private readonly network = inject(NetworkDataStore);
  private readonly operations = inject(RoomOperationsService);
  private readonly rates = inject(RoomRateService);
  private readonly reference = inject(ReferenceDataService);
  private readonly notifications = inject(NotificationsStore);
  async initialize(): Promise<void> {
    await this.reference.load();
  }
  clear(): void {
    this.operations.clear();
    this.rates.clear();
    this.notifications.clear();
    this.network.clear();
  }
}
