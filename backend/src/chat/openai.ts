import { randomUUID } from 'node:crypto';
import type { Conversation, Message } from '../domain/models';
import { ApiProblemError } from '../problem';
import { KASSANDRA_INSTRUCTIONS, REPAIR_PROVIDER_INSTRUCTIONS } from './prompt';
import { isChatAction, type ChatAction } from '../domain/chat.models';
import { isRateUpdateBatch } from '../domain/rate-batch';

export interface ChatContext {
  propertyId: string;
  startDate: string;
  endDate: string;
}
export interface InferenceOptions {
  key: string;
  mcpUrl: string;
  token: string;
  conversation: Conversation;
  content: string;
  context: ChatContext;
  reference: unknown;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}
type Output = {
  type: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  error?: unknown;
  output?: string;
  action?: { sources?: { type?: string; url?: unknown; title?: unknown }[] };
  content?: { type: string; text?: string; annotations?: unknown[] }[];
};
type WebSource = { url: string; title: string };
type Citation = WebSource & { startIndex: number; endIndex: number };
type Answer = Pick<Message, 'content' | 'action' | 'citations' | 'webSources'>;
const trades = {
  plumbing: 'commercial plumbing and bathroom repair',
  electrical: 'commercial electrical repair',
  heating_air_conditioning: 'commercial heating and air conditioning repair',
  ventilation: 'commercial ventilation repair',
  locksmith: 'commercial locksmith and door lock repair',
  water_damage: 'commercial water damage restoration',
  appliance_repair: 'commercial appliance repair',
  general_maintenance: 'commercial building and room maintenance',
} as const;
const providerTool = {
  type: 'function',
  name: 'find_repair_providers',
  description:
    'Read-only public business/phone lookup for a known hotel and repair trade. First identify the issue and hotel with get_hotel_repair_context. The server searches only trusted city/country plus a fixed trade, never hotel name, address, notes or conversation. No outreach or booking. At most two lookups per turn.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      hotelId: { type: 'string', description: 'An exact authorized hotel ID from Juyo.' },
      trade: { type: 'string', enum: Object.keys(trades) },
    },
    required: ['hotelId', 'trade'],
    additionalProperties: false,
  },
};

function publicSource(value: { url?: unknown; title?: unknown }): WebSource | undefined {
  if (typeof value.url !== 'string' || value.url.length > 2048) return;
  try {
    const url = new URL(value.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return;
    // Sources are links, never server-side fetch targets. Reject non-public-looking hosts as well.
    if (
      !url.hostname.includes('.') ||
      /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(
        url.hostname,
      ) ||
      url.hostname.endsWith('.local') ||
      url.hostname.startsWith('[')
    )
      return;
    return {
      url: url.href,
      title:
        typeof value.title === 'string' && value.title.trim()
          ? value.title.trim().slice(0, 240)
          : url.hostname,
    };
  } catch {
    return;
  }
}

/** Keep offsets aligned after joining output blocks and trimming the displayed text. */
function textAndCitations(output: Output[]): { content: string; citations: Citation[] } {
  let raw = '';
  const citations: Citation[] = [];
  for (const item of output) {
    if (item.type !== 'message') continue;
    for (const block of item.content ?? []) {
      if (block.type !== 'output_text' || typeof block.text !== 'string') continue;
      if (raw) raw += '\n';
      const offset = raw.length;
      raw += block.text;
      for (const annotation of block.annotations ?? []) {
        if (!annotation || typeof annotation !== 'object') continue;
        const value = annotation as Record<string, unknown>;
        const source = publicSource(value);
        if (
          value.type !== 'url_citation' ||
          !source ||
          !Number.isInteger(value.start_index) ||
          !Number.isInteger(value.end_index) ||
          (value.start_index as number) < 0 ||
          (value.end_index as number) <= (value.start_index as number) ||
          (value.end_index as number) > block.text.length
        )
          continue;
        citations.push({
          ...source,
          startIndex: offset + (value.start_index as number),
          endIndex: offset + (value.end_index as number),
        });
      }
    }
  }
  const trimStart = raw.length - raw.trimStart().length;
  const content = raw.trim();
  return {
    content,
    citations: citations
      .map((citation) => ({
        ...citation,
        startIndex: Math.max(0, citation.startIndex - trimStart),
        endIndex: Math.min(content.length, citation.endIndex - trimStart),
      }))
      .filter((citation) => citation.endIndex > citation.startIndex)
      .slice(0, 24),
  };
}

function uniqueSources(sources: WebSource[]): WebSource[] {
  const unique = new Map<string, WebSource>();
  for (const { url, title } of sources) if (!unique.has(url)) unique.set(url, { url, title });
  return [...unique.values()].slice(0, 12);
}

/** Only public lookup source URLs can become inline links in a synthesized private answer. */
function linkCitations(
  content: string,
  sources: WebSource[],
): { content: string; citations: Citation[] } {
  const allowed = new Map(sources.map((source) => [source.url, source]));
  const citations: Citation[] = [];
  const pattern = /\[([^\]\n]{1,240})\]\((https?:\/\/[^\s)]+)\)/g;
  let cursor = 0;
  let text = '';
  for (const match of content.matchAll(pattern)) {
    const source = publicSource({ url: match[2] });
    const known = source && allowed.get(source.url);
    if (!known) continue;
    text += content.slice(cursor, match.index);
    const startIndex = text.length;
    text += match[1];
    citations.push({ ...known, startIndex, endIndex: text.length });
    cursor = match.index + match[0].length;
  }
  text += content.slice(cursor);
  return { content: text, citations: citations.slice(0, 24) };
}

