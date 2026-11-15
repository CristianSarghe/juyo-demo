import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { generateAnswer, type InferenceOptions } from '../src/chat/openai.js';
import { requestKassandra } from '../src/chat/remote.js';
import type { ChatAction } from '../src/domain/chat.models.js';
import { isRateUpdateBatch, type RateUpdateReviewItem } from '../src/domain/rate-batch.js';
import { KASSANDRA_INSTRUCTIONS, REPAIR_PROVIDER_INSTRUCTIONS } from '../src/chat/prompt.js';

const conversation = {
  id: randomUUID(),
  title: 'Rates',
  updatedAt: new Date().toISOString(),
  messages: Array.from({ length: 20 }, (_, index) => ({
    id: randomUUID(),
    role: index % 2 ? ('assistant' as const) : ('user' as const),
    content: `Message ${index}`,
    createdAt: new Date().toISOString(),
  })),
};
const options = (fetcher: typeof fetch): InferenceOptions => ({
  key: 'unit-test-key',
  token: 'unit-test-session',
  mcpUrl: 'https://assistant.example.invalid/mcp',
  conversation,
  content: 'What is booked?',
  context: { propertyId: 'portfolio', startDate: '2026-11-01', endDate: '2026-11-30' },
  reference: { businessDate: '2026-11-14' },
  fetcher,
});
const output = (additional: unknown[] = [], text = 'There are 68 rooms booked.') => ({
  status: 'completed',
  output: [...additional, { type: 'message', content: [{ type: 'output_text', text }] }],
});
const fetchJson = (value: unknown, status = 200): typeof fetch =>
  (async () => Response.json(value, { status })) as typeof fetch;
const candidate = (): Omit<ChatAction, 'id' | 'status'> => ({
  kind: 'rate_update',
  summary: 'Set Classic rooms to €195.',
  details: {
    hotelId: 'dev-ams',
    hotelName: 'Canal House Amsterdam',
    roomTypeId: 'dev-ams-type-1',
    roomTypeName: 'Classic',
    startDate: '2026-11-14',
    endDate: '2026-11-20',
    nightlyRate: 195,
  },
});

test('Responses request uses exact Terra model, low effort, private bounded history and authenticated MCP', async () => {
  let body: any;
  let target: unknown;
  let authorization: string | null = null;
  const answer = await generateAnswer(
    options((async (url, init) => {
      target = url;
      authorization = new Headers(init?.headers).get('Authorization');
      body = JSON.parse(String(init?.body));
      return Response.json(output());
    }) as typeof fetch),
  );
  assert.equal(target, 'https://api.openai.com/v1/responses');
  assert.equal(authorization, 'Bearer unit-test-key');
  assert.equal(body.model, 'gpt-6.1-terra');
  assert.equal(body.reasoning.effort, 'low');
  assert.equal(body.store, false);
  assert.equal(body.input.length, 13);
  assert.equal(body.input[0].content, 'Message 8');
  assert.equal(body.input.at(-1).content, 'What is booked?');
  assert.equal(body.tools[0].type, 'mcp');
  assert.equal(body.tools[0].authorization, 'unit-test-session');
  assert.equal(body.tools[0].server_url, 'https://assistant.example.invalid/mcp');
  assert.equal(body.tools[0].require_approval, 'never');
  assert.equal(body.tools[1].name, 'find_repair_providers');
  assert.equal(body.tools[1].strict, true);
  assert.deepEqual(body.tools[1].parameters.required, ['hotelId', 'trade']);
  assert.equal(body.tools[1].parameters.additionalProperties, false);
  assert.equal(
    body.tools.some((tool: { type: string }) => tool.type === 'web_search'),
    false,
  );
  assert.equal(body.max_tool_calls, 12);
  assert.equal(body.max_output_tokens, 4096);
  assert.match(body.instructions, /2026-11-14/);
  assert.equal(answer.content, 'There are 68 rooms booked.');
});

