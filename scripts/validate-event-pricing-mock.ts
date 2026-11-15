import '@angular/compiler';
import assert from 'node:assert/strict';
import { HttpErrorResponse, HttpRequest } from '@angular/common/http';
import { MockChatRepository } from '../src/app/core/api/mock/mock-chat.repository';
import { MockRoomRatesRepository } from '../src/app/core/api/mock/mock-room-rates.repository';
import { MockRepositoryError } from '../src/app/core/api/mock/mock-repository-error';
import { mockEventPricingReply } from '../src/app/core/api/mock/mock-event-pricing';
import { createSession } from '../src/app/core/api/mock/mock-session.repository';
import { handleMockRequest } from '../src/app/core/api/mock/mock-api.backend';
import { eventPricingPrompt } from '../src/app/core/event-pricing-assistance';
import { NETWORK_DATA } from '../src/app/core/network.data';
import type { ChatAction, Conversation } from '../src/app/core/models';

const CHAT_KEY = 'juyo.network.v1.conversations';
const RATE_KEY = 'juyo.room-rates.v1';
const values = new Map<string, string>();
let blockedKey = '';
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => {
    if (blockedKey === key) throw new Error('Storage blocked');
    values.set(key, value);
  },
  removeItem: (key: string) => values.delete(key),
};
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
globalThis.fetch = (() => {
  throw new Error('No network is allowed in this test.');
}) as typeof fetch;
const signIn = (email: string) => createSession({ email, password: 'LocalUiTest2026' });
const rejects = (work: () => unknown, status: number) =>
  assert.throws(
    work,
    (error: unknown) => error instanceof MockRepositoryError && error.status === status,
  );

signIn('owner@example.invalid');
const hotel = NETWORK_DATA.hotels.find((item) => item.id === 'dev-ber')!;
const event = NETWORK_DATA.events.find((item) => item.id === 'event-urban-mobility')!;
assert(hotel && event);
const range = { startDate: event.startDate, endDate: event.endDate };
const prompt = eventPricingPrompt({ eventName: event.name, hotelName: hotel.name, ...range });
const rates = new MockRoomRatesRepository();
// A one-band offline uplift must preserve an existing, higher nightly quote.
const peakEvent = NETWORK_DATA.events.find((item) => item.name === 'Douro Makers Weekend')!;
const peakHotel = NETWORK_DATA.hotels.find((item) => item.id === 'dev-opo')!;
assert(peakEvent && peakHotel);
const peakRange = {
  startDate:
    peakEvent.startDate < NETWORK_DATA.bookingSnapshot.asOf
      ? NETWORK_DATA.bookingSnapshot.asOf
      : peakEvent.startDate,
  endDate: peakEvent.endDate,
};
const peakReview = mockEventPricingReply(
  eventPricingPrompt({
    eventName: peakEvent.name,
    hotelName: peakHotel.name,
    ...peakRange,
  }),
  peakHotel.id,
  rates,
);
assert(peakReview?.action?.kind === 'rate_batch_update');
const peakRow = peakReview.action.details.updates.find((row) => row.roomTypeName === 'Deluxe')!;
assert(peakRow);
const peakDays = rates.rows(peakRow.hotelId, peakRow.roomTypeId, peakRow);
assert(
  peakRow.currentMinRate < peakRow.currentMaxRate,
  'The regression spans different current quotes.',
);
assert(
  peakDays.every((day) => peakRow.nightlyRate >= day.nightlyRate),
  'An event uplift never reduces a higher existing nightly price.',
);
assert.equal(
  peakRow.nightlyRate,
  peakRow.currentMaxRate,
  'The existing peak is preserved when it exceeds the averaged rule suggestion.',
);
assert.equal(rates.changes().length, 0, 'Preparing the peak-price review never writes rates.');
// Make every existing quote deliberately different from the canonical fixture base rate.
for (const type of NETWORK_DATA.roomTypes.filter((item) => item.hotelId === hotel.id))
  assert(rates.update({ hotelId: hotel.id, roomTypeId: type.id, ...range, nightlyRate: 300 }));