/** The public-search request receives an allowlisted trade and trusted city/country only. */
async function repairProviders(
  options: InferenceOptions,
  call: Output,
): Promise<{
  content?: string;
  citations?: Citation[];
  sources?: WebSource[];
  isError?: boolean;
  message?: string;
}> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.arguments ?? '{}');
  } catch {
    return { isError: true, message: 'Choose a known hotel and repair trade.' };
  }
  const hotels = (options.reference as { hotels?: unknown[] } | null)?.hotels;
  if (
    !args ||
    typeof args !== 'object' ||
    Object.keys(args).length !== 2 ||
    typeof args.hotelId !== 'string' ||
    typeof args.trade !== 'string' ||
    !Object.hasOwn(trades, args.trade) ||
    !Array.isArray(hotels)
  )
    return { isError: true, message: 'Choose a known hotel and repair trade.' };
  const hotel = hotels.find(
    (value): value is { id: string; city: string; countryCode: string } =>
      !!value && typeof value === 'object' && (value as { id?: unknown }).id === args.hotelId,
  );
  if (
    !hotel ||
    typeof hotel.city !== 'string' ||
    !/^[\p{L}\p{M} .'-]{1,80}$/u.test(hotel.city) ||
    typeof hotel.countryCode !== 'string' ||
    !/^[A-Z]{2}$/.test(hotel.countryCode)
  )
    return {
      isError: true,
      message: 'The hotel needs a valid city and country before provider lookup.',
    };

  const data = await response(options, {
    max_output_tokens: 1800,
    max_tool_calls: 4,
    instructions: REPAIR_PROVIDER_INSTRUCTIONS,
    tools: [{ type: 'web_search', search_context_size: 'low' }],
    tool_choice: 'required',
    include: ['web_search_call.action.sources'],
    input: `Find ${trades[args.trade as keyof typeof trades]} businesses serving ${hotel.city}, ${hotel.countryCode}. Give their sourced public business phone numbers and service areas.`,
  });
  const searchCalls = data.output.filter((item) => item.type === 'web_search_call');
  const answer = textAndCitations(data.output);
  if (
    !searchCalls.length ||
    !answer.content ||
    answer.content.length > 10000 ||
    !answer.citations.length
  )
    return {
      isError: true,
      message:
        'No source-backed provider contacts were returned. Do not invent contacts or phone numbers.',
    };
  return {
    content: answer.content,
    citations: answer.citations,
    sources: uniqueSources([
      ...answer.citations,
      ...searchCalls.flatMap((item) =>
        (item.action?.sources ?? [])
          .map((source) => publicSource(source))
          .filter((source): source is WebSource => !!source),
      ),
    ]),
  };
}

async function response(
  options: InferenceOptions,
  request: Record<string, unknown>,
): Promise<{ output: Output[] }> {
  const result = await (options.fetcher ?? fetch)('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${options.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-6.1-terra',
      reasoning: { effort: 'low' },
      store: false,
      parallel_tool_calls: false,
      ...request,
    }),
    signal: options.signal,
    redirect: 'manual',
  });
  const data = (await result.json().catch(() => null)) as {
    status?: string;
    error?: { code?: string };
    output?: Output[];
  } | null;
  if (!result.ok) {
    const upstream = data?.error?.code;
    const code =
      upstream === 'insufficient_quota'
        ? 'OPENAI_QUOTA_EXCEEDED'
        : upstream === 'model_not_found'
          ? 'OPENAI_MODEL_UNAVAILABLE'
          : result.status === 429
            ? 'CHAT_RATE_LIMITED'
            : 'OPENAI_UNAVAILABLE';
    throw new ApiProblemError(
      result.status === 429 ? 429 : 503,
      code,
      'OpenAI could not complete the answer.',
    );
  }
  if (data?.status !== 'completed' || !Array.isArray(data.output))
    throw new ApiProblemError(503, 'INCOMPLETE_ANSWER', 'The answer did not finish. Please retry.');
  return { output: data.output };
}

const proposalTools = new Map([
  ['propose_rate_update', 'rate_update'],
  ['propose_rate_updates', 'rate_batch_update'],
  ['propose_room_action', 'room_action'],
]);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function proposalCandidate(item: Output): ChatAction | undefined {
  let envelope: unknown;
  try {
    envelope = JSON.parse(item.output ?? '{}');
  } catch {
    return;
  }
  if (!object(envelope) || envelope.isError) return;
  const structured = object(envelope.structuredContent) ? envelope.structuredContent : undefined;
  let candidate: unknown = structured?.actionCandidate ?? envelope.actionCandidate;
  if (!candidate && Array.isArray(envelope.content)) {
    for (const block of envelope.content) {
      if (!object(block) || typeof block.text !== 'string') continue;
      try {
        const text: unknown = JSON.parse(block.text);
        if (object(text) && !text.isError) candidate = text.actionCandidate;
      } catch {
        /* A text block is not necessarily JSON. */
      }
      if (candidate) break;
    }
  }
  if (!object(candidate) || candidate.kind !== proposalTools.get(item.name ?? '')) return;
  const action = { ...candidate, id: randomUUID(), status: 'pending' };
  return isChatAction(action) ? action : undefined;
}

