import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MCP_TOOLS, callMcpTool, type McpDependencies } from '../src/mcp/tools.js';
import { handleMcp } from '../src/mcp/server.js';
import type { HotelNetwork } from '../src/domain/network.models.js';
import { RESOURCE_PATHS } from '../src/domain/resource-paths.js';
import { createNetworkSelectors, reportingDatesFor } from '../src/domain/network.selectors.js';
import { resourceRows, page } from '../src/rest-data.js';
import { createBookingRateHistory } from '../src/domain/room-price-history.js';
import { buildNetworkSchema } from '../src/domain/network.schema.js';
import {
  isRateUpdateBatch,
  rateVersion,
  type RateUpdateReviewItem,
} from '../src/domain/rate-batch.js';

const data = JSON.parse(
  readFileSync(new URL('../../public/data/hotel-network.json', import.meta.url), 'utf8'),
) as HotelNetwork;
const selectors = createNetworkSelectors(data);
const readCalls: string[] = [];
const deps: McpDependencies = {
  allowedOrigins: new Set(['http://127.0.0.1:4200']),
  async read(path, params = new URLSearchParams()) {
    readCalls.push(path);
    if (path === '/reference-data')
      return {
        meta: data.meta,
        bookingSnapshot: data.bookingSnapshot,
        hotels: data.hotels,
        reportingPeriods: data.reportingPeriods,
        dates: reportingDatesFor(data.meta.reportingPeriod),
      };
    if (path === '/room-state-changes') return [];
    if (path === '/schema') return buildNetworkSchema(data);
    if (path === '/analytics/dashboard') {
      const scope = params.get('hotelId') ?? 'portfolio';
      const range = { startDate: params.get('from')!, endDate: params.get('to')! };
      return {
        outlook: selectors.bookingOutlook(scope, range),
        days: selectors.bookingPace(scope, range),
        chartContext: selectors.bookingChartContext(scope, range),
        bookingSources: selectors.bookingSources(scope, range),
      };
    }
    const history = path.match(/^\/room-types\/([^/]+)\/price-history$/);
    if (history) {
      const type = data.roomTypes.find((row) => row.id === decodeURIComponent(history[1]))!;
      return createBookingRateHistory(data)(type.hotelId, type.id).filter(
        (row) => row.date >= params.get('from')! && row.date <= params.get('to')!,
      );
    }
    const state = path.match(/^\/rooms\/([^/]+)\/state$/);
    if (state) {
      const room = data.rooms.find((row) => row.id === decodeURIComponent(state[1]))!;
      return { ...room, status: room.occupancy };
    }
    const resource = Object.entries(RESOURCE_PATHS).find(([, value]) => path === value)?.[0];
    if (!resource) throw new Error('Test adapter route not implemented.');
    return page(resourceRows(data, resource as keyof typeof RESOURCE_PATHS, params), params);
  },
};

const post = (payload: unknown, extra: Record<string, string> = {}) =>
  new Request('https://example.invalid/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...extra,
    },
    body: JSON.stringify(payload),
  });

test('stateless MCP negotiates, lists bounded tools and accepts notifications', async () => {
  const init = await handleMcp(
    post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', clientInfo: { name: 'test', version: '1' } },
    }),
    deps,
  );
  const initialized = (await init.json()) as { result: { protocolVersion: string } };
  assert.equal(initialized.result.protocolVersion, '2025-06-18');
  const listed = await handleMcp(post({ jsonrpc: '2.0', id: 'list', method: 'tools/list' }), deps);
  const toolList = (await listed.json()) as { result: { tools: { name: string }[] } };
  assert.equal(toolList.result.tools.length, 13);
  assert.equal(new Set(toolList.result.tools.map((tool) => tool.name)).size, 13);
  assert.equal(
    (await handleMcp(post({ jsonrpc: '2.0', method: 'notifications/initialized' }), deps)).status,
    202,
  );
  assert.equal((await handleMcp(new Request('https://example.invalid/mcp'), deps)).status, 405);
  assert.equal(
    (
      await handleMcp(
        post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'https://untrusted.invalid' }),
        deps,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await handleMcp(
        post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'MCP-Protocol-Version': '2099-01-01' }),
        deps,
      )
    ).status,
    400,
  );
});

