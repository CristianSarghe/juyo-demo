# Juyo API

Independent SQL-backed REST API for the Angular frontend. The configured endpoint is https://api-juyo.cristiansarghe.com/api/v1. The authorized production frontend origin is [https://juyo-demo.pages.dev](https://juyo-demo.pages.dev), on Cloudflare Pages Free; local development remains on `127.0.0.1:4200`.

The API's small edge entry delegates SQL/TLS work to a compute-only `JuyoSqlGateway` Durable Object on Cloudflare Free. The gateway uses the existing SQL Server directly. Its namespace has the SQLite backend required by Cloudflare Free, but application code never uses that storage; all hotel, user, session, chat and audit data remains in SQL Server. The backend uses no Containers, paid Cloudflare feature or D1, and does not host the frontend. The same REST handler runs locally on Node. A separate, small Kassandra Worker provides authenticated MCP tools and OpenAI Responses inference; the SQL API remains the owner of sessions, conversations and writes. Angular continues to use HTTP by default, with fixtures available only through the explicit `mock` configuration.

## Data and persistence

`SqlNetworkRepository` reconstructs the REST read model from normalized `juyo` tables/views, with no runtime fixture import. Canonical reservations, accepted nightly prices and financial history remain read-only. Reference data has a small dedicated query; collections filter and paginate in SQL. Derived reports use a decoded snapshot cached for 30 seconds. Full snapshots use small RPC batches within one consistent transaction; room/rate changes and conversations read durable state separately.

The Worker handles warnings, upcoming events and booked-price history through scoped repository reads before the full-snapshot fallback. Warnings read physical rooms and states for the requested hotel/date, then merge current room overlays. Upcoming events read only event/assessment catalogs and reference metadata. Price history reads only the selected type's reservations and nights within the inclusive interval; existing domain calculations preserve accepted-price buckets and null days. `GET /room-states` and `GET /reservation-nights` accept `roomTypeId` together with hotel/date/room filters, applying room membership before counts and pagination. These reads retain request-scoped SQL pools and bearer authentication; no private response CDN cache or Cloudflare storage is added.

Hotel DTOs include nullable `address: { line1, line2?, postalCode }`, read from the optional one-to-one `juyo.HotelAddress` table introduced by [003_hotel_addresses.sql](../database/migrations/003_hotel_addresses.sql). City/country remain normalized geography references. The user-authorized sample addresses belong to fictional properties; neither those addresses nor the illustrative coordinates are verified real hotel locations. API operations read these canonical facts without editing them.

The transactional [001_api.sql](migrations/001_api.sql) migration creates eight tables in `juyo_api`: migration history, users, sessions, room overlays, room audit, rate updates, conversations and messages. The additive [002_demo_accounts.sql](migrations/002_demo_accounts.sql) migration makes the legacy password-hash column nullable so demo identities need no database password. Migrations preserve existing account IDs, history and canonical facts; repeating an applied version skips it.

Room actions merge under a per-room transaction lock and protect occupied rooms. Rate updates retain application order and never reprice accepted bookings. Chat commits each question/answer pair atomically, retains 30 conversations and 100 messages per conversation, and predicates access on the authenticated user. All provisioned accounts currently share the hotel workspace; conversation histories are private.

Chat proposals and bounded `citations`/`webSources` use a versioned envelope in the existing `Message.InsightJson` column. Source URLs, titles and citation offsets are validated before persistence and restored with conversation history. Legacy direct Insight objects remain readable; no new chat table or migration is required. Confirming a proposal locks the user and owned conversation, revalidates the mutation, and commits its room/rate write together with the proposal's applied status. Repeating the same decision returns the current conversation without another write. An opposite decision returns a conflict. Rejected or stale room changes leave the proposal pending.

## Authentication

`POST /sessions` accepts `{ email, password, remember? }` and returns `{ user, token }`. The backend compares the supplied password directly with its hardcoded [demo account catalog](src/demo-accounts.ts); passwords are intentionally plaintext test credentials, with no password hashing or database password lookup. Invalid credentials are rejected before connecting to SQL. These accounts are for this demo application only.

| Name          | Email              | Password    |
| ------------- | ------------------ | ----------- |
| Alex Morgan   | `alex@juyo.local`  | `juyo-demo` |
| Sarah Laurent | `sarah@juyo.local` | `juyo-demo` |
| Marco Silva   | `marco@juyo.local` | `juyo-demo` |

