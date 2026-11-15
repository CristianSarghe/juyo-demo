import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantUiStore } from './assistant-ui.store';
import { ChatService } from './chat.service';
import type { Message } from './models';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('AssistantUiStore', () => {
  let store: AssistantUiStore;
  let chat: {
    messages: ReturnType<typeof signal<readonly Message[]>>;
    loading: ReturnType<typeof signal<boolean>>;
    isResponding: ReturnType<typeof signal<boolean>>;
    pendingAction: ReturnType<typeof signal<string | null>>;
    error: ReturnType<typeof signal<string>>;
    initialize: ReturnType<typeof vi.fn>;
    newConversation: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
    decideAction: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    chat = {
      messages: signal<readonly Message[]>([]),
      loading: signal(false),
      isResponding: signal(false),
      pendingAction: signal<string | null>(null),
      error: signal(''),
      initialize: vi.fn().mockResolvedValue(undefined),
      newConversation: vi.fn(),
      send: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
      clear: vi.fn(),
      decideAction: vi.fn().mockResolvedValue(undefined),
    };
    TestBed.configureTestingModule({
      providers: [AssistantUiStore, { provide: ChatService, useValue: chat }],
    });
    store = TestBed.inject(AssistantUiStore);
  });

  it('opens contextual help without submitting it and keeps an editable draft when closed', async () => {
    expect(chat.initialize).not.toHaveBeenCalled();
    store.setDraft('Find a ventilation company in Berlin.');
    store.open({ kind: 'warning', label: '  Room 105 repair  ' });
    await store.initialize();

    expect(store.isOpen()).toBe(true);
    expect(store.context()).toEqual({ kind: 'warning', label: 'Room 105 repair' });
    expect(store.draft()).toBe('Find a ventilation company in Berlin.');
    expect(chat.initialize).toHaveBeenCalledTimes(1);
    expect(chat.send).not.toHaveBeenCalled();

    store.close();
    expect(store.isOpen()).toBe(false);
    expect(store.draft()).toBe('Find a ventilation company in Berlin.');
    expect(chat.stop).not.toHaveBeenCalled();
  });

  it('sends the edited draft through the existing conversation and displays its reply', async () => {
    await store.initialize();
    const reply: Message = {
      id: 'reply',
      role: 'assistant',
      content: 'Two local repair companies serve Berlin.',
      createdAt: '2026-11-14T12:00:00Z',
    };
    chat.send.mockImplementation(async () => {
      chat.messages.set([reply]);
    });
    store.setDraft('  Find repair help for room 105.  ');

    await store.send();

    expect(chat.send).toHaveBeenCalledExactlyOnceWith('Find repair help for room 105.');
    expect(chat.newConversation).not.toHaveBeenCalled();
    expect(store.draft()).toBe('');
    expect(store.messages()).toEqual([reply]);
  });

  it('starts one contextual request and ignores a duplicate click while that request is pending', async () => {
    await store.initialize();
    const response = deferred();
    chat.send.mockReturnValue(response.promise);

    const asking = store.ask('Review prices during the event.', {
      kind: 'event',
      label: 'Urban mobility summit',
    });
    expect(store.requestPending()).toBe(true);
    expect(store.isOpen()).toBe(true);
    expect(await store.ask('Review prices again.', { kind: 'event', label: 'Duplicate' })).toBe(
      false,
    );
    await Promise.resolve();
    expect(chat.newConversation).toHaveBeenCalledTimes(1);
    expect(chat.send).toHaveBeenCalledExactlyOnceWith('Review prices during the event.');
    expect(store.context().label).toBe('Urban mobility summit');

    response.resolve();
    expect(await asking).toBe(true);
    expect(store.requestPending()).toBe(false);
    expect(store.draft()).toBe('');
  });

  it('retains a failed question for editing and clears it after a successful retry', async () => {
    await store.initialize();
    chat.send.mockImplementationOnce(async () => {
      chat.error.set('Could not reach Kassandra.');
    });
    store.setDraft('Explain booked revenue.');

    await store.send();
    expect(store.error()).toBe('Could not reach Kassandra.');
    expect(store.draft()).toBe('Explain booked revenue.');

    chat.send.mockImplementationOnce(async () => {
      chat.error.set('');
    });
    await store.send();
    expect(chat.send).toHaveBeenCalledTimes(2);
    expect(store.error()).toBe('');
    expect(store.draft()).toBe('');
  });

  it('stops a pending contextual request without closing the helper or accepting its late completion', async () => {
    await store.initialize();
    const response = deferred();
    chat.send.mockReturnValue(response.promise);
    const asking = store.ask('Find local repair companies.', {
      kind: 'warning',
      label: 'Room repair',
    });
    await Promise.resolve();
    expect(chat.send).toHaveBeenCalledTimes(1);

    store.stop();
    expect(chat.stop).toHaveBeenCalledTimes(1);
    expect(store.requestPending()).toBe(false);
    expect(store.isOpen()).toBe(true);
    response.resolve();
    expect(await asking).toBe(false);
    expect(store.requestPending()).toBe(false);
  });
});
