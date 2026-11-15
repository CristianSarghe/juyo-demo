import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of, Subject, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './chat.service';
import { ApiClient } from './api/api-client.service';
import { ReferenceDataService } from './api/reference-data.service';
import { HotelScopeService } from './hotel-scope.service';
import { ReportingScopeService } from './reporting-scope.service';
import { RoomOperationsService } from './room-operations.service';
import { RoomRateService } from './room-rate.service';
import type { ChatAction, Conversation, Message } from './models';

const date = '2026-11-14';
const range = { startDate: '2026-11-11', endDate: '2026-11-22' };
const conversation = (overrides: Partial<Conversation> = {}): Conversation => ({
  id: 'conversation-berlin',
  title: 'Berlin rooms',
  propertyId: 'dev-ber',
  month: '2026-11',
  roomDate: date,
  messages: [],
  updatedAt: '2026-11-14T12:00:00Z',
  ...overrides,
});
const message = (overrides: Partial<Message> = {}): Message => ({
  id: 'answer-1',
  role: 'assistant',
  content: 'There is one room out of service.',
  createdAt: '2026-11-14T12:00:00Z',
  ...overrides,
});
const rateAction: ChatAction = {
  id: 'rate-action',
  kind: 'rate_update',
  status: 'pending',
  summary: 'Set Classic rooms to €195 per night.',
  details: {
    hotelId: 'dev-ber',
    hotelName: 'Spreehof Berlin',
    roomTypeId: 'dev-ber-type-1',
    roomTypeName: 'Classic',
    startDate: range.startDate,
    endDate: range.endDate,
    nightlyRate: 195,
  },
};
const roomAction: ChatAction = {
  id: 'room-action',
  kind: 'room_action',
  status: 'pending',
  summary: 'Mark room 105 clean.',
  details: {
    roomId: 'dev-ber-room-105',
    hotelName: 'Spreehof Berlin',
    roomNumber: '105',
    action: 'clean',
    date,
  },
};
const batchAction: ChatAction = {
  id: 'batch-action',
  kind: 'rate_batch_update',
  status: 'pending',
  summary: 'Review two November price changes.',
  details: {
    updates: [195, 205].map((nightlyRate, index) => ({
      ...rateAction.details,
      roomTypeId: `dev-ber-type-${index + 1}`,
      roomTypeName: index === 0 ? 'Classic' : 'Superior',
      nightlyRate,
      currentMinRate: 185,
      currentMaxRate: 190,
      expectedRateVersion: 'a'.repeat(64),
    })),
  },
};

