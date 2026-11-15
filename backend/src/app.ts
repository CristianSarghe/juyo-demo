import { randomUUID } from 'node:crypto';
import type { ApiEnvironment } from './config';
import { allowedOrigins } from './config';
import { ApiProblemError, reject } from './problem';
import type { AuthenticatedUser, SessionRepository } from './auth';
import type { SqlWorkspaceRepository } from './persistence/sql-workspace.repository';
import type { HotelNetwork, RoomWarning } from './domain/network.models';
import type {
  CreateConversationRequest,
  RoomOperationAction,
  RoomRateUpdateRequest,
} from './domain/mutation.models';
import { createNetworkSelectors, reportingDatesFor } from './domain/network.selectors';
import { buildNetworkSchema } from './domain/network.schema';
import { createBookingRateHistory } from './domain/room-price-history';
import { applyRoomChange } from './domain/room-operation-state';
import { RESOURCE_PATHS } from './domain/resource-paths';
import type { CollectionKey, Page, ReferenceDataDto } from './domain/api.models';
import { requestKassandra } from './chat/remote';
import { encodeMessagePayload } from './domain/chat.models';
import { page, resourceRows, selectedDate, selectedRange, selectedScope } from './rest-data';

export interface ApiDependencies {
  env: ApiEnvironment;
  sessions: Pick<SessionRepository, 'login' | 'authenticate' | 'logout'>;
  workspace: SqlWorkspaceRepository;
  loadNetwork(): Promise<HotelNetwork>;
  /** Workers release request-owned SQL sockets during the potentially long model wait. */
  runInference?<T>(infer: () => Promise<T>): Promise<T>;
  loadReference?(): Promise<ReferenceDataDto>;
  readCollection?(key: CollectionKey, params: URLSearchParams): Promise<Page<unknown>>;
  loadWarningsData?(params: URLSearchParams): Promise<HotelNetwork>;
  loadUpcomingEventsData?(params: URLSearchParams): Promise<HotelNetwork>;
  loadPriceHistoryData?(roomTypeId: string, params: URLSearchParams): Promise<HotelNetwork>;
}
const resources = new Map<string, CollectionKey>(
  Object.entries(RESOURCE_PATHS).map(([key, path]) => [path, key as CollectionKey]),
);
const knownReads = new Set([
  '/reference-data',
  '/schema',
  '/exports/network',
  '/room-state-changes',
  '/warnings',
  '/events/upcoming',
  '/analytics/dashboard',
]);
const loginAttempts = new Map<string, { count: number; until: number }>();
function limitLogin(key: string): void {
  const now = Date.now(),
    entry = loginAttempts.get(key);
  if (entry && entry.until > now) {
    if (entry.count >= 10)
      reject(429, 'TOO_MANY_ATTEMPTS', 'Too many sign-in attempts. Try again in 15 minutes.');
    entry.count++;
  } else {
    if (loginAttempts.size >= 1000)
      for (const [id, value] of loginAttempts) if (value.until <= now) loginAttempts.delete(id);
    if (loginAttempts.size >= 1000)
      reject(429, 'TOO_MANY_ATTEMPTS', 'Please try signing in later.');
    loginAttempts.set(key, { count: 1, until: now + 15 * 60_000 });
  }
}
function methodsFor(path: string): string[] | undefined {
  if (path === '/sessions') return ['POST'];
  if (path === '/sessions/current') return ['GET', 'DELETE'];
  if (/^\/rooms\/[^/]+\/state$/.test(path)) return ['GET', 'PATCH', 'DELETE'];
  if (path === '/rate-updates' || path === '/conversations') return ['GET', 'POST'];
  if (/^\/rate-updates\/[^/]+$/.test(path)) return ['GET'];
  if (/^\/conversations\/[^/]+\/messages$/.test(path)) return ['POST'];
  if (/^\/conversations\/[^/]+\/actions\/[^/]+$/.test(path)) return ['POST'];
  if (/^\/conversations\/[^/]+$/.test(path)) return ['GET', 'DELETE'];
  if (
    resources.has(path) ||
    knownReads.has(path) ||
    /^\/room-types\/[^/]+\/price-history$/.test(path)
  )
    return ['GET'];
  for (const prefix of resources.keys())
    if (path.startsWith(`${prefix}/`) && !path.slice(prefix.length + 1).includes('/'))
      return ['GET'];
  return undefined;
}
async function body(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('content-type') ?? ''))
    reject(415, 'JSON_REQUIRED', 'Send an application/json request.');
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > 32768) reject(413, 'BODY_TOO_LARGE', 'Request body is too large.');
  const reader = request.body?.getReader();
  if (!reader) reject(422, 'BODY_REQUIRED', 'A JSON request body is required.');
  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > 32768) {
        await reader.cancel();
        reject(413, 'BODY_TOO_LARGE', 'Request body is too large.');
      }
      chunks.push(part.value);
    }
    const all = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      all.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder().decode(all));
    } catch {
      reject(400, 'INVALID_JSON', 'Send a valid JSON request.');
    }
  } finally {
    reader.releaseLock();
  }
}

