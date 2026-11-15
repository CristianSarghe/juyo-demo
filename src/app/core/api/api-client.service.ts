import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import {
  Observable,
  catchError,
  concatMap,
  defer,
  from,
  map,
  of,
  reduce,
  retry,
  throwError,
  timer,
  timeout,
  TimeoutError,
} from 'rxjs';
import { API_CONFIG } from './api.config';
import type { ApiProblem, ApiQuery, Page } from './api.models';
import { BrowserSessionService } from './browser-session.service';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly errors?: Readonly<Record<string, string>>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

@Injectable({ providedIn: 'root' })
export class ApiClient {
  private readonly http = inject(HttpClient);
  private readonly config = inject(API_CONFIG);
  private readonly session = inject(BrowserSessionService);

  get<T>(path: string, query: ApiQuery = {}): Observable<T> {
    const request = this.request<T>('GET', path, undefined, query);
    if (this.config.mode !== 'http') return request;
    // Cold/free-tier failures are retryable reads. Mutations never enter this path.
    return request.pipe(
      retry({
        count: 2,
        delay: (error: unknown, attempt) =>
          error instanceof ApiError && [0, 502, 503, 504].includes(error.status)
            ? timer(attempt * 300)
            : throwError(() => error),
      }),
      // The budget includes retry delays and attempts, so startup cannot wait
      // three full request timeouts for a single unavailable resource.
      timeout({ first: this.config.timeoutMs }),
      catchError((error: unknown) =>
        throwError(() =>
          error instanceof TimeoutError
            ? new ApiError(0, 'TIMEOUT', 'The request timed out. Please retry.')
            : error,
        ),
      ),
    );
  }
  post<T>(path: string, body: unknown, options: { timeoutMs?: number } = {}): Observable<T> {
    return this.request<T>('POST', path, body, {}, options.timeoutMs);
  }
  patch<T>(path: string, body: unknown): Observable<T> {
    return this.request<T>('PATCH', path, body);
  }
  delete<T = void>(path: string): Observable<T> {
    return this.request<T>('DELETE', path);
  }

  /** A bounded reporting cache, never an unbounded recursive API crawler. */
  listAll<T>(path: string, query: ApiQuery = {}): Observable<T[]> {
    const pageSize = 1000;
    const assertPage = (page: Page<T>, expected: number) => {
      if (
        !page ||
        !Array.isArray(page.items) ||
        page.page !== expected ||
        page.pageSize !== pageSize ||
        !Number.isSafeInteger(page.total) ||
        page.total < 0 ||
        page.total > 50_000 ||
        page.items.length > pageSize
      ) {
        throw new ApiError(502, 'INVALID_RESPONSE', 'The API returned an invalid page.');
      }
      return page;
    };
    return this.get<Page<T>>(path, { ...query, page: 1, pageSize }).pipe(
      map((page) => assertPage(page, 1)),
      concatMap((first) => {
        const count = Math.ceil(first.total / pageSize);
        return from(Array.from({ length: Math.max(0, count - 1) }, (_, index) => index + 2)).pipe(
          concatMap((page) =>
            this.get<Page<T>>(path, { ...query, page, pageSize }).pipe(
              map((result) => {
                assertPage(result, page);
                if (result.total !== first.total)
                  throw new ApiError(
                    409,
                    'SNAPSHOT_CHANGED',
                    'The reporting data changed while loading. Please retry.',
                  );
                return result;
              }),
            ),
          ),
          reduce((items, page) => [...items, ...page.items], first.items),
          map((items) => {
            if (items.length !== first.total)
              throw new ApiError(
                409,
                'SNAPSHOT_CHANGED',
                'The reporting data changed while loading. Please retry.',
              );
            return items;
          }),
        );
      }),
    );
  }

  private request<T>(
    method: string,
    path: string,
    body?: unknown,
    query: ApiQuery = {},
    timeoutMs = this.config.timeoutMs,
  ): Observable<T> {
    if (
      !path.startsWith('/') ||
      path.startsWith('//') ||
      /[\\?#\s]/.test(path) ||
      path.includes('://') ||
      /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i.test(path)
    ) {
      return throwError(() => new ApiError(400, 'INVALID_PATH', 'Use an API resource path.'));
    }
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query))
      if (value !== undefined && value !== null) params = params.set(key, String(value));
    return defer(() => {
      // Login creates a session; only API resource requests receive its bearer token.
      const token = method === 'POST' && path === '/sessions' ? null : this.session.token();
      return this.http
        .request<T>(method, `${this.config.baseUrl.replace(/\/$/, '')}${path}`, {
          body,
          params,
          withCredentials: false,
          headers: {
            Accept: 'application/json',
            ...(this.config.mode === 'http' && token ? { Authorization: `Bearer ${token}` } : {}),
          },
        })
        .pipe(
          timeout({ first: timeoutMs }),
          catchError((error: unknown) => {
            if (error instanceof ApiError) return throwError(() => error);
            if (error instanceof TimeoutError)
              return throwError(
                () => new ApiError(0, 'TIMEOUT', 'The request timed out. Please retry.'),
              );
            if (error instanceof HttpErrorResponse) {
              if (error.status === 401 && token && this.config.mode === 'http')
                this.session.invalidate(token);
              const problem = error.error as Partial<ApiProblem> | null;
              return throwError(
                () =>
                  new ApiError(
                    error.status,
                    typeof problem?.code === 'string' ? problem.code : 'HTTP_ERROR',
                    typeof problem?.detail === 'string'
                      ? problem.detail
                      : error.status === 0
                        ? 'Could not reach the API. Please retry.'
                        : 'Could not complete the request. Please retry.',
                    problem?.errors,
                  ),
              );
            }
            return throwError(
              () =>
                new ApiError(0, 'REQUEST_FAILED', 'Could not complete the request. Please retry.'),
            );
          }),
        );
    });
  }
}
