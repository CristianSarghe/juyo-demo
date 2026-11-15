import { inject } from '@angular/core';
import { Router, Routes } from '@angular/router';
import { authGuard, guestGuard } from './core/auth.guard';
import { workspaceResolver } from './core/workspace.resolver';

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
      {
        path: 'network',
        title: 'Hotel network · Juyo',
        loadComponent: () =>
          import('./features/network/network.component').then((m) => m.NetworkComponent),
      },
      {
        path: 'room-prices',
        pathMatch: 'full',
        redirectTo: ({ queryParams }) =>
          inject(Router).createUrlTree(['/network'], {
            queryParams: { ...queryParams, view: 'rooms', section: 'prices' },
          }),
      },
      {
        path: 'chat',
        pathMatch: 'full',
        redirectTo: () =>
          inject(Router).createUrlTree(['/network'], {
            queryParams: { view: 'overview', assistant: 'open' },
          }),
      },
      { path: '', pathMatch: 'full', redirectTo: 'network' },
    ],
  },
  { path: '**', redirectTo: 'network' },
];
