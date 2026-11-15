import { Injectable, inject } from '@angular/core';
import { map, type Observable } from 'rxjs';
import type { DateRange } from '../network.models';
import type { BookingRateHistoryDay } from '../room-price-history';
import type { RoomOperationChange } from './mutation.models';
import type {
  ApiQuery,
  CollectionItem,
  CollectionKey,
  IdentifiedCollectionKey,
} from './api.models';
import { ApiClient, ApiError } from './api-client.service';
import { RESOURCE_PATHS } from './resource-paths';
import { assertCollectionRows } from './api-response.validation';

/** Typed resource transport. It owns no fixtures, derived UI state, or browser persistence. */
@Injectable({ providedIn: 'root' })
export class NetworkApiService {
  private readonly api = inject(ApiClient);

  priceHistory(roomTypeId: string, range: DateRange): Observable<BookingRateHistoryDay[]> {
    return this.api
      .get<
        BookingRateHistoryDay[]
      >(`/room-types/${encodeURIComponent(roomTypeId)}/price-history`, { from: range.startDate, to: range.endDate })
      .pipe(
        map((rows) => {
          if (
            !Array.isArray(rows) ||
            rows.length > 366 ||
            rows.some(
              (row) =>
                !row ||
                typeof row.date !== 'string' ||
                row.date < range.startDate ||
                row.date > range.endDate ||
                !(row.weightedRate === null || Number.isFinite(row.weightedRate)) ||
                !Number.isSafeInteger(row.bookedRoomNights) ||
                row.bookedRoomNights < 0 ||
                !Number.isFinite(row.bookedRevenue) ||
                !Number.isSafeInteger(row.rateCount) ||
                !Array.isArray(row.priceBuckets) ||
                row.rateCount !== row.priceBuckets.length ||
                row.priceBuckets.some(
                  (bucket) =>
                    !bucket ||
                    !Number.isFinite(bucket.nightlyRate) ||
                    !Number.isSafeInteger(bucket.roomNights) ||
                    bucket.roomNights < 1,
                ),
            )
          )
            throw new ApiError(502, 'INVALID_RESPONSE', 'The API returned invalid price history.');
          return rows;
        }),
      );
  }

  roomChanges(): Observable<RoomOperationChange[]> {
    return this.api.get<RoomOperationChange[]>('/room-state-changes');
  }

  list<K extends CollectionKey>(
    collection: K,
    query: ApiQuery = {},
  ): Observable<CollectionItem<K>[]> {
    return this.api.listAll<CollectionItem<K>>(RESOURCE_PATHS[collection], query).pipe(
      map((rows) => {
        assertCollectionRows(collection, rows);
        return rows;
      }),
    );
  }
  get<K extends IdentifiedCollectionKey>(collection: K, id: string): Observable<CollectionItem<K>> {
    return this.api.get<CollectionItem<K>>(
      `${RESOURCE_PATHS[collection]}/${encodeURIComponent(id)}`,
    );
  }
}
