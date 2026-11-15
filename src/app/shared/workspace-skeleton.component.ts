import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { SkeletonComponent } from './skeleton.component';
import { PageSkeletonComponent } from './page-skeleton.component';

@Component({
  selector: 'app-workspace-skeleton',
  imports: [SkeletonComponent, PageSkeletonComponent],
  template: `
    <div class="workspace-placeholder">
      <div class="toolbar-placeholder" aria-hidden="true">
        <img src="/assets/juyo-logo.svg" alt="" width="91" height="32" />
        <app-skeleton class="hotel-placeholder" width="240px" height="36px" radius="8px" />
        <div class="toolbar-end">
          <app-skeleton width="105px" height="34px" radius="8px" /><app-skeleton
            width="115px"
            height="34px"
            radius="8px"
          /><app-skeleton width="30px" height="30px" radius="50%" />
        </div>
      </div>
      <div class="workspace-body">
        <div class="sidebar-placeholder" aria-hidden="true">
          @for (width of ['74%', '92%', '82%', '96%', '86%']; track $index) {
            <div class="nav-placeholder">
              <app-skeleton width="15px" height="15px" radius="3px" /><app-skeleton
                [width]="width"
                height="11px"
              />
            </div>
          }
        </div>
        <app-page-skeleton class="main-placeholder" [view]="view()" label="Loading workspace…" />
      </div>
    </div>
  `,
  styles: `
    :host {
      display: block;
      min-height: 100dvh;
      background: var(--canvas);
    }
    .workspace-placeholder {
      padding: 12px;
      min-height: 100dvh;
    }
    .toolbar-placeholder {
      display: flex;
      align-items: center;
      gap: 22px;
      height: 68px;
      padding: 0 22px;
      background: #fff;
      border: 1px solid var(--line);
      border-radius: 13px;
    }
    .toolbar-placeholder img {
      flex: none;
      object-fit: contain;
    }
    .toolbar-end {
      display: flex;
      align-items: center;
      gap: 14px;
      margin-left: auto;
    }
    .workspace-body {
      display: flex;
      align-items: stretch;
      gap: 12px;
      margin-top: 12px;
    }
    .sidebar-placeholder {
      display: flex;
      flex-direction: column;
      gap: 22px;
      flex: 0 0 220px;
      padding: 27px 22px;
      background: #fff;
      border: 1px solid var(--line);
      border-radius: 13px;
      min-height: calc(100dvh - 104px);
    }
    .nav-placeholder {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .nav-placeholder app-skeleton:last-child {
      flex-shrink: 1;
    }
    .main-placeholder {
      flex: 1;
      min-width: 0;
    }
    @media (max-width: 1100px) {
      .sidebar-placeholder {
        flex-basis: 208px;
      }
      .toolbar-placeholder {
        gap: 16px;
        padding-inline: 16px;
      }
    }
    @media (max-width: 760px) {
      .workspace-placeholder {
        padding: 8px;
      }
      .toolbar-placeholder {
        height: 62px;
        padding-inline: 12px;
        gap: 14px;
      }
      .toolbar-placeholder img {
        width: 74px;
      }
      .sidebar-placeholder {
        display: none;
      }
      .toolbar-end app-skeleton:not(:last-child) {
        display: none;
      }
      .hotel-placeholder {
        flex: 1;
        min-width: 0;
      }
      .workspace-body {
        margin-top: 8px;
      }
    }
    @media (max-width: 420px) {
      .toolbar-placeholder {
        gap: 10px;
      }
      .toolbar-end {
        gap: 0;
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkspaceSkeletonComponent {
  readonly view = input('overview');
}
