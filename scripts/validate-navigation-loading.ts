import '@angular/compiler';
import assert from 'node:assert/strict';
import { Location } from '@angular/common';
import {
  createEnvironmentInjector,
  Injector,
  provideZonelessChangeDetection,
  ɵINJECTOR_SCOPE,
  type EnvironmentInjector,
} from '@angular/core';
import {
  DefaultUrlSerializer,
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  NavigationSkipped,
  NavigationStart,
  RouteConfigLoadEnd,
  RouteConfigLoadStart,
  ResolveStart,
  Router,
  type Event,
  type NavigationBehaviorOptions,
} from '@angular/router';
import { Subject } from 'rxjs';
import { NavigationLoadingService } from '../src/app/shared/navigation-loading.service';

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function environment(path = '/reservations') {
  const events = new Subject<Event>();
  const serializer = new DefaultUrlSerializer();
  const retries: { url: string; options?: NavigationBehaviorOptions }[] = [];
  let retryNavigation: (url: string) => Promise<boolean> = async () => false;
  const env = createEnvironmentInjector(
    [
      { provide: ɵINJECTOR_SCOPE, useValue: 'root' },
      provideZonelessChangeDetection(),
      { provide: Location, useValue: { path: () => path } },
      {
        provide: Router,
        useValue: {
          events: events.asObservable(),
          parseUrl: (url: string) => serializer.parse(url),
          navigateByUrl: (url: string, options?: NavigationBehaviorOptions) => {
            retries.push({ url, options });
            return retryNavigation(url);
          },
        },
      },
    ],
    Injector.NULL as EnvironmentInjector,
  );
  return {
    env,
    events,
    retries,
    loading: env.get(NavigationLoadingService),
    retryWith: (navigate: typeof retryNavigation) => (retryNavigation = navigate),
  };
}

