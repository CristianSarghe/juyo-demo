import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
  signal,
  viewChild,
  ElementRef,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IconComponent } from './icon.component';

@Component({
  selector: 'app-composer',
  imports: [FormsModule, IconComponent],
  template: `
    <form
      class="composer flex items-end gap-3"
      (ngSubmit)="send()"
      [attr.aria-busy]="busy() ? true : null"
    >
      <label class="sr-only" for="chat-prompt">Ask Kassandra</label>
      <textarea
        #prompt
        class="min-w-0 flex-1"
        id="chat-prompt"
        name="prompt"
        [ngModel]="draft()"
        (ngModelChange)="draft.set($event)"
        placeholder="Ask a question…"
        rows="1"
        maxlength="2000"
        (keydown)="onKeydown($event)"
        [readOnly]="busy()"
        [disabled]="disabled()"
      ></textarea>
      @if (busy()) {
        <button
          class="send-button"
          type="button"
          (click)="stop.emit()"
          aria-label="Stop response"
          title="Stop response"
        >
          <app-icon name="stop" />
        </button>
      } @else {
        <button
          class="send-button"
          type="submit"
          [disabled]="disabled() || !draft().trim()"
          aria-label="Send message"
          title="Send (Enter)"
        >
          <app-icon name="up" />
        </button>
      }
    </form>
  `,
  styles: [
    `
      :host {
        display: block;
        width: 100%;
      }
      .composer {
        padding: 14px;
        background: white;
        border: 1px solid #e0e5e0;
        border-radius: 12px;
        box-shadow: 0 2px 3px #1b211f02;
        transition:
          border-color 0.2s,
          box-shadow 0.2s;
      }
      .composer:focus-within {
        border-color: var(--brand-ink);
        box-shadow: 0 0 0 2px var(--brand-focus-ring);
      }
      textarea {
        display: block;
        width: 100%;
        border: 0;
        outline: 0 !important;
        resize: none;
        min-height: 42px;
        max-height: 144px;
        field-sizing: content;
        font-size: 14px;
        line-height: 1.7;
        background: transparent;
        color: var(--ink);
        padding: 6px 2px;
      }
      textarea::placeholder {
        color: #909891;
      }
      .send-button {
        display: grid;
        place-items: center;
        width: 38px;
        height: 38px;
        flex: none;
        border-radius: 9px;
        background: var(--brand);
        color: var(--ink);
        transition:
          background 0.2s,
          color 0.2s,
          transform 0.15s;
      }
      .send-button:hover:not(:disabled) {
        background: var(--brand-hover);
        color: #fff;
      }
      .send-button:active:not(:disabled) {
        transform: scale(0.94);
      }
      .send-button:disabled {
        color: #a0aaa2;
        background: #edf1ed;
      }
      .send-button app-icon {
        width: 19px;
        height: 19px;
      }
      @media (max-width: 600px) {
        .composer {
          padding: 11px;
          border-radius: 11px;
        }
        textarea {
          font-size: 16px;
        }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComposerComponent {
  readonly busy = input(false);
  readonly disabled = input(false);
  readonly submitPrompt = output<string>();
  readonly stop = output<void>();
  readonly draft = signal('');
  readonly prompt = viewChild<ElementRef<HTMLTextAreaElement>>('prompt');
  send(): void {
    const value = this.draft().trim();
    if (!value || this.busy() || this.disabled()) return;
    this.submitPrompt.emit(value);
    this.draft.set('');
    this.focus();
  }
  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      this.send();
    }
  }
  focus(): void {
    this.prompt()?.nativeElement.focus();
  }
  restoreDraft(value: string): void {
    if (!this.draft()) this.draft.set(value);
  }
}
