import '@angular/compiler';
import assert from 'node:assert/strict';
import {
  createEnvironmentInjector,
  Injector,
  provideZonelessChangeDetection,
  ɵINJECTOR_SCOPE,
  type EnvironmentInjector,
} from '@angular/core';
import {
  HttpBackend,
  HttpClient,
  HttpErrorResponse,
  HttpRequest,
  HttpResponse,
  provideHttpClient,
  withNoXsrfProtection,
  type HttpEvent,
} from '@angular/common/http';
import { Subject, firstValueFrom, of, throwError, type Observable } from 'rxjs';
import { AuthService } from '../src/app/core/auth.service';
import { ApiClient, ApiError } from '../src/app/core/api/api-client.service';
import {
  API_CONFIG,
  HTTP_API_CONFIG,
  MOCK_API_CONFIG,
  type ApiConfig,
} from '../src/app/core/api/api.config';
import { BrowserSessionService } from '../src/app/core/api/browser-session.service';
import { AuthenticatedWorkspaceService } from '../src/app/core/api/authenticated-workspace.service';

class TestStorage {
  readonly values = new Map<string, string>();
  blocked = false;
  getItem(key: string): string | null {
    if (this.blocked) throw new Error('Storage blocked');
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.blocked) throw new Error('Storage blocked');
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    if (this.blocked) throw new Error('Storage blocked');
    this.values.delete(key);
  }
}
const sessionStorage = new TestStorage();
const localStorage = new TestStorage();
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: sessionStorage });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
const owner = { name: 'Owner', email: 'owner@example.com' };
const firstToken = 'opaque-session-one';
const nextToken = 'opaque-session-two';
const response = (body: unknown = null, status = 200) => of(new HttpResponse({ status, body }));
const failure = (status: number) =>
  throwError(
    () =>
      new HttpErrorResponse({
        status,
        error: {
          code: status === 401 ? 'UNAUTHENTICATED' : 'UNAVAILABLE',
          detail: 'Request rejected.',
        },
      }),
  );
function environment(
  config: ApiConfig = HTTP_API_CONFIG,
  backend: (request: HttpRequest<unknown>) => Observable<HttpEvent<unknown>> = () => response(),
) {
  let loaded = 0;
  let cleared = 0;
  const env = createEnvironmentInjector(
    [
      { provide: ɵINJECTOR_SCOPE, useValue: 'root' },
      provideZonelessChangeDetection(),
      provideHttpClient(withNoXsrfProtection()),
      { provide: API_CONFIG, useValue: config },
      { provide: HttpBackend, useValue: { handle: backend } },
      {
        provide: AuthenticatedWorkspaceService,
        useFactory: (api: ApiClient) => ({
          initialize: async () => {
            await firstValueFrom(api.get('/reference-data'));
            loaded++;
          },
          clear: () => {
            cleared++;
          },
        }),
        deps: [ApiClient],
      },
    ],
    Injector.NULL as EnvironmentInjector,
  );
  return { env, loaded: () => loaded, cleared: () => cleared };
}

function deferredSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => (resolve = complete));
  return { promise, resolve };
}

