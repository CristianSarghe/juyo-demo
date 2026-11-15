import { Injectable, inject } from '@angular/core';
import type { PropertyScope, HotelNetwork } from './network.models';
import { RoomOperationsService } from './room-operations.service';
import { createNetworkSelectors, type NetworkSelectors } from './network.selectors';
import { NetworkDataStore } from './api/network-data.store';
import { ReferenceDataService } from './api/reference-data.service';

/** Domain queries over the active page. Shared hotel/calendar metadata never depends on page loading. */
@Injectable({ providedIn: 'root' })
export class NetworkService {
  private readonly store = inject(NetworkDataStore);
  private readonly reference = inject(ReferenceDataService);
  private readonly operations = inject(RoomOperationsService);
  readonly dayRevision = this.store.dayRevision;
  private source?: HotelNetwork;
  private bound?: NetworkSelectors;
  get data() {
    return this.store.data;
  }
  get meta() {
    return this.reference.data.meta;
  }
  get hotels() {
    return this.reference.data.hotels;
  }
  get bookingSnapshot() {
    return this.reference.data.bookingSnapshot;
  }
  get periods() {
    return this.reference.data.reportingPeriods;
  }
  get dates() {
    return this.reference.data.dates;
  }
  private get queries() {
    const data = this.data;
    if (this.source !== data || !this.bound) {
      this.source = data;
      this.bound = createNetworkSelectors(data);
    }
    return this.bound;
  }
  get bookingPace() {
    return this.queries.bookingPace;
  }
  get bookingChartContext() {
    return this.queries.bookingChartContext;
  }
  get bookingOutlook() {
    return this.queries.bookingOutlook;
  }
  get validateDateRange() {
    return this.reference.validateDateRange.bind(this.reference);
  }
  get bookingSources() {
    return this.queries.bookingSources;
  }
  get bookingRateHistory() {
    return (hotelId: string, roomTypeId: string) => this.store.getPriceHistory(hotelId, roomTypeId);
  }
  hotelInventory(scope: PropertyScope = 'portfolio', date = this.bookingSnapshot.asOf) {
    return this.operations.rooms(scope, date);
  }
  loadDay(scope: PropertyScope, date: string) {
    return this.store.loadDay(scope, date);
  }
  cancelDayLoad(): void {
    this.store.cancelDayLoad();
  }
  hotelDaySummary(scope: PropertyScope, date: string) {
    return this.store.getDaySummary(scope, date);
  }
}