The catalog exists only in the backend; it is not imported into Angular, API responses or exported hotel data. `npm run db:migrate` provisions the corresponding SQL identities by email while preserving existing IDs and disabled states. New demo identities store no password in SQL. Legacy account rows and hashes remain intact, but the sign-in endpoint accepts only the catalog above; the old generated owner password is no longer a sign-in credential.

Sessions remain opaque random bearer tokens. Send the token as `Authorization: Bearer …`; SQL stores its SHA-256 hash. Sessions expire after one day, or 30 days with Remember me. Logout is idempotent, including expired sessions. The browser keeps only the token in session storage, or local storage when remembered, scoped to the API base URL. Demo passwords and SQL credentials never enter that store. Conversation histories and audit ownership still use the persistent SQL user ID.

Allowed browser origins default to `http://127.0.0.1:4200`, `http://localhost:4200`, `http://127.0.0.1:4201` and `http://localhost:4201`. Both Worker configurations additionally allow exactly `https://juyo-demo.pages.dev` for the authorized Pages frontend. Keep their deployed `ALLOWED_ORIGINS` variables aligned while preserving the local origins. Pages preview domains and wildcard origins are not allowed. Requests use bearer authorization without cookies. Login has a bounded in-memory IP throttle; Worker isolates do not provide a globally shared durable rate limiter.

## Local Node runtime

Use Node 24.15 or newer and supply these environment variables through the process or secret manager:

Start from [`.env.example`](.env.example), filling values only in an ignored local `.env` or `.dev.vars` file. Node expects variables in its process environment; Wrangler reads `.dev.vars` for local Workers. Never commit the filled files. SQL hosts, database names, users, passwords, Cloudflare credentials and OpenAI keys are intentionally absent from the repository's deployment configs.

| Variable                     | Meaning                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `SQL_SERVER`, `SQL_DATABASE` | Existing SQL Server host and database.                                                    |
| `SQL_USER`, `SQL_PASSWORD`   | Server-only connection credentials.                                                       |
| `SQL_PORT`                   | Optional; defaults to 1433.                                                               |
| `SQL_TRUST_CERTIFICATE`      | Node-only compatibility option; default certificate verification remains enabled.         |
| `ALLOWED_ORIGINS`            | Optional comma-separated browser-origin allowlist.                                        |
| `KASSANDRA_URL`              | Server-side inference Worker origin; configured as `https://mcp-juyo.cristiansarghe.com`. |
| `PORT`                       | Node listener port; defaults to 8788.                                                     |

From `backend/`:

```sh
npm ci
npm run typecheck
npm run dev
```

Node binds to `127.0.0.1:8788`. `npm run build` creates the independent Node bundle; `npm start` runs it. `npm run db:migrate` applies the API-owned migrations and provisions demo identities. The canonical schema and import remain managed by [database/](../database/README.md).

## Worker runtime

[wrangler.jsonc](wrangler.jsonc) configures the custom API domain, `nodejs_compat`, public connection metadata, allowed origins, and `SQL_GATEWAY` binding. Its `v1` namespace migration declares the exported `JuyoSqlGateway` class with `new_sqlite_classes`. SQL username/password are Cloudflare secrets.

