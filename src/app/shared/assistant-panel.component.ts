import { DOCUMENT, NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  afterNextRender,
  afterRenderEffect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { AssistantUiStore, ASSISTANT_EXAMPLES } from '../core/assistant-ui.store';
import { BrandMarkComponent } from './brand-mark.component';
import { IconComponent } from './icon.component';
import { SpinnerComponent } from './spinner.component';
import { SkeletonComponent } from './skeleton.component';
import { ChatActionComponent } from './chat-action.component';
import { AnswerComponent } from '../features/chat/answer.component';
import { CitedAnswerComponent } from './cited-answer.component';

@Component({
  selector: 'app-assistant-panel',
  imports: [
    NgTemplateOutlet,
    BrandMarkComponent,
    IconComponent,
    SpinnerComponent,
    SkeletonComponent,
    ChatActionComponent,
    AnswerComponent,
    CitedAnswerComponent,
  ],
  templateUrl: './assistant-panel.component.html',
  styleUrl: './assistant-panel.component.css',
  host: { id: 'kassandra-panel', '[class.is-open]': 'assistant.isOpen()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AssistantPanelComponent {
  readonly assistant = inject(AssistantUiStore);
  readonly examples = ASSISTANT_EXAMPLES;
  readonly mobile = signal(false);
  readonly mobileViewport = signal<{ height: number; top: number } | null>(null);
  private readonly document = inject(DOCUMENT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly destroyRef = inject(DestroyRef);
  private readonly prompt = viewChild<ElementRef<HTMLTextAreaElement>>('prompt');
  private readonly transcript = viewChild<ElementRef<HTMLDivElement>>('transcript');
  private readonly mobileDialog = viewChild<ElementRef<HTMLDialogElement>>('mobileDialog');
  private opener: HTMLElement | null = null;
  private wasOpen = false;
  private lastOpenSequence = 0;
  private wasMobile = false;

  constructor() {
    afterNextRender(() => {
      const view = this.document.defaultView;
      if (!view?.matchMedia) return;
      const media = view.matchMedia('(max-width: 760px)');
      const update = () => this.mobile.set(media.matches);
      update();
      media.addEventListener('change', update);
      // Mobile keyboards may resize only the visual viewport, leaving 100dvh unchanged.
      const viewport = view.visualViewport;
      const updateViewport = () => {
        this.mobileViewport.set(
          viewport ? { height: viewport.height, top: viewport.offsetTop } : null,
        );
      };
      updateViewport();
      viewport?.addEventListener('resize', updateViewport);
      viewport?.addEventListener('scroll', updateViewport);
      this.destroyRef.onDestroy(() => {
        media.removeEventListener('change', update);
        viewport?.removeEventListener('resize', updateViewport);
        viewport?.removeEventListener('scroll', updateViewport);
      });
    });
    afterRenderEffect(() => {
      const open = this.assistant.isOpen();
      const mobile = this.mobile();
      const sequence = this.assistant.openSequence();
      const messages = this.assistant.messages();
      if (open) {
        if (!this.wasOpen || this.lastOpenSequence !== sequence) {
          const active = this.document.activeElement;
          if (active instanceof HTMLElement && !this.host.nativeElement.contains(active))
            this.opener =
              active !== this.document.body && active !== this.document.documentElement
                ? active
                : null;
          else if (!this.wasOpen) this.opener = null;
        }
        const dialog = this.mobileDialog()?.nativeElement;
        if (mobile && dialog && !dialog.open) dialog.showModal();
        if (!this.wasOpen || this.wasMobile !== mobile || this.lastOpenSequence !== sequence)
          this.prompt()?.nativeElement.focus({ preventScroll: true });
        const transcript = this.transcript()?.nativeElement;
        if (transcript) transcript.scrollTop = messages.length ? transcript.scrollHeight : 0;
      } else if (this.wasOpen) {
        const fallback =
          this.document.getElementById('assistant-trigger') ??
          this.document.querySelector<HTMLElement>('.mobile-nav-toggle');
        const opener = this.opener;
        const target =
          opener?.isConnected &&
          opener !== this.document.body &&
          opener !== this.document.documentElement &&
          !opener.closest('dialog:not([open])') &&
          opener.getClientRects().length
            ? opener
            : fallback;
        if (target?.getClientRects().length) target.focus({ preventScroll: true });
        else
          this.document
            .querySelector<HTMLElement>('.mobile-nav-toggle')
            ?.focus({ preventScroll: true });
        this.opener = null;
      }
      this.wasOpen = open;
      this.wasMobile = mobile;
      this.lastOpenSequence = sequence;
    });
  }

  @HostListener('document:keydown', ['$event'])
  onEscape(event: KeyboardEvent): void {
    if (
      event.key !== 'Escape' ||
      !this.assistant.isOpen() ||
      this.mobile() ||
      event.defaultPrevented ||
      this.document.querySelector('dialog[open]')
    )
      return;
    event.preventDefault();
    this.assistant.close();
  }

  onCancel(event: Event): void {
    event.preventDefault();
    this.assistant.close();
  }

  chooseExample(prompt: string): void {
    this.assistant.setDraft(prompt);
    this.prompt()?.nativeElement.focus({ preventScroll: true });
  }

  onInput(event: Event): void {
    this.assistant.setDraft((event.target as HTMLTextAreaElement).value);
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      this.send();
    }
  }

  send(): void {
    void this.assistant.send();
    this.prompt()?.nativeElement.focus({ preventScroll: true });
  }

  newConversation(): void {
    this.assistant.newConversation();
    this.prompt()?.nativeElement.focus({ preventScroll: true });
  }
}
