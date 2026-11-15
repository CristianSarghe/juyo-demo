import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiClient } from './api-client.service';
import { API_CONFIG, type ApiConfig } from './api.config';
import { BrowserSessionService } from './browser-session.service';

const baseUrl = 'https://api.example.test/api/v1';
const config: ApiConfig = {
  mode: 'http',
  baseUrl: `${baseUrl}/`,
  timeoutMs: 2_000,
  mockLatencyMs: 0,
};

describe('ApiClient', () => {
  let api: ApiClient;
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
    api = TestBed.inject(ApiClient);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    sessionStorage.clear();
    localStorage.clear();
  });

  it('encodes scoped query values and attaches only the opaque session bearer', async () => {
    TestBed.inject(BrowserSessionService).set('opaque-session-token', false);
    const result = firstValueFrom(
      api.get<{ id: string }[]>('/rooms', {
        hotelId: 'hotel & Berlin',
        available: false,
        page: 2,
        unused: undefined,
        empty: null,
      }),
    );
    const request = http.expectOne((value) => value.url === `${baseUrl}/rooms`);
    expect(request.request.method).toBe('GET');
    expect(request.request.params.get('hotelId')).toBe('hotel & Berlin');
    expect(request.request.urlWithParams).toContain('hotelId=hotel%20%26%20Berlin');
    expect(request.request.params.get('available')).toBe('false');
    expect(request.request.params.get('page')).toBe('2');
    expect(request.request.params.has('unused')).toBe(false);
    expect(request.request.params.has('empty')).toBe(false);
    expect(request.request.headers.get('Authorization')).toBe('Bearer opaque-session-token');
    expect(request.request.withCredentials).toBe(false);
    request.flush([{ id: 'room-101' }]);
    expect(await result).toEqual([{ id: 'room-101' }]);
  });

  it('preserves POST, PATCH and DELETE bodies and response contracts', async () => {
    const update = { roomTypeId: 'classic', nightlyRate: 180 };
    const created = firstValueFrom(api.post<{ id: string }>('/rate-updates', update));
    const changed = firstValueFrom(
      api.patch<{ status: string }>('/rooms/101/state', { action: 'clean' }),
    );
    const deleted = firstValueFrom(api.delete('/conversations/old'));

    const post = http.expectOne(`${baseUrl}/rate-updates`);
    expect(post.request.method).toBe('POST');
    expect(post.request.body).toEqual(update);
    post.flush({ id: 'update-1' }, { status: 201, statusText: 'Created' });

    const patch = http.expectOne(`${baseUrl}/rooms/101/state`);
    expect(patch.request.method).toBe('PATCH');
    expect(patch.request.body).toEqual({ action: 'clean' });
    patch.flush({ status: 'clean' });

    const remove = http.expectOne(`${baseUrl}/conversations/old`);
    expect(remove.request.method).toBe('DELETE');
    remove.flush(null, { status: 204, statusText: 'No Content' });

    expect(await created).toEqual({ id: 'update-1' });
    expect(await changed).toEqual({ status: 'clean' });
    expect(await deleted).toBeNull();
  });

  it('collects every page in order while retaining the hotel filter', async () => {
    const firstPage = Array.from({ length: 1000 }, (_, index) => ({ id: `room-${index}` }));
    const result = firstValueFrom(api.listAll<{ id: string }>('/rooms', { hotelId: 'berlin' }));
    const first = http.expectOne((value) => value.params.get('page') === '1');
    expect(first.request.params.get('hotelId')).toBe('berlin');
    expect(first.request.params.get('pageSize')).toBe('1000');
    first.flush({ items: firstPage, total: 1001, page: 1, pageSize: 1000 });

    const second = http.expectOne((value) => value.params.get('page') === '2');
    expect(second.request.params.get('hotelId')).toBe('berlin');
    second.flush({ items: [{ id: 'room-1000' }], total: 1001, page: 2, pageSize: 1000 });
    expect(await result).toEqual([...firstPage, { id: 'room-1000' }]);
  });

  it('exposes a failed write as an API problem without repeating the mutation', async () => {
    const result = firstValueFrom(api.post('/rate-updates', { nightlyRate: 180 }));
    http
      .expectOne(`${baseUrl}/rate-updates`)
      .flush(
        { code: 'PERSISTENCE_UNAVAILABLE', detail: 'The update was not saved.' },
        { status: 503, statusText: 'Unavailable' },
      );
    await expect(result).rejects.toMatchObject({
      name: 'ApiError',
      status: 503,
      code: 'PERSISTENCE_UNAVAILABLE',
      message: 'The update was not saved.',
    });
    http.expectNone(`${baseUrl}/rate-updates`);
  });
});
