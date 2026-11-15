/** Actual workerd + SQL smoke check. Database secrets use process env, never generated files/bundles. */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { RESOURCE_PATHS } from '../src/domain/resource-paths';
import { DEMO_ACCOUNTS } from '../src/demo-accounts';

const origin = process.env.SMOKE_ORIGIN ?? 'http://127.0.0.1:4200';
assert.equal(new URL(origin).origin, origin, 'SMOKE_ORIGIN must be a browser origin.');
assert.ok(/^https?:$/.test(new URL(origin).protocol), 'SMOKE_ORIGIN must use HTTP or HTTPS.');
const liveBase = process.env.SMOKE_API_URL;
const base = (liveBase ?? 'https://api-juyo.cristiansarghe.com/api/v1').replace(/\/$/, '');
if (liveBase) assert.equal(new URL(liveBase).protocol, 'https:', 'Use HTTPS for the deployed API.');
const required = ['SQL_SERVER', 'SQL_DATABASE', 'SQL_USER', 'SQL_PASSWORD'] as const;
for (const key of liveBase ? [] : required)
  assert.ok(process.env[key], `Set ${key} before running the Worker smoke check.`);
const credentials = {
  email: process.env.API_DEMO_EMAIL ?? DEMO_ACCOUNTS[0].email,
  password: process.env.API_DEMO_PASSWORD ?? DEMO_ACCOUNTS[0].password,
};
const bindings = Object.fromEntries(required.map((key) => [key, process.env[key]!])) as Record<
  string,
  string
>;
bindings.SQL_PORT = process.env.SQL_PORT ?? '1433';
bindings.ALLOWED_ORIGINS = origin;
const runtime = liveBase
  ? undefined
  : new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        scriptPath: fileURLToPath(new URL('../dist/worker/worker.js', import.meta.url)),
        compatibilityDate: '2026-11-14',
        compatibilityFlags: ['nodejs_compat'],
        bindings,
        durableObjects: { SQL_GATEWAY: { className: 'JuyoSqlGateway', useSQLite: true } },
        log: new Log(LogLevel.ERROR),
      }),
    );
const checks: { name: string; status: number; elapsedMs: number }[] = [];
let token = '';
let conversationId = '';
const dispatch = (url: string, options: RequestInit) =>
  runtime ? runtime.dispatchFetch(url, options) : fetch(url, options);
