import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TuiDataList, TuiTextfield } from '@taiga-ui/core';
import { TuiSelect } from '@taiga-ui/kit';

export interface AppSelectOption {
  readonly value: string;
  readonly label: string;
}

/** A compact Taiga UI select. Its public value remains an ID, never an option object. */
@Component({
  selector: 'app-select',
  imports: [FormsModule, TuiDataList, TuiTextfield, TuiSelect],
  template: `
    <tui-textfield
      class="select-field"
      tuiTextfieldSize="m"
      [tuiTextfieldCleaner]="false"
      [stringify]="stringify"
    >
      <input
        tuiSelect
        [disabled]="disabled()"
        [attr.id]="inputId()"
        [attr.aria-label]="label()"
        [placeholder]="placeholder()"
        [ngModel]="value()"
        [ngModelOptions]="{ standalone: true }"
        (ngModelChange)="selectValue($event)"
      />
      <svg class="select-chevron" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="m4.75 6.25 3.25 3.5 3.25-3.5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.25"
        />
      </svg>
      <tui-data-list *tuiDropdown class="select-options" size="s">
        @for (option of options(); track option.value) {
          <button
            type="button"
            tuiOption
            class="select-option"
            [class.is-selected]="option.value === value()"
            [value]="option.value"
          >
            {{ option.label }}
          </button>
        }
      </tui-data-list>
    </tui-textfield>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    tui-textfield.select-field {
      min-height: 40px;
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 10px;
      outline: 0;
      box-shadow: none;
      background: var(--surface);
      color: var(--ink);
      transition:
        border-color 140ms,
        box-shadow 140ms;
    }
    tui-textfield.select-field:hover {
      border-color: #cbd3cc;
    }
    tui-textfield.select-field:focus-within {
      border-color: var(--brand-ink);
      box-shadow: 0 0 0 3px var(--brand-focus-ring);
    }
    input[tuiSelect] {
      min-width: 0;
      font:
        500 12px/1.4 'DM Sans',
        sans-serif;
      color: var(--ink);
      padding-inline-end: 32px;
      text-overflow: ellipsis;
    }
    .select-chevron {
      position: absolute;
      right: 12px;
      top: 50%;
      transform: translateY(-50%);
      pointer-events: none;
      color: #727b75;
    }
    .select-options {
      padding: 5px;
    }
    button.select-option {
      min-height: 36px;
      padding: 8px 10px;
      border-radius: 7px;
      font:
        400 12px/1.5 'DM Sans',
        sans-serif;
      color: var(--ink);
    }
    button.select-option.is-selected {
      background: var(--brand-soft);
      color: var(--brand-ink);
      font-weight: 500;
    }
    button.select-option:hover {
      background: #f1f4f1;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppSelectComponent {
  readonly label = input.required<string>();
  readonly inputId = input<string | null>(null);
  readonly placeholder = input('');
  readonly disabled = input(false);
  readonly options = input.required<readonly AppSelectOption[]>();
  readonly value = input.required<string>();
  readonly valueChange = output<string>();
  readonly stringify = (value: string): string =>
    this.options().find((option) => option.value === value)?.label ?? value;

  selectValue(value: string | null): void {
    if (
      !this.disabled() &&
      value !== null &&
      value !== this.value() &&
      this.options().some((option) => option.value === value)
    ) {
      this.valueChange.emit(value);
    }
  }
}
