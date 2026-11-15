import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_CONFIG, type ApiConfig } from './api.config';
import { BrowserSessionService } from './browser-session.service';

const config: ApiConfig = {
  mode: 'http',
  baseUrl: 'https://api.example.test/api/v1',
  timeoutMs: 2_000,
  mockLatencyMs: 0,
};
const configure = () =>
  TestBed.configureTestingModule({
    providers: [{ provide: API_CONFIG, useValue: config }],
  });

describe('BrowserSessionService', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    configure();
  });

  afterEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  it.each([
    { remember: false, label: 'visit-only' },
    { remember: true, label: 'remembered' },
  ])('restores a $label session while persisting only its opaque token', ({ remember }) => {
    const token = 'opaque-session-token';
    TestBed.inject(BrowserSessionService).set(token, remember);
    const selected = remember ? localStorage : sessionStorage;
    const other = remember ? sessionStorage : localStorage;
    expect(selected.length).toBe(1);
    expect(selected.getItem(selected.key(0)!)).toBe(token);
    expect(other.length).toBe(0);

    TestBed.resetTestingModule();
    configure();
    expect(TestBed.inject(BrowserSessionService).token()).toBe(token);
  });

  it('ignores an old unauthorized response and invalidates only the current session', () => {
    const session = TestBed.inject(BrowserSessionService);
    const invalidated = vi.fn();
    const subscription = session.invalidated.subscribe(invalidated);
    session.set('previous-session-token', false);
    session.set('current-session-token', true);

    session.invalidate('previous-session-token');
    expect(session.token()).toBe('current-session-token');
    expect(invalidated).not.toHaveBeenCalled();

    session.invalidate('current-session-token');
    expect(session.token()).toBeNull();
    expect(invalidated).toHaveBeenCalledOnce();
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
    subscription.unsubscribe();
  });
});