test('MCP rejects malformed requests and unknown methods without executing tools', async () => {
  assert.equal(
    (await handleMcp(post([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]), deps)).status,
    400,
  );
  const unknown = await handleMcp(
    post({ jsonrpc: '2.0', id: 2, method: 'sql/query', params: { sql: 'anything' } }),
    deps,
  );
  assert.equal(((await unknown.json()) as { error: { code: number } }).error.code, -32601);
  const before = readCalls.length;
  await handleMcp(
    post({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'get_workspace_context' } }),
    deps,
  );
  assert.equal(readCalls.length, before, 'Notifications cannot execute tools.');
});

test('tool schemas prevent arbitrary paths, excessive pages and invalid dates', async () => {
  for (const [name, args] of [
    ['get_hotel_data', { resource: 'https://untrusted.invalid/secrets' }],
    ['get_hotel_data', { resource: 'rooms', pageSize: 1000 }],
    ['get_hotel_data', { resource: 'rooms', sql: 'arbitrary' }],
    ['get_hotel_analytics', { from: '2026-11-31', to: '2026-12-01' }],
    ['get_hotel_analytics', { from: '2026-11-20', to: '2026-11-01' }],
  ] as const) {
    const before = readCalls.length;
    assert.equal((await callMcpTool(name, args, deps)).isError, true);
    assert.equal(readCalls.length, before);
  }
  for (const tool of MCP_TOOLS) assert.equal(tool.annotations.readOnlyHint, true);
});

test('analytics preserves stay-date calculations and excludes enclosing-month chart context', async () => {
  const hotel = data.hotels[0];
  const range = { startDate: '2026-11-11', endDate: '2026-11-22' };
  const response = await callMcpTool(
    'get_hotel_analytics',
    { hotelId: hotel.id, from: range.startDate, to: range.endDate },
    deps,
  );
  assert.equal(response.isError, undefined);
  const value = response.structuredContent!.data as {
    outlook: unknown;
    days: unknown[];
    chartContext?: unknown;
  };
  assert.deepEqual(value.outlook, selectors.bookingOutlook(hotel.id, range));
  assert.equal(value.days.length, 12);
  assert.equal(value.chartContext, undefined);
});

test('inventory totals reconcile physical and sellable rooms', async () => {
  const response = await callMcpTool('get_room_inventory', { hotelId: data.hotels[0].id }, deps);
  assert.equal(response.isError, undefined);
  const value = response.structuredContent!.data as {
    rooms: unknown[];
    counts: Record<string, number>;
  };
  assert.equal(value.counts.physical, value.rooms.length);
  assert.equal(
    value.counts.available + value.counts.booked + value.counts.held,
    value.counts.sellable,
  );
  assert.equal(value.counts.sellable + value.counts.outOfService, value.counts.physical);
});

test('inventory reuses canonical operational overlays and refuses truncated counts', async () => {
  const date = data.bookingSnapshot.asOf;
  const room = data.rooms.find((row) =>
    data.dailyRoomStates.some(
      (state) =>
        state.roomId === row.id && state.date === date && state.occupancy === 'out_of_service',
    ),
  )!;
  assert(room);
  const reader: McpDependencies = {
    read: async (path, params) =>
      path === '/room-state-changes'
        ? [{ roomId: room.id, date, status: 'available', appliedAt: '2026-11-14T10:00:00Z' }]
        : deps.read(path, params),
  };
  const response = await callMcpTool('get_room_inventory', { hotelId: room.hotelId }, reader);
  assert.equal(response.isError, undefined);
  const changed = (
    response.structuredContent!.data as {
      rooms: {
        id: string;
        status: string;
        occupancy: string;
        maintenance: string;
        maintenanceNote: string | null;
      }[];
    }
  ).rooms.find((value) => value.id === room.id)!;
  assert.equal(changed.status, 'available');
  assert.equal(changed.occupancy, 'available');
  assert.equal(changed.maintenance, 'none');
  assert.equal(changed.maintenanceNote, null);
  const truncated = await callMcpTool(
    'get_room_inventory',
    {},
    {
      read: async (path, params) =>
        path === '/rooms'
          ? { items: [], total: 101, page: 1, pageSize: 100 }
          : deps.read(path, params),
    },
  );
  assert.equal(truncated.isError, true);
});

