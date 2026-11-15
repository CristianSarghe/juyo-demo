import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Decorative geometry only. Its containing section announces the loading state once. */
@Component({
  selector: 'app-skeleton',
  template: '',
  host: {
    'aria-hidden': 'true',
    '[style.width]': 'width()',
    '[style.height]': 'height()',
    '[style.border-radius]': 'radius()',
  },
  styles: `
    :host {
      display: block;
      max-width: 100%;
      flex-shrink: 0;
      background: var(--loading-surface, #eceeed);
      animation: skeleton-breathe 1.8s ease-in-out infinite;
      pointer-events: none;
    }
    @keyframes skeleton-breathe {
      50% {
        opacity: 0.48;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      :host {
        animation: none;
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SkeletonComponent {
  readonly width = input('100%');
  readonly height = input('14px');
  readonly radius = input('6px');
}
