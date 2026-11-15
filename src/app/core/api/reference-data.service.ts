import { Injectable, inject } from '@angular/core';
import { patchState, signalState } from '@ngrx/signals';
import { firstValueFrom, Subject, takeUntil } from 'rxjs';
import type { DateRange } from '../network.models';
import { ApiClient, ApiError } from './api-client.service';
import type { ReferenceDataDto } from './api.models';

/** Shared hotel/calendar catalog. No room, reservation or financial ledger is loaded here. */
@Injectable({ providedIn: 'root' })
export class ReferenceDataService {
  private readonly api = inject(ApiClient);
  private readonly state = signalState<{
    value: ReferenceDataDto | null;
    loading: boolean;
    error: string;
  }>({ value: null, loading: false, error: '' });
  readonly snapshot = this.state.value;
  readonly loading = this.state.loading;
  readonly error = this.state.error;
  private readonly cancel = new Subject<void>();
  private pending?: Promise<void>;
  private generation = 0;
  get data(): ReferenceDataDto {
    const value = this.state.value();
    if (!value) throw new Error('Reference data must load before opening the workspace.');
    return value;
  }
  load(): Promise<void> {
    if (this.state.value()) return Promise.resolve();
    if (this.pending) return this.pending;
    const generation = this.generation;
    patchState(this.state, { loading: true, error: '' });
    this.pending = firstValueFrom(
      this.api.get<ReferenceDataDto>('/reference-data').pipe(takeUntil(this.cancel)),
    )
      .then((value) => {
        if (generation !== this.generation)
          throw new ApiError(0, 'CANCELLED', 'The reference request was cancelled.');
        if (
          !value ||
          !Array.isArray(value.hotels) ||
          !value.hotels.length ||
          !Array.isArray(value.dates) ||
          !value.dates.length ||
          value.dates.length > 366 ||
          !Array.isArray(value.reportingPeriods) ||
          !value.reportingPeriods.length ||
          !value.meta?.reportingPeriod ||
          !value.bookingSnapshot ||
          !value.hotels.every(
            (hotel) => typeof hotel.id === 'string' && typeof hotel.name === 'string',
          ) ||
          !value.dates.every((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)) ||
          !value.dates.includes(value.bookingSnapshot.asOf)
        )
          throw new ApiError(
            502,
            'INVALID_REFERENCE_DATA',
            'The API returned invalid reference data.',
          );
        patchState(this.state, { value, loading: false, error: '' });
      })
      .catch((error: unknown) => {
        if (generation !== this.generation)
          throw new ApiError(0, 'CANCELLED', 'The reference request was cancelled.');
        patchState(this.state, {
          loading: false,
          error: error instanceof Error ? error.message : 'Could not load hotel information.',
        });
        throw error;
      })
      .finally(() => {
        if (generation === this.generation) this.pending = undefined;
      });
    return this.pending;
  }
  clear(): void {
    this.cancel.next();
    this.generation++;
    this.pending = undefined;
    patchState(this.state, { value: null, loading: false, error: '' });
  }
  validateDateRange(range: DateRange): DateRange {
    if (
      !range ||
      !this.data.dates.includes(range.startDate) ||
      !this.data.dates.includes(range.endDate) ||
      range.startDate > range.endDate
    )
      throw new RangeError('Choose a valid interval within the available reporting calendar.');
    return { startDate: range.startDate, endDate: range.endDate };
  }
}