interface RepairContextResult {
  asOf: string;
  hotel: {
    id: string;
    city: string;
    coordinates: { latitude: number; longitude: number };
    address: { line1: string; line2?: string; postalCode: string } | null;
    addressStatus: string;
    addressSource: string;
  };
  issues: {
    roomId: string;
    maintenanceNote: string | null;
    needsProblemDescription: boolean;
  }[];
  roomScope: { roomId: string; status: string } | null;
  counts: { hotelOutOfServiceRooms: number; scopedTechnicalIssues: number };
  facilities: { id: string; kind: string; name: string }[];
  publicSearchLocation: Record<string, unknown>;
  missingInformation: string[];
  limitations: string[];
}

test('repair context uses configured location, current room facts and explicit missing details', async () => {
  const date = data.bookingSnapshot.asOf;
  const state = data.dailyRoomStates.find(
    (row) => row.date === date && row.occupancy === 'out_of_service',
  )!;
  const hotel = data.hotels.find((row) => row.id === state.hotelId)!;
  const response = await callMcpTool(
    'get_hotel_repair_context',
    { hotelId: hotel.id },
    {
      read: async (path, params) => {
        const value = await deps.read(path, params);
        return path === '/reference-data'
          ? { ...(value as object), hotels: data.hotels.map((row) => ({ ...row, address: null })) }
          : value;
      },
    },
  );
  assert.equal(response.isError, undefined);
  const value = response.structuredContent!.data as RepairContextResult;
  assert.equal(value.asOf, date);
  assert.equal(value.hotel.id, hotel.id);
  assert.equal(value.hotel.city, hotel.city);
  assert.deepEqual(value.hotel.coordinates, hotel.coordinates);
  assert.equal(value.hotel.address, null);
  assert.equal(value.hotel.addressStatus, 'missing');
  assert.equal(value.hotel.addressSource, 'missing');
  assert(value.missingInformation.some((message) => message.includes('address')));
  assert.deepEqual(
    value.issues.map((row) => row.roomId),
    [state.roomId],
  );
  assert.equal(value.issues[0].maintenanceNote, state.maintenanceNote);
  assert.equal(value.issues[0].needsProblemDescription, false);
  assert.equal(value.counts.scopedTechnicalIssues, 1);
  assert.deepEqual(
    value.facilities,
    data.facilities
      .filter((row) => row.hotelId === hotel.id)
      .map(({ id, kind, name }) => ({ id, kind, name })),
  );
  assert.equal(value.publicSearchLocation['address'], undefined);
  assert.equal(value.publicSearchLocation['maintenanceNote'], undefined);
  assert(value.limitations.some((message) => message.includes('omit exact hotel addresses')));
});

test('repair context distinguishes a configured address from independent verification', async () => {
  const hotel = data.hotels[0];
  const address = {
    line1: '  Configured street 12  ',
    line2: '  Front desk  ',
    postalCode: '  1000  ',
  };
  const response = await callMcpTool(
    'get_hotel_repair_context',
    { hotelId: hotel.id },
    {
      read: async (path, params) => {
        const value = await deps.read(path, params);
        return path === '/reference-data'
          ? { ...(value as object), hotels: data.hotels.map((row) => ({ ...row, address })) }
          : value;
      },
    },
  );
  assert.equal(response.isError, undefined);
  const value = response.structuredContent!.data as RepairContextResult;
  assert.deepEqual(value.hotel.address, {
    line1: 'Configured street 12',
    line2: 'Front desk',
    postalCode: '1000',
  });
  assert.equal(value.hotel.addressStatus, 'available');
  assert.equal(value.hotel.addressSource, 'configured');
  assert(value.limitations.some((message) => message.includes('not independently verified')));
  assert(!value.missingInformation.some((message) => message.includes('address')));
});

