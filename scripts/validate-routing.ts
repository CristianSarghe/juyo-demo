import '@angular/compiler';
import assert from 'node:assert/strict';
import { Location } from '@angular/common';
import { provideLocationMocks, SpyLocation } from '@angular/common/testing';
import {
  Component,
  createEnvironmentInjector,
  Injector,
  provideZonelessChangeDetection,
  ɵConsole,
  ɵINJECTOR_SCOPE,
  type EnvironmentInjector,
} from '@angular/core';
import {
  NavigationEnd,
  provideRouter,
  Router,
  TitleStrategy,
  type ActivatedRouteSnapshot,
  type Routes,
} from '@angular/router';
import { filter, firstValueFrom, take, timeout } from 'rxjs';
import { routes } from '../src/app/app.routes';
import { AuthService } from '../src/app/core/auth.service';
import { safeReturnUrl } from '../src/app/core/auth-redirect';

/** Keep the production routes, redirects, guards and resolvers. Only visual rendering is stubbed. */
let stubId = 0;
function routeStubs(config: Routes): Routes {
  return config.map((route) => {
    const copy = { ...route };
    if (route.loadComponent) {
      class RouteView {}
      Component({ selector: `routing-check-${++stubId}`, template: '', standalone: true })(
        RouteView,
      );
      copy.loadComponent = async () => RouteView;
    }
    if (route.children) copy.children = routeStubs(route.children);
    return copy;
  });
}

function environment(startUrl = '/', authenticated = true) {
  let catalogLoads = 0;
  const auth = {
    initialize: async () => undefined,
    prepareWorkspace: async () => {
      catalogLoads++;
    },
    isAuthenticated: () => authenticated,
  };
  const env = createEnvironmentInjector(
    [
      { provide: ɵINJECTOR_SCOPE, useValue: 'root' },
      ɵConsole,
      provideZonelessChangeDetection(),
      provideRouter(routeStubs(routes)),
      provideLocationMocks(),
      { provide: TitleStrategy, useValue: { updateTitle: () => undefined } },
      { provide: AuthService, useValue: auth },
    ],
    Injector.NULL as EnvironmentInjector,
  );
  const location = env.get(Location) as SpyLocation;
  location.setInitialPath(startUrl);
  const router = env.get(Router);
  router.setUpLocationChangeListener();
  return {
    env,
    router,
    location,
    catalogLoads: () => catalogLoads,
    authenticate: () => (authenticated = true),
  };
}

function chain(router: Router): ActivatedRouteSnapshot[] {
  const activated: ActivatedRouteSnapshot[] = [];
  let route = router.routerState.snapshot.root.firstChild;
  while (route) {
    activated.push(route);
    route = route.firstChild;
  }
  return activated;
}

function nextNavigation(router: Router): Promise<NavigationEnd> {
  return firstValueFrom(
    router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      take(1),
      timeout(2000),
    ),
  );
}

