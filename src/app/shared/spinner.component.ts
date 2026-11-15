import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** One shared indicator for pending actions. Button text supplies its accessible label. */
@Component({
  selector: 'app-spinner',
  template: `<span class="spinner-ring" aria-hidden="true"></span>`,
  host: {
    '[attr.data-size]': 'size()',
    '[attr.role]': 'decorative() ? null : "status"',
    '[attr.aria-label]': 'decorative() ? null : label()',
    '[attr.aria-hidden]': 'decorative() ? "true" : null',
  },
  styles: `
    :host {
      display: inline-flex;
      flex: none;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      color: inherit;
      vertical-align: middle;
      pointer-events: none;
    }
    :host([data-size='sm']) {
      width: 14px;
      height: 14px;
    }
    :host([data-size='lg']) {
      width: 26px;
      height: 26px;
    }
    .spinner-ring {
      width: 100%;
      height: 100%;
      border: 2px solid currentColor;
      border-right-color: transparent;
      border-bottom-color: transparent;
      border-radius: 50%;
      animation: spinner-turn 760ms linear infinite;
    }
    @keyframes spinner-turn {
      to {
        transform: rotate(360deg);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .spinner-ring {
        animation: none;
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SpinnerComponent {
  readonly size = input<'sm' | 'md' | 'lg'>('md');
  readonly label = input('Loading…');
  readonly decorative = input(false);
}