test('repair context respects operational repairs and never infers an unspecified technical fault', async () => {
  const date = data.bookingSnapshot.asOf;
  const state = data.dailyRoomStates.find(
    (row) => row.date === date && row.occupancy === 'out_of_service',
  )!;
  const responseForStatus = (status: string) =>
    callMcpTool(
      'get_hotel_repair_context',
      { hotelId: state.hotelId, roomId: state.roomId },
      {
        read: async (path, params) =>
          path === '/room-state-changes'
            ? [{ roomId: state.roomId, date, status, appliedAt: '2026-11-14T10:00:00Z' }]
            : deps.read(path, params),
      },
    );
  const fixed = await responseForStatus('available');
  assert.equal(fixed.isError, undefined);
  const fixedValue = fixed.structuredContent!.data as RepairContextResult;
  assert.equal(fixedValue.roomScope?.status, 'available');
  assert.deepEqual(fixedValue.issues, []);
  assert.equal(fixedValue.counts.hotelOutOfServiceRooms, 0);
  assert(fixedValue.limitations.some((message) => message.includes('do not invent a fault')));

  const blocked = await responseForStatus('out_of_service');
  assert.equal(blocked.isError, undefined);
  const blockedValue = blocked.structuredContent!.data as RepairContextResult;
  assert.equal(blockedValue.issues[0].maintenanceNote, 'Set out of service manually.');
  assert.equal(blockedValue.issues[0].needsProblemDescription, true);
  assert(
    blockedValue.missingInformation.some((message) =>
      message.includes('ask before choosing a repair trade'),
    ),
  );
});

test('repair context rejects cross-hotel rooms and incomplete facility facts', async () => {
  const hotel = data.hotels[0];
  const foreignRoom = data.rooms.find((room) => room.hotelId !== hotel.id)!;
  assert.equal(
    (
      await callMcpTool(
        'get_hotel_repair_context',
        {
          hotelId: hotel.id,
          roomId: foreignRoom.id,
        },
        deps,
      )
    ).isError,
    true,
  );

  const reads: string[] = [];
  const invalid = await callMcpTool(
    'get_hotel_repair_context',
    { hotelId: 'unknown-hotel' },
    {
      read: async (path, params) => {
        reads.push(path);
        return deps.read(path, params);
      },
    },
  );
  assert.equal(invalid.isError, true);
  assert.deepEqual(reads, ['/reference-data']);

  const incomplete = await callMcpTool(
    'get_hotel_repair_context',
    { hotelId: hotel.id },
    {
      read: async (path, params) =>
        path === '/facilities'
          ? { items: [], total: 101, page: 1, pageSize: 100 }
          : deps.read(path, params),
    },
  );
  assert.equal(incomplete.isError, true);
  assert(incomplete.content[0].text.includes('incomplete'));

  const missingInventory = await callMcpTool(
    'get_hotel_repair_context',
    { hotelId: hotel.id },
    {
      read: async (path, params) =>
        path === '/rooms'
          ? { items: [], total: 24, page: 1, pageSize: 100 }
          : deps.read(path, params),
    },
  );
  assert.equal(missingInventory.isError, true);
  assert(missingInventory.content[0].text.includes('incomplete'));
});

test('dictionary includes field references and enum descriptions without duplicate machine schema', async () => {
  const response = await callMcpTool('get_data_dictionary', {}, deps);
  assert.equal(response.isError, undefined);
  const dictionary = response.structuredContent!.data as Record<string, unknown>;
  assert(Array.isArray(dictionary.dataDictionary));
  assert(Array.isArray(dictionary.enumDictionary));
  assert.equal(dictionary.schema, undefined);
  const hotelDictionary = (
    dictionary.dataDictionary as {
      key: string;
      fields: { name: string; type: string; required: boolean }[];
    }[]
  ).find((entity) => entity.key === 'hotels')!;
  const address = hotelDictionary.fields.find((field) => field.name === 'address')!;
  assert.equal(address.type, 'object | null');
  assert.equal(address.required, false);
  assert(response.content[0].text.length < 80000);
});

