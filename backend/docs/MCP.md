# Kassandra MCP

Kassandra uses a separate, thin Cloudflare Worker (`juyo-kassandra`) for OpenAI
Responses and MCP. The SQL-backed `juyo-api` remains the source of facts,
authorization and durable changes. Neither the MCP module nor Angular receives
SQL credentials. The separate frontend is authorized on Cloudflare Pages Free at `https://juyo-demo.pages.dev`, with local development retained.

Verified public MCP URL: `https://mcp-juyo.cristiansarghe.com/mcp`.
`JUYO_API_URL` points to `https://api-juyo.cristiansarghe.com/api/v1`.
The custom MCP domain and authenticated data path are live; Angular continues to use the HTTP API by default in local development and on the authorized Pages frontend.

## Access and protocol

Every MCP HTTP request requires the current user's opaque API bearer session,
including `initialize` and `tools/list`. The Worker validates it against the API
and binds all reads to that identity. Demo-account authentication and workspace
permissions are unchanged. Do not publish bearer values or put them in URLs.

The endpoint implements stateless Streamable HTTP: one JSON-RPC message per
`POST`, JSON responses, notifications acknowledged with empty HTTP 202, no MCP
session ID or SSE. The thin MCP Worker needs no Durable Object; the backing SQL API delegates its SQL/TLS compute to the Free `JuyoSqlGateway` object. `GET`/`DELETE` return 405. Supported
protocols: `2025-03-26`, `2025-06-18`, `2025-11-25`. Requests are limited to 32 KiB;
tool results and pagination are bounded. Browser origins use the explicit
local allowlist plus exactly `https://juyo-demo.pages.dev`; Pages preview origins
and wildcards are not allowed. Requests without an Origin still require authentication.

All tools are read-only. Proposal tools return a candidate, never execute it.
The API stages the candidate on an assistant message; the user reviews the exact
change and confirms it through a separate authenticated action endpoint. The
SQL repository revalidates room availability and rate inputs when applying. Batch prices also recheck every dated selling-quote fingerprint and commit all reviewed rows plus the decision in one transaction. A stale quote rejects the entire batch.
The model has no arbitrary SQL, arbitrary URL fetch or direct mutation tool.

## Tools and REST bindings

| Tool                       | Purpose                                                                                    | Existing API reads                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `get_workspace_context`    | Hotel IDs/coordinates, calendar, business date, currency, provenance                       | `/reference-data`                                                                                         |
| `get_hotel_analytics`      | Interval totals, occupancy, targets, ADR/RevPAR, daily pace, booking sources               | `/analytics/dashboard`                                                                                    |
| `get_hotel_data`           | One normalized resource with filters and pagination                                        | Fixed collection paths below                                                                              |
| `get_room_inventory`       | Dated physical inventory merged with operational changes; availability/housekeeping counts | `/reference-data`, `/rooms`, `/room-states`, `/room-state-changes`                                        |
| `get_booked_price_history` | Accepted booking-price buckets and weighted average by stay date                           | `/room-types/{id}/price-history`                                                                          |
| `get_warnings`             | Scoped dated warnings with hotel/room detail                                               | `/warnings`                                                                                               |
| `get_upcoming_events`      | Ordered events, coordinates, per-hotel relevance/distance                                  | `/events/upcoming`                                                                                        |
| `get_data_dictionary`      | Entity fields, relationships, enums and descriptions                                       | `/schema` (duplicate machine schema omitted from tool result)                                             |
| `recommend_room_price`     | Explainable daily selling-rate suggestions and comparison evidence                         | Reference, room types, effective room rates, accepted-price history, dashboard, events, event assessments |
| `propose_rate_updates`     | One batch of 1–20 grounded hotel/type/date changes, current rate ranges and version fingerprints | Reference, room types, effective rates; optional relevant events |
| `propose_rate_update`      | Exact hotel/type/date/rate candidate for review                                            | Reference, room types, effective rates; optional relevant event                                           |
| `propose_room_action`      | One current-day housekeeping/availability candidate                                        | Reference, `/rooms/{id}/state`                                                                            |

`get_hotel_data.resource` is an enum, not a URL. It covers hotels, room types,
selling rates, rooms, room states, reservations, reservation nights, daily
performance, booking positions, daily/monthly channels, daily/monthly costs,
unit costs, facilities, daily facility activity, restaurants, events,
hotel-event impacts and reporting periods. Fixed paths are declared in
`src/mcp/tools.ts`. Pages default to 50 and cannot exceed 100. Results retain
`total`, `page` and `pageSize`; retrieve every page before claiming a complete
aggregate. Invalid resource/filter combinations are rejected.

Omit `hotelId` for portfolio scope where supported. `from`/`to` are inclusive
ISO stay dates. Reservations overlap the stay interval; one multi-night
reservation counts once in the booking-sources summary. Today means the API's
business date. Past revenue is actual; today/future revenue is on the books,
not forecast revenue. Manual holds reduce availability but are not bookings.