async function validateLoadingStages() {
  const sessionResponse = new Subject<HttpEvent<unknown>>();
  const referenceResponse = new Subject<HttpEvent<unknown>>();
  const referenceRequested = deferredSignal();
  let sessionReads = 0;
  const restored = environment(HTTP_API_CONFIG, (request) => {
    if (request.url.endsWith('/sessions/current')) {
      sessionReads++;
      return sessionResponse;
    }
    referenceRequested.resolve();
    return referenceResponse;
  });
  restored.env.get(BrowserSessionService).set(firstToken, false);
  const auth = restored.env.get(AuthService);
  const restoring = auth.initialize();
  assert.equal(auth.initialize(), restoring, 'Session restoration is coalesced.');
  assert.equal(auth.loadingStage(), 'session');
  sessionResponse.next(new HttpResponse({ body: { user: owner } }));
  await restoring;
  assert.equal(auth.user()?.email, owner.email);
  assert.equal(restored.loaded(), 0, 'Authentication does not fetch page data or references.');
  const preparing = auth.prepareWorkspace();
  await referenceRequested.promise;
  assert.equal(auth.isAuthenticated(), true, 'The resolver handles catalog readiness separately.');
  referenceResponse.next(new HttpResponse({ body: {} }));
  await preparing;
  assert.equal(restored.loaded(), 1);
  assert.equal(sessionReads, 1, 'The catalog resolver does not revalidate an existing session.');
  restored.env.get(BrowserSessionService).clear();
  restored.env.destroy();

  let unavailable = true;
  const retryable = environment(HTTP_API_CONFIG, (request) =>
    request.url.endsWith('/sessions/current')
      ? response({ user: owner })
      : unavailable
        ? failure(503)
        : response({}),
  );
  retryable.env.get(BrowserSessionService).set(firstToken, false);
  const retryAuth = retryable.env.get(AuthService);
  await retryAuth.initialize();
  await assert.rejects(retryAuth.prepareWorkspace());
  assert.equal(
    retryAuth.isAuthenticated(),
    true,
    'A catalog failure does not discard a valid session.',
  );
  unavailable = false;
  await retryAuth.prepareWorkspace();
  assert.equal(retryable.loaded(), 1, 'A failed resolver read can be retried.');
  retryable.env.get(BrowserSessionService).clear();
  retryable.env.destroy();

  let loginResponse = new Subject<HttpEvent<unknown>>();
  const signingIn = environment(HTTP_API_CONFIG, () => loginResponse);
  const loginAuth = signingIn.env.get(AuthService);
  await loginAuth.initialize();
  const firstResponse = loginResponse;
  const cancelledLogin = loginAuth.login(owner.email, 'test-password');
  const cancelled = assert.rejects(
    cancelledLogin,
    (error: unknown) => error instanceof ApiError && error.code === 'CANCELLED',
  );
  assert.equal(loginAuth.pending(), true);
  loginAuth.clearWorkspace();
  loginResponse = new Subject();
  const newerLogin = loginAuth.login(owner.email, 'test-password');
  const failed = assert.rejects(newerLogin);
  firstResponse.next(new HttpResponse({ body: { user: owner, token: firstToken } }));
  await cancelled;
  assert.equal(loginAuth.loadingStage(), 'session');
  assert.equal(loginAuth.user(), null, 'A stale sign-in must not publish a user.');
  loginResponse.error(new HttpErrorResponse({ status: 503 }));
  await failed;
  assert.equal(loginAuth.pending(), false);
  loginResponse = new Subject();
  const successful = loginAuth.login(owner.email, 'test-password');
  loginResponse.next(new HttpResponse({ body: { user: owner, token: nextToken } }));
  await successful;
  assert.equal(loginAuth.user()?.email, owner.email);
  assert.equal(signingIn.loaded(), 0, 'Sign-in never waits for a reporting ledger.');
  signingIn.env.get(BrowserSessionService).clear();
  signingIn.env.destroy();
}

