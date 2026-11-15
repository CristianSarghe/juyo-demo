import { handleMcp } from './mcp/server';
import { generateAnswer, type ChatContext } from './chat/openai';
import type { Conversation } from './domain/models';
import type { ReferenceDataDto } from './domain/api.models';
import { ApiProblemError, reject } from './problem';
import { searchRobotsResponse, withSearchExclusion } from './search-indexing';

export interface KassandraEnvironment {
  JUYO_API_URL: string;
  MCP_PUBLIC_URL: string;
  OPENAI_API_KEY: string;
  ALLOWED_ORIGINS?: string;
}
const budgets = new Map<string, { count: number; expires: number }>();
function limitChat(email: string): void {
  const now = Date.now();
  for (const [key, entry] of budgets) if (entry.expires <= now) budgets.delete(key);
  const entry = budgets.get(email);
  if (entry && entry.count >= 30) reject(429, 'CHAT_RATE_LIMITED', 'Try again in a few minutes.');
  if (!entry && budgets.size >= 500) reject(429, 'CHAT_RATE_LIMITED', 'Try again shortly.');
  budgets.set(email, {
    count: (entry?.count ?? 0) + 1,
    expires: entry?.expires ?? now + 15 * 60_000,
  });
}
function validDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value + 'T00:00:00Z')) &&
    new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value
  );
}
function contextFor(
  raw: unknown,
  conversation: Conversation,
  reference: ReferenceDataDto,
): ChatContext {
  const period =
    reference.reportingPeriods.find((row) => row.key === conversation.month) ??
    reference.reportingPeriods.find(
      (row) =>
        row.startDate <= reference.bookingSnapshot.asOf &&
        row.endDate >= reference.bookingSnapshot.asOf,
    )!;
  const fallback = {
    propertyId: conversation.propertyId ?? 'portfolio',
    startDate: period.startDate,
    endDate: period.endDate,
  };
  if (raw === undefined) return fallback;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    reject(422, 'INVALID_CHAT_CONTEXT', 'Choose a hotel and valid interval.');
  const value = raw as ChatContext;
  if (
    (value.propertyId !== 'portfolio' &&
      !reference.hotels.some((hotel) => hotel.id === value.propertyId)) ||
    !validDate(value.startDate) ||
    !validDate(value.endDate) ||
    value.startDate > value.endDate ||
    value.startDate < reference.meta.reportingPeriod.startDate ||
    value.endDate > reference.meta.reportingPeriod.endDate
  )
    reject(422, 'INVALID_CHAT_CONTEXT', 'Choose a hotel and interval in the available calendar.');
  return { propertyId: value.propertyId, startDate: value.startDate, endDate: value.endDate };
}
async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('content-type') ?? ''))
    reject(415, 'JSON_REQUIRED', 'Send application/json.');
  const reader = request.body?.getReader();
  if (!reader) reject(422, 'BODY_REQUIRED', 'A request body is required.');
  let value = '';
  const decoder = new TextDecoder();
  try {
    let length = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 16384) {
        await reader.cancel();
        reject(413, 'BODY_TOO_LARGE', 'Request body too large.');
      }
      value += decoder.decode(part.value, { stream: true });
    }
    value += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    reject(400, 'INVALID_JSON', 'Send a valid JSON body.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    reject(422, 'INVALID_BODY', 'Send a JSON object.');
  return parsed as Record<string, unknown>;
}

/** A small independent Worker: no SQL driver, storage binding or paid Cloudflare feature. */
export async function handleKassandra(
  request: Request,
  env: KassandraEnvironment,
): Promise<Response> {
  // Apply at the public boundary so successful MCP streams and every early
  // auth, CORS, validation or error response carry the same search policy.
  return searchRobotsResponse(request) ?? withSearchExclusion(await routeKassandra(request, env));
}