async function main() {
  for (const [url, view] of [
    ['/', 'overview'],
    ['/rooms', 'rooms'],
    ['/rooms/prices?type=room-type-one', 'rooms'],
    ['/reservations', 'reservations'],
    ['/hotel-configuration', 'configuration'],
    ['/?view=rooms', 'overview'],
    ['/reservations?view=configuration', 'reservations'],
  ]) {
    const initial = environment(url);
    assert.equal(initial.loading.targetView(), view, `Startup loading follows the path ${url}`);
    initial.env.destroy();
  }
  for (const removedView of ['schema', 'costs']) {
    const legacy = environment(`/network?view=${removedView}`);
    assert.equal(legacy.loading.targetView(), 'overview', 'Removed pages use the Overview loader');
    legacy.env.destroy();
  }
  const app = environment();
  const { loading, events } = app;
  const workspaceRoute = { path: '' };
  const chatRoute = { path: 'chat' };
  assert.equal(loading.initialized(), false);
  assert.equal(loading.targetView(), 'reservations', 'Startup uses the browser URL before routing');
  assert.equal(loading.pending(), false);

  events.next(new NavigationStart(1, '/rooms'));
  events.next(new RouteConfigLoadStart(workspaceRoute));
  assert.equal(loading.pending(), true);
  assert.equal(loading.targetView(), 'rooms');
  assert.equal(loading.visible(), false, 'A fast download does not paint a skeleton');
  events.next(new RouteConfigLoadEnd(workspaceRoute));
  events.next(new NavigationEnd(1, '/rooms', '/rooms'));
  await wait(135);
  assert.equal(loading.visible(), false, 'Finishing cancels the delayed feedback');
  assert.equal(loading.initialized(), true);

  events.next(new NavigationStart(2, '/hotel-configuration'));
  await wait(135);
  assert.equal(loading.visible(), false, 'Cached navigation has no invented download loader');
  events.next(new NavigationEnd(2, '/hotel-configuration', '/hotel-configuration'));

  events.next(new NavigationStart(3, '/chat'));
  events.next(new RouteConfigLoadStart(chatRoute));
  await wait(60);
  assert.equal(loading.visible(), false, 'Feedback waits through a brief loading interval');
  await wait(75);
  assert.equal(loading.visible(), true, 'A slow lazy download shows feedback');
  assert.equal(loading.targetView(), 'chat');
  events.next(new RouteConfigLoadEnd(chatRoute));
  events.next(new NavigationEnd(3, '/chat', '/chat'));
  assert.equal(loading.visible(), false, 'Successful navigation has no minimum display delay');
  assert.equal(loading.pending(), false);

  events.next(new NavigationStart(4, '/reservations'));
  events.next(new RouteConfigLoadStart(workspaceRoute));
  events.next(new NavigationStart(5, '/'));
  events.next(new NavigationCancel(4, '/reservations', 'Superseded'));
  events.next(new NavigationError(4, '/reservations', new Error('Old failure')));
  assert.equal(loading.pending(), true, 'An old terminal event cannot finish newer navigation');
  assert.equal(loading.error(), '');
  await wait(135);
  assert.equal(loading.visible(), true);
  events.next(new RouteConfigLoadEnd(workspaceRoute));
  events.next(new NavigationEnd(5, '/', '/'));
  assert.equal(loading.targetView(), 'overview');

  events.next(new NavigationStart(6, '/chat'));
  events.next(new RouteConfigLoadStart(chatRoute));
  events.next(new NavigationCancel(6, '/chat', 'Guard declined'));
  await wait(135);
  assert.equal(loading.pending(), false);
  assert.equal(loading.visible(), false, 'Cancellation also removes scheduled feedback');
  assert.equal(loading.error(), '', 'A cancelled navigation is not a page-load error');
  assert.equal(loading.initialized(), true, 'The previous routed page stays usable');
  events.next(new RouteConfigLoadEnd(chatRoute));

  events.next(new NavigationStart(7, '/hotel-configuration'));
  events.next(new RouteConfigLoadStart(workspaceRoute));
  events.next(new NavigationError(7, '/hotel-configuration', new Error('Private details')));
  assert.equal(loading.error(), 'Could not open this page. Try again.');
  assert.equal(loading.failedUrl(), '/hotel-configuration');
  assert.equal(loading.pending(), false);
  app.retryWith(async (url) => {
    events.next(new NavigationStart(8, url));
    events.next(new NavigationEnd(8, url, url));
    return true;
  });
  assert.equal(await loading.retry(), true);
  assert.deepEqual(app.retries, [
    { url: '/hotel-configuration', options: { onSameUrlNavigation: 'reload' } },
  ]);
  assert.equal(loading.error(), '');
  assert.equal(loading.failedUrl(), null);
  assert.equal(await loading.retry(), false, 'There is nothing to retry after success');

  events.next(new NavigationStart(9, '/hotel-configuration'));
  await wait(135);
  assert.equal(loading.visible(), false, 'Failed imports do not leave stale lazy-loading state');
  events.next(new NavigationSkipped(9, '/hotel-configuration', 'Same URL'));
  assert.equal(loading.pending(), false);
  assert.equal(loading.error(), '');
  events.next(new NavigationStart(10, '/room-prices'));
  assert.equal(loading.targetView(), 'rooms');
  events.next(new NavigationEnd(10, '/room-prices', '/rooms/prices'));
  assert.equal(loading.targetUrl(), '/rooms/prices');

  events.next(new NavigationStart(11, '/chat'));
  events.next(new RouteConfigLoadStart(chatRoute));
  events.next(new NavigationCancel(11, '/chat', 'Superseded'));
  events.next(new NavigationStart(12, '/chat'));
  await wait(135);
  assert.equal(
    loading.visible(),
    true,
    'A replacement navigation shows feedback when Angular reuses the pending lazy import',
  );
  events.next(new RouteConfigLoadEnd(chatRoute));
  events.next(new NavigationEnd(12, '/chat', '/chat'));
  assert.equal(loading.visible(), false);
  events.next(new NavigationStart(13, '/'));
  events.next(new ResolveStart(13, '/', '/', {} as any));
  await wait(135);
  assert.equal(loading.visible(), true, 'The shared-reference resolver receives delayed feedback.');
  events.next(new NavigationEnd(13, '/', '/'));
  assert.equal(loading.visible(), false, 'Successful resolver navigation removes its skeleton.');
  app.env.destroy();

  const startup = environment('/login');
  assert.equal(startup.loading.targetView(), 'login');
  startup.events.next(new NavigationStart(1, '/login'));
  startup.events.next(new NavigationError(1, '/login', new Error('Chunk unavailable')));
  assert.equal(startup.loading.initialized(), false, 'Initial failure keeps the startup surface');
  assert.equal(startup.loading.failedUrl(), '/login');
  startup.retryWith(async (url) => {
    startup.events.next(new NavigationStart(2, url));
    startup.events.next(new NavigationError(2, url, new Error('Still unavailable')));
    throw new Error('Router navigation rejected');
  });
  assert.equal(await startup.loading.retry(), false, 'A retry rejection is handled by page state');
  assert.equal(startup.loading.error(), 'Could not open this page. Try again.');
  startup.env.destroy();

  const disposed = environment();
  disposed.events.next(new NavigationStart(1, '/chat'));
  disposed.events.next(new RouteConfigLoadStart({ path: 'chat' }));
  disposed.env.destroy();
  await wait(135);
  assert.equal(disposed.loading.visible(), false, 'Destroy cancels the pending timer');
  disposed.events.next(new NavigationEnd(1, '/chat', '/chat'));
  assert.equal(disposed.loading.initialized(), false, 'Destroy unsubscribes from router events');
  console.log(
    'Validated initial URL context, lazy and resolver delayed route feedback, fast routes, cancellation races, errors, retry and teardown.',
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
