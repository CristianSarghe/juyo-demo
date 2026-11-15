import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { SkeletonComponent } from './skeleton.component';

/** Mirrors each destination's structure without inventing values or interactive controls. */
@Component({
  selector: 'app-page-skeleton',
  imports: [SkeletonComponent],
  template: `
    <p class="sr-only" role="status">{{ label() }}</p>
    <section
      class="page-placeholder"
      [class.content-only]="contentOnly()"
      aria-busy="true"
      [attr.aria-label]="label()"
    >
      @if (!contentOnly()) {
        <div class="placeholder-heading" aria-hidden="true">
          <div class="heading-lines">
            <app-skeleton width="180px" height="28px" /><app-skeleton width="110px" height="11px" />
          </div>
        </div>
      }
      @if (view() === 'overview' || view() === 'chat') {
        <div class="dashboard-placeholder" aria-hidden="true">
          <div class="placeholder-card revenue-placeholder">
            <app-skeleton width="55%" height="14px" />
            <div class="revenue-values">
              <app-skeleton width="38%" height="38px" /><app-skeleton width="38%" height="38px" />
            </div>
            <div class="chart-placeholder"><app-skeleton height="100%" radius="8px" /></div>
            <app-skeleton width="65px" height="13px" /><app-skeleton height="10px" radius="10px" />
            <div class="legend-placeholder">
              <app-skeleton width="22%" height="8px" /><app-skeleton
                width="22%"
                height="8px"
              /><app-skeleton width="22%" height="8px" />
            </div>
          </div>
          <div class="rail-placeholder">
            <div class="placeholder-card">
              <app-skeleton width="100px" /><app-skeleton height="85px" />
              <div class="revenue-values">
                <app-skeleton width="42%" height="32px" /><app-skeleton width="42%" height="32px" />
              </div>
            </div>
            <div class="placeholder-card">
              <app-skeleton width="130px" />
              @for (width of ['90%', '72%', '55%', '33%']; track $index) {
                <app-skeleton [width]="width" height="10px" />
              }
            </div>
          </div>
        </div>
        <div class="placeholder-card outlook-placeholder" aria-hidden="true">
          <app-skeleton width="210px" />
          @for (row of rows; track row) {
            <div class="table-placeholder-row">
              <app-skeleton width="35%" /><app-skeleton width="18%" /><app-skeleton width="18%" />
            </div>
          }
        </div>
      } @else {
        @if (view() === 'rooms') {
          <div class="room-summary-placeholder" aria-hidden="true">
            @for (row of [0, 1, 2, 3]; track row) {
              <div class="placeholder-card">
                <app-skeleton width="70%" /><app-skeleton width="45%" height="30px" /><app-skeleton
                  width="80px"
                  height="11px"
                />
              </div>
            }
          </div>
        }
        <div class="placeholder-card" aria-hidden="true">
          <app-skeleton width="150px" height="18px" />
          <div class="table-placeholder">
            @for (row of rows; track row) {
              <div class="table-placeholder-row">
                <app-skeleton width="27%" /><app-skeleton width="18%" /><app-skeleton
                  width="18%"
                /><app-skeleton width="14%" />
              </div>
            }
          </div>
        </div>
      }
    </section>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    .page-placeholder {
      padding: 32px 36px;
    }
    .page-placeholder.content-only {
      padding: 0;
    }
    .placeholder-heading {
      margin-bottom: 26px;
    }
    .heading-lines {
      display: grid;
      gap: 13px;
    }
    .placeholder-card {
      display: flex;
      flex-direction: column;
      gap: 22px;
      padding: 24px;
      background: var(--surface);
      border-radius: var(--radius);
      min-width: 0;
    }
    .dashboard-placeholder {
      display: grid;
      grid-template-columns: minmax(0, 2.25fr) minmax(240px, 1fr);
      gap: 14px;
    }
    .revenue-values,
    .legend-placeholder {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
    }
    .revenue-values {
      margin-top: 8px;
    }
    .chart-placeholder {
      height: 220px;
      padding-top: 14px;
    }
    .rail-placeholder {
      display: grid;
      gap: 14px;
    }
    .outlook-placeholder {
      margin-top: 24px;
    }
    .table-placeholder-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 20px;
      min-height: 48px;
      border-top: 1px solid var(--line);
    }
    .table-placeholder {
      display: grid;
    }
    .room-summary-placeholder {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 14px;
      margin-bottom: 22px;
    }
    @media (max-width: 1050px) {
      .page-placeholder {
        padding: 28px 24px;
      }
      .dashboard-placeholder {
        grid-template-columns: minmax(0, 1.8fr) minmax(200px, 1fr);
      }
    }
    @media (max-width: 760px) {
      .page-placeholder {
        padding: 24px 14px;
      }
      .dashboard-placeholder {
        grid-template-columns: 1fr;
      }
      .rail-placeholder {
        grid-template-columns: 1fr 1fr;
      }
      .room-summary-placeholder {
        grid-template-columns: 1fr 1fr;
      }
      .chart-placeholder {
        height: 180px;
      }
      .placeholder-card {
        padding: 20px;
        gap: 18px;
      }
    }
    @media (max-width: 420px) {
      .rail-placeholder {
        grid-template-columns: 1fr;
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PageSkeletonComponent {
  readonly view = input('overview');
  readonly contentOnly = input(false);
  readonly label = input('Loading page…');
  readonly rows = [0, 1, 2, 3, 4, 5];
}