async function routeKassandra(request: Request, env: KassandraEnvironment): Promise<Response> {
  const url = new URL(request.url),
    origin = request.headers.get('origin');
  const origins = new Set(
    (
      env.ALLOWED_ORIGINS ??
      'http://127.0.0.1:4200,http://localhost:4200,http://127.0.0.1:4201,http://localhost:4201'
    )
      .split(',')
      .map((value) => value.trim()),
  );
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin',
  });
  if (origin && origins.has(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, MCP-Protocol-Version',
    );
  }
  const json = (data: unknown, status = 200) => Response.json(data, { status, headers });
  try {
    if (origin && !origins.has(origin)) reject(403, 'ORIGIN_NOT_ALLOWED', 'Origin not allowed.');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (url.pathname === '/health' && request.method === 'GET')
      return json({ status: 'ok', service: 'juyo-kassandra', model: 'gpt-6.1-terra' });
    if (!['/mcp', '/chat'].includes(url.pathname)) reject(404, 'NOT_FOUND', 'Resource not found.');
    if (url.pathname === '/chat' && request.method !== 'POST')
      return new Response(null, {
        status: 405,
        headers: { ...Object.fromEntries(headers), Allow: 'POST' },
      });
    const authorization = request.headers.get('authorization');
    if (!authorization || !/^Bearer [A-Za-z0-9_-]{32,256}$/.test(authorization))
      reject(401, 'SIGN_IN_REQUIRED', 'Sign in to use Kassandra.');
    // Repair searches can require several bounded model/tool passes. MCP reads
    // retain their shorter deadline; caller cancellation always wins for both.
    const timeout = AbortSignal.timeout(url.pathname === '/chat' ? 160_000 : 75_000);
    const signal = AbortSignal.any([request.signal, timeout]);
    const read = async (path: string, params?: URLSearchParams): Promise<any> => {
      // Tool catalog owns every path. Never accept a model-provided URL/host.
      if (!path.startsWith('/') || path.startsWith('//') || /[?#\\]/.test(path))
        reject(400, 'INVALID_RESOURCE', 'Invalid resource.');
      const target = new URL(env.JUYO_API_URL.replace(/\/$/, '') + path);
      if (params) target.search = params.toString();
      // Only idempotent reads retry. Cold SQL/TLS Workers occasionally return an edge 503.
      // Never retry inference, confirmation, sign-in, or any mutation.
      for (let attempt = 0; attempt < 3; attempt++) {
        let response: Response | undefined;
        try {
          response = await fetch(target, {
            headers: { Authorization: authorization },
            signal,
            redirect: 'manual',
          });
        } catch {
          if (signal.aborted || attempt === 2)
            reject(
              503,
              'HOTEL_DATA_UNAVAILABLE',
              'Hotel data could not be retrieved. Please retry.',
            );
        }
        if (response?.ok) return response.json();
        if (response?.status === 401) reject(401, 'SESSION_EXPIRED', 'Sign in again.');
        if (response && (![502, 503, 504].includes(response.status) || attempt === 2))
          reject(
            response.status >= 300 && response.status < 400
              ? 502
              : response.status >= 500
                ? 503
                : response.status,
            'HOTEL_DATA_UNAVAILABLE',
            'Hotel data could not be retrieved. Please retry.',
          );
        await response?.body?.cancel();
        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
        signal.throwIfAborted();
      }
      reject(503, 'HOTEL_DATA_UNAVAILABLE', 'Hotel data could not be retrieved. Please retry.');
    };
    // Every MCP request is authenticated, including initialization and tool listing.
    const session = await read('/sessions/current');
    if (url.pathname === '/mcp') {
      const response = await handleMcp(request, { read, allowedOrigins: origins });
      const merged = new Headers(response.headers);
      for (const [name, value] of headers) merged.set(name, value);
      return new Response(response.body, { status: response.status, headers: merged });
    }
    if (!env.OPENAI_API_KEY) reject(503, 'CHAT_NOT_CONFIGURED', 'Kassandra is not configured yet.');
    const value = await readJson(request);
    if (typeof value.conversationId !== 'string' || !/^[a-f0-9-]{36}$/i.test(value.conversationId))
      reject(422, 'INVALID_CONVERSATION', 'Choose a conversation.');
    if (typeof value.content !== 'string' || !value.content.trim() || value.content.length > 4000)
      reject(422, 'INVALID_MESSAGE', 'Enter a question of up to 4,000 characters.');
    limitChat(session.user.email);
    const [conversation, reference] = await Promise.all([
      read(`/conversations/${value.conversationId}`) as Promise<Conversation>,
      read('/reference-data') as Promise<ReferenceDataDto>,
    ]);
    const answer = await generateAnswer({
      key: env.OPENAI_API_KEY,
      token: authorization.slice(7),
      mcpUrl: env.MCP_PUBLIC_URL,
      conversation,
      reference,
      content: value.content.trim(),
      context: contextFor(value.context, conversation, reference),
      signal,
    });
    return json(answer);
  } catch (error) {
    // Never log upstream bodies, prompts, bearer tokens or model keys.
    const known = error instanceof ApiProblemError;
    return json(
      {
        code: known ? error.code : 'CHAT_UNAVAILABLE',
        detail: known ? error.message : 'Kassandra could not finish. Please try again.',
      },
      known ? error.status : 503,
    );
  }
}
export default { fetch: handleKassandra };
