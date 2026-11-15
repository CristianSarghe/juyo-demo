import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { Message } from '../core/models';
import { citedAnswer } from '../core/chat-citations';
import { IconComponent } from './icon.component';

@Component({
  selector: 'app-cited-answer',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p class="answer-text">
      @for (segment of answer().segments; track $index) {
        <span>{{ segment.text }}</span>
        @for (reference of segment.references; track reference.number) {
          <a
            class="citation"
            [href]="reference.source.url"
            target="_blank"
            rel="noopener noreferrer"
            [attr.aria-label]="'Source ' + reference.number + ': ' + reference.source.title"
            [title]="reference.source.title"
            >{{ reference.number }}</a
          >
        }
      }
    </p>
    @if (answer().sources.length) {
      <section class="sources" aria-label="Sources">
        <div class="sources-heading">
          <h4>Sources</h4>
          <span>{{ answer().sources.length }}</span>
        </div>
        <ol class="source-links" role="list">
          @for (source of answer().sources; track source.url; let index = $index) {
            <li>
              <a
                class="source-link"
                [href]="source.url"
                target="_blank"
                rel="noopener noreferrer"
                [attr.aria-label]="
                  'Source ' + (index + 1) + ': ' + source.title + ' (opens in a new tab)'
                "
              >
                <span class="source-number" aria-hidden="true">{{ index + 1 }}</span>
                <span class="source-copy"
                  ><span class="source-title">{{ source.title }}</span
                  ><span class="source-domain">{{ hostname(source.url) }}</span></span
                >
                <app-icon class="source-arrow" name="arrow" />
              </a>
            </li>
          }
        </ol>
      </section>
    }
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    .answer-text {
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-size: 12px;
      line-height: 1.8;
      color: var(--ink);
    }
    .citation {
      display: inline-grid;
      place-items: center;
      vertical-align: super;
      min-width: 16px;
      height: 16px;
      margin-inline: 2px;
      padding-inline: 3px;
      border-radius: 5px;
      background: var(--brand-pale, #f0ebfc);
      color: var(--brand-ink);
      font-size: 9px;
      line-height: 1;
      text-decoration: none;
    }
    a:focus-visible {
      outline: 2px solid var(--brand-ink);
      outline-offset: 3px;
    }
    .citation:hover {
      background: #e3d8fa;
    }
    .sources {
      margin-top: 18px;
      padding-top: 14px;
      border-top: 1px solid var(--line);
    }
    .sources-heading {
      display: flex;
      align-items: baseline;
      gap: 7px;
      margin-bottom: 10px;
    }
    .sources-heading h4 {
      margin: 0;
      color: var(--muted);
      font-size: 11px;
      font-weight: 500;
    }
    .sources-heading > span {
      color: var(--muted);
      font-size: 10px;
      font-variant-numeric: tabular-nums;
    }
    .source-links {
      margin: 0;
      padding: 0;
      list-style: none;
      display: grid;
      gap: 7px;
    }
    .source-link {
      display: grid;
      grid-template-columns: 22px minmax(0, 1fr) 14px;
      align-items: center;
      gap: 8px;
      min-height: 52px;
      padding: 10px 12px 10px 10px;
      border: 1px solid var(--kassandra-line, #e9e1f5);
      border-radius: 9px;
      background: #fcfbfe;
      color: var(--ink);
      text-decoration: none;
      transition:
        background 140ms ease,
        border-color 140ms ease;
    }
    .source-link:hover {
      background: var(--kassandra-soft, #f6f0fc);
      border-color: #d8c9ed;
    }
    .source-number {
      align-self: start;
      padding-top: 1px;
      color: var(--kassandra-muted, #8a73a7);
      font-size: 10px;
      line-height: 1.7;
      font-variant-numeric: tabular-nums;
      text-align: center;
    }
    .source-copy {
      min-width: 0;
    }
    .source-title {
      display: block;
      font-size: 11px;
      font-weight: 550;
      line-height: 1.5;
      overflow-wrap: anywhere;
    }
    .source-domain {
      display: block;
      margin-top: 3px;
      color: var(--muted);
      font-size: 10px;
      line-height: 1.4;
      overflow-wrap: anywhere;
    }
    .source-arrow {
      width: 14px;
      height: 14px;
      color: var(--kassandra-muted, #8a73a7);
      transform: rotate(-45deg);
    }
    @media (prefers-reduced-motion: reduce) {
      .source-link {
        transition: none;
      }
    }
  `,
})
export class CitedAnswerComponent {
  readonly message = input.required<Message>();
  readonly answer = computed(() => citedAnswer(this.message()));
  hostname(url: string): string {
    return new URL(url).hostname.replace(/^www\./, '');
  }
}
