import { HttpErrorResponse, HttpHeaders, HttpRequest, HttpResponse } from '@angular/common/http';
import { NETWORK_DATA, REPORTING_DATES } from '../../network.data';
import { createNetworkSelectors } from '../../network.selectors';
import { createBookingRateHistory } from '../../room-price-history';
import { buildNetworkSchema } from '../../network.schema';
import type { DateRange, HotelId, PropertyScope, RoomWarning } from '../../network.models';
import type { ApiProblem, CollectionKey, Page } from '../api.models';
import type { RoomOperationAction } from '../mutation.models';
import { RESOURCE_PATHS } from '../resource-paths';
import { MockRoomOperationsRepository } from './mock-room-operations.repository';
import { MockRoomRatesRepository } from './mock-room-rates.repository';
import { MockChatRepository } from './mock-chat.repository';
import { getCurrentSession } from './mock-session.repository';
import { handleMockSession } from './mock-session.api';
import { MockRepositoryError } from './mock-repository-error';

const selectors = createNetworkSelectors(NETWORK_DATA);
const history = createBookingRateHistory(NETWORK_DATA);
const schema = buildNetworkSchema(NETWORK_DATA);
const resources = new Map<string, CollectionKey>(
  Object.entries(RESOURCE_PATHS).map(([key, path]) => [path, key as CollectionKey]),
);
let operations: MockRoomOperationsRepository | undefined;
let rates: MockRoomRatesRepository | undefined;
let chat: MockChatRepository | undefined;
const ops = () => (operations ??= new MockRoomOperationsRepository());
const sellingRates = () => (rates ??= new MockRoomRatesRepository(ops()));
const conversations = () => (chat ??= new MockChatRepository(sellingRates()));

