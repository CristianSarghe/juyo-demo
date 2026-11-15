import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { TuiAutoFocus, TuiDay, TuiDayRange, TuiMonth, tuiGenerateId } from '@taiga-ui/cdk';
import {
  TuiCalendar,
  TuiDropdown,
  TuiDropdownDirective,
  tuiCalendarSheetOptionsProvider,
  tuiIconsProvider,
} from '@taiga-ui/core';
import type { DateRange } from '../core/network.models';
import { ReferenceDataService } from '../core/api/reference-data.service';
import { IconComponent } from './icon.component';

const fullDate = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const shortDate = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});

@Component({
  selector: 'app-date-range-picker',
  imports: [TuiAutoFocus, TuiCalendar, TuiDropdown, IconComponent],
  providers: [
    tuiCalendarSheetOptionsProvider({ rangeMode: true }),
    tuiIconsProvider({
      '@tui.chevron-left':
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="m10 3-5 5 5 5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
      '@tui.chevron-right':
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
    }),
  ],
  templateUrl: './date-range-picker.component.html',
  styleUrl: './date-range-picker.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DateRangePickerComponent {
  readonly value = input.required<DateRange>();
  readonly valueChange = output<DateRange>();
  readonly id = tuiGenerateId();
  private readonly reference = inject(ReferenceDataService).data;
  readonly periods = this.reference.reportingPeriods;
  readonly today = TuiDay.jsonParse(this.reference.bookingSnapshot.asOf);
  readonly min = TuiDay.jsonParse(this.periods[0].startDate);
  readonly max = TuiDay.jsonParse(this.periods[this.periods.length - 1].endDate);
  readonly open = signal(false);
  readonly custom = signal(false);
  readonly startText = signal('');
  readonly endText = signal('');
  readonly touched = signal(false);
  readonly pendingStart = signal<TuiDay | null>(null);
  readonly viewedMonth = signal<TuiMonth>(this.today);
  readonly trigger = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  readonly startInput = viewChild<ElementRef<HTMLInputElement>>('startInput');
  readonly dropdown = viewChild(TuiDropdownDirective);
  private readonly injector = inject(Injector);

  readonly label = computed(() => this.formatRange(this.value()));
  readonly accessibleLabel = computed(
    () => `Reporting dates, ${this.formatRange(this.value(), false)}`,
  );
  readonly startDay = computed(() => this.parseField(this.startText()));
  readonly endDay = computed(() => this.parseField(this.endText()));
  readonly validation = computed(() => {
    const start = this.startDay();
    const end = this.endDay();
    if (!start || !end) return 'Enter valid dates as DD/MM/YYYY.';
    if (!this.inBounds(start) || !this.inBounds(end))
      return `Use dates from ${fullDate.format(this.min.toUtcNativeDate())} to ${fullDate.format(this.max.toUtcNativeDate())}.`;
    if (end.dayBefore(start)) return 'End date must be on or after start date.';
    return '';
  });
  readonly draftRange = computed(() => {
    const start = this.startDay();
    const end = this.endDay();
    return start && end && !this.validation() ? new TuiDayRange(start, end) : null;
  });
  readonly calendarValue = computed(() => this.pendingStart() ?? this.draftRange());
  readonly startInvalid = computed(
    () => this.touched() && (!this.startDay() || !this.inBounds(this.startDay()!)),
  );
  readonly endInvalid = computed(
    () =>
      this.touched() &&
      (!this.endDay() ||
        !this.inBounds(this.endDay()!) ||
        !!(this.startDay() && this.endDay()?.dayBefore(this.startDay()!))),
  );

  constructor() {
    effect(() => {
      const popup = this.dropdown()?.ref()?.location.nativeElement;
      popup?.setAttribute('aria-labelledby', `${this.id}-title`);
    });
  }

  onOpenChange(open: boolean): void {
    this.open.set(open);
    this.custom.set(false);
    this.resetDraft();
  }
  toggleCustom(): void {
    this.custom.set(!this.custom());
    this.resetDraft();
    if (this.custom()) {
      afterNextRender(() => this.startInput()?.nativeElement.focus(), { injector: this.injector });
    }
  }
  choosePreset(startDate: string, endDate: string): void {
    this.valueChange.emit({ startDate, endDate });
    this.close();
  }
  chooseToday(): void {
    const date = this.today.toJSON();
    this.choosePreset(date, date);
  }
  isActive(startDate: string, endDate: string): boolean {
    return this.value().startDate === startDate && this.value().endDate === endDate;
  }
  chooseDay(day: TuiDay): void {
    if (!this.inBounds(day)) return;
    const start = this.pendingStart();
    const range = start ? TuiDayRange.sort(start, day) : new TuiDayRange(day, day);
    this.startText.set(this.formatField(range.from));
    this.endText.set(this.formatField(range.to));
    this.pendingStart.set(start ? null : day);
    this.touched.set(false);
  }
  editField(field: 'start' | 'end', event: Event): void {
    (field === 'start' ? this.startText : this.endText).set(
      (event.target as HTMLInputElement).value,
    );
    this.pendingStart.set(null);
  }
  blurField(field: 'start' | 'end'): void {
    this.touched.set(true);
    const day = field === 'start' ? this.startDay() : this.endDay();
    if (day) {
      (field === 'start' ? this.startText : this.endText).set(this.formatField(day));
      if (field === 'start' && this.inBounds(day)) this.viewedMonth.set(day);
    }
  }
  apply(): void {
    const range = this.draftRange();
    if (!range) {
      this.touched.set(true);
      return;
    }
    this.valueChange.emit({ startDate: range.from.toJSON(), endDate: range.to.toJSON() });
    this.close();
  }
  close(): void {
    this.open.set(false);
    this.custom.set(false);
    this.resetDraft();
    this.trigger()?.nativeElement.focus({ preventScroll: true });
  }
  private resetDraft(): void {
    const from = TuiDay.jsonParse(this.value().startDate).dayLimit(this.min, this.max);
    const to = TuiDay.jsonParse(this.value().endDate).dayLimit(this.min, this.max);
    this.startText.set(this.formatField(from));
    this.endText.set(this.formatField(to));
    this.viewedMonth.set(from);
    this.pendingStart.set(null);
    this.touched.set(false);
  }
  private inBounds(day: TuiDay): boolean {
    return day.daySameOrAfter(this.min) && day.daySameOrBefore(this.max);
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
  private formatRange(range: DateRange, todayLabel = true): string {
    const period = this.periods.find(
      (period) => period.startDate === range.startDate && period.endDate === range.endDate,
    );
    if (period) return period.label;
    const from = TuiDay.jsonParse(range.startDate);
    const to = TuiDay.jsonParse(range.endDate);
    if (from.daySame(to))
      return todayLabel && from.daySame(this.today)
        ? 'Today'
        : fullDate.format(from.toUtcNativeDate());
    if (from.monthSame(to)) return `${from.day}–${fullDate.format(to.toUtcNativeDate())}`;
    return `${(from.year === to.year ? shortDate : fullDate).format(from.toUtcNativeDate())}–${fullDate.format(to.toUtcNativeDate())}`;
  }
}
