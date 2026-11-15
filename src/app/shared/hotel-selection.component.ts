import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  inject,
  output,
  signal,
} from '@angular/core';
import { ReferenceDataService } from '../core/api/reference-data.service';
import { AppSelectComponent } from './select.component';

/** The unconfirmed choice belongs to this screen; only Continue changes global context. */
@Component({
  selector: 'app-hotel-selection',
  imports: [AppSelectComponent],
  template: `
    <form (submit)="confirm($event)" aria-labelledby="hotel-selection-title">
      <h1 id="hotel-selection-title">What place do you want to see data for?</h1>
      <div class="selection-controls">
        <label for="hotel-selection">Hotel</label>
        <app-select
          inputId="hotel-selection"
          label="Choose a hotel"
          placeholder="Choose a hotel"
          [options]="hotelOptions"
          [value]="draft()"
          (valueChange)="draft.set($event)"
        />
        <button type="submit" [disabled]="!draft()">Continue</button>
      </div>
    </form>
  `,
  styles: `
    :host {
      display: block;
      width: min(100%, 460px);
    }
    h1 {
      margin: 0 0 32px;
      max-width: 450px;
      color: var(--ink);
      font-size: clamp(25px, 2.5vw, 32px);
      font-weight: 600;
      line-height: 1.25;
      letter-spacing: -1px;
      text-align: center;
      text-wrap: balance;
    }
    .selection-controls {
      width: min(100%, 320px);
      margin-inline: auto;
    }
    label {
      display: block;
      margin: 0 0 8px;
      font-size: 12px;
      font-weight: 500;
    }
    button {
      display: block;
      width: 100%;
      min-height: 42px;
      margin-top: 16px;
      border-radius: 9px;
      background: var(--brand-ink);
      color: white;
      font-size: 12px;
      font-weight: 600;
      transition:
        background 150ms,
        opacity 150ms;
    }
    button:hover:not(:disabled) {
      background: var(--brand-hover);
    }
    button:disabled {
      opacity: 0.4;
      cursor: default;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HotelSelectionComponent {
  private readonly hotels = inject(ReferenceDataService).data.hotels;
  readonly selected = output<string>();
  readonly draft = signal('');
  readonly hotelOptions = this.hotels.map((hotel) => ({ value: hotel.id, label: hotel.name }));
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    afterNextRender(() => this.host.nativeElement.querySelector('input')?.focus());
  }

  confirm(event: SubmitEvent): void {
    event.preventDefault();
    if (this.hotels.some((hotel) => hotel.id === this.draft())) this.selected.emit(this.draft());
  }
}
