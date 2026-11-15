import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  OnDestroy,
  afterNextRender,
  afterRenderEffect,
  inject,
  computed,
  signal,
  viewChild,
} from '@angular/core';
import { ChatService } from '../../core/chat.service';
import { ReportingScopeService } from '../../core/reporting-scope.service';
import { BrandMarkComponent } from '../../shared/brand-mark.component';
import { IconComponent } from '../../shared/icon.component';
import { ComposerComponent } from '../../shared/composer.component';
import { AnswerComponent } from './answer.component';
import { SpinnerComponent } from '../../shared/spinner.component';
import { SkeletonComponent } from '../../shared/skeleton.component';

@Component({
  selector: 'app-chat',
  imports: [
    BrandMarkComponent,
    IconComponent,
    ComposerComponent,
    AnswerComponent,
    SpinnerComponent,
    SkeletonComponent,
  ],
  templateUrl: './chat.component.html',
  styleUrl: './chat.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatComponent implements OnDestroy {
  readonly chat = inject(ChatService);
  readonly reporting = inject(ReportingScopeService);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  readonly composer = viewChild(ComposerComponent);
  readonly feed = viewChild<ElementRef<HTMLElement>>('feed');
  readonly error = signal('');
  readonly submitting = signal(false);
  readonly pendingPrompt = signal('');
  readonly responding = computed(() => this.submitting() || this.chat.isResponding());
  readonly prompts = computed(() => [
    `Show ${this.reporting.period().label} occupancy`,
    'Which booking channel is most profitable?',
    'What are the operating costs?',
    'How is the restaurant performing?',
  ]);
  constructor() {
    afterRenderEffect(() => {
      if (!this.chat.loading()) this.composer()?.focus();
    });
    afterRenderEffect(() => {
      const messageId = this.chat.messages().at(-1)?.id;
      const feed = this.feed()?.nativeElement;
      const target =
        feed && messageId
          ? feed.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`)
          : null;
      if (feed && target)
        feed.scrollTop +=
          target.getBoundingClientRect().top - feed.getBoundingClientRect().top - 24;
    });
  }
  ngOnDestroy(): void {
    this.chat.stop();
  }
  async send(prompt: string): Promise<void> {
    if (!prompt.trim() || this.responding() || this.chat.loading()) return;
    this.error.set('');
    this.pendingPrompt.set(prompt.trim().slice(0, 4000));
    this.submitting.set(true);
    try {
      const response = this.chat.send(prompt);
      this.focusComposer();
      await response;
    } catch {
      this.chat.stop();
      this.error.set('Couldn’t load the answer. Send your question again.');
    } finally {
      const retryPrompt =
        (this.error() || this.chat.error()) && !this.chat.messages().length
          ? this.pendingPrompt()
          : '';
      this.submitting.set(false);
      this.pendingPrompt.set('');
      if (retryPrompt && !this.destroyRef.destroyed) this.focusComposer(retryPrompt);
    }
  }
  private focusComposer(retryPrompt = ''): void {
    afterNextRender(
      () => {
        const composer = this.composer();
        if (retryPrompt) composer?.restoreDraft(retryPrompt);
        composer?.focus();
      },
      { injector: this.injector },
    );
  }
}
