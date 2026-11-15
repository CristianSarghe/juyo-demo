import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { TuiAutoFocus } from '@taiga-ui/cdk';
import { TuiDataList, TuiDropdown } from '@taiga-ui/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { AuthService } from '../core/auth.service';
import { AssistantUiStore } from '../core/assistant-ui.store';
import { IconComponent } from './icon.component';
import { AppSelectComponent } from './select.component';
import { HotelNotificationsComponent } from './hotel-notifications.component';
import { HotelScopeService } from '../core/hotel-scope.service';
import { ReferenceDataService } from '../core/api/reference-data.service';
import { AppUiStore } from '../core/app-ui.store';
import { NavigationLoadingService } from './navigation-loading.service';
import { PageSkeletonComponent } from './page-skeleton.component';
import { SpinnerComponent } from './spinner.component';
import { AssistantPanelComponent } from './assistant-panel.component';
import { BrandMarkComponent } from './brand-mark.component';

@Component({
  selector: 'app-shell',
  imports: [
    NgTemplateOutlet,
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    IconComponent,
    AppSelectComponent,
    HotelNotificationsComponent,
    PageSkeletonComponent,
    SpinnerComponent,
    AssistantPanelComponent,
    BrandMarkComponent,
    TuiAutoFocus,
    TuiDataList,
    TuiDropdown,
  ],
  templateUrl: './app-shell.component.html',
  styleUrl: './app-shell.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppShellComponent {
  readonly auth = inject(AuthService);
  readonly navigation = inject(NavigationLoadingService);
  readonly hotels = inject(HotelScopeService);
  private readonly ui = inject(AppUiStore);
  private readonly reference = inject(ReferenceDataService).data;
  readonly hotelOptions = [
    { value: 'portfolio', label: `All ${this.reference.hotels.length} hotels` },
    ...this.reference.hotels.map((hotel) => ({ value: hotel.id, label: hotel.name })),
  ];
  readonly assistant = inject(AssistantUiStore);
  private readonly router = inject(Router);
  private readonly currentUrl = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );
  readonly firstName = computed(() => this.auth.user()?.name.split(' ')[0] ?? 'User');
  readonly accountMenuOpen = signal(false);
  readonly loggingOut = signal(false);
  readonly logoutError = signal('');
  readonly mobileNav = viewChild<ElementRef<HTMLDialogElement>>('mobileNav');
  private readonly notifications = viewChild(HotelNotificationsComponent);

  constructor() {
    this.ui.reconcileReferenceContext();
    effect(() => {
      const url = this.router.parseUrl(this.currentUrl());
      if (url.queryParams['assistant'] !== 'open') return;
      untracked(() => this.openAssistant());
      delete url.queryParams['assistant'];
      void this.router.navigateByUrl(url, { replaceUrl: true });
    });
  }

  @HostListener('document:keydown', ['$event']) onShortcut(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      this.openAssistant();
    }
  }
  selectHotel(value: string): void {
    this.hotels.select(value);
  }
  openNav(): void {
    this.accountMenuOpen.set(false);
    this.notifications()?.closeAll();
    this.assistant.close();
    this.mobileNav()?.nativeElement.showModal();
  }
  closeNav(): void {
    this.mobileNav()?.nativeElement.close();
  }
  closeOnBackdrop(event: MouseEvent): void {
    if (event.target === this.mobileNav()?.nativeElement) this.closeNav();
  }
  openAssistant(): void {
    this.accountMenuOpen.set(false);
    this.notifications()?.closeAll();
    this.closeNav();
    this.assistant.open();
  }
  async logout(): Promise<void> {
    if (this.loggingOut()) return;
    this.loggingOut.set(true);
    this.logoutError.set('');
    this.notifications()?.closeAll();
    this.closeNav();
    try {
      await this.auth.logout();
      this.accountMenuOpen.set(false);
      await this.router.navigateByUrl('/login');
      this.assistant.clear();
      this.auth.clearWorkspace();
    } catch {
      this.logoutError.set('Could not log out. Try again.');
      this.accountMenuOpen.set(true);
    } finally {
      this.loggingOut.set(false);
    }
  }
}
