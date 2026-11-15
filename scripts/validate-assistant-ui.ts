import '@angular/compiler';
import assert from 'node:assert/strict';
import { createEnvironmentInjector, signal } from '@angular/core';
import { ASSISTANT_EXAMPLES, AssistantUiStore } from '../src/app/core/assistant-ui.store';
import { ChatService } from '../src/app/core/chat.service';
import type { Message } from '../src/app/core/models';
import { repairHelpPrompt } from '../src/app/core/repair-assistance';

async function main(): Promise<void> {
  const room = {
    hotelId: 'hotel-berlin',
    hotelName: 'Example Hotel',
    city: 'Berlin',
    country: 'Germany',
    roomNumber: '105',
    issue: 'Bathroom and ventilation maintenance',
  };
  const repairDraft = repairHelpPrompt([room]);
  assert.ok(repairDraft.includes('Berlin, Germany. Room 105'));
  assert.ok(repairDraft.includes('public business phone number'));
  assert.ok(repairDraft.endsWith('Do not invent companies, phone numbers or availability.'));
  assert.ok(
    repairHelpPrompt(
      Array.from({ length: 88 }, (_, index) => ({
        ...room,
        roomNumber: String(index),
        issue: 'Technical issue '.repeat(30),
      })),
    ).length <= 4000,
  );

  let initializations = 0;
  let sends = 0;
  const messages = signal<Message[]>([]);
  const error = signal('');
  const responding = signal(false);
  const loading = signal(false);
  const chat = {
    messages,
    error,
    loading,
    isResponding: responding,
    pendingAction: signal<string | null>(null),
    initialize: async () => {
      initializations++;
    },
    send: async (content: string) => {
      sends++;
      messages.set([
        { id: String(sends), role: 'user', content, createdAt: new Date().toISOString() },
      ]);
    },
    newConversation: () => messages.set([]),
    clear: () => messages.set([]),
    stop: () => undefined,
  };
  const injector = createEnvironmentInjector(
    [AssistantUiStore, { provide: ChatService, useValue: chat }],
    null!,
  );
  try {
    const assistant = injector.get(AssistantUiStore);
    assert.equal(initializations, 0, 'A closed assistant does not load chat history.');
    assert.equal(assistant.isOpen(), false);
    assert.equal(ASSISTANT_EXAMPLES.length, 3);
    assistant.open();
    await assistant.initialize();
    assert.equal(initializations, 1);
    assistant.setDraft('  ');
    await assistant.send();
    assert.equal(sends, 0);
    assistant.setDraft(ASSISTANT_EXAMPLES[0].prompt);
    assert.equal(sends, 0, 'An example only fills the draft.');
    await assistant.send();
    assert.equal(sends, 1);
    assert.equal(
      assistant.messages(),
      messages(),
      'The panel uses API chat messages, without canned answers.',
    );
    assert.equal(assistant.draft(), '');
    assistant.setDraft('Keep this draft.');
    assistant.close();
    assistant.open({ kind: 'warning', label: 'Room 105' });
    assert.equal(assistant.draft(), 'Keep this draft.');
    assert.equal(assistant.messages().length, 1);
    assert.equal(assistant.context().label, 'Room 105');
    responding.set(true);
    await assistant.send();
    assert.equal(sends, 1, 'A pending answer prevents a second question.');
    responding.set(false);
    chat.send = async () => {
      error.set('Unavailable');
    };
    await assistant.send();
    assert.equal(
      assistant.draft(),
      'Keep this draft.',
      'A failed request restores an editable question.',
    );
    assistant.setDraft('x'.repeat(4100));
    assert.equal(assistant.draft().length, 4000);
    assistant.newConversation();
    assert.equal(assistant.messages().length, 0);
    assert.equal(assistant.draft(), '');
    assistant.clear();
    assert.equal(assistant.isOpen(), false);
    assert.equal(assistant.context().kind, 'general');
    error.set('');
    let initialized!: () => void;
    const initializationStarted = new Promise<void>((resolve) => {
      initialized = resolve;
    });
    let releaseInitialization!: () => void;
    const initializationGate = new Promise<void>((resolve) => {
      releaseInitialization = resolve;
    });
    let contextualSends = 0;
    let newConversations = 0;
    let decisions = 0;
    const contextualChat = {
      ...chat,
      initialize: async () => {
        initialized();
        await initializationGate;
      },
      newConversation: () => {
        newConversations++;
        messages.set([]);
      },
      send: async (content: string) => {
        contextualSends++;
        messages.set([
          { id: 'event-question', role: 'user', content, createdAt: new Date().toISOString() },
        ]);
      },
      decideAction: async () => {
        decisions++;
      },
    };
    const contextualInjector = createEnvironmentInjector(
      [AssistantUiStore, { provide: ChatService, useValue: contextualChat }],
      null!,
    );
    try {
      const contextual = contextualInjector.get(AssistantUiStore);
      const question = 'Prepare an event price proposal for review.';
      const request = contextual.ask(question, { kind: 'event', label: 'Event pricing' });
      await initializationStarted;
      assert.equal(contextual.isOpen(), true);
      assert.equal(contextual.requestPending(), true);
      assert.equal(contextual.draft(), question);
      assert.equal(contextualSends, 0, 'A cold contextual request waits for chat initialization.');
      assert.equal(
        await contextual.ask(question, { kind: 'event', label: 'Event pricing' }),
        false,
      );
      await contextual.send();
      assert.equal(contextualSends, 0, 'Manual submission cannot duplicate a queued request.');
      releaseInitialization();
      assert.equal(await request, true);
      assert.equal(contextualSends, 1);
      assert.equal(newConversations, 1);
      assert.equal(contextual.draft(), '');
      assert.equal(contextual.requestPending(), false);
      assert.equal(decisions, 0, 'Requesting a proposal never confirms an operation.');

      contextualChat.send = async () => {
        error.set('Request unavailable');
      };
      assert.equal(
        await contextual.ask(question, { kind: 'event', label: 'Event pricing' }),
        false,
      );
      assert.equal(contextual.draft(), question, 'A failed contextual question remains retryable.');
      assert.equal(contextual.requestPending(), false);
      error.set('');

      let sent!: () => void;
      const sendStarted = new Promise<void>((resolve) => {
        sent = resolve;
      });
      let finishResponse!: () => void;
      const responseGate = new Promise<void>((resolve) => {
        finishResponse = resolve;
      });
      contextualChat.send = async () => {
        sent();
        await responseGate;
      };
      const cancelled = contextual.ask(question, { kind: 'event', label: 'Event pricing' });
      await sendStarted;
      contextual.stop();
      finishResponse();
      assert.equal(await cancelled, false);
      assert.equal(contextual.requestPending(), false);
      assert.equal(decisions, 0);
    } finally {
      contextualInjector.destroy();
    }
    console.log(
      'Validated chat ownership, cold contextual submission, duplicate protection, proposal-only requests, failure recovery, cancellation and reset.',
    );
  } finally {
    injector.destroy();
  }
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
