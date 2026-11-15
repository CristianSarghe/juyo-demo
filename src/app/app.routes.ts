import { inject } from '@angular/core';
import { Router, type RedirectFunction, type Routes } from '@angular/router';
import { authGuard, guestGuard } from './core/auth.guard';
import { workspaceResolver } from './core/workspace.resolver';

/** Keep saved links working while page identity moves from queries to paths. */
const legacyWorkspaceRedirect: RedirectFunction = ({ queryParams, fragment }) => {
  const { view, section, ...filters } = queryParams;
  const path =
    view === 'rooms'
      ? section === 'prices'
        ? '/rooms/prices'
        : '/rooms'
      : view === 'reservations'
        ? '/reservations'
        : view === 'configuration'
          ? '/hotel-configuration'
          : '/';
  return inject(Router).createUrlTree([path], {
    queryParams: filters,
    fragment: fragment ?? undefined,
  });
};

export const routes: Routes = [
  {
    path: 'login',
    canActivate: [guestGuard],
    title: 'Sign in · Juyo',
    loadComponent: () => import('./features/login/login.component').then((m) => m.LoginComponent),
  },
  {
    path: '',
    loadComponent: () => import('./shared/app-shell.component').then((m) => m.AppShellComponent),
    canActivate: [authGuard],
    canActivateChild: [authGuard],
    resolve: { workspace: workspaceResolver },
    children: [
      { path: 'network', pathMatch: 'full', redirectTo: legacyWorkspaceRedirect },
      {
        path: 'room-prices',
        pathMatch: 'full',
        redirectTo: ({ queryParams, fragment }) => {
          const { view, section, ...filters } = queryParams;
          return inject(Router).createUrlTree(['/rooms/prices'], {
            queryParams: filters,
            fragment: fragment ?? undefined,
          });
        },
      },
      {
        path: 'chat',
        pathMatch: 'full',
        redirectTo: () =>
          inject(Router).createUrlTree(['/'], { queryParams: { assistant: 'open' } }),
      },
      {
        path: '',
        loadComponent: () =>
          import('./features/network/network.component').then((m) => m.NetworkComponent),
        children: [
          {
            path: '',
            pathMatch: 'full',
            title: 'Overview · Juyo',
            data: { view: 'overview' },
            loadComponent: () =>
              import('./features/network/dashboard-page.component').then(
                (m) => m.DashboardPageComponent,
              ),
          },
          {
            path: 'rooms',
            data: { view: 'rooms' },
            loadComponent: () =>
              import('./features/network/room-management.component').then(
                (m) => m.RoomManagementComponent,
              ),
            children: [
              {
                path: '',
                pathMatch: 'full',
                title: 'Rooms · Juyo',
                data: { view: 'rooms', section: 'inventory' },
                loadComponent: () =>
                  import('./features/network/room-inventory.component').then(
                    (m) => m.RoomInventoryComponent,
                  ),
              },
              {
                path: 'prices',
                title: 'Room prices · Juyo',
                data: { view: 'rooms', section: 'prices' },
                loadComponent: () =>
                  import('./features/room-prices/room-prices-page.component').then(
                    (m) => m.RoomPricesPageComponent,
                  ),
              },
            ],
          },
          {
            path: 'reservations',
            title: 'Reservations · Juyo',
            data: { view: 'reservations' },
            loadComponent: () =>
              import('./features/reservations/reservations-page.component').then(
                (m) => m.ReservationsPageComponent,
              ),
          },
          {
            path: 'hotel-configuration',
            title: 'Hotel configuration · Juyo',
            data: { view: 'configuration' },
            loadComponent: () =>
              import('./features/hotel-configuration/hotel-configuration-page.component').then(
                (m) => m.HotelConfigurationPageComponent,
              ),
          },
        ],
      },
      {
        path: '**',
        title: 'Page not found · Juyo',
        loadComponent: () =>
          import('./shared/not-found.component').then((m) => m.NotFoundComponent),
      },
    ],
  },
];