async function request(
  path: string,
  status = 200,
  options: { method?: string; body?: unknown; auth?: string; origin?: string } = {},
) {
  const started = performance.now();
  const headers = new Headers({ Origin: options.origin ?? origin });
  const bearer = options.auth ?? token;
  if (bearer) headers.set('Authorization', `Bearer ${bearer}`);
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await dispatch(`${base}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  assert.equal(response.status, status, `${options.method ?? 'GET'} ${path} status`);
  if ((options.origin ?? origin) === origin)
    assert.equal(
      response.headers.get('Access-Control-Allow-Origin'),
      origin,
      `${path} localhost CORS`,
    );
  assert.equal(response.headers.get('Cache-Control'), 'no-store', `${path} cache policy`);
  checks.push({
    name: `${options.method ?? 'GET'} ${path}`,
    status,
    elapsedMs: Math.round(performance.now() - started),
  });
  return response;
}
try {
  await request('/sessions/current', 401);
  await request('/hotels', 401, { auth: '0'.repeat(64) });
  const preflight = await request('/hotels', 204, { method: 'OPTIONS' });
  assert.ok(
    preflight.headers.get('Access-Control-Allow-Headers')?.includes('Authorization'),
    'Bearer auth is allowed by CORS.',
  );
  await request('/hotels', 403, { origin: 'https://untrusted.invalid' });
  if (!process.env.SMOKE_SKIP_CREDENTIAL_FAILURES) {
    await request('/sessions', 401, {
      method: 'POST',
      body: { email: credentials.email, password: 'InvalidPasswordForSmokeCheck' },
    });
    await request('/sessions', 401, {
      method: 'POST',
      body: {
        email: 'worker-smoke-missing@example.invalid',
        password: 'InvalidPasswordForSmokeCheck',
      },
    });
  }
  const signedIn = (await (
    await request('/sessions', 201, { method: 'POST', body: credentials })
  ).json()) as { token?: string; user?: { email?: string } };
  assert.ok(
    signedIn.token && /^[a-f0-9]{64}$/.test(signedIn.token),
    'Sign-in returns an opaque session token.',
  );
  token = signedIn.token!;
  assert.ok(signedIn.user?.email, 'Sign-in returns a user projection.');
  await request('/sessions/current');
  const reference = (await (await request('/reference-data')).json()) as any;
  assert.equal(reference.hotels.length, 4, 'Four SQL-backed hotels.');
  assert.equal(reference.dates.length, 92, 'The SQL reporting calendar covers the quarter.');
  for (const path of Object.values(RESOURCE_PATHS)) {
    const result = (await (await request(`${path}?page=1&pageSize=5`)).json()) as any;
    assert.ok(Array.isArray(result.items) && result.items.length <= 5, `${path} bounded items`);
    assert.equal(result.page, 1, `${path} one-based page`);
    assert.equal(result.pageSize, 5, `${path} page size`);
    assert.ok(
      Number.isSafeInteger(result.total) && result.total >= result.items.length,
      `${path} total`,
    );
  }
  const hotel = reference.hotels[0];
  const hotelRooms = (await (
    await request(`/rooms?hotelId=${encodeURIComponent(hotel.id)}&page=1&pageSize=5`)
  ).json()) as any;
  assert.ok(
    hotelRooms.items.every((room: any) => room.hotelId === hotel.id),
    'Hotel filter applies.',
  );
  const types = (await (
    await request(`/room-types?hotelId=${encodeURIComponent(hotel.id)}&page=1&pageSize=5`)
  ).json()) as any;
  const from = reference.bookingSnapshot.asOf,
    through = from;
  const dashboard = (await (
    await request(
      `/analytics/dashboard?hotelId=${encodeURIComponent(hotel.id)}&from=${from}&to=${through}`,
    )
  ).json()) as any;
  assert.equal(dashboard.days.length, 1, 'A one-day dashboard uses one selected day.');
  await request('/schema');
  const history = await (
    await request(
      `/room-types/${encodeURIComponent(types.items[0].id)}/price-history?from=${from}&to=${through}`,
    )
  ).json();
  assert.ok(Array.isArray(history), 'Price history is a collection.');
  await request(`/rooms/${encodeURIComponent(hotelRooms.items[0].id)}/state?date=${from}`);
  await request('/room-state-changes');
  await request('/rate-updates');
  await request(`/warnings?hotelId=${encodeURIComponent(hotel.id)}&date=${from}`);
  await request(`/events/upcoming?hotelId=${encodeURIComponent(hotel.id)}&date=${from}`);
  await request('/conversations');
  const created = (await (
    await request('/conversations', 201, {
      method: 'POST',
      body: {
        title: 'Worker SQL smoke check',
        propertyId: hotel.id,
        month: from.slice(0, 7),
        roomDate: from,
      },
    })
  ).json()) as any;
  assert.ok(typeof created.id === 'string', 'The QA conversation is persisted.');
  conversationId = created.id;
  await request(`/conversations/${encodeURIComponent(conversationId)}`);
  await request(`/conversations/${encodeURIComponent(conversationId)}`, 204, { method: 'DELETE' });
  await request(`/conversations/${encodeURIComponent(conversationId)}`, 404);
  conversationId = '';
  await request('/sessions/current', 204, { method: 'DELETE' });
  await request('/sessions/current', 401);
  await request('/sessions/current', 204, { method: 'DELETE' });
  token = '';
  console.log(
    JSON.stringify(
      {
        verified: true,
        runtime: liveBase ? 'live Cloudflare HTTPS' : 'workerd via Miniflare',
        database: 'actual normalized SQL Server',
        checks,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      verified: false,
      runtime: liveBase ? 'live Cloudflare HTTPS' : 'workerd via Miniflare',
      completedChecks: checks.length,
      lastPassed: checks.at(-1)?.name,
      failure: error instanceof Error ? error.message : 'Worker smoke check failed.',
    }),
  );
  throw error;
} finally {
  if (conversationId && token)
    await dispatch(`${base}/conversations/${encodeURIComponent(conversationId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, Origin: origin },
    }).catch(() => undefined);
  if (token)
    await dispatch(`${base}/sessions/current`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, Origin: origin },
    }).catch(() => undefined);
  await runtime?.dispose();
}
