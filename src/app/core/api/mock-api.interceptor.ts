import { inject } from '@angular/core';
import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { defer, from, of, switchMap, timer, throwError, catchError } from 'rxjs';
import { API_CONFIG } from './api.config';

/** No mock dependency is imported by live clients; real mode delegates to HttpClient. */
export const mockApiInterceptor: HttpInterceptorFn = (request, next) => {
  const config = inject(API_CONFIG);
  const base = config.baseUrl.replace(/\/$/, '');
  if (config.mode !== 'mock' || !(request.url === base || request.url.startsWith(`${base}/`)))
    return next(request);
  const path = request.url.slice(base.length);
  const handler = () =>
    path === '/sessions' || path === '/sessions/current'
      ? import('./mock/mock-session.api').then((module) => module.handleMockSession)
      : import('./mock/mock-api.backend').then((module) => module.handleMockRequest);
  return defer(() => from(handler())).pipe(
    switchMap((handle) =>
      timer(config.mockLatencyMs).pipe(switchMap(() => defer(() => of(handle(request, base))))),
    ),
    catchError((error: unknown) =>
      throwError(() =>
        error instanceof HttpErrorResponse
          ? error
          : new HttpErrorResponse({
              status: 500,
              url: request.url,
              error: {
                type: 'about:blank',
                title: 'Request failed',
                status: 500,
                code: 'MOCK_ERROR',
                detail: 'Could not complete the local request.',
              },
            }),
      ),
    ),
  );
};
