import '@angular/compiler';
import assert from 'node:assert/strict';
import {
  createEnvironmentInjector,
  provideZonelessChangeDetection,
  signal,
  ɵINJECTOR_SCOPE,
} from '@angular/core';
import { Subject, filter, firstValueFrom, timeout } from 'rxjs';
import { AuthenticatedWorkspaceService } from '../src/app/core/api/authenticated-workspace.service';
import { ApiClient, ApiError } from '../src/app/core/api/api-client.service';
import { API_CONFIG, MOCK_API_CONFIG } from '../src/app/core/api/api.config';
import { NetworkDataStore } from '../src/app/core/api/network-data.store';
import { ReferenceDataService } from '../src/app/core/api/reference-data.service';
import { ChatService } from '../src/app/core/chat.service';
import { AuthService } from '../src/app/core/auth.service';
import { RoomOperationsService } from '../src/app/core/room-operations.service';
import { RoomRateService } from '../src/app/core/room-rate.service';
import { HotelScopeService } from '../src/app/core/hotel-scope.service';
import { ReportingScopeService } from '../src/app/core/reporting-scope.service';
import { NETWORK_DATA, REPORTING_DATES } from '../src/app/core/network.data';
import type { HotelNetwork, PropertyScope, ReportingMonth } from '../src/app/core/network.models';
import type { ChatAction, Conversation } from '../src/app/core/models';

type DeferredRequest = {
  method: string;
  path: string;
  body?: unknown;
  options?: { timeoutMs?: number };
  response: Subject<unknown>;
};
class DeferredApi {
  private readonly created = new Subject<DeferredRequest>();
  readonly requests: {
    method: string;
    path: string;
    body?: unknown;
    options?: { timeoutMs?: number };
    response: Subject<unknown>;
  }[] = [];
  private request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: { timeoutMs?: number },
  ) {
    const response = new Subject<unknown>();
    const request = { method, path, body, options, response };
    this.requests.push(request);
    this.created.next(request);
    return response.asObservable() as import('rxjs').Observable<T>;
  }
  get<T>(path: string) {
    return this.request<T>('GET', path);
  }
  post<T>(path: string, body: unknown, options?: { timeoutMs?: number }) {
    return this.request<T>('POST', path, body, options);
  }
  patch<T>(path: string, body: unknown) {
    return this.request<T>('PATCH', path, body);
  }
  delete<T>(path: string) {
    return this.request<T>('DELETE', path);
  }
  waitFor(method: string, path: string): Promise<DeferredRequest> {
    const existing = [...this.requests]
      .reverse()
      .find((item) => item.method === method && item.path === path);
    return existing
      ? Promise.resolve(existing)
      : firstValueFrom(
          this.created.pipe(
            filter((item) => item.method === method && item.path === path),
            timeout({ first: 2000 }),
          ),
        );
  }
  latest(method: string, path: string) {
    const request = [...this.requests]
      .reverse()
      .find((item) => item.method === method && item.path === path);
    assert(request, `${method} ${path} was requested`);
    return request;
  }
  resolve(method: string, path: string, value: unknown) {
    const request = this.latest(method, path);
    request.response.next(value);
    request.response.complete();
  }
}
const turn = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

