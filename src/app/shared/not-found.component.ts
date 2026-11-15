import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  inject,
} from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-not-found',
  imports: [RouterLink],
  template: `
    <main aria-labelledby="not-found-title">
      <h1 id="not-found-title" tabindex="-1">Page not found</h1>
      <p>This address does not match a page in Juyo.</p>
      <a routerLink="/">Go to dashboard</a>
    </main>
  `,
  styles: `
    :host {
      display: grid;
      flex: 1;
      place-items: center;
      padding: 32px;
    }
    main {
      width: min(100%, 480px);
    }
    h1 {
      margin: 0 0 12px;
      font-size: 28px;
      font-weight: 600;
      letter-spacing: -1px;
    }
    h1:focus {
      outline: none;
    }
    p {
      color: var(--muted);
      font-size: 14px;
      line-height: 1.6;
    }
    a {
      display: inline-block;
      margin-top: 12px;
      padding: 12px 18px;
      border-radius: 8px;
      background: var(--brand-ink);
      color: white;
      font-size: 13px;
      text-decoration: none;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NotFoundComponent {
  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef);
    afterNextRender(() => host.nativeElement.querySelector<HTMLElement>('h1')?.focus());
  }
}
