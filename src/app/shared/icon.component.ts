import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'app-icon',
  template: `<svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    @switch (name()) {
      @case ('plus') {
        <path d="M12 5v14M5 12h14" />
      }
      @case ('arrow') {
        <path d="M5 12h14m-6-6 6 6-6 6" />
      }
      @case ('up') {
        <path d="M12 19V5m-6 6 6-6 6 6" />
      }
      @case ('down') {
        <path d="m8 10 4 4 4-4" />
      }
      @case ('chat') {
        <path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H5l-3 3V12a9 9 0 1 1 18-.5Z" />
      }
      @case ('building') {
        <rect x="5" y="3" width="14" height="18" rx="2" />
        <path d="M9 7h1m4 0h1m-6 4h1m4 0h1m-6 4h1m4 0h1m-5 6v-3h4v3" />
      }
      @case ('menu') {
        <path d="M4 7h16M4 12h16M4 17h16" />
      }
      @case ('close') {
        <path d="m6 6 12 12M6 18 18 6" />
      }
      @case ('logout') {
        <path d="M9 4H5v16h4m0-8h12m-4-4 4 4-4 4" />
      }
      @case ('check') {
        <path d="m5 12 4 4L19 6" />
      }
      @case ('copy') {
        <rect x="8" y="8" width="12" height="13" rx="2" />
        <path d="M15 8V3H3v12h5" />
      }
      @case ('source') {
        <path d="M6 3h9l4 4v14H6V3Z" />
        <path d="M14 3v5h5M9 12h7m-7 4h5" />
      }
      @case ('trash') {
        <path d="M4 7h16m-13 0 1 14h8l1-14M9 7V3h6v4m-5 4v6m4-6v6" />
      }
      @case ('stop') {
        <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
      }
      @case ('help') {
        <circle cx="12" cy="12" r="9" />
        <path d="M9.5 9a2.5 2.5 0 1 1 4 2c-1 .6-1.5 1-1.5 2m0 3h.01" />
      }
      @case ('panel') {
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M9 4v16" />
      }
      @case ('thumb') {
        <path d="M7 10h-4v11h4V10Zm0 0 5-8c2 0 2 3 1 6h6c2 0 2 2 1 5l-2 8H7" />
      }
      @case ('calendar') {
        <rect x="4" y="5" width="16" height="16" rx="3" />
        <path d="M8 3v4m8-4v4M4 10h16" />
      }
      @case ('settings') {
        <path d="M4 6h4m4 0h8M4 12h10m4 0h2M4 18h2m4 0h10" />
        <rect x="8" y="3.5" width="4" height="5" rx="1" />
        <rect x="14" y="9.5" width="4" height="5" rx="1" />
        <rect x="6" y="15.5" width="4" height="5" rx="1" />
      }
      @case ('rates') {
        <path d="M10 3H4v6l10.8 11a2 2 0 0 0 2.8 0l3.4-3.4a2 2 0 0 0 0-2.8L10 3Z" />
        <circle cx="7" cy="6" r="1" />
        <path d="m11 11 6 6m-2-6h.01M11 15h.01" />
      }
      @case ('warning') {
        <path d="M12 3.8 22 20H2L12 3.8Z" />
        <path d="M12 9v4.5" />
        <circle cx="12" cy="16.7" r="0.8" fill="currentColor" stroke="none" />
      }
      @case ('pin') {
        <path d="M12 21c3-4 7-7.6 7-12A7 7 0 0 0 5 9c0 4.4 4 8 7 12Z" />
        <circle cx="12" cy="9" r="2.5" />
      }
      @case ('database') {
        <ellipse cx="12" cy="5" rx="8" ry="3" />
        <path d="M4 5v7c0 4 16 4 16 0V5M4 12v6c0 4 16 4 16 0v-6" />
      }
    }
  </svg>`,
  styles: [
    ':host{display:inline-flex;width:20px;height:20px;flex:none}svg{width:100%;height:100%}',
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class IconComponent {
  readonly name = input.required<string>();
}
