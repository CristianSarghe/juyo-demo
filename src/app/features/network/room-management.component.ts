import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { PageSkeletonComponent } from '../../shared/page-skeleton.component';
import { NetworkComponent } from './network.component';

/** Persistent room-management navigation with a routed page for each section. */
@Component({
  selector: 'app-room-management',
  imports: [RouterLink, RouterLinkActive, RouterOutlet, PageSkeletonComponent],
  template: `
    <nav class="room-sections" aria-label="Room management sections">
      <a
        routerLink="/rooms"
        routerLinkActive="selected"
        [routerLinkActiveOptions]="{
          paths: 'exact',
          queryParams: 'ignored',
          matrixParams: 'ignored',
          fragment: 'ignored',
        }"
        ariaCurrentWhenActive="page"
        >Rooms</a
      >
      <a routerLink="/rooms/prices" routerLinkActive="selected" ariaCurrentWhenActive="page"
        >Room prices</a
      >
    </nav>
    @if (!workspace.needsHotel()) {
      @if (workspace.pageError()) {
        <section class="page-data-error" role="alert">
          <p>{{ workspace.pageError() }}</p>
          <button type="button" (click)="workspace.retryPage()">Try again</button>
        </section>
      } @else if (!workspace.pageReady()) {
        <app-page-skeleton view="rooms" [contentOnly]="true" />
      }
    }
    <router-outlet />
  `,
  styleUrl: './room-management.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RoomManagementComponent {
  readonly workspace = inject(NetworkComponent);
}