function fail(status: number, code: string, message: string): never {
  throw new MockRepositoryError(status, code, message);
}
function scope(params: URLSearchParams): PropertyScope {
  const id = params.get('hotelId');
  if (!id) return 'portfolio';
  if (!NETWORK_DATA.hotels.some((hotel) => hotel.id === id))
    fail(400, 'INVALID_HOTEL', 'Choose a valid hotel.');
  return id as HotelId;
}
function range(params: URLSearchParams): DateRange | undefined {
  if (!params.has('from') && !params.has('to')) return undefined;
  if (!params.get('from') || !params.get('to'))
    fail(400, 'INVALID_RANGE', 'Provide both from and to dates.');
  return selectors.validateDateRange({
    startDate: params.get('from')!,
    endDate: params.get('to')!,
  });
}
function date(params: URLSearchParams, key = 'date'): string {
  const value = params.get(key) ?? NETWORK_DATA.bookingSnapshot.asOf;
  selectors.validateDateRange({ startDate: value, endDate: value });
  return value;
}
function integer(params: URLSearchParams, key: string, fallback: number, maximum: number): number {
  const raw = params.get(key);
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) fail(400, 'INVALID_PAGINATION', `${key} must be a positive integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    fail(400, 'INVALID_PAGINATION', `${key} is outside its allowed range.`);
  return value;
}
function page<T>(items: T[], params: URLSearchParams): Page<T> {
  const number = integer(params, 'page', 1, 100_000);
  const size = integer(params, 'pageSize', 50, 1000);
  return {
    items: items.slice((number - 1) * size, number * size),
    page: number,
    pageSize: size,
    total: items.length,
  };
}
function list(key: CollectionKey, params: URLSearchParams): unknown[] {
  const allowed = new Set([
    'hotelId',
    'roomTypeId',
    'roomId',
    'eventId',
    'status',
    'from',
    'to',
    'stayDate',
    'page',
    'pageSize',
    'basis',
  ]);
  for (const field of params.keys())
    if (!allowed.has(field)) fail(400, 'INVALID_FILTER', `Unsupported filter: ${field}.`);
  const hotelScope = scope(params);
  const selection = range(params);
  if (params.has('stayDate')) date(params, 'stayDate');
  const basis = params.get('basis');
  if (basis && !(key === 'roomRates' && basis === 'canonical'))
    fail(400, 'INVALID_FILTER', 'Unsupported reporting basis.');
  let rows = [...NETWORK_DATA[key]] as unknown as Record<string, unknown>[];
  if (key === 'roomRates' && basis !== 'canonical') {
    const dates = selection ?? NETWORK_DATA.meta.reportingPeriod;
    rows = NETWORK_DATA.roomTypes.flatMap((type) =>
      sellingRates()
        .rows(type.hotelId, type.id, dates)
        .map((row) => ({
          hotelId: type.hotelId,
          roomTypeId: type.id,
          date: row.date,
          nightlyRate: row.nightlyRate,
          currency: 'EUR',
        })),
    );
  }
  const roomTypeId = params.get('roomTypeId');
  const roomTypeRoomIds =
    (key === 'dailyRoomStates' || key === 'reservationNights') && roomTypeId
      ? new Set(
          NETWORK_DATA.rooms
            .filter((room) => room.roomTypeId === roomTypeId)
            .map((room) => room.id),
        )
      : null;
  return rows.filter((row) => {
    if (hotelScope !== 'portfolio') {
      if (
        key === 'hotels'
          ? row.id !== hotelScope
          : key === 'events'
            ? !NETWORK_DATA.eventHotelImpacts.some(
                (impact) => impact.hotelId === hotelScope && impact.eventId === row.id,
              )
            : row.hotelId !== hotelScope
      )
        return false;
    }
    for (const field of ['roomTypeId', 'roomId', 'eventId', 'status']) {
      const wanted = params.get(field);
      if (
        field === 'roomTypeId' &&
        (key === 'dailyRoomStates' || key === 'reservationNights')
      ) {
        if (wanted && !roomTypeRoomIds?.has(String(row.roomId))) return false;
      } else if (wanted && row[field] !== wanted) return false;
    }
    const stayDate = params.get('stayDate');
    if (
      stayDate &&
      key === 'reservations' &&
      !(String(row.arrival) <= stayDate && String(row.departure) > stayDate)
    )
      return false;
    if (selection) {
      const point = row.date ?? row.stayDate;
      if (typeof point === 'string' && (point < selection.startDate || point > selection.endDate))
        return false;
      if (
        typeof row.period === 'string' &&
        (row.period < selection.startDate.slice(0, 7) || row.period > selection.endDate.slice(0, 7))
      )
        return false;
      if (
        typeof row.arrival === 'string' &&
        !(row.arrival <= selection.endDate && String(row.departure) > selection.startDate)
      )
        return false;
      if (
        key === 'events' &&
        !(String(row.startDate) <= selection.endDate && String(row.endDate) >= selection.startDate)
      )
        return false;
    }
    return true;
  });
}
function response<T>(body: T, status = 200, location?: string): HttpResponse<T> {
  return new HttpResponse({
    status,
    body: structuredClone(body),
    headers: new HttpHeaders({
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...(location ? { Location: location } : {}),
    }),
  });
}
function allowedMethods(path: string): string[] | null {
  if (/^\/rooms\/[^/]+\/state$/.test(path)) return ['GET', 'PATCH', 'DELETE'];
  if (path === '/rate-updates' || path === '/conversations') return ['GET', 'POST'];
  if (/^\/rate-updates\/[^/]+$/.test(path)) return ['GET'];
  if (/^\/conversations\/[^/]+\/messages$/.test(path)) return ['POST'];
  if (/^\/conversations\/[^/]+\/actions\/[^/]+$/.test(path)) return ['POST'];
  if (/^\/conversations\/[^/]+$/.test(path)) return ['GET', 'DELETE'];
  if (
    resources.has(path) ||
    [
      '/reference-data',
      '/schema',
      '/exports/network',
      '/room-state-changes',
      '/warnings',
      '/events/upcoming',
      '/analytics/dashboard',
    ].includes(path) ||
    /^\/room-types\/[^/]+\/price-history$/.test(path)
  )
    return ['GET'];
  return null;
}

/** This is a browser-only mock HTTP adapter, not a listening or hosted server. */
export function handleMockRequest(
  request: HttpRequest<unknown>,
  baseUrl = '/api/v1',
): HttpResponse<unknown> {
  let allowed: string[] | null = null;
  try {
    const url = new URL(request.urlWithParams, 'http://localhost');
    const basePath = new URL(baseUrl, 'http://localhost').pathname.replace(/\/$/, '');
    const path = url.pathname.slice(basePath.length).replace(/\/$/, '') || '/';
    const method = request.method;
    if (path === '/sessions' || path === '/sessions/current')
      return handleMockSession(request, baseUrl);
    allowed = allowedMethods(path);
    if (allowed && !allowed.includes(method))
      fail(405, 'METHOD_NOT_ALLOWED', `Use ${allowed.join(' or ')} for this resource.`);
    const params = url.searchParams;
    const body = request.body;
    if (!getCurrentSession()) fail(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    if (path === '/reference-data' && method === 'GET')
      return response({
        meta: NETWORK_DATA.meta,
        bookingSnapshot: NETWORK_DATA.bookingSnapshot,
        hotels: NETWORK_DATA.hotels,
        reportingPeriods: NETWORK_DATA.reportingPeriods,
        dates: REPORTING_DATES,
      });
    if (path === '/schema' && method === 'GET') return response(schema);
    if (path === '/exports/network' && method === 'GET') return response(NETWORK_DATA);
    if (path === '/room-state-changes' && method === 'GET') return response(ops().changes());
    const stateMatch = path.match(/^\/rooms\/([^/]+)\/state$/);
    if (stateMatch) {
      const id = decodeURIComponent(stateMatch[1]);
      const room = NETWORK_DATA.rooms.find((row) => row.id === id);
      if (!room) fail(404, 'ROOM_NOT_FOUND', 'Room not found.');
      if (method === 'GET')
        return response(
          ops()
            .rooms(room.hotelId, date(params))
            .find((row) => row.id === id),
        );
      if (method !== 'PATCH' && method !== 'DELETE')
        fail(405, 'METHOD_NOT_ALLOWED', 'Use GET, PATCH or DELETE for room state.');
      const action =
        method === 'DELETE'
          ? 'reset'
          : body && typeof body === 'object' && 'action' in body
            ? body.action
            : undefined;
      if (
        !['clean', 'dirty', 'reserve', 'out_of_service', 'available', 'reset'].includes(
          String(action),
        )
      )
        fail(422, 'INVALID_ROOM_ACTION', 'Choose a valid room action.');
      if (!ops().update(id, action as RoomOperationAction))
        fail(
          ops().errorStatus(),
          ops().errorStatus() === 503 ? 'PERSISTENCE_UNAVAILABLE' : 'ROOM_STATE_CONFLICT',
          ops().error(),
        );
      return response(ops().changes());
    }
    if (path === '/rate-updates') {
      if (method === 'GET') return response(sellingRates().changes());
      if (method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED', 'Use GET or POST for rate updates.');
      if (!sellingRates().update(body as never))
        fail(
          sellingRates().errorStatus(),
          sellingRates().errorStatus() === 503 ? 'PERSISTENCE_UNAVAILABLE' : 'INVALID_RATE_UPDATE',
          sellingRates().error(),
        );
      const created = sellingRates().changes().at(-1)!;
      return response(created, 201, `${baseUrl}/rate-updates/${encodeURIComponent(created.id)}`);
    }
    const rateUpdateMatch = path.match(/^\/rate-updates\/([^/]+)$/);
    if (rateUpdateMatch && method === 'GET') {
      const found = sellingRates()
        .changes()
        .find((change) => change.id === decodeURIComponent(rateUpdateMatch[1]));
      if (!found) fail(404, 'RATE_UPDATE_NOT_FOUND', 'Rate update not found.');
      return response(found);
    }
    if (path === '/warnings' && method === 'GET') {
      const selected = scope(params);
      const rows: RoomWarning[] = ops()
        .rooms(selected, date(params))
        .filter((row) => row.status === 'out_of_service')
        .map((room) => ({
          room,
          hotel: NETWORK_DATA.hotels.find((hotel) => hotel.id === room.hotelId)!,
        }));
      return response(page(rows, params));
    }
    if (path === '/events/upcoming' && method === 'GET')
      return response(page(selectors.upcomingEvents(scope(params), date(params)), params));
    const priceHistoryMatch = path.match(/^\/room-types\/([^/]+)\/price-history$/);
    if (priceHistoryMatch && method === 'GET') {
      const type = NETWORK_DATA.roomTypes.find(
        (row) => row.id === decodeURIComponent(priceHistoryMatch[1]),
      );
      if (!type) fail(404, 'ROOM_TYPE_NOT_FOUND', 'Room type not found.');
      const selection = range(params);
      return response(
        history(type.hotelId, type.id).filter(
          (row) => !selection || (row.date >= selection.startDate && row.date <= selection.endDate),
        ),
      );
    }
    if (path === '/analytics/dashboard' && method === 'GET') {
      const selected = scope(params);
      const selection =
        range(params) ??
        NETWORK_DATA.reportingPeriods.find(
          (period) =>
            period.startDate <= NETWORK_DATA.bookingSnapshot.asOf &&
            period.endDate >= NETWORK_DATA.bookingSnapshot.asOf,
        )!;
      return response({
        outlook: selectors.bookingOutlook(selected, selection),
        days: selectors.bookingPace(selected, selection),
        chartContext: selectors.bookingChartContext(selected, selection),
        bookingSources: selectors.bookingSources(selected, selection),
        hotels: NETWORK_DATA.hotels.map((hotel) => ({
          hotel,
          outlook: selectors.bookingOutlook(hotel.id, selection),
        })),
      });
    }
    if (path === '/conversations') {
      if (method === 'GET') return response(conversations().list());
      if (method === 'POST') {
        const created = conversations().create(body as never);
        return response(created, 201, `${baseUrl}/conversations/${encodeURIComponent(created.id)}`);
      }
      fail(405, 'METHOD_NOT_ALLOWED', 'Use GET or POST for conversations.');
    }
    const actionMatch = path.match(/^\/conversations\/([^/]+)\/actions\/([^/]+)$/);
    if (actionMatch && method === 'POST') {
      const decision =
        body && typeof body === 'object' && 'decision' in body ? body.decision : undefined;
      return response(
        conversations().confirmAction(
          decodeURIComponent(actionMatch[1]),
          decodeURIComponent(actionMatch[2]),
          decision,
        ),
      );
    }
    const messageMatch = path.match(/^\/conversations\/([^/]+)\/messages$/);
    if (messageMatch && method === 'POST')
      return response(
        conversations().appendMessage(decodeURIComponent(messageMatch[1]), body as never),
        201,
      );
    const conversationMatch = path.match(/^\/conversations\/([^/]+)$/);
    if (conversationMatch) {
      const id = decodeURIComponent(conversationMatch[1]);
      if (!conversations().get(id)) fail(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found.');
      if (method === 'GET') return response(conversations().get(id));
      if (method === 'DELETE') {
        conversations().remove(id);
        return response(null, 204);
      }
      fail(405, 'METHOD_NOT_ALLOWED', 'Use GET or DELETE for this conversation.');
    }
    const key = resources.get(path);
    if (key) {
      if (method !== 'GET') fail(405, 'METHOD_NOT_ALLOWED', 'This resource is read-only.');
      return response(page(list(key, params), params));
    }
    for (const [resourcePath, collection] of resources) {
      if (
        path.startsWith(`${resourcePath}/`) &&
        path.slice(resourcePath.length + 1).indexOf('/') === -1
      ) {
        if (method !== 'GET') fail(405, 'METHOD_NOT_ALLOWED', 'This resource is read-only.');
        const id = decodeURIComponent(path.slice(resourcePath.length + 1));
        const found = (NETWORK_DATA[collection] as unknown as { id?: string }[]).find(
          (row) => row.id === id,
        );
        if (!found) fail(404, 'NOT_FOUND', 'Resource not found.');
        return response(found);
      }
    }
    fail(404, 'NOT_FOUND', 'API resource not found.');
  } catch (error) {
    if (error instanceof HttpErrorResponse) throw error;
    const failure =
      error instanceof MockRepositoryError
        ? error
        : error instanceof RangeError || error instanceof URIError
          ? new MockRepositoryError(400, 'INVALID_REQUEST', error.message)
          : new MockRepositoryError(500, 'INTERNAL_ERROR', 'Could not complete the local request.');
    const problem: ApiProblem = {
      type: 'about:blank',
      title: failure.status < 500 ? 'Request rejected' : 'Request failed',
      status: failure.status,
      detail: failure.message,
      code: failure.code,
    };
    throw new HttpErrorResponse({
      status: failure.status,
      statusText: problem.title,
      url: request.url,
      error: problem,
      headers: new HttpHeaders({
        'Content-Type': 'application/problem+json',
        ...(failure.status === 405 ? { Allow: allowed?.join(', ') ?? 'GET' } : {}),
      }),
    });
  }
}
