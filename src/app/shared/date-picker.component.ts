import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { TuiAutoFocus, TuiDay, TuiMonth, tuiGenerateId } from '@taiga-ui/cdk';
import {
  TuiCalendar,
  TuiDropdown,
  TuiDropdownDirective,
  tuiCalendarSheetOptionsProvider,
  tuiIconsProvider,
} from '@taiga-ui/core';
import { IconComponent } from './icon.component';

const fullDate = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** A bounded single date, with an editable keyboard alternative to the Taiga calendar. */
@Component({
  selector: 'app-date-picker',
  imports: [TuiAutoFocus, TuiCalendar, TuiDropdown, IconComponent],
  providers: [
    tuiCalendarSheetOptionsProvider({ rangeMode: false }),
    tuiIconsProvider({
      '@tui.chevron-left':
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="m10 3-5 5 5 5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
      '@tui.chevron-right':
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
    }),
  ],
  templateUrl: './date-picker.component.html',
  styleUrl: './date-picker.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DatePickerComponent {
  readonly value = input.required<string>();
  readonly min = input.required<string>();
  readonly max = input.required<string>();
  readonly label = input.required<string>();
  readonly disabled = input(false);
  readonly hint = input('');
  readonly valueChange = output<string>();
  readonly id = tuiGenerateId();
  readonly open = signal(false);
  readonly draftText = signal('');
  readonly touched = signal(false);
  readonly viewedMonth = signal<TuiMonth>(TuiMonth.currentLocal());
  readonly trigger = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  readonly dropdown = viewChild(TuiDropdownDirective);
  readonly minDay = computed(() => TuiDay.jsonParse(this.min()));
  readonly maxDay = computed(() => TuiDay.jsonParse(this.max()));
  readonly displayValue = computed(() =>
    fullDate.format(TuiDay.jsonParse(this.value()).toUtcNativeDate()),
  );
  readonly accessibleLabel = computed(() => `${this.label()}, ${this.displayValue()}`);
  readonly boundsLabel = computed(
    () =>
      `${fullDate.format(this.minDay().toUtcNativeDate())} to ${fullDate.format(this.maxDay().toUtcNativeDate())}`,
  );
  readonly draftDay = computed(() => this.parseField(this.draftText()));
  readonly validation = computed(() => {
    const day = this.draftDay();
    if (!day) return 'Enter a valid date as DD/MM/YYYY.';
    return this.inBounds(day) ? '' : `Use a date from ${this.boundsLabel()}.`;
  });
  readonly calendarValue = computed(() => (this.validation() ? null : this.draftDay()));
  readonly showError = computed(() => this.touched() && !!this.validation());

  constructor() {
    effect(() => {
      const popup = this.dropdown()?.ref()?.location.nativeElement;
      popup?.setAttribute('aria-labelledby', `${this.id}-title`);
    });
    effect(() => {
      if (this.disabled()) this.open.set(false);
    });
  }

  onOpenChange(open: boolean): void {
    this.open.set(open && !this.disabled());
    if (this.open()) {
      const day = TuiDay.jsonParse(this.value());
      this.draftText.set(this.formatField(day));
      this.viewedMonth.set(day.dayLimit(this.minDay(), this.maxDay()));
      this.touched.set(false);
    }
  }

  chooseDay(day: TuiDay): void {
    if (this.disabled() || !this.inBounds(day)) return;
    this.valueChange.emit(day.toJSON());
    this.close();
  }

  editField(event: Event): void {
    this.draftText.set((event.target as HTMLInputElement).value);
    const day = this.draftDay();
    if (day && this.inBounds(day)) this.viewedMonth.set(day);
  }

  blurField(): void {
    this.touched.set(true);
    const day = this.draftDay();
    if (day) this.draftText.set(this.formatField(day));
  }

  apply(): void {
    const day = this.draftDay();
    this.touched.set(true);
    if (!day || this.validation() || this.disabled()) return;
    this.chooseDay(day);
  }

  close(): void {
    this.open.set(false);
    this.trigger()?.nativeElement.focus({ preventScroll: true });
  }

  private inBounds(day: TuiDay): boolean {
    return day.daySameOrAfter(this.minDay()) && day.daySameOrBefore(this.maxDay());
  }

  private parseField(value: string): TuiDay | null {
    const digits = value.trim().replaceAll('/', '');
    if (!/^\d{8}$/.test(digits)) return null;
    const day = Number(digits.slice(0, 2));
    const month = Number(digits.slice(2, 4)) - 1;
    const year = Number(digits.slice(4));
    return TuiDay.isValidDay(year, month, day) ? new TuiDay(year, month, day) : null;
  }

  private formatField(day: TuiDay): string {
    return `${String(day.day).padStart(2, '0')}/${String(day.month + 1).padStart(2, '0')}/${day.year}`;
  }
}
