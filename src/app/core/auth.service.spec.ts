import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_CONFIG, type ApiConfig } from './api/api.config';
import { BrowserSessionService } from './api/browser-session.service';
import { AuthService } from './auth.service';

const baseUrl = 'https://api.example.test/api/v1';
const config: ApiConfig = { mode: 'http', baseUrl, timeoutMs: 2_000, mockLatencyMs: 0 };
const user = { name: 'Hotel Manager', email: 'manager@example.test' };
const token = 'opaque-session-token';

describe('AuthService', () => {
  let auth: AuthService;
  let session: BrowserSessionService;
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
    auth = TestBed.inject(AuthService);
    session = TestBed.inject(BrowserSessionService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    sessionStorage.clear();
    localStorage.clear();
  });

  it('signs in through the session endpoint without eagerly loading hotel data', async () => {
    const signedIn = auth.login(user.email, 'test-only-password', true);
    expect(auth.pending()).toBe(true);
    expect(auth.loadingStage()).toBe('session');
    const request = http.expectOne(`${baseUrl}/sessions`);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({
      email: user.email,
      password: 'test-only-password',
      remember: true,
    });
    expect(request.request.headers.has('Authorization')).toBe(false);
    request.flush({ user, token }, { status: 201, statusText: 'Created' });
    await signedIn;
    expect(auth.user()).toEqual(user);
    expect(auth.isAuthenticated()).toBe(true);
    expect(auth.pending()).toBe(false);
    expect(auth.loadingStage()).toBe('idle');
    expect(session.token()).toBe(token);
    http.expectNone(`${baseUrl}/reference-data`);
    http.expectNone(`${baseUrl}/exports/network`);
  });

  it('restores a stored bearer identity once for concurrent initialization', async () => {
    session.set(token, false);
    const first = auth.initialize();
    const concurrent = auth.initialize();
    expect(concurrent).toBe(first);
    const request = http.expectOne(`${baseUrl}/sessions/current`);
    expect(request.request.method).toBe('GET');
    expect(request.request.headers.get('Authorization')).toBe(`Bearer ${token}`);
    request.flush({ user });
    await Promise.all([first, concurrent]);
    expect(auth.user()).toEqual(user);
    expect(auth.isAuthenticated()).toBe(true);
    await auth.initialize();
    http.expectNone(`${baseUrl}/sessions/current`);
  });

  it('clears the identity and stored token after the server signs out', async () => {
    session.set(token, true);
    const restored = auth.initialize();
    http.expectOne(`${baseUrl}/sessions/current`).flush({ user });
    await restored;

    const signedOut = auth.logout();
    expect(auth.pending()).toBe(true);
    const request = http.expectOne(`${baseUrl}/sessions/current`);
    expect(request.request.method).toBe('DELETE');
    expect(request.request.headers.get('Authorization')).toBe(`Bearer ${token}`);
    request.flush(null, { status: 204, statusText: 'No Content' });
    await signedOut;
    expect(auth.user()).toBeNull();
    expect(auth.isAuthenticated()).toBe(false);
    expect(auth.pending()).toBe(false);
    expect(session.token()).toBeNull();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('keeps failed sign-in anonymous and releases the pending state', async () => {
    const signedIn = auth.login(user.email, 'incorrect-password');
    http
      .expectOne(`${baseUrl}/sessions`)
      .flush(
        { code: 'INVALID_CREDENTIALS', detail: 'Email or password is incorrect.' },
        { status: 401, statusText: 'Unauthorized' },
      );
    await expect(signedIn).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(auth.isAuthenticated()).toBe(false);
    expect(auth.user()).toBeNull();
    expect(session.token()).toBeNull();
    expect(auth.pending()).toBe(false);
    expect(auth.loadingStage()).toBe('idle');
  });
});
