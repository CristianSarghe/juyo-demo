import { Location } from '@angular/common';
import { DestroyRef, Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  NavigationSkipped,
  NavigationStart,
  PRIMARY_OUTLET,
  RouteConfigLoadEnd,
  RouteConfigLoadStart,
  ResolveStart,
  Router,
  type Route,
} from '@angular/router';
import { patchState, signalState } from '@ngrx/signals';

export type NavigationView =
  | 'overview'
  | 'rooms'
  | 'reservations'
  | 'configuration'
  | 'chat'
  | 'login';

interface NavigationLoadingState {
  pending: boolean;
  visible: boolean;
  initialized: boolean;
  targetView: NavigationView;
  targetUrl: string;
  error: string;
  failedUrl: string | null;
}

/** Route download feedback shared by startup and the authenticated shell. */
@Injectable({ providedIn: 'root' })
export class NavigationLoadingService {
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly destroyRef = inject(DestroyRef);
  private readonly initialUrl = this.location.path() || '/';
  private readonly state = signalState<NavigationLoadingState>({
    pending: false,
    visible: false,
    initialized: false,
    targetView: this.viewFromUrl(this.initialUrl),
    targetUrl: this.initialUrl,
    error: '',
    failedUrl: null,
  });
  private activeNavigationId: number | null = null;
  private showTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly lazyLoads = new Set<Route>();

  readonly pending = this.state.pending;
  readonly visible = this.state.visible;
  readonly initialized = this.state.initialized;
  readonly targetView = this.state.targetView;
  readonly targetUrl = this.state.targetUrl;
  readonly error = this.state.error;
  readonly failedUrl = this.state.failedUrl;

  constructor() {
    this.router.events.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (event instanceof NavigationStart) {
        this.clearTimer();
        this.activeNavigationId = event.id;
        patchState(this.state, {
          pending: true,
          visible: false,
          targetView: this.viewFromUrl(event.url),
          targetUrl: event.url,
          error: '',
          failedUrl: null,
        });
        // Angular reuses an in-flight import when a replacement navigation needs it.
        if (this.lazyLoads.size) this.scheduleFeedback();
      } else if (event instanceof RouteConfigLoadStart) {
        this.lazyLoads.add(event.route);
        this.scheduleFeedback();
      } else if (event instanceof ResolveStart) {
        this.scheduleFeedback();
      } else if (event instanceof RouteConfigLoadEnd) {
        this.lazyLoads.delete(event.route);
      } else if (event instanceof NavigationEnd) {
        if (!this.isCurrent(event.id)) return;
        this.finish({
          initialized: true,
          targetView: this.viewFromUrl(event.urlAfterRedirects),
          targetUrl: event.urlAfterRedirects,
        });
      } else if (event instanceof NavigationError) {
        if (!this.isCurrent(event.id)) return;
        // Failed lazy imports do not emit RouteConfigLoadEnd.
        this.lazyLoads.clear();
        this.finish({
          error: 'Could not open this page. Try again.',
          failedUrl: event.url,
        });
      } else if (event instanceof NavigationCancel || event instanceof NavigationSkipped) {
        if (this.isCurrent(event.id)) this.finish();
      }
    });
    this.destroyRef.onDestroy(() => {
      this.clearTimer();
      this.lazyLoads.clear();
    });
  }

  async retry(): Promise<boolean> {
    const url = this.failedUrl();
    if (!url || this.pending()) return false;
    try {
      return await this.router.navigateByUrl(url, { onSameUrlNavigation: 'reload' });
    } catch {
      // NavigationError publishes the retry state; keep the click handler rejection-free.
      return false;
    }
  }

  private scheduleFeedback(): void {
    const navigationId = this.activeNavigationId;
    if (navigationId === null || this.showTimer !== undefined || this.visible()) return;
    // Cached routes and synchronous query/filter changes never need a loading surface.
    this.showTimer = setTimeout(() => {
      this.showTimer = undefined;
      if (this.isCurrent(navigationId) && this.pending()) patchState(this.state, { visible: true });
    }, 120);
  }

  private isCurrent(id: number): boolean {
    return id === this.activeNavigationId;
  }

  private finish(changes: Partial<NavigationLoadingState> = {}): void {
    this.clearTimer();
    this.activeNavigationId = null;
    patchState(this.state, { pending: false, visible: false, ...changes });
  }

  private clearTimer(): void {
    if (this.showTimer === undefined) return;
    clearTimeout(this.showTimer);
    this.showTimer = undefined;
  }

  private viewFromUrl(url: string): NavigationView {
    try {
      const tree = this.router.parseUrl(url);
      const page = tree.root.children[PRIMARY_OUTLET]?.segments[0]?.path;
      if (page === 'login' || page === 'chat') return page;
      if (page === 'rooms' || page === 'room-prices') return 'rooms';
      if (page === 'reservations') return 'reservations';
      if (page === 'hotel-configuration') return 'configuration';
      if (page !== 'network') return 'overview';
      const view: unknown = tree.queryParams['view'];
      return view === 'rooms' || view === 'reservations' || view === 'configuration'
        ? view
        : 'overview';
    } catch {
      return 'overview';
    }
  }
}
