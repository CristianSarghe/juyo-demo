import { Location } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import {
  DefaultUrlSerializer,
  NavigationEnd,
  NavigationError,
  NavigationStart,
  RouteConfigLoadEnd,
  RouteConfigLoadStart,
  Router,
  type Event,
} from '@angular/router';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NavigationLoadingService } from './navigation-loading.service';

describe('NavigationLoadingService', () => {
  let service: NavigationLoadingService;
  let events: Subject<Event>;
  let navigateByUrl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    events = new Subject<Event>();
    navigateByUrl = vi.fn().mockResolvedValue(true);
    const serializer = new DefaultUrlSerializer();
    TestBed.configureTestingModule({
      providers: [
        NavigationLoadingService,
        { provide: Location, useValue: { path: () => '/network?view=overview' } },
        {
          provide: Router,
          useValue: { events, parseUrl: (url: string) => serializer.parse(url), navigateByUrl },
        },
      ],
    });
    service = TestBed.inject(NavigationLoadingService);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('completes a cached page navigation without flashing a loading surface', () => {
    const url = '/network?view=rooms';
    events.next(new NavigationStart(1, url));
    expect(service.pending()).toBe(true);
    expect(service.targetView()).toBe('rooms');
    expect(service.visible()).toBe(false);

    events.next(new NavigationEnd(1, url, url));
    vi.advanceTimersByTime(200);

    expect(service.pending()).toBe(false);
    expect(service.visible()).toBe(false);
    expect(service.initialized()).toBe(true);
    expect(service.targetUrl()).toBe(url);
    expect(service.error()).toBe('');
  });

  it('shows delayed feedback for a lazy page and removes it when the route is ready', () => {
    const url = '/network?view=configuration';
    const route = { path: 'network' };
    events.next(new NavigationStart(1, url));
    events.next(new RouteConfigLoadStart(route));
    vi.advanceTimersByTime(119);
    expect(service.visible()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(service.visible()).toBe(true);
    expect(service.pending()).toBe(true);
    expect(service.targetView()).toBe('configuration');

    events.next(new RouteConfigLoadEnd(route));
    events.next(new NavigationEnd(1, url, url));

    expect(service.visible()).toBe(false);
    expect(service.pending()).toBe(false);
    expect(service.initialized()).toBe(true);
  });

  it('lets the user retry a failed route and clears the error after successful navigation', async () => {
    const url = '/network?view=reservations';
    events.next(new NavigationStart(1, url));
    events.next(new RouteConfigLoadStart({ path: 'network' }));
    vi.advanceTimersByTime(120);
    events.next(new NavigationError(1, url, new Error('Chunk unavailable')));
    expect(service.visible()).toBe(false);
    expect(service.pending()).toBe(false);
    expect(service.error()).toBe('Could not open this page. Try again.');
    expect(service.failedUrl()).toBe(url);
    navigateByUrl.mockImplementation(async () => {
      events.next(new NavigationStart(2, url));
      events.next(new NavigationEnd(2, url, url));
      return true;
    });

    expect(await service.retry()).toBe(true);

    expect(navigateByUrl).toHaveBeenCalledExactlyOnceWith(url, { onSameUrlNavigation: 'reload' });
    expect(service.targetView()).toBe('reservations');
    expect(service.error()).toBe('');
    expect(service.failedUrl()).toBe(null);
    expect(service.visible()).toBe(false);
    expect(service.initialized()).toBe(true);
  });
});
