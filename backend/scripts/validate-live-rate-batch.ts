/**
 * Opt-in deployed REST → OpenAI/MCP → SQL batch validation. No SQL credentials needed.
 * Run only after deployment/coordination:
 *   LIVE_RATE_BATCH_APPLY=1 npx tsx scripts/validate-live-rate-batch.ts
 * Changes two one-day selling quotes by €1, then restores their original values.
 * Audit rows and the dedicated conversation remain as evidence.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_ACCOUNTS } from '../src/demo-accounts';
import { isChatAction, type ChatAction } from '../src/domain/chat.models';
import { rateVersion } from '../src/domain/rate-batch';
import type { Page, ReferenceDataDto } from '../src/domain/api.models';
import type { Conversation } from '../src/domain/models';
import type { RoomRateChange } from '../src/domain/mutation.models';
import type { RoomRate, RoomType } from '../src/domain/network.models';

function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new ValidationFailure(message);
}
class ValidationFailure extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

ensure(
  process.env.LIVE_RATE_BATCH_APPLY === '1',
  'This test writes live demo selling rates. Coordinate first, then set LIVE_RATE_BATCH_APPLY=1.',
);
const api = (process.env.SMOKE_API_URL ?? 'https://api-juyo.cristiansarghe.com/api/v1').replace(
  /\/$/,
  '',
);
const apiUrl = new URL(api);
ensure(
  apiUrl.protocol === 'https:' &&
    !apiUrl.username &&
    !apiUrl.password &&
    !apiUrl.search &&
    !apiUrl.hash &&
    apiUrl.pathname === '/api/v1',
  'Use an HTTPS API base ending in /api/v1, without credentials or query parameters.',
);
const origin = process.env.SMOKE_ORIGIN ?? 'http://127.0.0.1:4200';
ensure(
  /^https?:$/.test(new URL(origin).protocol) && new URL(origin).origin === origin,
  'SMOKE_ORIGIN must be a browser origin.',
);
const runId = randomUUID();
const reason = `Live batch validation ${runId}`;
const restoreReason = `Restore live batch ${runId}`;
const startedAt = new Date().toISOString();
const started = performance.now();
type Check = { name: string; passed: boolean; elapsedMs: number; detail?: string; code?: string };
type RequestTiming = { name: string; status?: number; elapsedMs: number; code?: string };
type Target = {
  hotelId: string;
  roomTypeId: string;
  roomTypeName: string;
  date: string;
  originalRate: number;
  testRate: number;
};
type Restoration = {
  roomTypeId: string;
  status: 'restored' | 'already-original' | 'skipped-concurrent-edit' | 'failed';
};
const checks: Check[] = [];
const requests: RequestTiming[] = [];
const restorations: Restoration[] = [];
let token = '';
let conversationId = '';
let action: Extract<ChatAction, { kind: 'rate_batch_update' }> | undefined;
let applyAttempted = false;
let targets: Target[] = [];
let appliedRows = 0;
let retryRows = 0;

async function step(name: string, run: () => Promise<void>, continueOnError = false) {
  const before = performance.now();
  try {
    await run();
    checks.push({ name, passed: true, elapsedMs: Math.round(performance.now() - before) });
  } catch (error) {
    // Only our fixed validation messages/codes enter logs; no response bodies or model text.
    const known = error instanceof ValidationFailure;
    checks.push({
      name,
      passed: false,
      elapsedMs: Math.round(performance.now() - before),
      detail: known ? error.message : 'Unexpected validation failure; response omitted.',
      ...(known && error.code ? { code: error.code } : {}),
    });
    if (!continueOnError) throw error;
  } finally {
    console.log(JSON.stringify(checks.at(-1)));
  }
}

async function rest<T>(
  name: string,
  path: string,
  expected: number,
  options: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const before = performance.now();
  const timing: RequestTiming = { name, elapsedMs: 0 };
  try {
    const headers = new Headers({ Origin: origin });
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    let response: Response;
    try {
      response = await fetch(api + path, {
        method: options.method ?? 'GET',
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(options.timeoutMs ?? 45_000),
        redirect: 'error',
      });
    } catch {
      throw new ValidationFailure('Remote request failed or timed out; transport details omitted.');
    }
    timing.status = response.status;
    if (response.status !== expected) {
      const problem = (await response.json().catch(() => null)) as { code?: unknown } | null;
      const code =
        typeof problem?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(problem.code)
          ? problem.code
          : undefined;
      timing.code = code;
      throw new ValidationFailure(`Expected HTTP ${expected}; received ${response.status}.`, code);
    }
    ensure(
      response.headers.get('Access-Control-Allow-Origin') === origin,
      'REST must allow the selected local browser origin.',
    );
    if (expected === 204) return undefined as T;
    const result: unknown = await response.json().catch(() => {
      throw new ValidationFailure('REST returned invalid JSON; response omitted.');
    });
    return result as T;
  } finally {
    timing.elapsedMs = Math.round(performance.now() - before);
    requests.push(timing);
  }
}

async function quote(target: Pick<Target, 'hotelId' | 'roomTypeId' | 'date'>): Promise<RoomRate> {
  const params = new URLSearchParams({
    hotelId: target.hotelId,
    roomTypeId: target.roomTypeId,
    from: target.date,
    to: target.date,
    pageSize: '2',
  });
  const result = await rest<Page<RoomRate>>(
    'Read one effective selling quote',
    `/room-rates?${params}`,
    200,
  );
  ensure(
    result?.total === 1 && Array.isArray(result.items) && result.items.length === 1,
    'The selected hotel/type/day must have exactly one current selling quote.',
  );
  const row = result.items[0];
  ensure(
    row.hotelId === target.hotelId &&
      row.roomTypeId === target.roomTypeId &&
      row.date === target.date &&
      row.currency === 'EUR' &&
      Number.isFinite(row.nightlyRate) &&
      row.nightlyRate > 0 &&
      row.nightlyRate <= 10_000,
    'The effective quote must match the requested scope and contain a valid EUR rate.',
  );
  return row;
}
async function history(): Promise<RoomRateChange[]> {
  const rows = await rest<RoomRateChange[]>('Read rate audit history', '/rate-updates', 200);
  ensure(Array.isArray(rows), 'Rate audit history must be a collection.');
  return rows;
}
const runRows = (rows: RoomRateChange[]) => rows.filter((row) => row.reason === reason);
const isApplied = (conversation: Conversation) =>
  conversation.messages.find((message) => message.action?.id === action?.id)?.action?.status ===
  'applied';

try {
  await step('Authenticate with the backend demo catalog', async () => {
    // Marco keeps this validation separate from the concurrent Alex browser session.
    const account = DEMO_ACCOUNTS[2];
    const session = await rest<{ token: string }>('Demo sign-in', '/sessions', 201, {
      method: 'POST',
      body: { email: account.email, password: account.password },
    });
    ensure(
      typeof session?.token === 'string' && /^[a-f0-9]{64}$/.test(session.token),
      'Sign-in must return an opaque bearer session.',
    );
    token = session.token;
  });
  await step('Select Amsterdam and two types on the last future calendar day', async () => {
    const reference = await rest<ReferenceDataDto>(
      'Read reference calendar',
      '/reference-data',
      200,
    );
    ensure(
      Array.isArray(reference.hotels) && Array.isArray(reference.dates),
      'Reference data must include hotels and dates.',
    );
    const hotel = reference.hotels.find((row) => row.city === 'Amsterdam');
    ensure(hotel, 'An Amsterdam hotel must exist.');
    const dates = reference.dates.filter((date) => date > reference.bookingSnapshot.asOf).sort();
    const date = dates.at(-1);
    ensure(
      date && /^\d{4}-\d{2}-\d{2}$/.test(date),
      'A future date must exist in the canonical calendar.',
    );
    const types = await rest<Page<RoomType>>(
      'Read Amsterdam room types',
      `/room-types?${new URLSearchParams({ hotelId: hotel.id, pageSize: '50' })}`,
      200,
    );
    ensure(
      Array.isArray(types.items) && types.items.every((row) => row.hotelId === hotel.id),
      'Room types must be scoped to Amsterdam.',
    );
    const selected = types.items.filter((row) => row.inventory > 0).slice(0, 2);
    ensure(selected.length === 2, 'Amsterdam must offer two room types with inventory.');
    for (const type of selected) {
      const current = await quote({ hotelId: hotel.id, roomTypeId: type.id, date });
      ensure(current.nightlyRate <= 9_999, 'The original quote must support a €1 test increase.');
      targets.push({
        hotelId: hotel.id,
        roomTypeId: type.id,
        roomTypeName: type.name,
        date,
        originalRate: current.nightlyRate,
        testRate: Math.round((current.nightlyRate + 1) * 100) / 100,
      });
    }
    const conversation = await rest<Conversation>(
      'Create dedicated validation conversation',
      '/conversations',
      201,
      {
        method: 'POST',
        body: {
          title: `Live batch validation ${runId.slice(0, 8)}`,
          propertyId: hotel.id,
          month: date.slice(0, 7),
          roomDate: date,
        },
      },
    );
    ensure(
      typeof conversation.id === 'string' && /^[a-f0-9-]{36}$/i.test(conversation.id),
      'A dedicated conversation must be created.',
    );
    conversationId = conversation.id;
  });
  await step('Live OpenAI/MCP prepares exactly two grounded pending changes', async () => {
    const [first] = targets;
    const changes = targets
      .map(
        (row) =>
          `${row.roomTypeName} (room type ID ${row.roomTypeId}) to EUR ${row.testRate.toFixed(2)} per night`,
      )
      .join('; ');
    const content = `Prepare one review containing both exact selling-rate changes for the Amsterdam hotel (hotel ID ${first.hotelId}) on ${first.date} only: ${changes}. Both start and end dates are ${first.date}. Use the exact reason "${reason}" for each change. These are explicit rates, not a recommendation. Put both changes in one batch review and leave it pending for Apply; do not change existing bookings.`;
    const conversation = await rest<Conversation>(
      'Ask live Kassandra for one batch',
      `/conversations/${conversationId}/messages`,
      201,
      {
        method: 'POST',
        body: {
          content,
          context: { propertyId: first.hotelId, startDate: first.date, endDate: first.date },
        },
        timeoutMs: 185_000,
      },
    );
    const candidate = conversation.messages.at(-1)?.action;
    ensure(
      isChatAction(candidate) &&
        candidate.kind === 'rate_batch_update' &&
        candidate.status === 'pending',
      'Live chat must produce one pending batch action.',
    );
    action = candidate;
    ensure(
      candidate.details.updates.length === 2,
      'The batch must contain exactly two room-type changes.',
    );
    for (const target of targets) {
      const rows = candidate.details.updates.filter(
        (row) => row.hotelId === target.hotelId && row.roomTypeId === target.roomTypeId,
      );
      ensure(rows.length === 1, 'Each requested room type must occur exactly once.');
      const row = rows[0];
      ensure(
        row.startDate === target.date &&
          row.endDate === target.date &&
          row.nightlyRate === target.testRate &&
          row.reason === reason,
        'The batch must preserve the exact day, requested rate, and test reason.',
      );
      ensure(
        row.currentMinRate === target.originalRate &&
          row.currentMaxRate === target.originalRate &&
          row.expectedRateVersion ===
            rateVersion([{ date: target.date, nightlyRate: target.originalRate }]),
        'The before prices and version must match the actual effective quotes.',
      );
    }
  });
  await step('Preparing the review makes no selling-rate writes', async () => {
    for (const target of targets)
      ensure(
        (await quote(target)).nightlyRate === target.originalRate,
        'Quotes must remain unchanged before Apply.',
      );
    ensure(
      runRows(await history()).length === 0,
      'The pending batch must have no matching rate audit writes.',
    );
  });
  await step('Apply commits both requested quotes together', async () => {
    ensure(action, 'A validated batch must exist before Apply.');
    applyAttempted = true;
    const result = await rest<Conversation>(
      'Apply the reviewed batch',
      `/conversations/${conversationId}/actions/${action.id}`,
      200,
      { method: 'POST', body: { decision: 'apply' } },
    );
    ensure(isApplied(result), 'Apply must record an applied decision.');
    for (const target of targets)
      ensure(
        (await quote(target)).nightlyRate === target.testRate,
        'Both effective quotes must equal their requested new rates.',
      );
    appliedRows = runRows(await history()).length;
    ensure(appliedRows === 2, 'Exactly two audit writes must belong to this applied batch.');
  });
  await step('Retrying Apply does not duplicate any rate writes', async () => {
    ensure(action, 'A validated batch must exist before retry.');
    const result = await rest<Conversation>(
      'Retry the same Apply decision',
      `/conversations/${conversationId}/actions/${action.id}`,
      200,
      { method: 'POST', body: { decision: 'apply' } },
    );
    ensure(isApplied(result), 'An Apply retry must retain the applied decision.');
    retryRows = runRows(await history()).length;
    ensure(
      retryRows === appliedRows && retryRows === 2,
      'An Apply retry must leave exactly the original two audit writes.',
    );
  });
} catch {
  // The failing step already recorded a bounded public diagnostic. Always attempt cleanup.
} finally {
  if (token && applyAttempted) {
    for (const target of targets) {
      let restoration: Restoration = { roomTypeId: target.roomTypeId, status: 'failed' };
      restorations.push(restoration);
      await step(
        `Restore original quote for ${target.roomTypeName}`,
        async () => {
          const current = await quote(target);
          if (current.nightlyRate === target.originalRate) {
            restoration.status = 'already-original';
            return;
          }
          const latest = [...(await history())]
            .reverse()
            .find(
              (row) =>
                row.hotelId === target.hotelId &&
                row.roomTypeId === target.roomTypeId &&
                row.startDate <= target.date &&
                row.endDate >= target.date,
            );
          if (current.nightlyRate !== target.testRate || latest?.reason !== reason) {
            restoration.status = 'skipped-concurrent-edit';
            throw new ValidationFailure(
              'Original quote was not restored because another edit now owns this day.',
            );
          }
          // Recheck immediately before writing. The manual REST contract has no compare-and-set.
          ensure(
            (await quote(target)).nightlyRate === target.testRate,
            'A concurrent edit changed the quote before restoration.',
          );
          await rest<RoomRateChange>('Restore one original selling quote', '/rate-updates', 201, {
            method: 'POST',
            body: {
              hotelId: target.hotelId,
              roomTypeId: target.roomTypeId,
              startDate: target.date,
              endDate: target.date,
              nightlyRate: target.originalRate,
              reason: restoreReason,
            },
          });
          ensure(
            (await quote(target)).nightlyRate === target.originalRate,
            'The original quote must be visible after restoration.',
          );
          restoration.status = 'restored';
        },
        true,
      );
    }
  }
  if (token && conversationId) {
    await step(
      'Leave no pending validation proposal',
      async () => {
        const current = await rest<Conversation>(
          'Read validation conversation',
          `/conversations/${conversationId}`,
          200,
        );
        for (const message of current.messages) {
          if (message.action?.status === 'pending')
            await rest<Conversation>(
              'Cancel remaining validation proposal',
              `/conversations/${conversationId}/actions/${message.action.id}`,
              200,
              { method: 'POST', body: { decision: 'cancel' } },
            );
        }
      },
      true,
    );
  }
  if (token)
    await step(
      'Log out the validation session',
      async () => {
        await rest<void>('Log out validation session', '/sessions/current', 204, {
          method: 'DELETE',
        });
        token = '';
      },
      true,
    );
  const verified = checks.length > 0 && checks.every((check) => check.passed);
  const report = {
    verified,
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - started),
    upstream: api,
    origin,
    data: 'Actual deployed REST, live OpenAI/MCP, and existing SQL selling-rate overrides',
    conversation: { id: conversationId || null, retained: true, softDeleteSupported: false },
    actionId: action?.id ?? null,
    applyAttempted,
    appliedRows,
    retryRows,
    targets,
    restorations,
    checks,
    requests,
  };
  const reportPath =
    process.env.LIVE_BATCH_REPORT ??
    fileURLToPath(new URL('../.local/live-rate-batch.json', import.meta.url));
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(
    JSON.stringify({
      verified,
      passed: checks.filter((check) => check.passed).length,
      failed: checks.filter((check) => !check.passed).length,
      report: reportPath,
    }),
  );
  if (!verified) process.exitCode = 1;
}