const chat = new MockChatRepository(rates);
const create = (repository = chat) =>
  repository.create({
    title: 'Event price review',
    propertyId: hotel.id,
    month: '2026-11',
    roomDate: '2026-11-14',
  });
const pending = (
  conversation: Conversation,
): Extract<ChatAction, { kind: 'rate_batch_update' }> => {
  const reply = conversation.messages.at(-1)!;
  assert.equal(reply.role, 'assistant');
  assert.match(reply.content, /Review the current and proposed prices/);
  assert(reply.action?.kind === 'rate_batch_update');
  assert(
    reply.action.details.updates.length > 1,
    'Event review includes every justified room type.',
  );
  assert.equal(reply.action.status, 'pending');
  return reply.action;
};

const original = create();
const before = rates.changes().length;
const first = chat.appendMessage(original.id, { content: prompt });
const proposal = pending(first);
assert.equal(rates.changes().length, before, 'Preparing a proposal never writes prices.');
for (const row of proposal.details.updates) {
  assert(
    row.nightlyRate >= 312 && row.nightlyRate <= 336,
    'Each proposal uses the effective €300 quote.',
  );
  assert.equal(row.currentMinRate, 300);
  assert.equal(row.currentMaxRate, 300);
  assert.equal(row.eventId, event.id);
  assert.deepEqual({ startDate: row.startDate, endDate: row.endDate }, range);
  assert.equal(row.hotelId, hotel.id);
}
assert(!('ownerEmail' in first), 'Private mock ownership metadata is not part of the API DTO.');

chat.appendMessage(original.id, { content: 'confirm' });
assert.equal(rates.changes().length, before, 'Typing confirmation cannot execute the proposal.');
chat.confirmAction(original.id, proposal.id, 'cancel');
chat.confirmAction(original.id, proposal.id, 'cancel');
assert.equal(rates.changes().length, before, 'Cancel and repeated Cancel do not write rates.');
rejects(() => chat.confirmAction(original.id, proposal.id, 'apply'), 409);

const second = create();
const secondProposal = pending(chat.appendMessage(second.id, { content: prompt }));
rejects(() => chat.confirmAction(second.id, secondProposal.id, 'yes'), 422);
rejects(() => chat.confirmAction(original.id, secondProposal.id, 'apply'), 404);
signIn('other@example.invalid');
assert.equal(chat.get(second.id), null);
assert(!chat.list().some((item) => item.id === second.id));
rejects(() => chat.confirmAction(second.id, secondProposal.id, 'apply'), 404);
signIn('owner@example.invalid');
const applied = chat.confirmAction(second.id, secondProposal.id, 'apply');
assert.equal(applied.messages.at(-1)!.action!.status, 'applied');
assert.equal(rates.changes().length, before + secondProposal.details.updates.length);
for (const row of secondProposal.details.updates)
  assert(
    rates
      .rows(row.hotelId, row.roomTypeId, row)
      .every((day) => day.nightlyRate === row.nightlyRate),
  );
chat.confirmAction(second.id, secondProposal.id, 'apply');
assert.equal(
  rates.changes().length,
  before + secondProposal.details.updates.length,
  'Repeated Apply is idempotent.',
);
rejects(() => chat.confirmAction(second.id, secondProposal.id, 'cancel'), 409);
assert(rates.updateBatch(secondProposal.details.updates, secondProposal.id));
assert(
  !rates.updateBatch(
    secondProposal.details.updates.map((row, index) =>
      index === 0 ? { ...row, nightlyRate: row.nightlyRate + 1 } : row,
    ),
    secondProposal.id,
  ),
);
assert.equal(rates.errorStatus(), 409);
assert(
  !rates.updateBatch(secondProposal.details.updates.slice(0, 1), secondProposal.id),
  'A truncated replay cannot reuse a batch ID.',
);
assert.equal(rates.errorStatus(), 409);
assert.equal(
  rates.changes().length,
  before + secondProposal.details.updates.length,
  'A reused batch id with changed details is rejected.',
);