Accepted price history uses immutable room-night revenue divided by accepted
room nights. Effective selling quotes include confirmed rate updates and do not
rewrite existing reservations. Operational inventory reuses the API's canonical
room-overlay calculation. Incomplete inventory/rate/event context returns a
tool error instead of inventing missing values or asserting partial totals.

## Price suggestion method

Version 1 deliberately uses a transparent rule, not an unexplained forecast:

- Hotel booked occupancy at least 90%: +10%; at least 75%: +5%; below 45%: -5%.
- A stored hotel-relevant important event on that date: +5%; medium: +2.5%.
- Combined increase capped at 15%; applied to each day's effective selling quote.
- Accepted booking-weighted prices are returned for comparison, not used as an
  elasticity model. Stored event assessments include importance, distance,
  reason and provenance.

Each result includes current/suggested rates, date, occupancy evidence, relevant
event IDs, the rule and limitations. No competitor rates, booking elasticity or
verified live demand feed exists. A suggestion changes nothing and guarantees
no revenue uplift. Historical dates are analysis; editing their asking quotes
cannot change settled revenue.

## Example protocol messages

Send these as JSON bodies to the MCP URL with `Authorization: Bearer` supplied
from a valid session, `Content-Type: application/json` and
`Accept: application/json, text/event-stream`.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "clientInfo": { "name": "juyo-client", "version": "1.0.0" },
    "capabilities": {}
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": { "name": "get_workspace_context", "arguments": {} }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "get_hotel_analytics",
    "arguments": { "hotelId": "dev-ams", "from": "2026-11-14", "to": "2026-11-20" }
  }
}
```

Discover valid hotel/type IDs before recommending or proposing a change.
Unknown dates, IDs, truncated upstream data and upstream failures produce tool
errors. The assistant must disclose those failures, not answer from guesses.

## Run, deploy and remove

The standard Cloudflare Worker Free platform is sufficient for the thin Fetch
adapter; no paid Cloudflare features are configured. OpenAI API usage is billed
separately by OpenAI. Keep `OPENAI_API_KEY` in a Worker secret, never Angular,
Wrangler vars, committed files or logs. Preserve the requested model ID and use
the supported reasoning setting; do not silently substitute another model.

From `backend`, run `npm run typecheck` and `npm test`. The focused MCP tests run
with `npx tsx --test tests/mcp.test.ts`. For actual local workerd against the
existing remote REST and SQL, run `npm run bundle:kassandra` followed by
`npm run test:mcp`. This uses the backend demo-account catalog, signs out in
`finally`, makes no OpenAI calls or domain changes, and records only non-secret
checks in the ignored `.local/mcp-smoke.json` report. It catches workerd Fetch
differences such as unsupported `redirect: 'error'`; adapters use `manual` and
reject non-success responses. It does not emulate Cloudflare's Free CPU budget.
To verify the public MCP endpoint instead, set `SMOKE_MCP_URL=https://mcp-juyo.cristiansarghe.com/mcp` when running `npm run test:mcp`. `SMOKE_MCP_REPORT` can select another ignored report path; reports never include bearer tokens.

The separate Worker configuration selects
`src/kassandra-worker.ts`; use its config for a Wrangler dry run, local preview
or deployment. The normal `wrangler.jsonc` deploys `juyo-api` together with its compute gateway class, binding and namespace migration.
When using the Cloudflare website, upload only the built thin Worker bundle,
set `JUYO_API_URL` and the aligned explicit local/production origin allowlist, add the secret, then verify its
authenticated initialization, tools, chat and explicit action flow.

SQL TLS/driver work remains in `juyo-api`, behind its `SQL_GATEWAY` compute binding. The deployed `JuyoSqlGateway` class uses the Free Durable Object CPU budget instead of the edge Worker's measured 10 ms failure. Its namespace has Cloudflare's required SQLite backend, but the class never accesses `ctx.storage`, SQLite, KV or any storage API. All hotel, session, conversation and audit records remain solely in the existing SQL Server. No D1 or paid Cloudflare feature is configured. Free quotas still apply; keep tool reads bounded and verify against the deployed service.

Verification on 14 November 2026: the actual SQL-backed workerd smoke passed 47 gateway checks, and public API/MCP authentication and data requests returned 200. Real OpenAI data answers, grounded price recommendations and an exact pending rate proposal returned 201 through the API conversation endpoint. The pending proposal changed no rate. Verify inference and explicit confirmation after deployment changes.

To remove the integration, remove the separate Worker/domain and its OpenAI
secret, remove `KASSANDRA_URL` so HTTP chat reports not configured, and remove `src/mcp` plus its tests. Do not silently replace HTTP data or real chat with fixtures. No hotel
facts, API sessions or canonical database tables depend on the MCP protocol.
API-owned conversation/action records remain independently managed by the API.

The SQL gateway is independently removable, but its provisioned namespace is deployment state. Preserve its class/binding during normal API updates. Removing or renaming it requires the matching versioned Cloudflare class migration; deleting its class requires a new `deleted_classes` migration, not just removing the JavaScript export. The direct edge SQL fallback remains available for local/transition use and retains the measured Free CPU constraint. See [backend runtime and removal](../README.md#worker-runtime).
