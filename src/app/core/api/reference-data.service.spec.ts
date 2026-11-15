import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { referenceData } from '../../../testing/fixtures';
import { API_CONFIG, type ApiConfig } from './api.config';
import { ReferenceDataService } from './reference-data.service';

const baseUrl = 'https://api.example.test/api/v1';
const config: ApiConfig = { mode: 'http', baseUrl, timeoutMs: 2_000, mockLatencyMs: 0 };

describe('ReferenceDataService', () => {
  let reference: ReferenceDataService;
  let http: HttpTestingController;

  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_CONFIG, useValue: config },
      ],
    });
    reference = TestBed.inject(ReferenceDataService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('shares one catalog request and reuses the complete loaded reference data', async () => {
    const first = reference.load();
    const concurrent = reference.load();
    expect(concurrent).toBe(first);
    expect(reference.loading()).toBe(true);
    expect(reference.snapshot()).toBeNull();
    http.expectOne(`${baseUrl}/reference-data`).flush(referenceData);
    await Promise.all([first, concurrent]);
    expect(reference.data).toEqual(referenceData);
    expect(reference.loading()).toBe(false);
    expect(reference.error()).toBe('');
    await reference.load();
    http.expectNone(`${baseUrl}/reference-data`);
  });

  it('accepts inclusive calendar endpoints and a one-day interval', async () => {
    const loaded = reference.load();
    http.expectOne(`${baseUrl}/reference-data`).flush(referenceData);
    await loaded;
    const range = {
      startDate: referenceData.dates[0],
      endDate: referenceData.dates.at(-1)!,
    };
    expect(reference.validateDateRange(range)).toEqual(range);
    const date = referenceData.bookingSnapshot.asOf;
    expect(reference.validateDateRange({ startDate: date, endDate: date })).toEqual({
      startDate: date,
      endDate: date,
    });
  });

  it('cancels the old session catalog on clear and loads a fresh catalog', async () => {
    const obsolete = reference.load();
    const rejected = expect(obsolete).rejects.toMatchObject({ code: 'CANCELLED' });
    const oldRequest = http.expectOne(`${baseUrl}/reference-data`);
    reference.clear();
    expect(oldRequest.cancelled).toBe(true);
    expect(reference.snapshot()).toBeNull();
    expect(reference.loading()).toBe(false);
    await rejected;

    const current = reference.load();
    http.expectOne(`${baseUrl}/reference-data`).flush(referenceData);
    await current;
    expect(reference.data).toEqual(referenceData);
  });

  it('leaves a malformed catalog unpublished and allows a successful retry', async () => {
    const invalid = reference.load();
    http.expectOne(`${baseUrl}/reference-data`).flush({ ...referenceData, hotels: [] });
    await expect(invalid).rejects.toMatchObject({ code: 'INVALID_REFERENCE_DATA' });
    expect(reference.snapshot()).toBeNull();
    expect(reference.loading()).toBe(false);
    expect(reference.error()).toBe('The API returned invalid reference data.');

    const retry = reference.load();
    http.expectOne(`${baseUrl}/reference-data`).flush(referenceData);
    await retry;
    expect(reference.data).toEqual(referenceData);
    expect(reference.error()).toBe('');
  });
});
