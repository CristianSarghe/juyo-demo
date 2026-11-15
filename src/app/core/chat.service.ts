import { Injectable, computed, effect, inject } from '@angular/core';
import { patchState, signalState } from '@ngrx/signals';
import { firstValueFrom, Subject, takeUntil } from 'rxjs';
import type { ChatAction, Conversation, HotelProperty, Message } from './models';
import { isPendingChatAction, isReviewableChatAction } from './models';
import { ApiClient } from './api/api-client.service';
import { ReferenceDataService } from './api/reference-data.service';
import { HotelScopeService } from './hotel-scope.service';
import { ReportingScopeService } from './reporting-scope.service';
import { RoomOperationsService } from './room-operations.service';
import { RoomRateService } from './room-rate.service';

const MAX_CONVERSATIONS = 30;
const MAX_MESSAGES = 100;

/** Async chat facade. Stored history and answer generation belong to the API. */
@Injectable({ providedIn: 'root' })
export class ChatService {
  private readonly api = inject(ApiClient);
  private readonly reference = inject(ReferenceDataService);
  private readonly hotelScope = inject(HotelScopeService);
  private readonly reporting = inject(ReportingScopeService);
  private readonly operations = inject(RoomOperationsService);
  private readonly rates = inject(RoomRateService);
  private readonly properties = computed<readonly HotelProperty[]>(() => {
    const hotels = this.reference.snapshot()?.hotels ?? [];
    return [
      ...hotels.map((hotel) => ({
        id: hotel.id,
        name: hotel.name,
        location: `${hotel.city}, ${hotel.country}`,
      })),
      { id: 'portfolio', name: 'All hotels', location: `Europe · ${hotels.length} hotels` },
    ];
  });
  get propertyOptions(): readonly HotelProperty[] {
    return this.properties();
  }
  readonly propertyId = this.hotelScope.scope;
  readonly selectedProperty = computed(
    () =>
      this.properties().find((property) => property.id === this.propertyId()) ??
      this.properties().at(-1)!,
  );
  private readonly state = signalState<{
    conversations: Conversation[];
    activeId: string | null;
    isResponding: boolean;
    loading: boolean;
    error: string;
    pendingAction: string | null;
  }>({
    conversations: [],
    activeId: null,
    isResponding: false,
    loading: false,
    error: '',
    pendingAction: null,
  });
  readonly conversations = this.state.conversations;
  readonly activeId = this.state.activeId;
  readonly isResponding = this.state.isResponding;
  readonly loading = this.state.loading;
  readonly error = this.state.error;
  readonly pendingAction = this.state.pendingAction;
  private readonly activeRecord = computed(
    () => this.conversations().find((conversation) => conversation.id === this.activeId()) ?? null,
  );
  readonly activeConversation = computed(() => {
    const conversation = this.activeRecord();
    return conversation &&
      (conversation.propertyId ?? 'portfolio') === this.propertyId() &&
      conversation.month === this.reporting.month() &&
      (!conversation.roomDate || conversation.roomDate === this.reporting.date())
      ? conversation
      : null;
  });
  readonly messages = computed(() => this.activeConversation()?.messages ?? []);
  private responseRun = 0;
  private responseContext = '';
  private generation = 0;
  private readonly cancelResponse = new Subject<void>();
  private initialized = false;
  private initialization?: Promise<void>;