async function main() {
  const api = new DeferredApi();
  const snapshot = signal<HotelNetwork | null>(NETWORK_DATA);
  const scope = signal<PropertyScope>('dev-bru');
  const month = signal<ReportingMonth>('2026-11');
  const date = signal('2026-11-14');
  const dashboardRange = signal({ startDate: '2026-11-01', endDate: '2026-11-30' });
  const store = {
    snapshot,
    dates: REPORTING_DATES,
    get data() {
      assert(snapshot());
      return snapshot()!;
    },
    load: async () => {},
    clear: () => snapshot.set(null),
    invalidateDayDetails: () => {},
  };
  const injector = createEnvironmentInjector(
    [
      // Test-only root scope supplies Angular's real zoneless effect scheduler.
      { provide: ɵINJECTOR_SCOPE, useValue: 'root' },
      provideZonelessChangeDetection(),
      { provide: API_CONFIG, useValue: MOCK_API_CONFIG },
      { provide: ApiClient, useValue: api },
      { provide: NetworkDataStore, useValue: store },
      {
        provide: ReferenceDataService,
        useValue: {
          snapshot,
          get data() {
            return { ...store.data, dates: REPORTING_DATES };
          },
          load: async () => {},
          clear: () => store.clear(),
        },
      },
      {
        provide: AuthenticatedWorkspaceService,
        useValue: {
          initialize: async () => {},
          clear: () => store.clear(),
        },
      },
      {
        provide: HotelScopeService,
        useValue: { scope, select: (value: PropertyScope) => scope.set(value) },
      },
      {
        provide: ReportingScopeService,
        useValue: {
          month,
          date,
          dashboardRange,
          selectMonth: (value: ReportingMonth) => month.set(value),
          selectDate: (value: string) => date.set(value),
        },
      },
      ChatService,
      AuthService,
      RoomOperationsService,
      RoomRateService,
    ],
    null!,
  );
  const chat = injector.get(ChatService);
  const queuedSend = chat.send('November room revenue');
  scope.set('dev-ber');
  api.resolve('GET', '/conversations', [
    {
      id: 'other-hotel-history',
      title: 'Previous question',
      propertyId: 'dev-bru',
      month: '2026-11',
      roomDate: '2026-11-14',
      messages: [],
      updatedAt: '2026-11-14T11:00:00Z',
    },
  ]);
  await queuedSend;
  assert.equal(
    scope(),
    'dev-ber',
    'Loading earlier conversations never changes the selected hotel.',
  );
  assert.equal(
    chat.activeConversation(),
    null,
    'Another hotel’s conversation is not auto-selected.',
  );
  assert.equal(
    api.requests.filter((request) => request.method === 'POST').length,
    0,
    'Changing scope while history loads cancels a queued send',
  );

  const pendingSend = chat.send('November room revenue');
  await turn();
  const conversation: Conversation = {
    id: 'conversation-test',
    title: 'Revenue',
    propertyId: 'dev-ber',
    month: '2026-11',
    roomDate: '2026-11-14',
    messages: [],
    updatedAt: '2026-11-14T12:00:00Z',
  };
  api.resolve('POST', '/conversations', conversation);
  await turn();
  const messageRequest = api.latest('POST', '/conversations/conversation-test/messages');
  assert.equal(
    messageRequest.options?.timeoutMs,
    180_000,
    'Inference has a bounded three-minute deadline.',
  );
  assert.equal(
    api.latest('POST', '/conversations').options,
    undefined,
    'Creating a conversation keeps the normal API deadline.',
  );
  assert.equal(chat.messages().at(-1)?.role, 'user');
  chat.stop();
  assert.equal(
    messageRequest.response.observers.length,
    0,
    'Stop unsubscribes the active HTTP request',
  );
  messageRequest.response.next({
    ...conversation,
    messages: [
      {
        id: 'stale',
        role: 'assistant',
        content: 'stale answer',
        createdAt: conversation.updatedAt,
      },
    ],
  });
  await pendingSend;
  assert(
    !chat.messages().some((message) => message.id === 'stale'),
    'Cancelled responses cannot replace the visible conversation',
  );
  assert.equal(chat.isResponding(), false);

  const proposal: ChatAction = {
    id: 'proposal-test',
    kind: 'rate_update',
    status: 'pending',
    summary: 'Set Classic rooms to €170 per night',
    details: {
      hotelId: 'dev-ber',
      hotelName: 'Spreehof Berlin',
      roomTypeId: 'dev-ber-type-1',
      roomTypeName: 'Classic',
      startDate: '2026-11-20',
      endDate: '2026-11-22',
      nightlyRate: 170,
    },
  };
  const proposalSend = chat.send('Suggest a rate change for December');
  await turn();
  const contextualMessage = api.latest('POST', '/conversations/conversation-test/messages');
  assert.equal(month(), '2026-11', 'Explicit dates in a question do not change the global filter.');
  assert.deepEqual(
    (contextualMessage.body as { context: unknown }).context,
    {
      propertyId: 'dev-ber',
      startDate: '2026-11-01',
      endDate: '2026-11-30',
    },
    'The applied hotel and inclusive interval accompany each question.',
  );
  const proposedConversation: Conversation = {
    ...conversation,
    messages: [
      {
        id: 'answer-proposal',
        role: 'assistant',
        content: 'Review this change.',
        action: proposal,
        createdAt: conversation.updatedAt,
      },
    ],
  };
  api.resolve('POST', '/conversations/conversation-test/messages', proposedConversation);
  await proposalSend;
  const apply = chat.decideAction(proposal, 'apply');
  assert.equal(
    api.latest('POST', '/conversations/conversation-test/actions/proposal-test').options,
    undefined,
    'Confirmed writes keep the normal API deadline.',
  );
  assert.equal(chat.pendingAction(), proposal.id);
  await chat.decideAction(proposal, 'apply');
  assert.equal(
    api.requests.filter((request) => request.path.includes('/actions/')).length,
    1,
    'A repeated click cannot submit a second concurrent action.',
  );
  api.resolve('POST', '/conversations/conversation-test/actions/proposal-test', {
    ...proposedConversation,
    messages: proposedConversation.messages.map((message) => ({
      ...message,
      action: { ...proposal, status: 'applied' },
    })),
  });
  await api.waitFor('GET', '/rate-updates');
  api.resolve('GET', '/rate-updates', []);
  await apply;
  assert.equal(chat.messages().at(-1)?.action?.status, 'applied');
  assert.equal(chat.pendingAction(), null);

  const changingRangeSend = chat.send('Compare these dates');
  await turn();
  const changingRangeRequest = api.latest('POST', '/conversations/conversation-test/messages');
  dashboardRange.set({ startDate: '2026-11-14', endDate: '2026-11-20' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    changingRangeRequest.response.observers.length,
    0,
    'Applying a different dashboard interval unsubscribes the old chat request.',
  );
  await changingRangeSend;
  assert.equal(chat.isResponding(), false);

  const operations = injector.get(RoomOperationsService);
  const update = operations.update(NETWORK_DATA.rooms[0].id, 'dirty');
  assert.equal(operations.pending(), true);
  assert.equal(
    api.requests.filter((request) => request.method === 'PATCH').length,
    0,
    'Writes await their initial API history',
  );
  api.resolve('GET', '/room-state-changes', []);
  await turn();
  api
    .latest('PATCH', `/rooms/${NETWORK_DATA.rooms[0].id}/state`)
    .response.error(new ApiError(409, 'CONFLICT', 'Room is occupied.'));
  assert.equal(await update, false);
  assert.deepEqual(operations.changes(), [], 'Rejected writes do not publish speculative state');
  assert.equal(operations.error(), 'Room is occupied.');
  assert.equal(operations.pending(), false);

  const auth = injector.get(AuthService);
  const restore = auth.initialize();
  assert.equal(auth.initialize(), restore, 'Session restore coalesces concurrent initialization');
  api
    .latest('GET', '/sessions/current')
    .response.error(new ApiError(401, 'UNAUTHENTICATED', 'Sign in.'));
  await restore;
  assert.equal(auth.isAuthenticated(), false);
  const login = auth.login('qa@example.com', 'local-password');
  await assert.rejects(
    auth.login('other@example.com', 'other-password'),
    (error: unknown) => error instanceof ApiError && error.code === 'AUTH_BUSY',
  );
  assert.equal(
    api.requests.filter((request) => request.method === 'POST' && request.path === '/sessions')
      .length,
    1,
    'Overlapping sign-ins cannot create duplicate sessions',
  );
  api.resolve('POST', '/sessions', { user: { name: 'Qa', email: 'qa@example.com' } });
  await login;
  await auth.prepareWorkspace();
  assert.equal(auth.isAuthenticated(), true);
  const failedLogout = auth.logout();
  api
    .latest('DELETE', '/sessions/current')
    .response.error(new ApiError(503, 'UNAVAILABLE', 'Try again.'));
  await assert.rejects(failedLogout);
  assert.equal(auth.isAuthenticated(), true, 'A failed logout preserves the session');
  const logout = auth.logout();
  api.resolve('DELETE', '/sessions/current', null);
  await logout;
  assert.equal(auth.isAuthenticated(), false);
  assert(snapshot(), 'Workspace data survives until authenticated views finish navigating away');
  chat.clear();
  auth.clearWorkspace();
  assert.equal(snapshot(), null);
  assert.deepEqual(chat.conversations(), []);
  assert.equal(
    chat.propertyOptions.length,
    1,
    'Cleared metadata safely falls back to portfolio chrome',
  );
  snapshot.set({
    ...NETWORK_DATA,
    hotels: [{ ...NETWORK_DATA.hotels[0], id: 'new-hotel', name: 'New hotel' }],
  });
  assert(
    chat.propertyOptions.some((property) => property.id === 'new-hotel'),
    'A new API workspace updates cached chat property options',
  );
  const staleApi = new DeferredApi();
  const staleInjector = createEnvironmentInjector(
    [
      AuthService,
      { provide: ApiClient, useValue: staleApi },
      {
        provide: AuthenticatedWorkspaceService,
        useValue: { initialize: async () => {}, clear: () => {} },
      },
    ],
    injector,
  );
  const staleAuth = staleInjector.get(AuthService);
  const staleRestore = staleAuth.initialize();
  staleAuth.clearWorkspace();
  staleApi.resolve('GET', '/sessions/current', {
    user: { name: 'Previous user', email: 'previous@example.com' },
  });
  await staleRestore;
  assert.equal(staleAuth.user(), null, 'A cleared workspace rejects late session restoration');
  staleInjector.destroy();

  const retryApi = new DeferredApi();
  let partialCache: string | null = null;
  let loadAttempts = 0;
  const retryWorkspace = {
    initialize: async () => {
      loadAttempts++;
      if (loadAttempts === 1) {
        partialCache = 'account-a';
        throw new ApiError(503, 'PARTIAL_WORKSPACE', 'Room states could not load.');
      }
      assert.equal(
        partialCache,
        null,
        'A different account must not reuse a partial reporting cache',
      );
      partialCache = 'account-b';
    },
    clear: () => {
      partialCache = null;
    },
  };
  const retryInjector = createEnvironmentInjector(
    [
      AuthService,
      { provide: ApiClient, useValue: retryApi },
      { provide: AuthenticatedWorkspaceService, useValue: retryWorkspace },
    ],
    injector,
  );
  const retryAuth = retryInjector.get(AuthService);
  const firstLogin = retryAuth.login('account-a@example.com', 'local-password');
  retryApi.resolve('POST', '/sessions', {
    user: { name: 'Account A', email: 'account-a@example.com' },
  });
  await firstLogin;
  await assert.rejects(retryAuth.prepareWorkspace());
  assert.equal(
    retryAuth.user()?.email,
    'account-a@example.com',
    'Reference loading is separate from authentication and remains retryable.',
  );
  const firstLogout = retryAuth.logout();
  retryApi.resolve('DELETE', '/sessions/current', null);
  await firstLogout;
  assert.equal(partialCache, 'account-a');
  const secondLogin = retryAuth.login('account-b@example.com', 'local-password');
  assert.equal(
    partialCache,
    null,
    'A sign-in retry clears the previous partial workspace before making a new session',
  );
  retryApi.resolve('POST', '/sessions', {
    user: { name: 'Account B', email: 'account-b@example.com' },
  });
  await secondLogin;
  await retryAuth.prepareWorkspace();
  assert.equal(retryAuth.user()?.email, 'account-b@example.com');
  assert.equal(partialCache, 'account-b');
  await assert.rejects(retryAuth.login('account-c@example.com', 'local-password'));
  retryInjector.destroy();
  injector.destroy();
  console.log(
    'Validated API facade cancellation, stale-scope protection, serialized initialization/writes, rejected-write rollback, session failures and workspace cache reset.',
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