const saved = JSON.parse(values.get(CHAT_KEY)!) as Conversation[];
saved.find((item) => item.id === second.id)!.dataVersion = 'older-fixture-version';
values.set(CHAT_KEY, JSON.stringify(saved));
const restored = new MockChatRepository(new MockRoomRatesRepository());
const restoredAction = restored.get(second.id)!.messages.at(-1)!;
assert.equal(restoredAction.action!.id, secondProposal.id);
assert.equal(restoredAction.action!.status, 'applied');
assert.match(
  restoredAction.content,
  /Review the current and proposed prices/,
  'Refresh preserves the historical proposal rather than replacing it with analytics.',
);

const invalid = create();
const writes = rates.changes().length;
rejects(
  () => chat.appendMessage(invalid.id, { content: prompt.replace(event.name, 'Unknown event') }),
  422,
);
rejects(
  () => chat.appendMessage(invalid.id, { content: prompt.replace(range.startDate, '2026-11-30') }),
  422,
);
rejects(
  () =>
    chat.appendMessage(invalid.id, {
      content: prompt.replace('Hotel: ', 'Hotel: Unknown\nHotel: '),
    }),
  422,
);
assert.equal(rates.changes().length, writes);

// A failed history save after the authorized price write can safely resume after reload.
const third = create();
const thirdConversation = chat.appendMessage(third.id, { content: prompt });
const thirdAction = thirdConversation.messages.at(-1)!.action!;
assert(thirdAction.kind === 'rate_batch_update');
const beforeFailure = rates.changes().length;
blockedKey = CHAT_KEY;
rejects(() => chat.confirmAction(third.id, thirdAction.id, 'apply'), 503);
assert.equal(rates.changes().length, beforeFailure + thirdAction.details.updates.length);
blockedKey = '';
rejects(() => chat.confirmAction(third.id, thirdAction.id, 'cancel'), 409);
assert.equal(
  chat.get(third.id)!.messages.at(-1)!.action!.status,
  'pending',
  'A partial Apply can never be mislabeled as cancelled.',
);
assert.equal(rates.changes().length, beforeFailure + thirdAction.details.updates.length);
const recoveredRates = new MockRoomRatesRepository();
const recoveredChat = new MockChatRepository(recoveredRates);
recoveredChat.confirmAction(third.id, thirdAction.id, 'apply');
assert.equal(
  recoveredRates.changes().length,
  beforeFailure + thirdAction.details.updates.length,
  'Reload and retry never apply the authorized proposal twice.',
);
assert.equal(recoveredChat.get(third.id)!.messages.at(-1)!.action!.status, 'applied');

const fourth = create(recoveredChat);
const fourthAction = recoveredChat
  .appendMessage(fourth.id, { content: prompt })
  .messages.at(-1)!.action!;
const beforeBlockedRate = recoveredRates.changes().length;
blockedKey = RATE_KEY;
rejects(() => recoveredChat.confirmAction(fourth.id, fourthAction.id, 'apply'), 503);
assert.equal(recoveredRates.changes().length, beforeBlockedRate);
blockedKey = '';

// A stale row must prevent every row in the batch from being written.
const staleConversation = create(recoveredChat);
const stale = pending(recoveredChat.appendMessage(staleConversation.id, { content: prompt }));
const staleRow = stale.details.updates.at(-1)!;
assert(recoveredRates.update({ ...staleRow, nightlyRate: staleRow.currentMaxRate + 1 }));
const afterConcurrentEdit = recoveredRates.changes().length;
rejects(() => recoveredChat.confirmAction(staleConversation.id, stale.id, 'apply'), 409);
assert.equal(
  recoveredRates.changes().length,
  afterConcurrentEdit,
  'A stale last row leaves no earlier writes.',
);
assert.equal(recoveredChat.get(staleConversation.id)!.messages.at(-1)!.action!.status, 'pending');
const conflicting = [stale.details.updates[0], { ...stale.details.updates[0], nightlyRate: 250 }];
assert(
  !recoveredRates.updateBatch(conflicting, crypto.randomUUID()),
  'Overlapping intervals are invalid.',
);
assert(
  !recoveredRates.updateBatch(
    Array.from({ length: 21 }, () => stale.details.updates[0]),
    crypto.randomUUID(),
  ),
);
assert.equal(recoveredRates.changes().length, afterConcurrentEdit);