const providerCall = (
  args: unknown = { hotelId: 'dev-ams', trade: 'plumbing' },
  callId = 'call-repair',
) => ({
  type: 'function_call',
  name: 'find_repair_providers',
  call_id: callId,
  arguments: JSON.stringify(args),
});
const providerOutput = (withSearch = true, withCitation = true) => ({
  status: 'completed',
  output: [
    ...(withSearch
      ? [
          {
            type: 'web_search_call',
            action: {
              sources: [
                {
                  type: 'url',
                  url: 'https://repairs.example/contact',
                  title: 'Pipe Works contact',
                },
                { type: 'url', url: 'https://repairs.example/contact' },
                { type: 'url', url: 'javascript:alert(1)' },
                { type: 'url', url: 'https://secret@example.com/contact' },
                { type: 'url', url: 'http://127.0.0.1/private' },
              ],
            },
          },
        ]
      : []),
    {
      type: 'message',
      content: [
        {
          type: 'output_text',
          text: 'Pipe Works — +31 20 000 0000. Commercial plumbers serving Amsterdam. Call to confirm availability.',
          annotations: withCitation
            ? [
                {
                  type: 'url_citation',
                  url: 'https://repairs.example/contact',
                  title: 'Pipe Works contact',
                  start_index: 0,
                  end_index: 27,
                },
              ]
            : [],
        },
      ],
    },
  ],
});
const repairReference = {
  businessDate: '2026-11-14',
  hotels: [
    {
      id: 'dev-ams',
      name: 'Private Hotel Name',
      city: 'Amsterdam',
      countryCode: 'NL',
      address: { line1: 'Private Street 27', postalCode: '1234 AB' },
      notes: 'Guest Alice, room 999; internal private information.',
    },
  ],
};

test('provider lookup separates public search from private MCP context and preserves cited contacts', async () => {
  const bodies: any[] = [];
  const initial = {
    status: 'completed',
    output: [
      { type: 'reasoning', encrypted_content: 'opaque-reasoning', summary: [] },
      { type: 'mcp_call', name: 'get_hotel_repair_context', output: '{"fault":"private fault"}' },
      providerCall(),
    ],
  };
  const responses = [
    initial,
    providerOutput(),
    output(
      [],
      'For the plumbing issue: Pipe Works — +31 20 000 0000. [Contact page](https://repairs.example/contact). Call to confirm availability.',
    ),
  ];
  const answer = await generateAnswer({
    ...options((async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json(responses[bodies.length - 1]);
    }) as typeof fetch),
    content: 'Find someone to fix room 999 at Private Street 27. Guest Alice is there.',
    reference: repairReference,
  });
  assert.equal(bodies.length, 3);
  const publicRequest = bodies[1];
  assert.equal(publicRequest.model, 'gpt-6.1-terra');
  assert.equal(publicRequest.store, false);
  assert.equal(
    publicRequest.input,
    'Find commercial plumbing and bathroom repair businesses serving Amsterdam, NL. Give their sourced public business phone numbers and service areas.',
  );
  assert.deepEqual(publicRequest.tools, [{ type: 'web_search', search_context_size: 'low' }]);
  assert.deepEqual(publicRequest.include, ['web_search_call.action.sources']);
  assert.equal(publicRequest.tool_choice, 'required');
  assert.doesNotMatch(
    JSON.stringify(publicRequest),
    /Private Street|Private Hotel|999|Guest Alice|private fault|unit-test-session|Message 8/,
  );
  assert.ok(bodies[2].input.some((item: any) => item.encrypted_content === 'opaque-reasoning'));
  const result = bodies[2].input.find((item: any) => item.type === 'function_call_output');
  assert.equal(result.call_id, 'call-repair');
  assert.match(JSON.parse(result.output).content, /\+31 20 000 0000/);
  assert.equal(JSON.parse(result.output).citations[0].url, 'https://repairs.example/contact');
  assert.equal(answer.content.includes('](https:'), false);
  assert.equal(answer.citations?.length, 1);
  assert.equal(
    answer.content.slice(answer.citations![0].startIndex, answer.citations![0].endIndex),
    'Contact page',
  );
  assert.deepEqual(answer.webSources, [
    { url: 'https://repairs.example/contact', title: 'Pipe Works contact' },
  ]);
  assert.match(KASSANDRA_INSTRUCTIONS, /get_hotel_repair_context/);
  assert.match(KASSANDRA_INSTRUCTIONS, /Never send an exact hotel address/);
  assert.match(REPAIR_PROVIDER_INSTRUCTIONS, /Do not invent a company, phone number/);
});