test('price recommendations use effective quotes and explain bounded daily adjustments', async () => {
  const type = data.roomTypes[0];
  const response = await callMcpTool(
    'recommend_room_price',
    { hotelId: type.hotelId, roomTypeId: type.id, from: '2026-11-14', to: '2026-11-20' },
    deps,
  );
  assert.equal(response.isError, undefined);
  const value = response.structuredContent!.data as {
    days: { currentSellingRate: number; suggestedSellingRate: number; adjustmentPercent: number }[];
    limitations: string[];
  };
  assert.equal(value.days.length, 7);
  for (const day of value.days) {
    assert(day.adjustmentPercent >= -5 && day.adjustmentPercent <= 15);
    assert.equal(
      day.suggestedSellingRate,
      Math.round(day.currentSellingRate * (1 + day.adjustmentPercent / 100) * 100) / 100,
    );
  }
  assert(value.limitations.some((text) => text.includes('not a forecast')));
  assert.equal(
    response.structuredContent!.actionCandidate,
    undefined,
    'Recommendations never stage a mutation by themselves.',
  );
});

test('rate proposals are exact reviewable candidates and never write', async () => {
  const type = data.roomTypes[0];
  const response = await callMcpTool(
    'propose_rate_update',
    {
      hotelId: type.hotelId,
      roomTypeId: type.id,
      from: '2026-11-14',
      to: '2026-11-20',
      nightlyRate: 199.99,
      reason: 'Review November occupancy.',
    },
    deps,
  );
  assert.equal(response.isError, undefined);
  const candidate = response.structuredContent!.actionCandidate as {
    kind: string;
    details: Record<string, unknown>;
  };
  assert.equal(candidate.kind, 'rate_update');
  assert.equal(candidate.details.nightlyRate, 199.99);
  assert.equal(candidate.details.startDate, '2026-11-14');
  assert.equal(candidate.details.endDate, '2026-11-20');
  assert.equal((response.structuredContent!.data as { applied: boolean }).applied, false);
  assert.equal(
    (
      await callMcpTool(
        'propose_rate_update',
        {
          hotelId: type.hotelId,
          roomTypeId: type.id,
          from: '2026-11-14',
          to: '2026-11-20',
          nightlyRate: 199.999,
        },
        deps,
      )
    ).isError,
    true,
  );
});

test('one batch stages every hotel/type/date change with authoritative before prices and shared reads', async () => {
  const first = data.roomTypes[0];
  const other = data.roomTypes.find((row) => row.hotelId !== first.hotelId)!;
  const updates = [
    {
      hotelId: first.hotelId,
      roomTypeId: first.id,
      from: '2026-11-14',
      to: '2026-11-16',
      nightlyRate: 210,
    },
    {
      hotelId: first.hotelId,
      roomTypeId: first.id,
      from: '2026-11-17',
      to: '2026-11-20',
      nightlyRate: 225,
    },
    {
      hotelId: other.hotelId,
      roomTypeId: other.id,
      from: '2026-11-14',
      to: '2026-11-20',
      nightlyRate: 230,
    },
  ];
  const immutable = JSON.stringify(data.roomRates);
  const offset = readCalls.length;
  const response = await callMcpTool('propose_rate_updates', { updates }, deps);
  assert.equal(response.isError, undefined);
  const candidate = response.structuredContent!.actionCandidate as {
    kind: string;
    details: { updates: RateUpdateReviewItem[] };
  };
  assert.equal(candidate.kind, 'rate_batch_update');
  assert(isRateUpdateBatch(candidate.details.updates));
  assert.equal(candidate.details.updates.length, updates.length);
  assert.equal((response.structuredContent!.data as { applied: boolean }).applied, false);
  assert.equal(readCalls.slice(offset).filter((path) => path === '/reference-data').length, 1);
  assert.equal(
    readCalls.slice(offset).filter((path) => path === '/room-types').length,
    2,
    'Room types are shared per hotel within one batch, not fetched per row.',
  );
  for (const [index, row] of candidate.details.updates.entries()) {
    const requested = updates[index];
    const quotes = data.roomRates.filter(
      (rate) =>
        rate.hotelId === row.hotelId &&
        rate.roomTypeId === row.roomTypeId &&
        rate.date >= row.startDate &&
        rate.date <= row.endDate,
    );
    assert.equal(row.nightlyRate, requested.nightlyRate);
    assert.equal(row.startDate, requested.from);
    assert.equal(row.endDate, requested.to);
    assert.equal(row.currentMinRate, Math.min(...quotes.map((quote) => quote.nightlyRate)));
    assert.equal(row.currentMaxRate, Math.max(...quotes.map((quote) => quote.nightlyRate)));
    assert.equal(row.expectedRateVersion, rateVersion(quotes));
  }
  assert.equal(JSON.stringify(data.roomRates), immutable, 'Proposal tools never apply a rate.');
});

