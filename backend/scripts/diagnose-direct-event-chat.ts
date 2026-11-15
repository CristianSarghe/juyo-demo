/**
 * Separate one event inference from SQL message persistence. No room/rate writes.
 * --run calls inference directly; --api includes SQL message persistence.
 * --check checks the offline TDS estimator only.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Request as TediousRequest, TYPES } from 'tedious';
import RpcRequestPayload from 'tedious/lib/rpcrequest-payload.js';
import { Collation } from 'tedious/lib/collation.js';
import { resolveParameter } from 'tedious/lib/data-type.js';
import type { InternalConnectionOptions } from 'tedious/lib/connection.js';
import { DEMO_ACCOUNTS } from '../src/demo-accounts';
import { encodeMessagePayload, isChatAction } from '../src/domain/chat.models';
import type { Message } from '../src/domain/models';
import { WORKER_SQL_PACKET_SIZE } from '../src/sql-worker-transport';
import { eventPricingPrompt } from '../../src/app/core/event-pricing-assistance';

const api = 'https://api-juyo.cristiansarghe.com/api/v1';
const inference = 'https://mcp-juyo.cristiansarghe.com/chat';
const origin = 'http://127.0.0.1:4200';
const context = { propertyId: 'dev-ber', startDate: '2026-12-01', endDate: '2026-12-03' };
// A local size estimate of the current appendMessages assistant INSERT. It is never sent to SQL.
const insertSql = `
INSERT juyo_api.Message(Id,ConversationId,Ordinal,RoleCode,Content,InsightJson,CreatedAt)
SELECT @id,@conversationId,COALESCE(MAX(Ordinal),0)+1,@role,@content,@insight,@createdAt
FROM juyo_api.Message WHERE ConversationId = @conversationId;`;

async function rpcSize(content: string, payload: string | null) {
  // The role value is ASCII, so this representative SQL collation does not alter its byte size.
  const collation = new Collation(1033, 0, 0, 52);
  const options = { tdsVersion: '7_4', useUTC: true } as InternalConnectionOptions;
  const statement = new TediousRequest(insertSql, () => {});
  statement.addParameter('id', TYPES.UniqueIdentifier, randomUUID());
  statement.addParameter('conversationId', TYPES.UniqueIdentifier, randomUUID());
  statement.addParameter('role', TYPES.VarChar, 'assistant', { length: 16 });
  statement.addParameter('content', TYPES.NVarChar, content, { length: Infinity });
  statement.addParameter('insight', TYPES.NVarChar, payload, { length: Infinity });
  statement.addParameter('createdAt', TYPES.DateTime2, new Date(), { scale: 3 });
  statement.validateParameters(collation, options);
  const resolveText = (name: string, value: string) =>
    resolveParameter(
      {
        name,
        type: TYPES.NVarChar,
        value,
        output: false,
        length: undefined,
        precision: undefined,
        scale: undefined,
      },
      collation,
      options,
    );
  const parameters = [
    resolveText('statement', insertSql),
    resolveText('params', statement.makeParamsParameter(statement.parameters)),
    ...statement.resolvedParameters,
  ];
  // Tedious' Sp_ExecuteSql identifier is 10. A transaction descriptor is always 8 bytes.
  const rpc = new RpcRequestPayload(10, parameters, Buffer.alloc(8), options);
  let rpcPayloadBytes = 0;
  let serializerChunks = 0;
  for await (const chunk of rpc) {
    rpcPayloadBytes += chunk.byteLength;
    serializerChunks++;
  }
  const packetCount = Math.ceil(rpcPayloadBytes / (WORKER_SQL_PACKET_SIZE - 8));
  return {
    estimator: 'Pinned Tedious RPC serializer; local only, no SQL connection',
    rpcPayloadBytes,
    serializerChunks,
    workerPacketSize: WORKER_SQL_PACKET_SIZE,
    estimatedTdsPacketCount: packetCount,
    estimatedTdsBytesIncludingHeaders: rpcPayloadBytes + packetCount * 8,
    includesTlsFraming: false,
  };
}

type Stage = {
  name: string;
  elapsedMs: number;
  status?: number;
  code?: string;
  edge1102?: boolean;
  requestId?: string | null;
};
const code = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[A-Z0-9_]{1,64}$/.test(value) ? value : undefined;
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
class SafeFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

async function main(apiMode = false): Promise<void> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const stages: Stage[] = [];
  const account = DEMO_ACCOUNTS.find((item) => item.email === 'sarah@juyo.local')!;
  let token = '';
  let conversationId: string | undefined;
  let answer: Pick<Message, 'content' | 'action'> | undefined;
  let metrics: Record<string, unknown> | undefined;
  let failureCode: string | undefined;
  let loggedOut = false;
  let inferenceRequested = false;
  let persistedMessageCount: number | undefined;
  const prompt = eventPricingPrompt({
    eventName: 'Urban Mobility Suppliers Forum',
    hotelName: 'Spreehof Berlin',
    startDate: context.startDate,
    endDate: context.endDate,
  });
  async function request(name: string, url: string, method: string, body?: unknown) {
    const start = performance.now();
    const headers = new Headers({ Origin: origin });
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(
          url === inference || url.endsWith('/messages') ? 185_000 : 40_000,
        ),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      stages.push({ name, elapsedMs: Math.round(performance.now() - start), code: 'FETCH_FAILED' });
      throw new SafeFailure('FETCH_FAILED');
    }
    const text = await response.text();
    let value: unknown;
    try {
      value = text ? JSON.parse(text) : undefined;
    } catch {
      /* Never expose raw body text. */
    }
    const stage: Stage = {
      name,
      elapsedMs: Math.round(performance.now() - start),
      status: response.status,
      requestId: response.headers.get('x-request-id')?.slice(0, 128) ?? null,
      ...(!response.ok
        ? { code: object(value) ? code(value.code) : undefined, edge1102: text.includes('1102') }
        : {}),
    };
    stages.push(stage);
    console.log(JSON.stringify(stage));
    if (!response.ok) throw new SafeFailure(stage.code ?? `HTTP_${response.status}`);
    return { value, status: response.status };
  }
  try {
    const login = await request('Sarah demo sign-in', `${api}/sessions`, 'POST', {
      email: account.email,
      password: account.password,
    });
    if (
      !object(login.value) ||
      typeof login.value.token !== 'string' ||
      !/^[a-f0-9]{64}$/.test(login.value.token)
    )
      throw new SafeFailure('INVALID_SESSION_RESPONSE');
    token = login.value.token;
    const created = await request(
      'Create retained Berlin diagnostic conversation',
      `${api}/conversations`,
      'POST',
      {
        title: `${apiMode ? 'API' : 'Direct'} event diagnostic ${startedAt.slice(0, 19)}`,
        propertyId: context.propertyId,
        month: '2026-12',
        roomDate: context.startDate,
      },
    );
    if (!object(created.value) || !uuid(created.value.id))
      throw new SafeFailure('INVALID_CONVERSATION_RESPONSE');
    conversationId = created.value.id;
    inferenceRequested = true;
    const result = apiMode
      ? await request(
          'Full API inference and SQL message append',
          `${api}/conversations/${conversationId}/messages`,
          'POST',
          { content: prompt, context },
        )
      : await request('Direct MCP inference; no message append', inference, 'POST', {
          conversationId,
          content: prompt,
          context,
        });
    let rawAnswer = result.value;
    if (apiMode) {
      if (
        result.status !== 201 ||
        !object(result.value) ||
        result.value.id !== conversationId ||
        !Array.isArray(result.value.messages)
      )
        throw new SafeFailure('INVALID_API_CONVERSATION_RESPONSE');
      persistedMessageCount = result.value.messages.length;
      rawAnswer = result.value.messages.findLast(
        (item: unknown) => object(item) && item.role === 'assistant',
      );
    }
    if (
      !object(rawAnswer) ||
      typeof rawAnswer.content !== 'string' ||
      !rawAnswer.content.trim() ||
      rawAnswer.content.length > 10_000 ||
      (rawAnswer.action !== undefined &&
        (!isChatAction(rawAnswer.action) || rawAnswer.action.status !== 'pending'))
    )
      throw new SafeFailure('INVALID_INFERENCE_RESPONSE');
    answer = {
      content: rawAnswer.content,
      ...(rawAnswer.action ? { action: rawAnswer.action as Message['action'] } : {}),
    };
    const payload = encodeMessagePayload(answer);
    metrics = {
      responseStatus: result.status,
      ...(apiMode ? { persistedMessageCount } : { inferenceStatus: result.status }),
      actionKind: answer.action?.kind ?? null,
      actionRowCount:
        answer.action?.kind === 'rate_batch_update'
          ? answer.action.details.updates.length
          : answer.action
            ? 1
            : 0,
      contentChars: answer.content.length,
      contentUtf16Bytes: Buffer.byteLength(answer.content, 'utf16le'),
      encodedPayloadChars: payload?.length ?? 0,
      encodedPayloadUtf16Bytes: Buffer.byteLength(payload ?? '', 'utf16le'),
      successBodyUtf8Bytes: Buffer.byteLength(JSON.stringify(answer), 'utf8'),
      ...(await rpcSize(answer.content, payload)),
    };
  } catch (error) {
    failureCode = error instanceof SafeFailure ? error.code : 'DIAGNOSTIC_FAILED';
  } finally {
    if (token) {
      try {
        loggedOut =
          (await request('Log out diagnostic API session', `${api}/sessions/current`, 'DELETE'))
            .status === 204;
      } catch {
        /* Status/code already recorded; no headers or raw errors are logged. */
      }
    }
    // Only allowlisted response fields are saved; redact the in-memory bearer defensively.
    const report = {
      startedAt,
      elapsedMs: Math.round(performance.now() - started),
      mode: apiMode
        ? 'Full API inference and SQL message append'
        : 'Direct Cloudflare MCP inference only; SQL message append bypassed',
      conversationId,
      retainedConversation: !!conversationId,
      context,
      roomRateWrites: 0,
      messageWrites: apiMode
        ? (persistedMessageCount ?? (inferenceRequested ? 'unknown after failure' : 0))
        : 0,
      inferenceRequests: inferenceRequested ? 1 : 0,
      prompt,
      stages,
      loggedOut,
      ...(failureCode ? { failureCode } : {}),
      ...(metrics ? { metrics } : {}),
      ...(answer ? { answer } : {}),
    };
    const stamp = startedAt.replace(/[:.]/g, '-');
    const path = fileURLToPath(
      new URL(`../.local/${apiMode ? 'api' : 'direct'}-event-chat-${stamp}.json`, import.meta.url),
    );
    await mkdir(dirname(path), { recursive: true });
    const serialized = JSON.stringify(report, null, 2);
    await writeFile(
      path,
      (token ? serialized.replaceAll(token, '[REDACTED]') : serialized) + '\n',
      { mode: 0o600 },
    );
    token = '';
    console.log(
      JSON.stringify({
        report: path,
        elapsedMs: report.elapsedMs,
        conversationId,
        loggedOut,
        ...(failureCode ? { failureCode } : {}),
        ...(metrics ? { metrics } : {}),
      }),
    );
    if (failureCode || !loggedOut) process.exitCode = 1;
  }
}

if (process.argv.includes('--api')) await main(true);
else if (process.argv.includes('--run')) await main();
else if (process.argv.includes('--check'))
  console.log(JSON.stringify(await rpcSize('Offline serializer check.', null)));
else
  console.log(
    'Ready. Pass --run for direct inference, --api for the full API message append, or --check for offline serialization only.',
  );
