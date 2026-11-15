import { ChangeDetectionStrategy, Component } from '@angular/core';
import { BrandMarkComponent } from './brand-mark.component';

/** Shared attribution for contextual assistant advice outside the chat transcript. */
@Component({
  selector: 'app-kassandra-note',
  imports: [BrandMarkComponent],
  template: `<app-brand-mark />
    <div class="bubble"><ng-content /></div>`,
  styles: `
    :host {
      display: grid;
      grid-template-columns: 28px minmax(0, 1fr);
      align-items: start;
      gap: 12px;
      min-width: 0;
    }
    app-brand-mark {
      width: 28px;
      height: 28px;
      margin-top: 14px;
    }
    .bubble {
      position: relative;
      min-width: 0;
      padding: 11px 14px;
      border: 1px solid var(--kassandra-line);
      border-radius: 11px;
      background: var(--kassandra-soft);
    }
    .bubble::before {
      content: '';
      position: absolute;
      top: 22px;
      left: -5px;
      width: 8px;
      height: 8px;
      border-left: 1px solid var(--kassandra-line);
      border-bottom: 1px solid var(--kassandra-line);
      background: var(--kassandra-soft);
      transform: rotate(45deg);
      pointer-events: none;
    }
    @media (max-width: 480px) {
      :host {
        grid-template-columns: 24px minmax(0, 1fr);
        gap: 9px;
      }
      app-brand-mark {
        width: 24px;
        height: 24px;
      }
      .bubble {
        padding: 10px 12px;
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class KassandraNoteComponent {}
