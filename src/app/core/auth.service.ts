import { Injectable, Injector, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { patchState, signalState } from '@ngrx/signals';
import { firstValueFrom } from 'rxjs';
import type { User } from './models';
import { ApiClient, ApiError } from './api/api-client.service';
import type { AuthenticatedWorkspaceService } from './api/authenticated-workspace.service';
import { API_CONFIG } from './api/api.config';
import { BrowserSessionService } from './api/browser-session.service';
import type { SessionDto } from './api/api.models';

/** Session transport is replaceable; credentials and mock persistence stay behind the API. */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly api = inject(ApiClient);
  private readonly injector = inject(Injector);
  private readonly config = inject(API_CONFIG);
  private readonly session = inject(BrowserSessionService);
  private workspace?: AuthenticatedWorkspaceService;
  private readonly state = signalState<{
    user: User | null;
    pending: boolean;
    loadingStage: 'idle' | 'session' | 'workspace';
  }>({
    user: null,
    pending: false,
    loadingStage: 'idle',
  });
  readonly user = this.state.user;
  readonly pending = this.state.pending;
  readonly loadingStage = this.state.loadingStage;
  readonly isAuthenticated = computed(() => this.user() !== null);
  private readonly expired = signal(false);
  readonly sessionExpired = this.expired.asReadonly();
  private initialized = false;
  private loading?: Promise<void>;
  private generation = 0;

  constructor() {
    this.session.invalidated.pipe(takeUntilDestroyed()).subscribe(() => {
      const wasAuthenticated = this.isAuthenticated();
      this.generation++;
      this.initialized = true;
      patchState(this.state, { user: null, pending: false, loadingStage: 'idle' });
      if (wasAuthenticated) this.expired.set(true);
    });
  }

  initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (this.loading) return this.loading;
    const loading = this.restore();
    this.loading = loading;
    const complete = () => {
      if (this.loading === loading) this.loading = undefined;
    };
    void loading.then(complete, complete);
    return loading;
  }
  private async restore(): Promise<void> {
    const generation = this.generation;
    if (this.config.mode === 'http' && !this.session.token()) {
      this.initialized = true;
      return;
    }
    patchState(this.state, { loadingStage: 'session' });
    try {
      let user: User;
      try {
        user = this.sessionUser(
          await firstValueFrom(this.api.get<SessionDto>('/sessions/current')),
        );
      } catch (error) {
        if (error && typeof error === 'object' && 'status' in error && error.status === 401) {
          if (generation !== this.generation) return;
          this.session.clear();
          patchState(this.state, { user: null });
          this.initialized = true;
          return;
        }
        throw error;
      }
      if (generation !== this.generation) return;
      patchState(this.state, { user });
      this.initialized = true;
    } finally {
      if (generation === this.generation) patchState(this.state, { loadingStage: 'idle' });
    }
  }
  /** The protected shell resolver loads shared references, never a page ledger. */
  async prepareWorkspace(): Promise<void> {
    if (!this.isAuthenticated())
      throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in before opening the workspace.');
    const generation = this.generation;
    const { AuthenticatedWorkspaceService } = await import('./api/authenticated-workspace.service');
    this.workspace ??= this.injector.get(AuthenticatedWorkspaceService);
    await this.workspace.initialize();
    if (generation !== this.generation || !this.isAuthenticated())
      throw new ApiError(0, 'CANCELLED', 'The workspace request was cancelled.');
  }
  async login(email: string, password: string, remember = false): Promise<void> {
    if (this.pending())
      throw new ApiError(409, 'AUTH_BUSY', 'A session request is already in progress.');
    if (this.isAuthenticated())
      throw new ApiError(409, 'ALREADY_SIGNED_IN', 'Log out before signing in to another account.');
    const generation = ++this.generation;
    this.expired.set(false);
    this.session.clear();
    this.workspace?.clear();
    patchState(this.state, { pending: true, loadingStage: 'session' });
    try {
      const response = await firstValueFrom(
        this.api.post<SessionDto>('/sessions', { email, password, remember }),
      );
      if (generation !== this.generation)
        throw new ApiError(0, 'CANCELLED', 'The sign-in request was cancelled.');
      const user = this.sessionUser(response);
      if (this.config.mode === 'http') {
        if (typeof response.token !== 'string')
          throw new ApiError(502, 'INVALID_SESSION', 'The API did not return a session token.');
        try {
          this.session.set(response.token, remember);
        } catch {
          throw new ApiError(502, 'INVALID_SESSION', 'The API returned an invalid session token.');
        }
      }
      patchState(this.state, { user });
      this.initialized = true;
    } finally {
      if (generation === this.generation)
        patchState(this.state, { pending: false, loadingStage: 'idle' });
    }
  }
  clearWorkspace(): void {
    this.generation++;
    this.loading = undefined;
    patchState(this.state, { pending: false, loadingStage: 'idle' });
    this.workspace?.clear();
  }
  async logout(): Promise<void> {
    if (this.pending())
      throw new ApiError(409, 'AUTH_BUSY', 'A session request is already in progress.');
    const generation = ++this.generation;
    patchState(this.state, { pending: true });
    try {
      await firstValueFrom(this.api.delete<void>('/sessions/current'));
      if (generation !== this.generation) return;
      this.session.clear();
      this.initialized = true;
      patchState(this.state, { user: null });
    } catch (error) {
      if (error && typeof error === 'object' && 'status' in error && error.status === 401) {
        // A revoked/expired session is already signed out on the server.
        if (generation === this.generation) {
          this.session.clear();
          this.initialized = true;
          patchState(this.state, { user: null });
        }
        return;
      }
      throw error;
    } finally {
      if (generation === this.generation) patchState(this.state, { pending: false });
    }
  }

  private sessionUser(response: SessionDto): User {
    if (
      !response?.user ||
      typeof response.user.name !== 'string' ||
      !response.user.name.trim() ||
      typeof response.user.email !== 'string' ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(response.user.email)
    )
      throw new ApiError(502, 'INVALID_SESSION', 'The API returned an invalid user session.');
    return { name: response.user.name, email: response.user.email };
  }
}