  constructor() {
    effect(() => this.reconcileScope());
  }
  initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    return (this.initialization ??= this.load());
  }
  private async load(): Promise<void> {
    const generation = this.generation;
    patchState(this.state, { loading: true, error: '' });
    try {
      const conversations = await firstValueFrom(this.api.get<Conversation[]>('/conversations'));
      if (generation !== this.generation) return;
      patchState(this.state, { conversations });
      if (!this.activeId()) {
        const latest = conversations.find(
          (conversation) =>
            (conversation.propertyId ?? 'portfolio') === this.propertyId() &&
            conversation.month === this.reporting.month() &&
            (!conversation.roomDate || conversation.roomDate === this.reporting.date()),
        );
        if (latest) patchState(this.state, { activeId: latest.id });
      }
      this.initialized = true;
    } catch (error) {
      if (generation === this.generation)
        patchState(this.state, {
          error: this.message(error, 'Could not load conversations. Try again.'),
        });
      throw error;
    } finally {
      if (generation === this.generation) {
        this.initialization = undefined;
        patchState(this.state, { loading: false });
      }
    }
  }
  newConversation(): void {
    this.stop();
    patchState(this.state, { activeId: null, error: '' });
  }
  selectConversation(id: string): void {
    const conversation = this.conversations().find((item) => item.id === id);
    if (!conversation) return;
    this.stop();
    this.hotelScope.select(conversation.propertyId ?? 'portfolio');
    if (conversation.month) this.reporting.selectMonth(conversation.month);
    if (conversation.roomDate) this.reporting.selectDate(conversation.roomDate);
    patchState(this.state, { activeId: id, error: '' });
  }
  selectProperty(id: string): void {
    if (!this.propertyOptions.some((property) => property.id === id)) return;
    if (id === this.propertyId()) {
      this.reconcileScope();
      return;
    }
    this.newConversation();
    this.hotelScope.select(id);
  }
  async deleteConversation(id: string): Promise<void> {
    const generation = this.generation;
    try {
      await this.initialize();
      if (generation !== this.generation) return;
      await firstValueFrom(this.api.delete<void>(`/conversations/${encodeURIComponent(id)}`));
      if (generation !== this.generation) return;
      if (this.activeId() === id) this.newConversation();
      patchState(this.state, ({ conversations }) => ({
        conversations: conversations.filter((item) => item.id !== id),
        error: '',
      }));
    } catch (error) {
      if (generation === this.generation)
        patchState(this.state, {
          error: this.message(error, 'Could not delete the conversation. Try again.'),
        });
      throw error;
    }
  }
  async send(value: string): Promise<void> {
    const prompt = value.trim().slice(0, 4000);
    if (!prompt || this.isResponding() || this.pendingAction()) return;
    const initialRun = this.responseRun;
    const initialScope = this.propertyId();
    const initialMonth = this.reporting.month();
    const initialDate = this.reporting.date();
    const initialRange = this.reporting.dashboardRange();
    try {
      await this.initialize();
    } catch {
      return;
    }
    if (
      this.isResponding() ||
      initialRun !== this.responseRun ||
      initialScope !== this.propertyId() ||
      initialMonth !== this.reporting.month() ||
      initialDate !== this.reporting.date() ||
      initialRange.startDate !== this.reporting.dashboardRange().startDate ||
      initialRange.endDate !== this.reporting.dashboardRange().endDate
    )
      return;
    this.reconcileScope();
    const propertyId = this.propertyId();
    const month = this.reporting.month();
    const roomDate = this.reporting.date();
    const run = ++this.responseRun;
    this.responseContext = this.contextKey();
    const current = () =>
      run === this.responseRun &&
      this.propertyId() === propertyId &&
      this.reporting.month() === month &&
      this.reporting.date() === roomDate &&
      this.reporting.dashboardRange().startDate === initialRange.startDate &&
      this.reporting.dashboardRange().endDate === initialRange.endDate;
    patchState(this.state, { isResponding: true, error: '' });
    try {
      let conversationId = this.activeId();
      if (!conversationId) {
        const conversation = await firstValueFrom(
          this.api
            .post<Conversation>('/conversations', {
              title: prompt.slice(0, 48),
              propertyId,
              month,
              roomDate,
            })
            .pipe(takeUntil(this.cancelResponse)),
        );
        if (!current()) return;
        conversationId = conversation.id;
        this.upsert(conversation);
        patchState(this.state, { activeId: conversationId });
      }
      const originId = conversationId;
      this.append(originId, {
        id: crypto.randomUUID(),
        role: 'user',
        content: prompt,
        createdAt: new Date().toISOString(),
      });
      const conversation = await firstValueFrom(
        this.api
          .post<Conversation>(
            `/conversations/${encodeURIComponent(originId)}/messages`,
            { content: prompt, context: { propertyId, ...initialRange } },
            // Allow the bounded model/tool flow and API persistence to finish.
            // Ordinary reads and confirmed changes retain the API's default deadline.
            { timeoutMs: 180_000 },
          )
          .pipe(takeUntil(this.cancelResponse)),
      );
      if (!current() || this.activeId() !== originId) return;
      this.upsert(conversation);
    } catch (error) {
      if (current())
        patchState(this.state, {
          error: this.message(error, 'Could not send the message. Try again.'),
        });
    } finally {
      if (run === this.responseRun) patchState(this.state, { isResponding: false });
    }
  }
  async decideAction(action: ChatAction, decision: 'apply' | 'cancel'): Promise<void> {
    const conversation = this.activeConversation();
    if (
      !conversation ||
      this.pendingAction() ||
      this.isResponding() ||
      !isPendingChatAction(action) ||
      (decision !== 'apply' && decision !== 'cancel')
    )
      return;
    const stored = conversation.messages.find(
      (message) => message.role === 'assistant' && message.action?.id === action.id,
    )?.action;
    if (!isPendingChatAction(stored)) return;
    if (
      decision === 'apply' &&
      (!isReviewableChatAction(action) || !isReviewableChatAction(stored))
    ) {
      patchState(this.state, {
        error: 'This proposal cannot be reviewed safely. Ask Kassandra for a new proposal.',
      });
      return;
    }
    const generation = this.generation;
    patchState(this.state, { pendingAction: action.id, error: '' });
    try {
      const updated = await firstValueFrom(
        this.api.post<Conversation>(
          `/conversations/${encodeURIComponent(conversation.id)}/actions/${encodeURIComponent(action.id)}`,
          { decision },
        ),
      );
      if (generation !== this.generation) return;
      this.upsert(updated);
      if (decision === 'apply') {
        try {
          if (stored.kind === 'rate_update' || stored.kind === 'rate_batch_update')
            await this.rates.refresh();
          else await this.operations.refresh();
        } catch {
          if (generation === this.generation)
            patchState(this.state, {
              error: 'Change saved. Reload the page to refresh the hotel data.',
            });
        }
      }
    } catch (error) {
      if (generation === this.generation)
        patchState(this.state, {
          error: this.message(error, 'Could not save the decision. Try again.'),
        });
    } finally {
      if (generation === this.generation) patchState(this.state, { pendingAction: null });
    }
  }
  clear(): void {
    this.stop();
    this.generation++;
    this.initialized = false;
    this.initialization = undefined;
    patchState(this.state, {
      conversations: [],
      activeId: null,
      loading: false,
      error: '',
      pendingAction: null,
    });
  }
  stop(): void {
    this.responseRun++;
    this.cancelResponse.next();
    patchState(this.state, { isResponding: false });
  }
  private reconcileScope(): void {
    if (this.isResponding() && this.responseContext !== this.contextKey()) this.stop();
    const conversation = this.activeRecord();
    if (
      conversation &&
      ((conversation.propertyId ?? 'portfolio') !== this.propertyId() ||
        conversation.month !== this.reporting.month() ||
        (conversation.roomDate && conversation.roomDate !== this.reporting.date()))
    )
      this.newConversation();
  }
  private contextKey(): string {
    const range = this.reporting.dashboardRange();
    return `${this.propertyId()}/${this.reporting.month()}/${this.reporting.date()}/${range.startDate}/${range.endDate}`;
  }
  private upsert(conversation: Conversation): void {
    patchState(this.state, ({ conversations }) => ({
      conversations: [conversation, ...conversations.filter((item) => item.id !== conversation.id)]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, MAX_CONVERSATIONS),
    }));
  }
  private append(id: string, message: Message): void {
    patchState(this.state, ({ conversations }) => ({
      conversations: conversations
        .map((item) =>
          item.id === id
            ? {
                ...item,
                messages: [...item.messages, message].slice(-MAX_MESSAGES),
                updatedAt: message.createdAt,
              }
            : item,
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    }));
  }
  private message(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : fallback;
  }
}