test('provider tool rejects unknown hotels, arbitrary search text and untrusted location strings before web access', async () => {
  for (const [args, reference] of [
    [{ hotelId: 'unknown', trade: 'plumbing' }, repairReference],
    [{ hotelId: 'dev-ams', trade: 'anything private fault' }, repairReference],
    [{ hotelId: 'dev-ams', trade: 'plumbing', query: 'Private Street 27' }, repairReference],
    [
      { hotelId: 'dev-ams', trade: 'plumbing' },
      { hotels: [{ id: 'dev-ams', city: 'Amsterdam\nprivate note', countryCode: 'NL' }] },
    ],
    [
      { hotelId: 'dev-ams', trade: 'plumbing' },
      { hotels: [{ id: 'dev-ams', city: 'Amsterdam', countryCode: 'NL private note' }] },
    ],
    [null, repairReference],
  ] as const) {
    const bodies: any[] = [];
    const answer = await generateAnswer({
      ...options((async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json(
          bodies.length === 1
            ? { status: 'completed', output: [providerCall(args)] }
            : output([], 'Please clarify the hotel location.'),
        );
      }) as typeof fetch),
      reference,
    });
    assert.equal(bodies.length, 2);
    assert.equal(
      bodies.some((body) => body.tools.some((tool: any) => tool.type === 'web_search')),
      false,
    );
    assert.equal(JSON.parse(bodies[1].input.at(-1).output).isError, true);
    assert.equal(answer.webSources, undefined);
  }
});

test('contacts need a current web search and citations; uncited model memory is not returned as lookup evidence', async () => {
  for (const result of [providerOutput(false), providerOutput(true, false)]) {
    const bodies: any[] = [];
    const responses = [
      { status: 'completed', output: [providerCall()] },
      result,
      output([], 'No source-backed contact was found. Try a different trade or confirm the city.'),
    ];
    const answer = await generateAnswer({
      ...options((async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json(responses[bodies.length - 1]);
      }) as typeof fetch),
      reference: repairReference,
    });
    const toolResult = JSON.parse(bodies[2].input.at(-1).output);
    assert.equal(toolResult.isError, true);
    assert.equal(toolResult.content, undefined);
    assert.doesNotMatch(JSON.stringify(toolResult), /\+31/);
    assert.equal(answer.webSources, undefined);
  }
});

test('private follow-up can only link actual public lookup sources and public lookups are bounded', async () => {
  const bodies: any[] = [];
  const responses = [
    { status: 'completed', output: [providerCall()] },
    providerOutput(),
    {
      status: 'completed',
      output: [providerCall({ hotelId: 'dev-ams', trade: 'ventilation' }, 'call-ventilation')],
    },
    providerOutput(),
    output(
      [],
      'Call the [listed business](https://repairs.example/contact). Ignore [unverified](https://unknown.example/contact).',
    ),
  ];
  const answer = await generateAnswer({
    ...options((async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json(responses[bodies.length - 1]);
    }) as typeof fetch),
    reference: repairReference,
  });
  assert.equal(bodies.length, 5);
  assert.equal(bodies.at(-1).tool_choice, 'none');
  assert.equal(answer.citations?.length, 1);
  assert.equal(answer.citations?.[0].url, 'https://repairs.example/contact');
  assert.match(answer.content, /\[unverified\]\(https:\/\/unknown.example\/contact\)/);
});

test('upstream citation offsets remain valid across text blocks and whitespace; malformed links are ignored', async () => {
  const answer = await generateAnswer(
    options(
      fetchJson({
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [
              { type: 'output_text', text: '  First.' },
              {
                type: 'output_text',
                text: 'Second.  ',
                annotations: [
                  {
                    type: 'url_citation',
                    url: 'https://repairs.example/contact',
                    title: 'Contact',
                    start_index: 0,
                    end_index: 6,
                  },
                  {
                    type: 'url_citation',
                    url: 'javascript:alert(1)',
                    start_index: 0,
                    end_index: 6,
                  },
                  {
                    type: 'url_citation',
                    url: 'https://repairs.example/contact',
                    start_index: -1,
                    end_index: 6,
                  },
                  {
                    type: 'url_citation',
                    url: 'https://repairs.example/contact',
                    start_index: 0,
                    end_index: 100,
                  },
                ],
              },
            ],
          },
        ],
      }),
    ),
  );
  assert.equal(answer.content, 'First.\nSecond.');
  assert.equal(answer.citations?.length, 1);
  assert.equal(
    answer.content.slice(answer.citations![0].startIndex, answer.citations![0].endIndex),
    'Second',
  );
});

