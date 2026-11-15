import { inject } from '@angular/core';
import type { CanActivateFn } from '@angular/router';
import { Router } from '@angular/router';
import { AuthService } from './auth.service';
import { safeReturnUrl } from './auth-redirect';

export const authGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.initialize();
  return (
    auth.isAuthenticated() ||
    router.createUrlTree(['/login'], {
      queryParams: state.url === '/' ? {} : { returnUrl: state.url },
    })
  );
};

export const guestGuard: CanActivateFn = async (route) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.initialize();
  return (
    !auth.isAuthenticated() ||
    router.parseUrl(safeReturnUrl(router, route.queryParamMap.get('returnUrl')))
  );
};