test('malformed, overlapping and oversized batches fail before reading or staging a partial proposal', async () => {
  const type = data.roomTypes[0];
  const row = {
    hotelId: type.hotelId,
    roomTypeId: type.id,
    from: '2026-11-14',
    to: '2026-11-20',
    nightlyRate: 210,
  };
  for (const updates of [
    [],
    Array.from({ length: 21 }, () => row),
    [row, { ...row, from: '2026-11-20' }],
    [row, { ...row, from: '2026-11-21', to: '2026-11-22', sql: 'anything' }],
    [{ ...row, from: '2026-11-31', to: '2026-12-01' }],
    [{ ...row, nightlyRate: 210.001 }],
  ]) {
    const offset = readCalls.length;
    const response = await callMcpTool('propose_rate_updates', { updates }, deps);
    assert.equal(response.isError, true);
    assert.equal(response.structuredContent?.actionCandidate, undefined);
    assert.equal(readCalls.length, offset, 'Argument/overlap failures do not query the hotel API.');
  }
  const wrongType = data.roomTypes.find((candidate) => candidate.hotelId !== type.hotelId)!;
  for (const invalid of [
    { ...row, roomTypeId: wrongType.id },
    { ...row, hotelId: 'missing-hotel' },
    { ...row, eventId: 'missing-event' },
  ]) {
    const response = await callMcpTool(
      'propose_rate_updates',
      { updates: [row, { ...invalid, from: '2026-11-21', to: '2026-11-22' }] },
      deps,
    );
    assert.equal(response.isError, true);
    assert.equal(
      response.structuredContent?.actionCandidate,
      undefined,
      'One invalid row must not leave a staged subset.',
    );
  }
});

test('a batch rejects missing dated selling quotes rather than inventing before prices', async () => {
  const type = data.roomTypes[0];
  const response = await callMcpTool(
    'propose_rate_updates',
    {
      updates: [
        {
          hotelId: type.hotelId,
          roomTypeId: type.id,
          from: '2026-11-14',
          to: '2026-11-20',
          nightlyRate: 220,
        },
      ],
    },
    {
      ...deps,
      read: async (path, params) =>
        path === '/room-rates'
          ? { items: [], total: 7, page: 1, pageSize: 100 }
          : deps.read(path, params),
    },
  );
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent?.actionCandidate, undefined);
});

test('room proposals reject freeing an occupied room but allow housekeeping', async () => {
  const room = data.rooms.find((row) => row.occupancy === 'occupied')!;
  assert(room);
  assert.equal(
    (await callMcpTool('propose_room_action', { roomId: room.id, action: 'available' }, deps))
      .isError,
    true,
  );
  const response = await callMcpTool(
    'propose_room_action',
    { roomId: room.id, action: 'clean' },
    deps,
  );
  assert.equal(response.isError, undefined);
  const candidate = response.structuredContent!.actionCandidate as {
    kind: string;
    details: Record<string, unknown>;
  };
  assert.equal(candidate.kind, 'room_action');
  assert.equal(candidate.details.roomId, room.id);
  assert.equal(candidate.details.date, data.bookingSnapshot.asOf);
});

test('upstream failures are bounded safe tool errors without leaking database details', async () => {
  const response = await callMcpTool(
    'get_workspace_context',
    {},
    {
      read: async () => {
        throw new Error('private database detail');
      },
    },
  );
  assert.equal(response.isError, true);
  assert(!JSON.stringify(response).includes('private database detail'));
});
