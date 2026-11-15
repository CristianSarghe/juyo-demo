/** Local workerd MCP → deployed REST → actual SQL. No OpenAI calls or domain writes. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { DEMO_ACCOUNTS } from '../src/demo-accounts';

const api = (process.env.SMOKE_API_URL ?? 'https://api-juyo.cristiansarghe.com/api/v1').replace(
  /\/$/,
  '',
);
assert.equal(new URL(api).protocol, 'https:', 'Use HTTPS for the actual remote API.');
const origin = process.env.SMOKE_ORIGIN ?? 'http://127.0.0.1:4200';
assert.equal(new URL(origin).origin, origin, 'SMOKE_ORIGIN must be a browser origin.');
assert.ok(/^https?:$/.test(new URL(origin).protocol), 'SMOKE_ORIGIN must use HTTP or HTTPS.');
const publicMcp = process.env.SMOKE_MCP_URL;
if (publicMcp)
  assert.equal(new URL(publicMcp).protocol, 'https:', 'Use HTTPS for the deployed MCP.');
const mcp = publicMcp ?? 'https://mcp-juyo.cristiansarghe.com/mcp';
const runtime = publicMcp
  ? undefined
  : new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        scriptPath: fileURLToPath(
          new URL('../dist/kassandra/kassandra-worker.js', import.meta.url),
        ),
        compatibilityDate: '2026-11-14',
        compatibilityFlags: ['nodejs_compat'],
        bindings: { JUYO_API_URL: api, MCP_PUBLIC_URL: mcp, ALLOWED_ORIGINS: origin },
        log: new Log(LogLevel.ERROR),
      }),
    );
type Check = {
  name: string;
  passed: boolean;
  elapsedMs: number;
  status?: number;
  detail?: string;
  upstreamFailure?: {
    contentType: string | null;
    code?: string;
    edge1102: boolean;
    requestId: string | null;
    ray: string | null;
  };
};
const checks: Check[] = [];
let token = '';
let rpcId = 0;
let lastStatus: number | undefined;
let upstreamFailure: Check['upstreamFailure'];
let context: any;
let hotel: any;
let type: any;
let room: any;
let date = '';

async function check(name: string, run: () => Promise<void>) {
  const started = performance.now();
  lastStatus = undefined;
  upstreamFailure = undefined;
  try {
    await run();
    checks.push({
      name,
      passed: true,
      elapsedMs: Math.round(performance.now() - started),
      status: lastStatus,
    });
  } catch (error) {
    // Assertions use fixed messages only. Never serialize response bodies, headers or credentials.
    const detail =
      error instanceof Error ? error.message.split('\n')[0].slice(0, 160) : 'Check failed.';
    checks.push({
      name,
      passed: false,
      elapsedMs: Math.round(performance.now() - started),
      status: lastStatus,
      detail,
      ...(upstreamFailure ? { upstreamFailure } : {}),
    });
  }
  console.log(JSON.stringify(checks.at(-1)));
}

async function rest(path: string, options: { method?: string; body?: unknown } = {}) {
  const headers = new Headers({ Origin: origin });
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await fetch(api + path, {
    method: options.method ?? 'GET',
    headers,
    signal: AbortSignal.timeout(40_000),
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  lastStatus = response.status;
  if (response.status >= 500) {
    const text = await response.clone().text();
    let code: string | undefined;
    try {
      const value = JSON.parse(text).code;
      if (typeof value === 'string' && /^[A-Z0-9_]{1,64}$/.test(value)) code = value;
    } catch {}
    upstreamFailure = {
      contentType: response.headers.get('content-type'),
      code,
      edge1102: text.includes('1102'),
      requestId: response.headers.get('x-request-id'),
      ray: response.headers.get('cf-ray'),
    };
  }
  return response;
}

async function rpc(method: string, params: unknown = {}, auth = token) {
  const headers = new Headers({
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Origin: origin,
    'MCP-Protocol-Version': '2025-06-18',
  });
  if (auth) headers.set('Authorization', `Bearer ${auth}`);
  const dispatch = runtime ? runtime.dispatchFetch.bind(runtime) : fetch;
  const response = await dispatch(mcp, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(80_000),
  });
  lastStatus = response.status;
  assert.equal(
    response.headers.get('Access-Control-Allow-Origin'),
    origin,
    'MCP preserves localhost CORS.',
  );
  return response;
}

async function tool(name: string, args: Record<string, unknown> = {}) {
  const response = await rpc('tools/call', { name, arguments: args });
  assert.equal(response.status, 200, 'MCP tool request returns HTTP 200.');
  const envelope = (await response.json()) as any;
  assert.equal(envelope.error, undefined, 'MCP tool has no protocol error.');
  if (envelope.result?.isError === true) {
    // The MCP executor deliberately returns only bounded public validation or
    // generic failure text; it never echoes upstream credentials/SQL errors.
    throw new Error(
      `MCP tool error: ${String(envelope.result.content?.[0]?.text ?? 'Required facts unavailable.').slice(0, 180)}`,
    );
  }
  assert(envelope.result?.structuredContent, 'MCP has structured output.');
  return envelope.result.structuredContent as any;
}

try {
  await check('MCP requires bearer authentication', async () => {
    assert.equal((await rpc('tools/list', {}, '')).status, 401, 'Missing auth returns 401.');
  });
  const signIn = async () => {
    const account = DEMO_ACCOUNTS[0];
    const response = await rest('/sessions', {
      method: 'POST',
      body: {
        email: process.env.API_DEMO_EMAIL ?? account.email,
        password: process.env.API_DEMO_PASSWORD ?? account.password,
      },
    });
    assert.equal(response.status, 201, 'Actual remote API sign-in returns 201.');
    const session = (await response.json()) as any;
    assert(
      typeof session.token === 'string' && /^[a-f0-9]{64}$/.test(session.token),
      'API returns an opaque bearer.',
    );
    token = session.token;
  };
  await check('Sign in with backend demo account', signIn);
  // Explicit diagnostic retry preserves the initial failure in the report.
  if (!token && process.env.SMOKE_RETRY_SIGN_IN === '1')
    await check('Explicit one-time diagnostic sign-in retry', signIn);
  if (!token) throw new Error('Cannot verify authenticated MCP without a remote API session.');
  await check('MCP rejects invalid session', async () => {
    assert.equal(
      (await rpc('tools/list', {}, '0'.repeat(64))).status,
      401,
      'Invalid bearer returns 401.',
    );
  });
  await check('MCP initializes in actual workerd', async () => {
    const response = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      clientInfo: { name: 'juyo-smoke', version: '1.0.0' },
      capabilities: {},
    });
    assert.equal(response.status, 200, 'Initialize returns 200.');
    const body = (await response.json()) as any;
    assert.equal(body.result?.protocolVersion, '2025-06-18', 'Protocol is negotiated.');
    assert.equal(body.result?.serverInfo?.name, 'juyo-kassandra', 'Correct MCP server.');
  });
  await check('MCP exposes the required bounded read/proposal tools', async () => {
    const response = await rpc('tools/list');
    assert.equal(response.status, 200, 'Tool list returns 200.');
    const body = (await response.json()) as any;
    assert(Array.isArray(body.result?.tools), 'A tool collection is returned.');
    const names = new Set(body.result.tools.map((entry: any) => entry.name));
    for (const required of [
      'get_workspace_context',
      'get_hotel_analytics',
      'get_hotel_data',
      'get_room_inventory',
      'get_hotel_repair_context',
      'get_booked_price_history',
      'get_warnings',
      'get_upcoming_events',
      'get_data_dictionary',
      'recommend_room_price',
      'propose_rate_update',
      'propose_rate_updates',
      'propose_room_action',
    ])
      assert(names.has(required), `Required tool ${required} is present.`);
    assert(
      body.result.tools.every((entry: any) => entry.annotations.readOnlyHint === true),
      'No direct domain mutation tool exists.',
    );
  });
  await check('MCP workspace context has four SQL-backed hotels', async () => {
    context = (await tool('get_workspace_context')).data;
    assert.equal(context.hotels.length, 4, 'Four hotels are returned.');
    assert.equal(context.dates.length, 92, 'Complete quarter calendar is returned.');
    assert(
      context.hotels.every(
        (row: any) =>
          Number.isFinite(row.coordinates.latitude) && Number.isFinite(row.coordinates.longitude),
      ),
      'Hotel coordinates are present.',
    );
    hotel = context.hotels[0];
    date = context.bookingSnapshot.asOf;
  });
  if (!hotel) throw new Error('Cannot continue scoped checks without reference data.');
  await check('MCP hotel/day analytics match actual REST', async () => {
    const response = await rest(
      `/analytics/dashboard?hotelId=${encodeURIComponent(hotel.id)}&from=${date}&to=${date}`,
    );
    assert.equal(response.status, 200, 'Direct analytics returns 200.');
    const expected = (await response.json()) as any;
    const actual = (await tool('get_hotel_analytics', { hotelId: hotel.id, from: date, to: date }))
      .data;
    assert.deepEqual(actual.outlook, expected.outlook, 'MCP outlook equals actual REST.');
    assert.deepEqual(actual.days, expected.days, 'MCP day facts equal actual REST.');
    assert.equal(actual.days.length, 1, 'Single date yields one day.');
  });
  await check('MCP operational inventory reconciles scoped rooms', async () => {
    const actual = (await tool('get_room_inventory', { hotelId: hotel.id })).data;
    const counts = actual.counts;
    assert(
      actual.rooms.every((row: any) => row.hotelId === hotel.id),
      'All rooms match selected hotel.',
    );
    assert.equal(
      counts.available + counts.booked + counts.held,
      counts.sellable,
      'Sellable inventory reconciles.',
    );
    assert.equal(
      counts.sellable + counts.outOfService,
      counts.physical,
      'Physical inventory reconciles.',
    );
    assert.equal(actual.date, date, 'Inventory uses business date.');
    room = actual.rooms[0];
  });
  await check('MCP room proposal prepares housekeeping without applying', async () => {
    assert(room?.id, 'Inventory provides a real room ID.');
    const actual = await tool('propose_room_action', { roomId: room.id, action: 'clean' });
    assert.equal(actual.data.applied, false, 'No room was changed.');
    assert.equal(actual.data.requiresConfirmation, true, 'User confirmation is required.');
    assert.equal(
      actual.actionCandidate.kind,
      'room_action',
      'Room proposal candidate is returned.',
    );
    assert.equal(actual.actionCandidate.details.roomId, room.id, 'Exact room is returned.');
    assert.equal(actual.actionCandidate.details.action, 'clean', 'Exact action is returned.');
  });
  await check('MCP normalized room types provide scoped identifiers', async () => {
    const actual = (
      await tool('get_hotel_data', { resource: 'room_types', hotelId: hotel.id, pageSize: 10 })
    ).data;
    assert(actual.items.length > 0, 'Selected hotel has room types.');
    assert(
      actual.items.every((row: any) => row.hotelId === hotel.id),
      'Types belong to selected hotel.',
    );
    type = actual.items[0];
  });
  if (!type) throw new Error('Cannot continue pricing checks without a room type.');
  await check('MCP accepted booking-price history matches REST', async () => {
    const response = await rest(
      `/room-types/${encodeURIComponent(type.id)}/price-history?from=${date}&to=${date}`,
    );
    assert.equal(response.status, 200, 'Direct price history returns 200.');
    const expected = await response.json();
    const actual = (
      await tool('get_booked_price_history', { roomTypeId: type.id, from: date, to: date })
    ).data;
    assert.deepEqual(actual, expected, 'MCP price history equals actual REST.');
  });
  await check('MCP recommendations are grounded and bounded', async () => {
    const actual = (
      await tool('recommend_room_price', {
        hotelId: hotel.id,
        roomTypeId: type.id,
        from: date,
        to: date,
      })
    ).data;
    assert.equal(actual.days.length, 1, 'One-day pricing suggestion.');
    assert(actual.days[0].currentSellingRate > 0, 'Current effective quote is present.');
    assert(
      actual.days[0].adjustmentPercent >= -5 && actual.days[0].adjustmentPercent <= 15,
      'Adjustment obeys disclosed rule.',
    );
    assert(actual.limitations.length >= 3, 'Limitations are explicit.');
  });
  await check('MCP rate proposal prepares exact change without applying', async () => {
    const actual = await tool('propose_rate_update', {
      hotelId: hotel.id,
      roomTypeId: type.id,
      from: date,
      to: date,
      nightlyRate: 199.99,
      reason: 'MCP smoke proposal only; no apply.',
    });
    assert.equal(actual.data.applied, false, 'Nothing was applied.');
    assert.equal(actual.data.requiresConfirmation, true, 'User confirmation is required.');
    assert.equal(
      actual.actionCandidate.kind,
      'rate_update',
      'Rate proposal candidate is returned.',
    );
    assert.equal(actual.actionCandidate.details.nightlyRate, 199.99, 'Exact rate is returned.');
  });
  await check('MCP batch proposal includes all grounded rows without applying', async () => {
    const dates = context.dates.map((row: any) => (typeof row === 'string' ? row : row.date));
    const following = dates.find((value: string) => value > date);
    assert(following, 'Another calendar day is available.');
    const actual = await tool('propose_rate_updates', {
      updates: [
        { hotelId: hotel.id, roomTypeId: type.id, from: date, to: date, nightlyRate: 199.99 },
        {
          hotelId: hotel.id,
          roomTypeId: type.id,
          from: following,
          to: following,
          nightlyRate: 209.99,
        },
      ],
    });
    assert.equal(actual.data.applied, false);
    assert.equal(actual.data.requiresConfirmation, true);
    assert.equal(actual.actionCandidate.kind, 'rate_batch_update');
    assert.equal(actual.actionCandidate.details.updates.length, 2);
    for (const row of actual.actionCandidate.details.updates) {
      assert(row.currentMinRate > 0 && row.currentMaxRate >= row.currentMinRate);
      assert.match(row.expectedRateVersion, /^[a-f0-9]{64}$/);
    }
  });
  await check('MCP warnings are scoped and bounded', async () => {
    const actual = (await tool('get_warnings', { hotelId: hotel.id, date, pageSize: 10 })).data;
    assert(
      Array.isArray(actual.items) && actual.items.length <= 10,
      'Warnings are a bounded collection.',
    );
    assert(
      actual.items.every((row: any) => row.hotel.id === hotel.id),
      'Warnings belong to selected hotel.',
    );
  });
  await check('MCP events include coordinates and hotel relevance', async () => {
    const actual = (await tool('get_upcoming_events', { hotelId: hotel.id, date, pageSize: 10 }))
      .data;
    assert(Array.isArray(actual.items) && actual.items.length <= 10, 'Events are bounded.');
    assert(
      actual.items.every(
        (row: any) =>
          Number.isFinite(row.event.coordinates.latitude) &&
          row.impacts.some((impact: any) => impact.hotel.id === hotel.id),
      ),
      'Events have map coordinates and selected-hotel relevance.',
    );
  });
  await check('MCP dictionary provides enums and normalized references', async () => {
    const actual = (await tool('get_data_dictionary')).data;
    assert(
      Array.isArray(actual.dataDictionary) && actual.dataDictionary.length > 10,
      'Entity dictionary is present.',
    );
    assert(
      Array.isArray(actual.enumDictionary) && actual.enumDictionary.length > 10,
      'Enum dictionary is present.',
    );
  });
} catch (error) {
  checks.push({
    name: 'Required prerequisite',
    passed: false,
    elapsedMs: 0,
    detail:
      error instanceof Error
        ? error.message.split('\n')[0].slice(0, 160)
        : 'Prerequisite unavailable.',
  });
} finally {
  if (token)
    await check('API session is logged out after smoke', async () => {
      assert.equal(
        (await rest('/sessions/current', { method: 'DELETE' })).status,
        204,
        'Logout returns 204.',
      );
      token = '';
    });
  await runtime?.dispose();
  const report = {
    verified: checks.every((entry) => entry.passed),
    checkedAt: new Date().toISOString(),
    runtime: publicMcp ? 'Actual deployed Cloudflare MCP' : 'Actual local workerd via Miniflare',
    mcp: publicMcp ?? 'Local workerd dispatch',
    upstream: api,
    data: 'Actual existing remote REST and normalized SQL; no mock facts',
    openaiCalls: 0,
    domainWrites: 0,
    checks,
  };
  const reportPath =
    process.env.SMOKE_MCP_REPORT ??
    fileURLToPath(new URL('../.local/mcp-smoke.json', import.meta.url));
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(
    JSON.stringify({
      verified: report.verified,
      passed: checks.filter((entry) => entry.passed).length,
      failed: checks.filter((entry) => !entry.passed).length,
      report: reportPath,
    }),
  );
  if (!report.verified) process.exitCode = 1;
}
