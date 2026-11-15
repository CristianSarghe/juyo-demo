import type { Conversation, Message } from '../../models';
import {
  PROPERTIES,
  demoReply,
  initialConversations,
  resolveReportingMonth,
} from '../../demo-data';
import {
  BOOKING_SNAPSHOT,
  FIXTURE_META,
  REPORTING_DATES,
  REPORTING_PERIODS,
} from '../../network.data';
import type { CreateConversationRequest, SendMessageRequest } from '../mutation.models';
import { MockRepositoryError } from './mock-repository-error';
import { MockRoomRatesRepository } from './mock-room-rates.repository';
import { getCurrentSession } from './mock-session.repository';
import { isMockEventRateAction, mockEventPricingReply } from './mock-event-pricing';
import { isMockBatchRateAction, mockBatchChangeIds } from './mock-rate-batch';

// Keep earlier prototype conversations separate from the four-hotel fixture.
const STORAGE_KEY = 'juyo.network.v1.conversations';
const MAX_CONVERSATIONS = 30;
const MAX_MESSAGES = 100;
type MockConversation = Conversation & { readonly ownerEmail?: string };

function publicConversation(value: MockConversation): Conversation {
  const { ownerEmail: _owner, ...conversation } = value;
  return structuredClone(conversation);
}

function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<Message>;
  return (
    typeof message.id === 'string' &&
    typeof message.content === 'string' &&
    message.content.length <= 10_000 &&
    (message.role === 'user' || message.role === 'assistant') &&
    typeof message.createdAt === 'string' &&
    !Number.isNaN(Date.parse(message.createdAt)) &&
    (!message.action ||
      isMockEventRateAction(message.action) ||
      isMockBatchRateAction(message.action)) &&
    (!message.insight ||
      (typeof message.insight.title === 'string' &&
        typeof message.insight.summary === 'string' &&
        typeof message.insight.recommendation === 'string' &&
        (!message.insight.chartTitle || typeof message.insight.chartTitle === 'string') &&
        (!message.insight.chartUnit ||
          ['percent', 'currency'].includes(message.insight.chartUnit)) &&
        (!message.insight.reportingPeriod || typeof message.insight.reportingPeriod === 'string') &&
        (!message.insight.chartSeries ||
          (typeof message.insight.chartSeries.value === 'string' &&
            typeof message.insight.chartSeries.comparison === 'string')) &&
        Array.isArray(message.insight.metrics) &&
        message.insight.metrics.length <= 10 &&
        message.insight.metrics.every(
          (metric) =>
            metric &&
            typeof metric.label === 'string' &&
            typeof metric.value === 'string' &&
            typeof metric.change === 'string',
        ) &&
        Array.isArray(message.insight.sources) &&
        message.insight.sources.every((source) => typeof source === 'string') &&
        (!message.insight.chart ||
          (Array.isArray(message.insight.chart) &&
            message.insight.chart.length <= 30 &&
            message.insight.chart.every(
              (point) =>
                point &&
                typeof point.label === 'string' &&
                Number.isFinite(point.value) &&
                Number.isFinite(point.comparison),
            )))))
  );
}

function normalizeGeneratedText(value: string): string {
  return value
    .replace(
      /^Here is an illustrative look at (.+)\. This demo uses the same sample dataset for every property\.$/,
      'Performance for $1.',
    )
    .replace(
      /DEV · (?=Meridian Brussels|Canal House Amsterdam|Spreehof Berlin|Ribeira Porto|All hotels)/g,
      '',
    )
    .replace(/ · development data$/g, '')
    .replace(/^(Facilities across \d+) development hotels\.$/, '$1 hotels.')
    .replace(/^The November workflow sample contains /, 'The November reservation list contains ')
    .replace(
      'These sample reservations are separate from the completed October performance ledger.',
      'These reservations are separate from the October performance ledger.',
    );
}

/** Update only known generated copy; identifiers, user messages and figures remain intact. */
function normalizeAssistantMessage(message: Message): Message {
  if (message.role !== 'assistant') return message;
  const insight = message.insight;
  const legacySources: Record<string, string> = {
    'Reservations · demo PMS': 'Reservations',
    'Room rates · demo RMS': 'Room rates',
    'Channel mix · demo PMS': 'Channel mix',
    'Acquisition costs · demo finance': 'Acquisition costs',
    'Restaurant sales · demo POS': 'Restaurant sales',
    'Food & labor costs · demo finance': 'Food & labor costs',
    'Room revenue · demo finance': 'Room revenue',
  };
  return {
    ...message,
    content: normalizeGeneratedText(message.content),
    ...(insight
      ? {
          insight: {
            ...insight,
            title: normalizeGeneratedText(insight.title),
            summary: normalizeGeneratedText(insight.summary),
            recommendation: normalizeGeneratedText(insight.recommendation),
            metrics: insight.metrics.map((metric) => ({
              label: normalizeGeneratedText(metric.label),
              value: normalizeGeneratedText(metric.value),
              change: normalizeGeneratedText(metric.change),
            })),
            sources: insight.sources.map(
              (source) => legacySources[source] ?? normalizeGeneratedText(source),
            ),
          },
        }
      : {}),
  };
}