describe('ChatService', () => {
  const hotel = signal('dev-ber');
  const month = signal('2026-11');
  const selectedDate = signal(date);
  const dashboardRange = signal(range);
  let service: ChatService;
  let api: {
    get: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  let rates: { refresh: ReturnType<typeof vi.fn> };
  let operations: { refresh: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    hotel.set('dev-ber');
    month.set('2026-11');
    selectedDate.set(date);
    dashboardRange.set(range);
    api = { get: vi.fn(() => of([])), post: vi.fn(), delete: vi.fn(() => of(undefined)) };
    rates = { refresh: vi.fn().mockResolvedValue(undefined) };
    operations = { refresh: vi.fn().mockResolvedValue(undefined) };
    TestBed.configureTestingModule({
      providers: [
        ChatService,
        { provide: ApiClient, useValue: api },
        {
          provide: ReferenceDataService,
          useValue: {
            snapshot: signal({
              hotels: [
                { id: 'dev-ber', name: 'Spreehof Berlin', city: 'Berlin', country: 'Germany' },
                {
                  id: 'dev-ams',
                  name: 'Canal House Amsterdam',
                  city: 'Amsterdam',
                  country: 'Netherlands',
                },
              ],
            }),
          },
        },
        {
          provide: HotelScopeService,
          useValue: { scope: hotel, select: (id: string) => hotel.set(id) },
        },
        {
          provide: ReportingScopeService,
          useValue: {
            month,
            date: selectedDate,
            dashboardRange,
            selectMonth: (value: string) => month.set(value),
            selectDate: (value: string) => selectedDate.set(value),
          },
        },
        { provide: RoomRateService, useValue: rates },
        { provide: RoomOperationsService, useValue: operations },
      ],
    });
    service = TestBed.inject(ChatService);
    TestBed.tick();
  });

  it('shares history loading and restores a conversation for the current hotel and dates', async () => {
    const history = new Subject<Conversation[]>();
    api.get.mockReturnValue(history);
    const berlin = conversation({ messages: [message()] });
    const amsterdam = conversation({ id: 'conversation-amsterdam', propertyId: 'dev-ams' });

    const first = service.initialize();
    const second = service.initialize();
    expect(second).toBe(first);
    expect(service.loading()).toBe(true);
    history.next([amsterdam, berlin]);
    await first;

    expect(api.get).toHaveBeenCalledExactlyOnceWith('/conversations');
    expect(service.loading()).toBe(false);
    expect(service.activeId()).toBe(berlin.id);
    expect(service.messages()).toEqual(berlin.messages);
    expect(service.selectedProperty().name).toBe('Spreehof Berlin');

    service.selectConversation(amsterdam.id);
    TestBed.tick();
    expect(hotel()).toBe('dev-ams');
    expect(service.activeConversation()?.id).toBe(amsterdam.id);
    await service.initialize();
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('creates a conversation, sends the selected interval, and replaces the optimistic question with saved history', async () => {
    await service.initialize();
    const created = new Subject<Conversation>();
    const reply = new Subject<Conversation>();
    api.post.mockReturnValueOnce(created).mockReturnValueOnce(reply);

    const sending = service.send('  Explain booked revenue.  ');
    await Promise.resolve();
    expect(service.isResponding()).toBe(true);
    expect(api.post).toHaveBeenNthCalledWith(1, '/conversations', {
      title: 'Explain booked revenue.',
      propertyId: 'dev-ber',
      month: '2026-11',
      roomDate: date,
    });
    created.next(conversation());
    await Promise.resolve();
    expect(service.messages()).toEqual([
      expect.objectContaining({ role: 'user', content: 'Explain booked revenue.' }),
    ]);
    expect(api.post).toHaveBeenNthCalledWith(
      2,
      '/conversations/conversation-berlin/messages',
      {
        content: 'Explain booked revenue.',
        context: { propertyId: 'dev-ber', ...range },
      },
      { timeoutMs: 180_000 },
    );

    const saved = conversation({
      messages: [
        message({ id: 'saved-question', role: 'user', content: 'Explain booked revenue.' }),
        message({ content: 'Booked revenue is €12,191.' }),
      ],
    });
    reply.next(saved);
    await sending;
    expect(service.messages()).toEqual(saved.messages);
    expect(service.messages()).toHaveLength(2);
    expect(service.isResponding()).toBe(false);
    expect(service.error()).toBe('');
  });

  it.each([
    { kind: 'rate update', action: rateAction, refresh: 'rates' },
    { kind: 'batch rate update', action: batchAction, refresh: 'rates' },
    { kind: 'room action', action: roomAction, refresh: 'operations' },
  ] as const)(
    'applies a reviewed $kind and refreshes only its affected data',
    async ({ action, refresh }) => {
      const pending = conversation({ messages: [message({ action })] });
      api.get.mockReturnValue(of([pending]));
      await service.initialize();
      const applied = conversation({
        messages: [message({ action: { ...action, status: 'applied' } })],
      });
      const confirmation = new Subject<Conversation>();
      api.post.mockReturnValue(confirmation);

      const deciding = service.decideAction(action, 'apply');
      expect(service.pendingAction()).toBe(action.id);
      await service.decideAction(action, 'apply');
      expect(api.post).toHaveBeenCalledExactlyOnceWith(
        `/conversations/${pending.id}/actions/${action.id}`,
        { decision: 'apply' },
      );
      expect(rates.refresh).not.toHaveBeenCalled();
      expect(operations.refresh).not.toHaveBeenCalled();
      confirmation.next(applied);
      await deciding;

      expect(service.messages()[0].action?.status).toBe('applied');
      expect(rates.refresh).toHaveBeenCalledTimes(refresh === 'rates' ? 1 : 0);
      expect(operations.refresh).toHaveBeenCalledTimes(refresh === 'operations' ? 1 : 0);
      expect(service.pendingAction()).toBe(null);
      expect(service.error()).toBe('');
    },
  );

  it('cancels a proposed change without refreshing or applying room prices', async () => {
    const pending = conversation({ messages: [message({ action: rateAction })] });
    api.get.mockReturnValue(of([pending]));
    await service.initialize();
    api.post.mockReturnValue(
      of(conversation({ messages: [message({ action: { ...rateAction, status: 'cancelled' } })] })),
    );

    await service.decideAction(rateAction, 'cancel');

    expect(api.post).toHaveBeenCalledExactlyOnceWith(
      `/conversations/${pending.id}/actions/${rateAction.id}`,
      { decision: 'cancel' },
    );
    expect(service.messages()[0].action?.status).toBe('cancelled');
    expect(rates.refresh).not.toHaveBeenCalled();
    expect(operations.refresh).not.toHaveBeenCalled();
    expect(service.pendingAction()).toBe(null);
  });

  it.each([
    { ...batchAction, kind: 'future_action' },
    { ...batchAction, details: { updates: [] } },
    { ...batchAction, details: null },
  ])('does not submit an unsupported or incomplete stored proposal', async (invalid) => {
    const action = invalid as unknown as ChatAction;
    api.get.mockReturnValue(of([conversation({ messages: [message({ action })] })]));
    await service.initialize();

    await service.decideAction(action, 'apply');

    expect(api.post).not.toHaveBeenCalled();
    expect(rates.refresh).not.toHaveBeenCalled();
    expect(operations.refresh).not.toHaveBeenCalled();
    expect(service.error()).toContain('cannot be reviewed safely');
    expect(service.pendingAction()).toBe(null);
  });

  it('checks the canonical stored review rather than a complete stale card with the same ID', async () => {
    const invalid = { ...batchAction, details: { updates: [] } };
    api.get.mockReturnValue(of([conversation({ messages: [message({ action: invalid })] })]));
    await service.initialize();

    await service.decideAction(batchAction, 'apply');

    expect(api.post).not.toHaveBeenCalled();
    expect(service.error()).toContain('cannot be reviewed safely');
  });

  it.each([
    message({ action: { ...rateAction, status: 'applied' } }),
    message({ role: 'user', action: rateAction }),
    message({ action: { ...rateAction, id: 'another-action' } }),
  ])('requires an owned pending assistant proposal before a decision', async (stored) => {
    api.get.mockReturnValue(of([conversation({ messages: [stored] })]));
    await service.initialize();

    await service.decideAction(rateAction, 'apply');

    expect(api.post).not.toHaveBeenCalled();
    expect(service.pendingAction()).toBe(null);
  });

  it('allows an unsupported owned pending proposal to be cancelled without refreshing hotel data', async () => {
    const action = {
      ...batchAction,
      kind: 'future_action',
      details: null,
    } as unknown as ChatAction;
    api.get.mockReturnValue(of([conversation({ messages: [message({ action })] })]));
    await service.initialize();
    api.post.mockReturnValue(
      of(conversation({ messages: [message({ action: { ...action, status: 'cancelled' } })] })),
    );

    await service.decideAction(action, 'cancel');

    expect(api.post).toHaveBeenCalledExactlyOnceWith(
      `/conversations/conversation-berlin/actions/${action.id}`,
      { decision: 'cancel' },
    );
    expect(service.messages()[0].action?.status).toBe('cancelled');
    expect(rates.refresh).not.toHaveBeenCalled();
    expect(operations.refresh).not.toHaveBeenCalled();
  });

  it('preserves a stale batch proposal and its error without refreshing or retrying a write', async () => {
    api.get.mockReturnValue(of([conversation({ messages: [message({ action: batchAction })] })]));
    await service.initialize();
    api.post.mockReturnValue(
      throwError(() => new Error('Rates changed since this proposal was prepared.')),
    );

    await service.decideAction(batchAction, 'apply');

    expect(api.post).toHaveBeenCalledTimes(1);
    expect(service.messages()[0].action?.status).toBe('pending');
    expect(service.error()).toContain('Rates changed');
    expect(service.pendingAction()).toBe(null);
    expect(rates.refresh).not.toHaveBeenCalled();
    expect(operations.refresh).not.toHaveBeenCalled();
  });
});