async function main() {
  const app = environment();
  try {
    const { router, location } = app;
    for (const [url, paths, view, section] of [
      ['/', ['', '', ''], 'overview', undefined],
      ['/rooms', ['', '', 'rooms', ''], 'rooms', 'inventory'],
      ['/rooms/prices', ['', '', 'rooms', 'prices'], 'rooms', 'prices'],
      ['/reservations', ['', '', 'reservations'], 'reservations', undefined],
      ['/hotel-configuration', ['', '', 'hotel-configuration'], 'configuration', undefined],
    ] as const) {
      assert.equal(await router.navigateByUrl(url), true);
      assert.equal(router.url, url);
      assert.equal(location.path(), url);
      const active = chain(router);
      assert.deepEqual(
        active.map((route) => route.routeConfig?.path),
        paths,
        `The URL ${url} activates the expected nested route outlets`,
      );
      assert.equal(active.at(-1)?.data['view'], view);
      assert.equal(active.at(-1)?.data['section'], section);
      assert.equal(
        new Set(active.map((route) => route.component)).size,
        active.length,
        'Each route level has a distinct lazy page/layout component',
      );
    }
    assert.equal(
      app.catalogLoads(),
      1,
      'Page/tab navigation reuses the authenticated shell catalog',
    );

    await router.navigateByUrl('/?view=rooms&section=prices');
    assert.equal(chain(router).at(-1)?.data['view'], 'overview', 'Query flags cannot select pages');
    await router.navigateByUrl('/reservations?view=configuration');
    assert.equal(chain(router).at(-1)?.data['view'], 'reservations');

    for (const [legacy, expected] of [
      ['/network', '/'],
      ['/network?view=overview', '/'],
      ['/network?view=rooms', '/rooms'],
      [
        '/network?view=rooms&section=prices&type=type-one&from=2026-11-14#daily',
        '/rooms/prices?type=type-one&from=2026-11-14#daily',
      ],
      [
        '/network?view=reservations&hotel=hotel-one&room=room-one',
        '/reservations?hotel=hotel-one&room=room-one',
      ],
      ['/network?view=configuration', '/hotel-configuration'],
      ['/network?view=schema', '/'],
      ['/network?view=costs', '/'],
      [
        '/room-prices?hotel=hotel-one&event=event-one',
        '/rooms/prices?hotel=hotel-one&event=event-one',
      ],
      ['/chat', '/?assistant=open'],
    ]) {
      await router.navigateByUrl(legacy);
      assert.equal(router.url, expected, `Legacy link ${legacy} keeps supported context`);
    }

    await router.navigateByUrl('/rooms');
    await router.navigateByUrl('/rooms/prices?type=type-one');
    const exactPath = {
      paths: 'exact',
      queryParams: 'ignored',
      fragment: 'ignored',
      matrixParams: 'ignored',
    } as const;
    assert.equal(router.isActive('/', exactPath), false, 'Dashboard is not active on another page');
    assert.equal(
      router.isActive('/rooms', { ...exactPath, paths: 'subset' }),
      true,
      'Room management stays active on its pricing child',
    );
    assert.equal(router.isActive('/rooms', exactPath), false, 'Rooms tab is not active on pricing');
    assert.equal(
      router.isActive('/rooms/prices', exactPath),
      true,
      'Pricing filters do not unset its active tab',
    );
    await router.navigateByUrl('/reservations');
    let completed = nextNavigation(router);
    location.back();
    await completed;
    assert.equal(router.url, '/rooms/prices?type=type-one', 'Back restores the actual pricing URL');
    assert.equal(chain(router).at(-1)?.data['section'], 'prices');
    completed = nextNavigation(router);
    location.back();
    await completed;
    assert.equal(router.url, '/rooms');
    completed = nextNavigation(router);
    location.forward();
    await completed;
    assert.equal(router.url, '/rooms/prices?type=type-one', 'Forward restores the nested tab');

    await router.navigateByUrl('/unavailable-page');
    assert.equal(router.url, '/unavailable-page');
    assert.equal(
      chain(router).at(-1)?.routeConfig?.path,
      '**',
      'Unknown paths render a real not-found page',
    );
    assert.equal(
      chain(router).length,
      2,
      'Not-found content bypasses scoped workspace data loading',
    );

    for (const unsafe of [
      null,
      '',
      'https://unrelated.example/rooms',
      '//unrelated.example/rooms',
      '/\\unrelated.example',
      '/login',
      '/login?returnUrl=/rooms',
      '/rooms\n/prices',
    ]) {
      assert.equal(
        safeReturnUrl(router, unsafe),
        '/',
        `Unsafe/looping return URL is rejected: ${unsafe}`,
      );
    }
    assert.equal(
      safeReturnUrl(router, '/rooms/prices?type=type-one&from=2026-11-14#daily'),
      '/rooms/prices?type=type-one&from=2026-11-14#daily',
      'Internal return paths retain filters and fragments',
    );
  } finally {
    app.env.destroy();
  }

  const direct = environment('/rooms/prices?type=type-one');
  try {
    const completed = nextNavigation(direct.router);
    direct.router.initialNavigation();
    await completed;
    assert.equal(
      direct.router.url,
      '/rooms/prices?type=type-one',
      'Refresh/deep linking recognizes a nested tab',
    );
    assert.equal(chain(direct.router).at(-1)?.data['section'], 'prices');
  } finally {
    direct.env.destroy();
  }

  const protectedPage = '/rooms/prices?type=type-one&from=2026-11-14';
  const anonymous = environment(protectedPage, false);
  try {
    await anonymous.router.navigateByUrl(protectedPage);
    const login = anonymous.router.parseUrl(anonymous.router.url);
    assert.equal(login.root.children['primary'].segments[0].path, 'login');
    assert.equal(login.queryParams['returnUrl'], protectedPage);
    assert.equal(anonymous.catalogLoads(), 0, 'Anonymous deep links never start workspace reads');
    anonymous.authenticate();
    await anonymous.router.navigateByUrl(
      safeReturnUrl(anonymous.router, login.queryParams['returnUrl']),
      {
        replaceUrl: true,
      },
    );
    assert.equal(
      anonymous.router.url,
      protectedPage,
      'Sign-in resumes the validated internal destination',
    );
    await anonymous.router.navigateByUrl('/login?returnUrl=' + encodeURIComponent(protectedPage));
    assert.equal(
      anonymous.router.url,
      protectedPage,
      'The guest guard resumes the validated internal destination',
    );
    assert.equal(anonymous.catalogLoads(), 1);
  } finally {
    anonymous.env.destroy();
  }
  const anonymousRoot = environment('/', false);
  try {
    await anonymousRoot.router.navigateByUrl('/');
    assert.equal(
      anonymousRoot.router.url,
      '/login',
      'Anonymous dashboard uses the clean sign-in URL',
    );
  } finally {
    anonymousRoot.env.destroy();
  }
  console.log(
    'Validated real Angular route recognition, nested pages, legacy redirects, history, direct loads, auth return paths and unknown pages.',
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