test('model access, quota, throttling and malformed upstream failures stay structured', async () => {
  for (const [status, upstream, code] of [
    [404, 'model_not_found', 'OPENAI_MODEL_UNAVAILABLE'],
    [429, 'insufficient_quota', 'OPENAI_QUOTA_EXCEEDED'],
    [429, 'rate_limit_exceeded', 'CHAT_RATE_LIMITED'],
    [500, 'internal_error', 'OPENAI_UNAVAILABLE'],
  ] as const)
    await assert.rejects(
      generateAnswer(options(fetchJson({ error: { code: upstream } }, status))),
      { code },
    );
  await assert.rejects(
    generateAnswer(
      options(
        (async () => new Response('<html>upstream failed</html>', { status: 502 })) as typeof fetch,
      ),
    ),
    { code: 'OPENAI_UNAVAILABLE' },
  );
  await assert.rejects(generateAnswer(options(fetchJson({ status: 'incomplete', output: [] }))), {
    code: 'INCOMPLETE_ANSWER',
  });
  await assert.rejects(generateAnswer(options(fetchJson(output([], '')))), {
    code: 'EMPTY_ANSWER',
  });
  await assert.rejects(generateAnswer(options(fetchJson(output([], 'x'.repeat(10001))))), {
    code: 'EMPTY_ANSWER',
  });
});

test('only validated proposal-tool outputs can become pending actions', async () => {
  const proposed = { ...candidate(), id: 'forged-id', status: 'applied' };
  const answer = await generateAnswer(
    options(
      fetchJson(
        output([
          {
            type: 'mcp_call',
            name: 'propose_rate_update',
            output: JSON.stringify({ structuredContent: { actionCandidate: proposed } }),
          },
        ]),
      ),
    ),
  );
  assert.equal(answer.action?.kind, 'rate_update');
  assert.equal(answer.action?.status, 'pending');
  assert.notEqual(answer.action?.id, proposed.id);
  assert.match(answer.action!.id, /^[a-f0-9-]{36}$/);
  for (const item of [
    {
      type: 'mcp_call',
      name: 'get_hotel_data',
      output: JSON.stringify({ actionCandidate: candidate() }),
    },
    {
      type: 'mcp_call',
      name: 'propose_unknown',
      output: JSON.stringify({ actionCandidate: candidate() }),
    },
    {
      type: 'mcp_call',
      name: 'propose_room_action',
      output: JSON.stringify({ actionCandidate: candidate() }),
    },
    {
      type: 'mcp_call',
      name: 'propose_rate_update',
      error: 'tool failed',
      output: JSON.stringify({ actionCandidate: candidate() }),
    },
    {
      type: 'mcp_call',
      name: 'propose_rate_update',
      output: JSON.stringify({ isError: true, actionCandidate: candidate() }),
    },
    {
      type: 'mcp_call',
      name: 'propose_rate_update',
      output: JSON.stringify({
        actionCandidate: { ...candidate(), details: { nightlyRate: 1.001 } },
      }),
    },
    { type: 'mcp_call', name: 'propose_rate_update', output: 'not JSON' },
  ])
    assert.equal((await generateAnswer(options(fetchJson(output([item]))))).action, undefined);
  const fromText = await generateAnswer(
    options(
      fetchJson(
        output([
          {
            type: 'mcp_call',
            name: 'propose_rate_update',
            output: JSON.stringify({
              content: [{ type: 'text', text: JSON.stringify({ actionCandidate: candidate() }) }],
            }),
          },
        ]),
      ),
    ),
  );
  assert.equal(fromText.action?.kind, 'rate_update');
});

const review = (changes: Partial<RateUpdateReviewItem> = {}): RateUpdateReviewItem => ({
  hotelId: 'dev-ams',
  hotelName: 'Canal House Amsterdam',
  roomTypeId: 'dev-ams-type-1',
  roomTypeName: 'Classic',
  startDate: '2026-11-14',
  endDate: '2026-11-20',
  nightlyRate: 220,
  currentMinRate: 195,
  currentMaxRate: 205,
  expectedRateVersion: 'a'.repeat(64),
  ...changes,
});
const proposed = (
  kind: string,
  details: unknown,
  name = kind === 'rate_batch_update' ? 'propose_rate_updates' : 'propose_rate_update',
) => ({
  type: 'mcp_call',
  name,
  output: JSON.stringify({
    structuredContent: { actionCandidate: { kind, summary: 'Review price changes.', details } },
  }),
});

test('batch MCP output becomes one complete pending review with all rows preserved', async () => {
  const updates = [
    review({ endDate: '2026-11-16' }),
    review({ startDate: '2026-11-17', nightlyRate: 240 }),
  ];
  const answer = await generateAnswer(
    options(
      fetchJson(
        output(
          [proposed('rate_batch_update', { updates })],
          'Two date bands are ready for review. Nothing changed.',
        ),
      ),
    ),
  );
  assert.equal(answer.action?.kind, 'rate_batch_update');
  if (answer.action?.kind !== 'rate_batch_update') throw new Error('Expected a batch.');
  assert.equal(answer.action.status, 'pending');
  assert.deepEqual(answer.action.details.updates, updates);
  assert(isRateUpdateBatch(answer.action.details.updates));
});