// Portfolio requests evaluate all relevant hotels and explain unsupported changes.
const sharedEvent = NETWORK_DATA.events.find(
  (item) =>
    item.endDate >= NETWORK_DATA.bookingSnapshot.asOf &&
    NETWORK_DATA.eventHotelImpacts.filter((impact) => impact.eventId === item.id).length > 1,
)!;
assert(sharedEvent, 'At least one event is relevant to multiple hotels.');
const scopedHotels = NETWORK_DATA.hotels.filter((item) =>
  NETWORK_DATA.eventHotelImpacts.some(
    (impact) => impact.eventId === sharedEvent.id && impact.hotelId === item.id,
  ),
);
const portfolio = recoveredChat.create({
  title: 'Portfolio event review',
  propertyId: 'portfolio',
  month: '2026-11',
  roomDate: '2026-11-14',
});
const portfolioPrompt = eventPricingPrompt({
  eventName: sharedEvent.name,
  hotelNames: scopedHotels.map((item) => item.name),
  startDate: sharedEvent.startDate,
  endDate: sharedEvent.endDate,
});
const portfolioReply = recoveredChat.appendMessage(portfolio.id, { content: portfolioPrompt });
const portfolioAction = pending(portfolioReply);
assert(
  portfolioAction.details.updates.some((item) => item.hotelId === 'dev-bru'),
  'The strong event opportunity is retained.',
);
assert(
  portfolioAction.details.updates.every((item) =>
    scopedHotels.some((hotel) => hotel.id === item.hotelId),
  ),
  'No hotel outside the requested relevant scope is proposed.',
);
assert(
  !portfolioAction.details.updates.some((item) => item.hotelId === 'dev-ams'),
  'A mild event with insufficient booked demand does not force an unjustified price update.',
);
assert.match(
  portfolioReply.messages.at(-1)!.content,
  /Kept current prices at Canal House Amsterdam: booked occupancy and the event's mild relevance do not support an increase/,
  'The evaluated but excluded hotel and its reason are explicit.',
);
assert.equal(
  recoveredRates.changes().length,
  afterConcurrentEdit,
  'Portfolio preparation does not mutate rates.',
);

// Exercise the HTTP decision route independently of the UI, including method validation.
const response = handleMockRequest(
  new HttpRequest('POST', `/api/v1/conversations/${fourth.id}/actions/${fourthAction.id}`, {
    decision: 'cancel',
    details: { nightlyRate: 1 },
  }),
);
assert.equal(response.status, 200);
assert.equal((response.body as Conversation).messages.at(-1)!.action!.status, 'cancelled');
assert.throws(
  () =>
    handleMockRequest(
      new HttpRequest('GET', `/api/v1/conversations/${fourth.id}/actions/${fourthAction.id}`),
    ),
  (error: unknown) => error instanceof HttpErrorResponse && error.status === 405,
);
signIn('other@example.invalid');
assert.throws(
  () =>
    handleMockRequest(
      new HttpRequest('POST', `/api/v1/conversations/${fourth.id}/actions/${fourthAction.id}`, {
        decision: 'apply',
      }),
    ),
  (error: unknown) => error instanceof HttpErrorResponse && error.status === 404,
);

console.log(
  'Validated event mock proposals, effective quotes, no pre-confirmation writes, ownership, cancellation, idempotence, reload/retry recovery and REST decisions.',
);
