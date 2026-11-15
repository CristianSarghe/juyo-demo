import { Injectable, Injector, computed, inject } from '@angular/core';
import { patchState, signalState } from '@ngrx/signals';
import type { ChatService } from './chat.service';
import type { ChatAction, Message } from './models';

export interface AssistantContext {
  kind: 'general' | 'warning' | 'event';
  label: string;
}

export const ASSISTANT_EXAMPLES = [
  {
    id: 'revenue',
    label: 'Understand revenue',
    prompt: 'Explain revenue for the selected dates.',
  },
  {
    id: 'operations',
    label: 'Find repair help',
    prompt:
      'Find local repair companies for rooms out of service, with public phone numbers and sources.',
  },
  {
    id: 'pricing',
    label: 'Review room prices',
    prompt:
      'Review prices across room types for the selected dates using bookings, availability and nearby events. Prepare justified changes together for my review.',
  },
] as const;

/** Shell state stays local; conversation history, answers and proposed changes belong to the API. */
@Injectable({ providedIn: 'root' })
export class AssistantUiStore {
  private readonly injector = inject(Injector);
  private chatService?: ChatService;
  private moduleLoad?: Promise<void>;
  private readonly state = signalState<{
    isOpen: boolean;
    context: AssistantContext;
    draft: string;
    openSequence: number;
    chatLoaded: boolean;
    loadingModule: boolean;
    moduleError: string;
    requestPending: boolean;
  }>({
    isOpen: false,
    context: { kind: 'general', label: 'General conversation' },
    draft: '',
    openSequence: 0,
    chatLoaded: false,
    loadingModule: false,
    moduleError: '',
    requestPending: false,
  });
  private generation = 0;

  readonly isOpen = this.state.isOpen;
  readonly context = this.state.context;
  readonly draft = this.state.draft;
  readonly openSequence = this.state.openSequence;
  readonly requestPending = this.state.requestPending;
  readonly messages = computed<readonly Message[]>(() =>
    this.state.chatLoaded() ? this.chatService!.messages() : [],
  );
  readonly loading = computed(
    () => this.state.loadingModule() || (this.state.chatLoaded() && this.chatService!.loading()),
  );
  readonly responding = computed(() => this.state.chatLoaded() && this.chatService!.isResponding());
  readonly pendingAction = computed(() =>
    this.state.chatLoaded() ? this.chatService!.pendingAction() : null,
  );
  readonly error = computed(
    () => this.state.moduleError() || (this.state.chatLoaded() ? this.chatService!.error() : ''),
  );

  /** Keep the API chat and reporting dependencies out of the sign-in bundle. */
  initialize(): Promise<void> {
    if (this.chatService) return this.chatService.initialize();
    if (this.moduleLoad) return this.moduleLoad;
    const generation = this.generation;
    patchState(this.state, { loadingModule: true, moduleError: '' });
    const loading = import('./chat.service')
      .then(({ ChatService }) => {
        if (generation !== this.generation) return;
        this.chatService = this.injector.get(ChatService);
        patchState(this.state, { chatLoaded: true, loadingModule: false });
        return this.chatService.initialize();
      })
      .catch((error: unknown) => {
        if (generation === this.generation && !this.chatService)
          patchState(this.state, { moduleError: 'Could not load Kassandra. Try again.' });
        throw error;
      })
      .finally(() => {
        if (this.moduleLoad === loading) {
          this.moduleLoad = undefined;
          patchState(this.state, { loadingModule: false });
        }
      });
    this.moduleLoad = loading;
    return loading;
  }

  open(context?: AssistantContext): void {
    patchState(this.state, {
      isOpen: true,
      context: context
        ? {
            kind: context.kind,
            label: context.label.trim().slice(0, 100) || 'General conversation',
          }
        : this.context(),
      openSequence: this.openSequence() + 1,
    });
    void this.initialize().catch(() => undefined);
  }

  close(): void {
    patchState(this.state, { isOpen: false });
  }

  setDraft(value: string): void {
    patchState(this.state, { draft: value.slice(0, 4000) });
  }

  /** A contextual action submits one new question, never a proposed domain change. */
  async ask(value: string, context: AssistantContext): Promise<boolean> {
    const content = value.trim().slice(0, 4000);
    if (!content || this.requestPending() || this.responding() || this.pendingAction())
      return false;
    const generation = this.generation;
    patchState(this.state, { requestPending: true, draft: content });
    this.open(context);
    try {
      // Opening a cold drawer loads its module/history. Await it before submitting.
      await this.initialize();
      if (generation !== this.generation || !this.chatService) return false;
      this.chatService.newConversation();
      patchState(this.state, { draft: '' });
      await this.chatService.send(content);
      if (generation !== this.generation) return false;
      if (this.error()) {
        if (!this.draft()) patchState(this.state, { draft: content });
        return false;
      }
      return true;
    } catch {
      // The module/chat facade owns the retryable error; retain the original question.
      if (generation === this.generation && !this.draft())
        patchState(this.state, { draft: content });
      return false;
    } finally {
      if (generation === this.generation) patchState(this.state, { requestPending: false });
    }
  }

  async send(): Promise<void> {
    const content = this.draft().trim();
    if (
      !content ||
      this.requestPending() ||
      this.responding() ||
      this.loading() ||
      this.pendingAction()
    )
      return;
    const generation = this.generation;
    if (!this.chatService) {
      try {
        await this.initialize();
      } catch {
        return;
      }
      if (generation !== this.generation || !this.chatService) return;
    }
    patchState(this.state, { draft: '' });
    await this.chatService.send(content);
    if (generation === this.generation && this.error() && !this.draft())
      patchState(this.state, { draft: content });
  }

  retry(): void {
    if (this.draft().trim()) void this.send();
    else void this.initialize().catch(() => undefined);
  }

  newConversation(): void {
    this.generation++;
    this.chatService?.newConversation();
    patchState(this.state, { draft: '', requestPending: false });
  }

  clear(): void {
    this.generation++;
    this.moduleLoad = undefined;
    this.chatService?.clear();
    patchState(this.state, {
      isOpen: false,
      context: { kind: 'general', label: 'General conversation' },
      draft: '',
      loadingModule: false,
      moduleError: '',
      requestPending: false,
    });
  }

  stop(): void {
    if (this.requestPending()) {
      this.generation++;
      patchState(this.state, { requestPending: false });
    }
    this.chatService?.stop();
  }

  decideAction(action: ChatAction, decision: 'apply' | 'cancel'): void {
    void this.chatService?.decideAction(action, decision);
  }
}