test('several grounded single-rate tool outputs combine into one batch instead of dropping later changes', async () => {
  const updates = [
    review({ endDate: '2026-11-16' }),
    review({ startDate: '2026-11-17', nightlyRate: 240 }),
  ];
  const answer = await generateAnswer(
    options(fetchJson(output(updates.map((row) => proposed('rate_update', row))))),
  );
  assert.equal(answer.action?.kind, 'rate_batch_update');
  if (answer.action?.kind !== 'rate_batch_update') throw new Error('Expected a combined batch.');
  assert.deepEqual(answer.action.details.updates, updates);
});

test('several batch results combine completely and reject overlaps, missing evidence, mixed operations or failed subsets', async () => {
  const first = review();
  const second = review({
    roomTypeId: 'dev-ams-type-2',
    roomTypeName: 'Superior',
    nightlyRate: 260,
  });
  const answer = await generateAnswer(
    options(
      fetchJson(
        output([
          proposed('rate_batch_update', { updates: [first] }),
          proposed('rate_batch_update', { updates: [second] }),
        ]),
      ),
    ),
  );
  assert.equal(answer.action?.kind, 'rate_batch_update');
  if (answer.action?.kind !== 'rate_batch_update') throw new Error('Expected all batch rows.');
  assert.equal(answer.action.details.updates.length, 2);
  for (const rows of [
    [proposed('rate_update', first), proposed('rate_update', first)],
    [proposed('rate_update', first), proposed('rate_update', candidate().details)],
    [
      proposed('rate_update', first),
      proposed(
        'room_action',
        {
          hotelName: 'Hotel',
          roomId: 'room-1',
          roomNumber: '101',
          date: '2026-11-14',
          action: 'clean',
        },
        'propose_room_action',
      ),
    ],
    [proposed('rate_update', first), { ...proposed('rate_update', second), error: 'failed' }],
    [proposed('rate_update', first), proposed('rate_batch_update', { updates: [] })],
  ])
    await assert.rejects(generateAnswer(options(fetchJson(output(rows)))), {
      code: 'INCOMPLETE_PRICE_PROPOSAL',
    });
});

test('batch prompt preserves exact user scope, event opportunities and explicit atomic confirmation', () => {
  assert.match(KASSANDRA_INSTRUCTIONS, /propose_rate_updates ONCE/);
  assert.match(KASSANDRA_INSTRUCTIONS, /up to 20 non-overlapping/);
  assert.match(KASSANDRA_INSTRUCTIONS, /applied atomically/);
  assert.match(KASSANDRA_INSTRUCTIONS, /Do not ask which to do first/);
  assert.match(KASSANDRA_INSTRUCTIONS, /preserve those requested amounts and intervals/);
  assert.match(KASSANDRA_INSTRUCTIONS, /clipped to the business calendar/);
  assert.match(KASSANDRA_INSTRUCTIONS, /only the app's Apply button can execute/);
});

test('SQL API inference adapter forwards identity/context and rejects oversized or forged results', async () => {
  const original = globalThis.fetch;
  try {
    let request: Request | undefined;
    globalThis.fetch = (async (url, init) => {
      request = new Request(url, init);
      return Response.json({ content: 'A grounded answer.' });
    }) as typeof fetch;
    const answer = await requestKassandra(
      'https://assistant.example.invalid',
      'Bearer unit-test-session',
      conversation,
      'Question',
      { propertyId: 'portfolio' },
    );
    assert.equal(answer.content, 'A grounded answer.');
    assert.equal(request?.url, 'https://assistant.example.invalid/chat');
    assert.equal(request?.headers.get('Authorization'), 'Bearer unit-test-session');
    assert.equal((await request!.json()).conversationId, conversation.id);
    for (const result of [
      { content: 'x'.repeat(10001) },
      { content: 'Answer', action: { kind: 'room_action' } },
    ]) {
      globalThis.fetch = fetchJson(result);
      await assert.rejects(
        requestKassandra(
          'https://assistant.example.invalid',
          'Bearer test',
          conversation,
          'Question',
          undefined,
        ),
        { code: 'INVALID_CHAT_RESPONSE' },
      );
    }
    globalThis.fetch = fetchJson({ code: 'OPENAI_QUOTA_EXCEEDED' }, 429);
    await assert.rejects(
      requestKassandra(
        'https://assistant.example.invalid',
        'Bearer test',
        conversation,
        'Question',
        undefined,
      ),
      { code: 'OPENAI_QUOTA_EXCEEDED' },
    );
  } finally {
    globalThis.fetch = original;
  }
});