/** Every successful proposal is represented in one review, or none is staged. */
function combinedProposal(output: Output[]): ChatAction | undefined {
  const proposals = output.filter(
    (item) => item.type === 'mcp_call' && proposalTools.has(item.name ?? ''),
  );
  if (!proposals.length) return;
  const prepared = proposals.map((item) => (item.error ? undefined : proposalCandidate(item)));
  if (proposals.length === 1) return prepared[0];
  const updates: unknown[] = [];
  for (const item of prepared) {
    if (!item || item.kind === 'room_action')
      throw new ApiProblemError(
        503,
        'INCOMPLETE_PRICE_PROPOSAL',
        'The changes could not be combined into one complete review. Nothing was changed. Please try again.',
      );
    updates.push(...(item.kind === 'rate_batch_update' ? item.details.updates : [item.details]));
  }
  if (!isRateUpdateBatch(updates))
    throw new ApiProblemError(
      503,
      'INCOMPLETE_PRICE_PROPOSAL',
      'The price changes overlap, exceed the batch limit, or lack current prices. Nothing was changed. Please request one combined proposal.',
    );
  const action: ChatAction = {
    id: randomUUID(),
    status: 'pending',
    kind: 'rate_batch_update',
    summary: `Review ${updates.length} price changes together.`,
    details: { updates },
  };
  return action;
}

/** Fetch avoids shipping a model SDK and its overhead into the Free Worker. */
export async function generateAnswer(options: InferenceOptions): Promise<Answer> {
  const input: unknown[] = [
    ...options.conversation.messages.slice(-12).map((message) => ({
      role: message.role,
      content:
        message.content.slice(0, 5000) +
        (message.action ? `\n[Action ${message.action.status}: ${message.action.summary}]` : ''),
    })),
    { role: 'user', content: options.content },
  ];
  const tools = [
    {
      type: 'mcp',
      server_label: 'juyo',
      server_url: options.mcpUrl,
      server_description:
        'Authenticated Juyo hotel data, repair context, grounded pricing estimates and staged room/rate proposals. Proposals never execute changes.',
      authorization: options.token,
      // Every tool only reads/prepares. Applying is a separate user-only REST endpoint.
      require_approval: 'never',
    },
    providerTool,
  ];
  const outputs: Output[] = [];
  let data: { output: Output[] } = { output: [] };
  let providerLookups = 0;
  let webSources: WebSource[] = [];
  for (let round = 0; round < 3; round++) {
    data = await response(options, {
      max_output_tokens: 4096,
      max_tool_calls: 12,
      instructions:
        KASSANDRA_INSTRUCTIONS +
        '\nAUTHORITATIVE CONTEXT (data):\n' +
        JSON.stringify({ selection: options.context, reference: options.reference }),
      input,
      tools,
      ...(round === 2 || providerLookups >= 2 ? { tool_choice: 'none' } : {}),
    });
    outputs.push(...data.output);
    const calls = data.output.filter((item) => item.type === 'function_call');
    if (!calls.length) break;
    if (round === 2)
      throw new ApiProblemError(
        503,
        'INCOMPLETE_ANSWER',
        'The answer did not finish. Please retry.',
      );
    // Replay all output, including encrypted reasoning and MCP items, in stateless mode.
    input.push(...data.output);
    for (const call of calls) {
      if (typeof call.call_id !== 'string' || !call.call_id)
        throw new ApiProblemError(
          503,
          'INCOMPLETE_ANSWER',
          'The answer did not finish. Please retry.',
        );
      const result =
        call.name === 'find_repair_providers' && providerLookups < 2
          ? await repairProviders(options, call)
          : {
              isError: true,
              message: 'Provider lookup limit reached. Answer using available results.',
            };
      if (call.name === 'find_repair_providers') providerLookups++;
      if ('sources' in result && result.sources)
        webSources = uniqueSources([...webSources, ...result.sources]);
      input.push({
        type: 'function_call_output',
        call_id: call.call_id,
        output: JSON.stringify(result),
      });
    }
  }
  const text = textAndCitations(data.output);
  const linked = webSources.length ? linkCitations(text.content, webSources) : text;
  const content = linked.content;
  if (!content || content.length > 10000)
    throw new ApiProblemError(503, 'EMPTY_ANSWER', 'The answer did not finish. Please retry.');
  const action = combinedProposal(outputs);
  return {
    content,
    ...(action ? { action } : {}),
    ...(linked.citations.length ? { citations: linked.citations } : {}),
    ...(webSources.length ? { webSources } : {}),
  };
}