/** Framework-free Fetch handler. SQL transport and deployment can be removed independently. */
export async function handleApi(request: Request, deps: ApiDependencies): Promise<Response> {
  const origin = request.headers.get('origin'),
    origins = allowedOrigins(deps.env),
    headers = new Headers({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      Vary: 'Origin',
    });
  if (origin && origins.has(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    headers.set('Access-Control-Expose-Headers', 'Location, X-Request-Id');
    headers.set('Access-Control-Max-Age', '600');
  }
  const requestId = randomUUID();
  headers.set('X-Request-Id', requestId);
  const json = (value: unknown, status = 200, location?: string) => {
    const h = new Headers(headers);
    h.set('Content-Type', 'application/json');
    if (location) h.set('Location', location);
    return new Response(status === 204 ? null : JSON.stringify(value), { status, headers: h });
  };
  let allowed: string[] | undefined;
  try {
    if (origin && !origins.has(origin))
      reject(403, 'ORIGIN_NOT_ALLOWED', 'This application origin is not allowed.');
    const url = new URL(request.url),
      path = url.pathname.replace(/^\/api\/v1(?=\/|$)/, '').replace(/\/$/, '') || '/';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (url.pathname === '/health' && request.method === 'GET') return json({ status: 'ok' });
    if (!url.pathname.startsWith('/api/v1/')) reject(404, 'NOT_FOUND', 'API resource not found.');
    allowed = methodsFor(path);
    if (allowed && !allowed.includes(request.method))
      reject(405, 'METHOD_NOT_ALLOWED', `Use ${allowed.join(' or ')} for this resource.`);
    if (path === '/sessions') {
      limitLogin(request.headers.get('cf-connecting-ip') ?? 'local');
      return json(await deps.sessions.login(await body(request)), 201, '/api/v1/sessions/current');
    }
    const authorization = request.headers.get('authorization') ?? undefined;
    if (path === '/sessions/current' && request.method === 'DELETE') {
      await deps.sessions.logout(authorization);
      return json(null, 204);
    }
    const user: AuthenticatedUser = await deps.sessions.authenticate(authorization);
    if (path === '/sessions/current') {
      return json({ user: { name: user.name, email: user.email } });
    }
    if (path === '/conversations') {
      if (request.method === 'GET') return json(await deps.workspace.listConversations(user.id));
      const created = await deps.workspace.createConversation(
        user.id,
        (await body(request)) as CreateConversationRequest,
      );
      return json(created, 201, `/api/v1/conversations/${created.id}`);
    }
    const conversationMatch = path.match(/^\/conversations\/([^/]+)$/);
    if (conversationMatch) {
      const id = decodeURIComponent(conversationMatch[1]);
      if (request.method === 'DELETE') {
        if (!(await deps.workspace.deleteConversation(user.id, id)))
          reject(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found.');
        return json(null, 204);
      }
      const conversation = await deps.workspace.getConversation(user.id, id);
      if (!conversation) reject(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found.');
      return json(conversation);
    }
    const actionMatch = path.match(/^\/conversations\/([^/]+)\/actions\/([^/]+)$/);
    if (actionMatch) {
      const value = await body(request);
      const decision =
        value && typeof value === 'object' && 'decision' in value ? value.decision : undefined;
      if (decision !== 'apply' && decision !== 'cancel')
        reject(422, 'INVALID_DECISION', 'Choose Apply or Cancel.');
      return json(
        await deps.workspace.confirmChatAction(
          user.id,
          decodeURIComponent(actionMatch[1]),
          decodeURIComponent(actionMatch[2]),
          decision,
        ),
      );
    }
    const messageMatch = path.match(/^\/conversations\/([^/]+)\/messages$/);
    if (messageMatch) {
      const id = decodeURIComponent(messageMatch[1]);
      const conversation = await deps.workspace.getConversation(user.id, id);
      if (!conversation) reject(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found.');
      const value = await body(request);
      const content =
        value && typeof value === 'object' && 'content' in value ? value.content : undefined;
      if (typeof content !== 'string' || !content.trim() || content.length > 4000)
        reject(422, 'INVALID_MESSAGE', 'Enter a question of up to 4,000 characters.');
      const context =
        value && typeof value === 'object' && 'context' in value ? value.context : undefined;
      const infer = () =>
        requestKassandra(
          deps.env.KASSANDRA_URL,
          authorization!,
          conversation!,
          content.trim(),
          context,
          request.signal,
        );
      const answer = await (deps.runInference ? deps.runInference(infer) : infer());
      if (answer.action?.kind === 'rate_batch_update' && answer.action.details.updates.length > 8)
        console.info(
          JSON.stringify({
            code: 'CHAT_REPLY_PREPARED',
            requestId,
            contentUtf16Bytes: Buffer.byteLength(answer.content, 'utf16le'),
            encodedPayloadUtf16Bytes: Buffer.byteLength(
              encodeMessagePayload(answer) ?? '',
              'utf16le',
            ),
            rowCount: answer.action.details.updates.length,
          }),
        );
      const createdAt = new Date().toISOString();
      return json(
        await deps.workspace.appendMessages(user.id, id, [
          { id: randomUUID(), role: 'user', content: content.trim(), createdAt },
          { id: randomUUID(), role: 'assistant', ...answer, createdAt },
        ]),
        201,
      );
    }
    if (path === '/room-state-changes') return json(await deps.workspace.listRoomChanges());
    if (path === '/rate-updates') {
      if (request.method === 'GET') return json(await deps.workspace.listRateUpdates());
      const created = await deps.workspace.createRateUpdate(
        (await body(request)) as RoomRateUpdateRequest,
        user.id,
      );
      return json(created, 201, `/api/v1/rate-updates/${created.id}`);
    }
    const rateMatch = path.match(/^\/rate-updates\/([^/]+)$/);
    if (rateMatch) {
      const value = await deps.workspace.getRateUpdate(decodeURIComponent(rateMatch[1]));
      if (!value) reject(404, 'RATE_UPDATE_NOT_FOUND', 'Rate update not found.');
      return json(value);
    }
    const stateMatch = path.match(/^\/rooms\/([^/]+)\/state$/);
    if (stateMatch && request.method !== 'GET') {
      const id = decodeURIComponent(stateMatch[1]);
      const value = request.method === 'DELETE' ? { action: 'reset' } : await body(request);
      if (
        !value ||
        typeof value !== 'object' ||
        !('action' in value) ||
        typeof value.action !== 'string'
      )
        reject(422, 'INVALID_ROOM_ACTION', 'Choose a valid room action.');
      return json(
        await deps.workspace.applyRoomAction(
          id,
          (value as { action: string }).action as RoomOperationAction,
          user.id,
        ),
      );
    }
    if (path === '/reference-data' && deps.loadReference) return json(await deps.loadReference());
    const requestedCollection = resources.get(path);
    if (requestedCollection && deps.readCollection)
      return json(await deps.readCollection(requestedCollection, url.searchParams));
    const historyMatch = path.match(/^\/room-types\/([^/]+)\/price-history$/);
    const data =
        path === '/warnings' && deps.loadWarningsData
          ? await deps.loadWarningsData(url.searchParams)
          : path === '/events/upcoming' && deps.loadUpcomingEventsData
            ? await deps.loadUpcomingEventsData(url.searchParams)
            : historyMatch && deps.loadPriceHistoryData
              ? await deps.loadPriceHistoryData(
                  decodeURIComponent(historyMatch[1]),
                  url.searchParams,
                )
              : await deps.loadNetwork(),
      selectors = createNetworkSelectors(data),
      params = url.searchParams;
    if (path === '/reference-data')
      return json({
        meta: data.meta,
        bookingSnapshot: data.bookingSnapshot,
        hotels: data.hotels,
        reportingPeriods: data.reportingPeriods,
        dates: reportingDatesFor(data.meta.reportingPeriod),
      });
    if (path === '/schema') return json(buildNetworkSchema(data));
    if (path === '/exports/network') return json(data);
    const managedRooms = async () => {
      const date = selectedDate(data, params),
        scope = selectedScope(data, params),
        changes = await deps.workspace.listRoomChanges(date);
      return selectors.hotelInventory(scope, date).map((room) =>
        applyRoomChange(
          room,
          changes.find((change) => change.roomId === room.id && change.date === date),
        ),
      );
    };
    if (stateMatch) {
      const id = decodeURIComponent(stateMatch[1]),
        room = (await managedRooms()).find((row) => row.id === id);
      if (!room) reject(404, 'ROOM_NOT_FOUND', 'Room not found.');
      return json(room);
    }
    if (path === '/warnings') {
      const warnings: RoomWarning[] = (await managedRooms())
        .filter((room) => room.status === 'out_of_service')
        .map((room) => ({ room, hotel: data.hotels.find((hotel) => hotel.id === room.hotelId)! }));
      return json(page(warnings, params));
    }
    if (path === '/events/upcoming')
      return json(
        page(
          selectors.upcomingEvents(selectedScope(data, params), selectedDate(data, params)),
          params,
        ),
      );
    if (historyMatch) {
      const id = decodeURIComponent(historyMatch[1]),
        type = data.roomTypes.find((type) => type.id === id);
      if (!type) reject(404, 'ROOM_TYPE_NOT_FOUND', 'Room type not found.');
      const range = selectedRange(data, params);
      return json(
        createBookingRateHistory(data)(type!.hotelId, id).filter(
          (row) => !range || (row.date >= range.startDate && row.date <= range.endDate),
        ),
      );
    }
    if (path === '/analytics/dashboard') {
      const scope = selectedScope(data, params),
        range =
          selectedRange(data, params) ??
          data.reportingPeriods.find(
            (period) =>
              period.startDate <= data.bookingSnapshot.asOf &&
              period.endDate >= data.bookingSnapshot.asOf,
          )!;
      return json({
        outlook: selectors.bookingOutlook(scope, range),
        days: selectors.bookingPace(scope, range),
        chartContext: selectors.bookingChartContext(scope, range),
        bookingSources: selectors.bookingSources(scope, range),
        hotels: data.hotels.map((hotel) => ({
          hotel,
          outlook: selectors.bookingOutlook(hotel.id, range),
        })),
      });
    }
    const key = resources.get(path);
    if (key)
      return json(
        page(
          resourceRows(
            data,
            key,
            params,
            key === 'roomRates' && params.get('basis') !== 'canonical'
              ? await deps.workspace.listRateUpdates()
              : [],
          ),
          params,
        ),
      );
    for (const [prefix, collection] of resources)
      if (path.startsWith(`${prefix}/`) && !path.slice(prefix.length + 1).includes('/')) {
        const id = decodeURIComponent(path.slice(prefix.length + 1)),
          found = (data[collection] as unknown as { id?: string }[]).find((row) => row.id === id);
        if (!found) reject(404, 'NOT_FOUND', 'Resource not found.');
        return json(found);
      }
    reject(404, 'NOT_FOUND', 'API resource not found.');
  } catch (error) {
    const known =
      error &&
      typeof error === 'object' &&
      'status' in error &&
      'code' in error &&
      error instanceof Error;
    const failure = known
      ? (error as ApiProblemError)
      : error instanceof RangeError || error instanceof URIError
        ? new ApiProblemError(400, 'INVALID_REQUEST', error.message)
        : new ApiProblemError(
            503,
            'SERVICE_UNAVAILABLE',
            'The database service is temporarily unavailable. Please retry.',
          );
    if (!known && !(error instanceof RangeError) && !(error instanceof URIError))
      console.error(
        JSON.stringify({
          requestId,
          code: 'DATABASE_REQUEST_FAILED',
          cause: error && typeof error === 'object' && 'code' in error ? error.code : undefined,
          message:
            error instanceof Error
              ? error.message.replaceAll(deps.env.SQL_PASSWORD, '[redacted]').slice(0, 240)
              : undefined,
        }),
      );
    const h = new Headers(headers);
    h.set('Content-Type', 'application/problem+json');
    if (failure.status === 405) h.set('Allow', allowed?.join(', ') ?? 'GET');
    if (failure.status === 429) h.set('Retry-After', '900');
    return new Response(
      JSON.stringify({
        type: 'about:blank',
        title: failure.status < 500 ? 'Request rejected' : 'Request failed',
        status: failure.status,
        code: failure.code,
        detail: failure.message,
      }),
      { status: failure.status, headers: h },
    );
  }
}
