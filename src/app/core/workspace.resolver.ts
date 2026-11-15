import { inject } from '@angular/core';
import type { ResolveFn } from '@angular/router';
import { AuthService } from './auth.service';

/** Only the small shared catalog blocks shell activation. Page reads belong to page stores. */
export const workspaceResolver: ResolveFn<boolean> = async () => {
  await inject(AuthService).prepareWorkspace();
  return true;
};