/** Recalculate saved fixture answers when the underlying dataset changes. */
function refreshConversation(conversation: MockConversation): MockConversation {
  const property = PROPERTIES.find(
    (property) => property.id === (conversation.propertyId ?? 'portfolio'),
  )!;
  const firstQuestion =
    conversation.messages.find((message) => message.role === 'user')?.content ?? '';
  const previousPeriod =
    conversation.messages.find((message) => message.insight)?.insight?.reportingPeriod ?? '';
  const month = REPORTING_PERIODS.some((period) => period.key === conversation.month)
    ? conversation.month!
    : resolveReportingMonth(firstQuestion + ' ' + previousPeriod);
  const period = REPORTING_PERIODS.find((period) => period.key === month)!;
  const roomDate =
    conversation.roomDate &&
    REPORTING_DATES.includes(conversation.roomDate) &&
    conversation.roomDate.startsWith(month)
      ? conversation.roomDate
      : BOOKING_SNAPSHOT.asOf.startsWith(month)
        ? BOOKING_SNAPSHOT.asOf
        : period.endDate < BOOKING_SNAPSHOT.asOf
          ? period.endDate
          : period.startDate;
  const needsRefresh =
    conversation.dataVersion !== FIXTURE_META.schemaVersion ||
    conversation.roomDate !== roomDate ||
    conversation.month !== month;
  let question = '';
  const messages = conversation.messages.map((message) => {
    if (message.role === 'user') {
      question = message.content;
      return message;
    }
    return needsRefresh && question && !message.action
      ? { ...message, ...demoReply(question, property, month, roomDate) }
      : normalizeAssistantMessage(message);
  });
  return { ...conversation, month, roomDate, dataVersion: FIXTURE_META.schemaVersion, messages };
}

function restoredConversations(): MockConversation[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return initialConversations();
    if (stored.length > 2_000_000) return initialConversations();
    const value: unknown = JSON.parse(stored);
    if (!Array.isArray(value)) return initialConversations();
    return value
      .filter(
        (item): item is MockConversation =>
          item &&
          typeof item.id === 'string' &&
          typeof item.title === 'string' &&
          item.title.length <= 100 &&
          typeof item.updatedAt === 'string' &&
          !Number.isNaN(Date.parse(item.updatedAt)) &&
          Array.isArray(item.messages) &&
          item.messages.length <= MAX_MESSAGES &&
          item.messages.every(isMessage) &&
          (item.ownerEmail === undefined ||
            (typeof item.ownerEmail === 'string' &&
              /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item.ownerEmail))) &&
          (!item.propertyId || PROPERTIES.some((property) => property.id === item.propertyId)),
      )
      .slice(0, MAX_CONVERSATIONS)
      .map(refreshConversation);
  } catch {
    return initialConversations();
  }
}

/** Mock-only persistence and generated answers. The live chat service never imports fixtures. */
export class MockChatRepository {
  private conversations = restoredConversations();

  constructor(private readonly rates = new MockRoomRatesRepository()) {}

  private owner(): string {
    const email = getCurrentSession()?.email.toLowerCase();
    if (!email) throw new MockRepositoryError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    return email;
  }
  private owned(id: string): MockConversation | undefined {
    const owner = this.owner();
    return this.conversations.find(
      (item) => item.id === id && (!item.ownerEmail || item.ownerEmail === owner),
    );
  }