The edge handler forwards the unchanged request to `SQL_GATEWAY.getByName('juyo-network').fetch(request)`; authentication, CORS, validation and SQL transactions still run in the same REST handler. Public `/health` bypasses the gateway. The class never accesses its constructor state or any storage API. It uses Durable Objects' Free CPU budget for the SQL driver's work, which exceeded the edge Worker's 10 ms budget. This is compute placement, not a migration of application data. Cloudflare's [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/) and [Free quotas](https://developers.cloudflare.com/durable-objects/platform/pricing/) still apply.

The current deployment was created through the signed-in Cloudflare website. The live API includes the gateway class and its provisioned namespace/binding. To update its code the same way, run `npm run bundle:worker`, replace `worker.js` in the Worker editor with `dist/worker/worker.js`, and deploy while preserving `JuyoSqlGateway` and `SQL_GATEWAY`. Runtime variables and encrypted secrets live under Settings; the custom domain lives under Domains. The `workers.dev` alias and preview URLs are disabled. No Cloudflare CLI token was created or stored for this deployment. The equivalent CLI workflow, if separately authenticated, is:

```sh
npx wrangler secret put SQL_SERVER
npx wrangler secret put SQL_DATABASE
npx wrangler secret put SQL_USER
npx wrangler secret put SQL_PASSWORD
npm run bundle:worker
npm run deploy
```

Choose the authorized Cloudflare account through the CLI login or the private `CLOUDFLARE_ACCOUNT_ID` environment variable. Both configs use `keep_vars: true` to retain existing dashboard-managed variables during CLI deployment. Configure SQL connection values in Worker secrets before a new deployment; preserve the existing gateway binding and migration. Local diagnostics, verification reports and the private deployment-settings backup stay ignored and are not required to build or test the code.

The isolated [SQL transport adapter](src/sql-worker-transport.ts) targets **mssql 12.7.14 / Tedious 20.3.9**. It establishes verified TLS directly, uses `encrypt: 'strict'` and a 16,000-byte TDS packet within [Microsoft's encrypted SQL packet guidance](https://learn.microsoft.com/en-us/troubleshoot/sql/integration-services/use-encryption-network-packet-size), then prevents redundant TLS wrapping on that connection instance. Hostname/certificate verification stays enabled; there is no global prototype patch or certificate bypass. Recheck actual SQL reads/writes in workerd before upgrading either dependency. The read adapter splits count/page queries and full-snapshot projections rather than sending a large SQL batch.

Workerd resets connections on large Unicode parameters that the normal Node driver accepts. Message writes above 8,000 combined UTF-16 bytes therefore stage 2,048-character pieces in a SQL local temporary table on the transaction's pinned connection. The final insert or action-status update assembles the complete values with ordered `STRING_AGG`; JSON constraints see one complete document. The temporary table is dropped, and all changes roll back together on failure. This uses no new schema or Cloudflare storage and preserves the existing payload limits.

TCP pools are created and closed per gateway request; only decoded data crosses requests. The Node runtime uses its bounded process pool. [Domain copies](src/domain/) are intentional: the backend can be removed independently and the frontend switched to its explicit mock build. Keep DTOs/calculations synchronized with the frontend when changing contracts.

## Kassandra and MCP

[wrangler.kassandra.jsonc](wrangler.kassandra.jsonc) configures the independent `juyo-kassandra` Worker and `mcp-juyo.cristiansarghe.com` custom domain. It contains no SQL driver, database connection or storage binding. Its three routes are:

| Route         | Purpose                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| `GET /health` | Public service/model status; no secrets or hotel data.                  |
| `POST /mcp`   | Authenticated stateless Streamable HTTP MCP, JSON-RPC request/response. |
| `POST /chat`  | Authenticated internal inference adapter used by the SQL API.           |

MCP initialization, tool listing and every tool call validate the existing bearer session through the SQL API. Origins are checked against the same explicit local and production Pages allowlist. The transport accepts the supported `2025-03-26`, `2025-06-18` and `2025-11-25` protocol versions, needs no MCP session registry, and returns 405 for SSE `GET` requests. Tools can only call trusted, fixed REST paths; no tool accepts an arbitrary URL, SQL statement or credential.

| Tool                       | Data or operation                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `get_workspace_context`    | Hotels, configured addresses, coordinates, available calendar, business date, currency and provenance.             |
| `get_hotel_analytics`      | Date-scoped revenue, occupancy, ADR, RevPAR, targets and booking sources.                                          |
| `get_hotel_data`           | Paginated canonical resources, including reservations, costs, facilities, rooms, rates and events.                 |
| `get_room_inventory`       | Dated physical inventory, operational changes, cleaning and availability counts.                                   |
| `get_hotel_repair_context` | Configured hotel location, current technical room issues, maintenance notes, facilities and missing information.    |
| `get_booked_price_history` | Accepted booking prices and their room-night-weighted average.                                                     |
| `get_warnings`             | Dated operational warnings.                                                                                        |
| `get_upcoming_events`      | Stored events, hotel relevance, dates, coordinates and distances.                                                  |
| `get_data_dictionary`      | Field meanings, relationships and enums.                                                                           |
| `recommend_room_price`     | Explainable occupancy/event heuristic applied to effective selling quotes; booking history is supporting evidence. |
| `propose_rate_updates`     | One grounded review of 1–20 hotel/type/interval changes, with current selling quotes and stale-price protection. |
| `propose_rate_update`      | Validated exact rate proposal, without applying it.                                                                |
| `propose_room_action`      | Validated current-room proposal, without applying it.                                                              |

Collection results are bounded and expose pagination; oversized results ask for narrower filters. Booked nightly prices remain separate from current selling quotes. Recommendations describe their heuristic and missing market/demand evidence; they do not claim to optimize prices, guarantee revenue or update a PMS. Stored event assessments retain their original provenance and are not verified live listings.

Repair requests first use `get_hotel_repair_context` for the selected hotel and optional room. A separate server-side Responses function, `find_repair_providers`, performs up to two public lookups per turn using an allowlisted trade and the hotel's trusted city/country. Its isolated web-search request receives no hotel name, exact address, room notes, guest/booking information, credentials or conversation history. It returns up to three businesses with sourced public phone numbers and service areas; missing evidence remains explicit. Listings are not confirmed availability, a quality endorsement or a booking. Safe inline citations and a source list survive conversation reloads. No company is contacted and no room state changes through a search.

The SQL API's message route calls the inference Worker, which restores the owned conversation and authoritative hotel/date context before calling [OpenAI Responses](https://developers.openai.com/api/docs/guides/tools-connectors-mcp). The model is [`gpt-6.1-terra`](https://developers.openai.com/api/docs/models/gpt-6.1-terra), with `reasoning.effort: low` (the API setting used for the requested light reasoning). Responses use `store: false`, at most 12 retained history messages, at most 4,096 output tokens and 12 tool calls per model pass and the authenticated remote MCP endpoint. The key and bearer token never enter model-visible user content. Instructions require tool-grounded facts, explicit dates/scope, concise answers, untrusted-data handling, and honest errors when information is missing.

The OpenAI key belongs only in the Kassandra Worker's encrypted `OPENAI_API_KEY` secret. Its nonsecret variables are `JUYO_API_URL`, `MCP_PUBLIC_URL` and `ALLOWED_ORIGINS`. The SQL API needs only the nonsecret `KASSANDRA_URL`; it does not receive the model key. Build the independent artifact with:

```sh
npm run bundle:kassandra
```

When deploying through the Cloudflare website, upload `dist/kassandra/kassandra-worker.js` to `juyo-kassandra`, configure its variables and encrypted secret, and deploy the SQL API bundle with `KASSANDRA_URL` configured. The equivalent authenticated CLI secret command is `npx wrangler secret put OPENAI_API_KEY --config wrangler.kassandra.jsonc`. Never paste the key into source, a public variable, frontend configuration, a URL or a report.

All MCP tools are read-only or prepare proposals. Actual execution is a separate user action: `POST /api/v1/conversations/:id/actions/:actionId` with `{ "decision": "apply" }` or `{ "decision": "cancel" }`. Only a persisted proposal from the user's own conversation is accepted. Plain-text confirmations and model output cannot execute writes. A `rate_batch_update` applies all 1–20 reviewed rows and the message status in one SQL transaction. Same-type date intervals cannot overlap. Apply rechecks a SHA-256 fingerprint of every current dated quote; stale batches return `409 STALE_RATE_PROPOSAL` with no partial changes. Room types are locked in stable order, shared with manual rate updates. Multi-room-type, multi-hotel and disjoint-date proposals use one review/Apply; invalid or mixed proposal outputs are rejected rather than silently truncated. Chat failures do not fall back to fabricated or canned answers.

Inference has a bounded 160-second Worker deadline for model/tool passes, a 170-second SQL-to-inference deadline and a 180-second browser message deadline. MCP-only requests retain 75 seconds; ordinary browser reads and confirmed changes retain the standard API timeout. The request-owned SQL pool closes during inference and reopens before saving the response, so model waits do not retain an idle SQL socket. The Node server keeps its shared process pool. Cancellation propagates through the same request signals, and neither inference nor writes retry automatically.

Both Workers and the compute-only SQL gateway use Cloudflare Free. The gateway addresses the measured edge CPU failure without storing application data in Cloudflare. Free request/compute quotas still apply; its in-memory chat throttle is per isolate, not a global quota. Actual OpenAI use requires an enabled project/model and available OpenAI credit; Cloudflare Free does not cover model usage. Verify the deployed MCP and a real model/tool round trip after future changes, independently of successful local tests.

## Checks

```sh
npm test
npm run db:verify
SQL_INTEGRATION=1 npm test
npm run bundle:worker
npm run bundle:kassandra
npm run test:worker
SMOKE_API_URL=https://api-juyo.cristiansarghe.com/api/v1 SMOKE_SKIP_CREDENTIAL_FAILURES=1 npm run test:worker
```

The read-only SQL verifier compares every exported property against the canonical offline JSON oracle. The opt-in integration test creates temporary API-only accounts, verifies room/rate/chat persistence, concurrency and rollback, then cleans those accounts and checks that the canonical snapshot is unchanged. It requires normal SQL environment variables and never edits `juyo` facts.

The Worker smoke check defaults to the first backend demo account. `API_DEMO_EMAIL` and `API_DEMO_PASSWORD` can select another catalog account without reading the retired owner credential file. Both Worker and MCP smoke scripts accept `SMOKE_ORIGIN` to verify the intended browser origin, for example `SMOKE_ORIGIN=https://juyo-demo.pages.dev` for production or `SMOKE_ORIGIN=http://127.0.0.1:4201` locally. This defaults to port 4200 and never changes a deployed allowlist. The explicit Angular mock mode remains separate: it accepts formatted local credentials and does not contain the backend account catalog. To run the real API from port 4201, use `npm start -- --port 4201` without the `mock` configuration and sign in with a backend demo account; mock sessions do not contain a real API token.

Verification on 14 November 2026: the actual SQL-backed workerd smoke passed 47 checks through the bound compute gateway. Public API authentication and authenticated MCP handshake/tool reads returned 200 after gateway deployment. Real OpenAI hotel-data answers, grounded price recommendations and an exact pending rate proposal returned 201 through the conversation endpoint. A pending proposal is not an applied change; verify explicit confirmation separately after deployment changes. The SQL integration checks rate updates, room concurrency, user isolation and atomic chat writes while preserving canonical facts.

To remove AI inference alone, remove the `juyo-kassandra` Worker, its secret and custom domain, and remove `KASSANDRA_URL` from the SQL API; hotel REST data remains independent and chat reports that it is not configured. The SQL gateway can remain. To remove the entire backend later, switch Angular explicitly to `mock`, then remove the Workers/domains and this folder. Retaining HTTP mode never silently falls back to fixtures. The separate `juyo_api` schema can be retained as an audit archive; dropping it is a separate database operation. Canonical `juyo` tables are independent.

The provisioned Durable Object namespace is part of deployment state. Do not merely remove `JuyoSqlGateway` from an uploaded bundle or strip its binding: preserve it during normal updates. Removing or renaming it requires the corresponding versioned Cloudflare class migration; for deletion this is a new `deleted_classes` migration, with the binding/class removed in that deployment. Review that operation separately even though this adapter never stores application data there. Returning SQL work to the direct edge fallback would restore the measured Free CPU limit; it is not an equivalent live replacement.

See the [API contract](../docs/api.md) and [OpenAPI 3.1](../docs/openapi.json). Check `/health` and authenticated resource requests after future deployments; a successful local bundle alone is not a live deployment check.

## Search indexing

`src/search-indexing.ts` owns the search exclusion policy for the public API and Kassandra Workers. Their public entry points attach `X-Robots-Tag: noindex, nofollow, nosnippet, noimageindex` to every handled response, retaining the original status, CORS headers and streamed body. Public `/robots.txt` is served without authentication, SQL or inference; it allows fetching so crawlers can discover the exclusion header. Do not replace that with `Disallow: /`, which can hide the noindex instruction from search engines.

`tests/search-indexing-api.test.ts` and `tests/search-indexing-kassandra.test.ts` cover public metadata, protected/protocol responses, errors and streaming contracts. Keep `workers_dev` and `preview_urls` disabled in both deployment configs. Deploy both Workers when updating the shared policy, then verify their public response headers alongside the frontend's custom domain and Pages fallback. Normal authentication remains required for hotel data and MCP calls.

The live custom domains additionally receive the policy from the Free Cloudflare response-header Transform Rule **Prevent indexing of Juyo demo, API and MCP**, scoped to the three Juyo custom hostnames in the `cristiansarghe.com` zone. The initial live rollout uses this edge rule; it does not require republishing either Worker or changing its bindings, secrets or database. The source wrappers retain the same protection when the Workers are next deployed. Verify success, authentication, preflight and missing-route responses after changes to either layer.