async function main() {
  assert.equal(HTTP_API_CONFIG.mode, 'http');
  assert.equal(HTTP_API_CONFIG.baseUrl, 'https://api-juyo.cristiansarghe.com/api/v1');
  const storageEnv = environment();
  const sessions = storageEnv.env.get(BrowserSessionService);
  sessions.set(firstToken, false);
  assert.deepEqual([...sessionStorage.values.values()], [firstToken]);
  assert.equal(localStorage.values.size, 0, 'Sessions are per-tab unless remember-me is selected');
  const restored = environment();
  assert.equal(restored.env.get(BrowserSessionService).token(), firstToken);
  restored.env.destroy();
  sessions.set(nextToken, true);
  assert.equal(sessionStorage.values.size, 0);
  assert.deepEqual([...localStorage.values.values()], [nextToken]);
  const otherApi = environment({ ...HTTP_API_CONFIG, baseUrl: 'https://other.example/api/v1' });
  assert.equal(
    otherApi.env.get(BrowserSessionService).token(),
    null,
    'Different API origins cannot reuse authorization',
  );
  otherApi.env.destroy();
  const mock = environment(MOCK_API_CONFIG);
  const mockSessions = mock.env.get(BrowserSessionService);
  mockSessions.set('mock-token', true);
  assert.equal(
    mockSessions.token(),
    null,
    'The removable mock does not inherit real API credentials',
  );
  mock.env.destroy();
  sessions.clear();
  assert.equal(localStorage.values.size + sessionStorage.values.size, 0);
  sessionStorage.blocked = localStorage.blocked = true;
  sessions.set(firstToken, true);
  assert.equal(sessions.token(), firstToken, 'Storage restrictions allow a memory-only session');
  sessions.clear();
  assert.equal(sessions.token(), null);
  sessionStorage.blocked = localStorage.blocked = false;
  storageEnv.env.destroy();

  const requests: HttpRequest<unknown>[] = [];
  let deleteStatus = 204;
  let protectedStatus = 200;
  let loginToken: string | undefined = firstToken;
  let deferred: Subject<HttpEvent<unknown>> | undefined;
  let pendingRevoke: Subject<HttpEvent<unknown>> | undefined;
  const app = environment(HTTP_API_CONFIG, (request) => {
    requests.push(request);
    if (request.url.endsWith('/sessions') && request.method === 'POST')
      return response({ user: owner, ...(loginToken ? { token: loginToken } : {}) }, 201);
    if (request.url.endsWith('/sessions/current')) {
      if (request.method === 'DELETE')
        return (
          pendingRevoke?.asObservable() ??
          (deleteStatus === 204 ? response(null, 204) : failure(deleteStatus))
        );
      return response({ user: owner });
    }
    if (request.url.endsWith('/deferred')) return (deferred = new Subject()).asObservable();
    return protectedStatus === 200 ? response({ ok: true }) : failure(protectedStatus);
  });
  const api = app.env.get(ApiClient);
  const auth = app.env.get(AuthService);
  const tokens = app.env.get(BrowserSessionService);
  await auth.initialize();
  assert.equal(requests.length, 0, 'Anonymous HTTP startup does not request protected data');
  await auth.login(owner.email, 'test-password');
  assert.equal(auth.user()?.email, owner.email);
  assert.equal(
    requests[0].headers.has('Authorization'),
    false,
    'Credentials create a session without a stale bearer token',
  );
  assert.equal(app.loaded(), 0, 'Session creation does not preload the workspace.');
  await auth.prepareWorkspace();
  assert.equal(
    requests[1].headers.get('Authorization'),
    `Bearer ${firstToken}`,
    'The resolver uses the new token for the shared catalog',
  );
  assert(
    requests.every((request) => request.withCredentials === false),
    'Cross-origin API auth never depends on third-party cookies',
  );
  assert.equal(app.loaded(), 1);
  assert.equal(
    JSON.stringify([...sessionStorage.values.values()]).includes('test-password'),
    false,
  );

  await firstValueFrom(app.env.get(HttpClient).get('https://unrelated.example/image.svg'));
  assert.equal(
    requests.at(-1)?.headers.has('Authorization'),
    false,
    'Unrelated HttpClient requests never receive API credentials',
  );
  for (const path of [
    '//other.example',
    '/../../outside',
    '/%2e%2e/outside',
    '/\\other.example',
    '/rooms?next=https://other.example',
  ])
    await assert.rejects(
      firstValueFrom(api.get(path)),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_PATH',
    );

  const oldRequest = firstValueFrom(api.get('/deferred'));
  const oldFailure = assert.rejects(
    oldRequest,
    (error: unknown) => error instanceof ApiError && error.status === 401,
  );
  tokens.set(nextToken, false);
  deferred!.error(new HttpErrorResponse({ status: 401 }));
  await oldFailure;
  assert.equal(
    tokens.token(),
    nextToken,
    'A delayed 401 for an old token preserves the current session',
  );
  assert.equal(auth.isAuthenticated(), true);
  protectedStatus = 401;
  await assert.rejects(firstValueFrom(api.get('/protected')));
  assert.equal(tokens.token(), null);
  assert.equal(auth.user(), null);
  assert.equal(auth.sessionExpired(), true);
  assert.equal(
    sessionStorage.values.size + localStorage.values.size,
    0,
    'Expiry removes both persistence options',
  );
  assert.equal(
    app.cleared(),
    0,
    'Expired session caches survive until authenticated views are destroyed',
  );
  auth.clearWorkspace();
  assert.equal(app.cleared(), 1);

  protectedStatus = 200;
  await auth.login(owner.email, 'test-password', true);
  assert.equal(auth.sessionExpired(), false);
  assert.equal(localStorage.values.size, 1);
  deleteStatus = 503;
  await assert.rejects(auth.logout());
  assert.equal(tokens.token(), firstToken, 'A failed revoke preserves a retryable session');
  assert.equal(auth.isAuthenticated(), true);
  deleteStatus = 204;
  await auth.logout();
  assert.equal(auth.user(), null);
  assert.equal(tokens.token(), null);
  assert.equal(sessionStorage.values.size + localStorage.values.size, 0);

  loginToken = undefined;
  await assert.rejects(
    auth.login(owner.email, 'test-password'),
    (error: unknown) => error instanceof ApiError && error.code === 'INVALID_SESSION',
  );
  assert.equal(auth.isAuthenticated(), false, 'HTTP login requires a server-issued token');
  loginToken = firstToken;
  await auth.login(owner.email, 'test-password');
  deleteStatus = 401;
  await auth.logout();
  assert.equal(
    auth.isAuthenticated(),
    false,
    'Revocation of an already-expired session succeeds locally',
  );
  await auth.login(owner.email, 'test-password');
  pendingRevoke = new Subject();
  const oldLogout = auth.logout();
  protectedStatus = 401;
  await assert.rejects(firstValueFrom(api.get('/protected')));
  auth.clearWorkspace();
  protectedStatus = 200;
  loginToken = nextToken;
  await auth.login(owner.email, 'test-password');
  pendingRevoke.error(new HttpErrorResponse({ status: 401 }));
  await oldLogout;
  assert.equal(tokens.token(), nextToken, 'A delayed revoke failure cannot clear a newer sign-in');
  assert.equal(auth.isAuthenticated(), true);
  pendingRevoke = undefined;
  deleteStatus = 204;
  await auth.logout();
  app.env.destroy();

  const seed = environment();
  seed.env.get(BrowserSessionService).set(nextToken, true);
  seed.env.destroy();
  const restoreRequests: HttpRequest<unknown>[] = [];
  const restore = environment(HTTP_API_CONFIG, (request) => {
    restoreRequests.push(request);
    return response(request.url.endsWith('/sessions/current') ? { user: owner } : {});
  });
  await restore.env.get(AuthService).initialize();
  assert.equal(restore.env.get(AuthService).user()?.email, owner.email);
  assert.equal(restore.loaded(), 0, 'Session restoration does not preload page data.');
  await restore.env.get(AuthService).prepareWorkspace();
  assert.equal(restore.loaded(), 1);
  assert(
    restoreRequests.every(
      (request) => request.headers.get('Authorization') === `Bearer ${nextToken}`,
    ),
  );
  restore.env.get(BrowserSessionService).clear();
  restore.env.destroy();
  const expiredSeed = environment();
  expiredSeed.env.get(BrowserSessionService).set(firstToken, false);
  expiredSeed.env.destroy();
  const expired = environment(HTTP_API_CONFIG, () => failure(401));
  await expired.env.get(AuthService).initialize();
  assert.equal(expired.env.get(AuthService).user(), null);
  assert.equal(
    expired.env.get(AuthService).sessionExpired(),
    false,
    'An expired restored token opens the login page without publishing a session',
  );
  assert.equal(expired.loaded(), 0);
  assert.equal(expired.env.get(BrowserSessionService).token(), null);
  expired.env.destroy();
  await validateLoadingStages();
  console.log(
    'Validated bearer-session persistence, API isolation, protected restoration, stale/current 401 handling, logout failures, mock compatibility and deferred loading-stage transitions/retry/cancellation.',
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
