import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'app-brand-mark',
  host: { 'aria-hidden': 'true' },
  template: `<span class="mark"></span>`,
  styles: [
    `:host {
      display: inline-flex;
      width: 34px;
      height: 34px;
      color: var(--kassandra-mark-color, var(--kassandra-ink, #6442a6));
      flex: none;
    }
    .mark {
      display: block;
      width: 100%;
      height: 100%;
      background: currentColor;
      mask: url('/assets/kassandra-logo.svg') center / contain no-repeat;
    }`,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrandMarkComponent {}
