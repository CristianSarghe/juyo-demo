import {
  ChangeDetectionStrategy,
  Component,
  Injector,
  effect,
  inject,
  signal,
} from '@angular/core';
import { RouterOutlet, Router } from '@angular/router';
import { TuiRoot } from '@taiga-ui/core';
import { AuthService } from './core/auth.service';
import { NavigationLoadingService } from './shared/navigation-loading.service';
import { SpinnerComponent } from './shared/spinner.component';
import { WorkspaceSkeletonComponent } from './shared/workspace-skeleton.component';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, TuiRoot, SpinnerComponent, WorkspaceSkeletonComponent],
  template: `<tui-root class="min-h-dvh">
    @if (error() || (!navigation.initialized() && navigation.error())) {
      <main class="startup-state">
        <p role="alert">{{ error() || navigation.error() }}</p>
        <button type="button" (click)="start()">Try again</button>
      </main>
    } @else if (!ready() || !navigation.initialized()) {
      @if (auth.loadingStage() === 'workspace' || auth.isAuthenticated()) {
        <app-workspace-skeleton [view]="navigation.targetView()" />
      } @else {
        <main class="startup-state">
          <img src="/assets/juyo-logo.svg" alt="Juyo" width="102" height="32" />
          <span class="startup-status" role="status"
            ><app-spinner [decorative]="true" /> Loading…</span
          >
        </main>
      }
    }
    @if (ready()) {
      <div [class.initial-route-pending]="!navigation.initialized()"><router-outlet /></div>
    }
  </tui-root>`,
  styles: `
    .startup-state {
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 16px;
      padding: 24px;
      color: var(--muted);
      font-size: 13px;
      text-align: center;
    }
    .startup-state p {
      margin: 0;
    }
    .startup-status {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      margin-top: 8px;
    }
    .startup-status app-spinner {
      color: var(--brand-ink);
    }
    .initial-route-pending {
      display: none;
    }
    .startup-state button {
      padding: 10px 18px;
      border-radius: 8px;
      color: white;
      background: var(--brand-ink);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent {
  readonly auth = inject(AuthService);
  readonly navigation = inject(NavigationLoadingService);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private expiring = false;
  readonly ready = signal(false);
  readonly error = signal('');
  constructor() {
    effect(() => {
      if (this.auth.sessionExpired()) void this.expireSession();
    });
    void this.start();
  }
  private async expireSession(): Promise<void> {
    if (this.expiring) return;
    this.expiring = true;
    try {
      const returnUrl = this.router.url;
      await this.router.navigate(['/login'], {
        queryParams: returnUrl === '/' ? {} : { returnUrl },
        replaceUrl: true,
      });
      if (!this.auth.sessionExpired()) return;
      const { AssistantUiStore } = await import('./core/assistant-ui.store');
      if (!this.auth.sessionExpired()) return;
      this.injector.get(AssistantUiStore).clear();
      this.auth.clearWorkspace();
    } catch {
      this.ready.set(false);
      this.error.set('Could not finish signing out. Please reload.');
    } finally {
      this.expiring = false;
    }
  }
  async start(): Promise<void> {
    this.error.set('');
    try {
      await this.auth.initialize();
      this.ready.set(true);
      if (this.navigation.failedUrl()) await this.navigation.retry();
      else this.router.initialNavigation();
    } catch (error) {
      this.error.set(
        error instanceof Error ? error.message : 'Could not load the application. Please retry.',
      );
    }
  }
}