  list(): Conversation[] {
    const owner = this.owner();
    return this.conversations
      .filter((item) => !item.ownerEmail || item.ownerEmail === owner)
      .map(publicConversation);
  }
  get(id: string): Conversation | null {
    const value = this.owned(id);
    return value ? publicConversation(value) : null;
  }
  create(value: unknown): Conversation {
    if (!value || typeof value !== 'object')
      throw new MockRepositoryError(
        422,
        'invalid_conversation',
        'Choose a hotel and reporting period.',
      );
    const request = value as Partial<CreateConversationRequest>;
    if (
      typeof request.title !== 'string' ||
      !request.title.trim() ||
      request.title.length > 100 ||
      !PROPERTIES.some((property) => property.id === request.propertyId) ||
      !REPORTING_PERIODS.some((period) => period.key === request.month) ||
      typeof request.roomDate !== 'string' ||
      !REPORTING_DATES.includes(request.roomDate) ||
      !request.roomDate.startsWith(request.month!)
    )
      throw new MockRepositoryError(
        422,
        'invalid_conversation',
        'Choose a valid hotel and reporting period.',
      );
    const conversation: MockConversation = {
      id: crypto.randomUUID(),
      title: request.title.trim(),
      messages: [],
      updatedAt: new Date().toISOString(),
      propertyId: request.propertyId,
      month: request.month,
      roomDate: request.roomDate,
      dataVersion: FIXTURE_META.schemaVersion,
      ownerEmail: this.owner(),
    };
    this.commit([conversation, ...this.conversations].slice(0, MAX_CONVERSATIONS));
    return publicConversation(conversation);
  }
  remove(id: string): void {
    if (!this.owned(id))
      throw new MockRepositoryError(
        404,
        'conversation_not_found',
        'This conversation no longer exists.',
      );
    this.commit(this.conversations.filter((item) => item.id !== id));
  }
  appendMessage(id: string, value: unknown): Conversation {
    const conversation = this.owned(id);
    if (!conversation)
      throw new MockRepositoryError(
        404,
        'conversation_not_found',
        'This conversation no longer exists.',
      );
    const request = value as Partial<SendMessageRequest> | null;
    if (
      !request ||
      typeof request.content !== 'string' ||
      !request.content.trim() ||
      request.content.length > 4_000
    )
      throw new MockRepositoryError(
        422,
        'invalid_message',
        'Enter a message of up to 4,000 characters.',
      );
    const prompt = request.content.trim();
    const property = PROPERTIES.find(
      (property) => property.id === (conversation.propertyId ?? 'portfolio'),
    )!;
    const month = conversation.month ?? resolveReportingMonth(prompt);
    const roomDate = conversation.roomDate ?? BOOKING_SNAPSHOT.asOf;
    const now = new Date().toISOString();
    const eventReply = mockEventPricingReply(
      prompt,
      conversation.propertyId ?? 'portfolio',
      this.rates,
    );
    const messages: Message[] = [
      { id: crypto.randomUUID(), role: 'user', content: prompt, createdAt: now },
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        createdAt: now,
        ...(eventReply ?? demoReply(prompt, property, month, roomDate)),
      },
    ];
    const updated = {
      ...conversation,
      messages: [...conversation.messages, ...messages].slice(-MAX_MESSAGES),
      updatedAt: now,
      dataVersion: FIXTURE_META.schemaVersion,
      ownerEmail: this.owner(),
    };
    this.commit(
      this.conversations
        .map((item) => (item.id === id ? updated : item))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    );
    return publicConversation(updated);
  }
  confirmAction(id: string, actionId: string, decision: unknown): Conversation {
    if (decision !== 'apply' && decision !== 'cancel')
      throw new MockRepositoryError(422, 'INVALID_DECISION', 'Choose Apply or Cancel.');
    const conversation = this.owned(id);
    const message = conversation?.messages.find(
      (item) => item.role === 'assistant' && item.action?.id === actionId,
    );
    if (
      !conversation ||
      conversation.ownerEmail !== this.owner() ||
      !message ||
      (!isMockEventRateAction(message.action) && !isMockBatchRateAction(message.action))
    )
      throw new MockRepositoryError(
        404,
        'CHAT_ACTION_NOT_FOUND',
        'This proposed change was not found.',
      );
    const action = message.action;
    const status = decision === 'apply' ? 'applied' : 'cancelled';
    if (action.status === status) return publicConversation(conversation);
    if (action.status !== 'pending')
      throw new MockRepositoryError(
        409,
        'CHAT_ACTION_ALREADY_DECIDED',
        'This proposed change was already handled.',
      );
    const appliedIds =
      action.kind === 'rate_batch_update'
        ? mockBatchChangeIds(action.id, action.details.updates.length)
        : [action.id];
    if (
      decision === 'cancel' &&
      this.rates.changes().some((change) => appliedIds.includes(change.id))
    )
      throw new MockRepositoryError(
        409,
        'CHAT_ACTION_ALREADY_APPLIED',
        'This price change was already applied. Retry Apply to finish saving its decision.',
      );
    const saved =
      decision !== 'apply' ||
      (action.kind === 'rate_batch_update'
        ? this.rates.updateBatch(action.details.updates, action.id)
        : this.rates.update(action.details, action.id));
    if (!saved)
      throw new MockRepositoryError(
        this.rates.errorStatus(),
        'RATE_UPDATE_FAILED',
        this.rates.error(),
      );
    const updated = {
      ...conversation,
      updatedAt: new Date().toISOString(),
      messages: conversation.messages.map((item) =>
        item.id === message.id ? { ...item, action: { ...action, status } } : item,
      ),
    } satisfies MockConversation;
    this.commit(
      this.conversations.map((item) => (item.id === id ? updated : item)),
      true,
    );
    return publicConversation(updated);
  }
  private commit(conversations: MockConversation[], requireStorage = false): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
    } catch {
      if (requireStorage)
        throw new MockRepositoryError(
          503,
          'PERSISTENCE_UNAVAILABLE',
          'Could not save this decision on this device. Try again.',
        );
      /* History remains available for this visit if local storage is unavailable. */
    }
    this.conversations = conversations;
  }
}
