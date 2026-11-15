# Juyo hotel network

An Angular 22 application for inspecting a fictional European hotel network, with a data-backed Kassandra chat. It supports local development and the authorized Cloudflare Pages Free frontend. All records are test fixtures, identified in exported metadata. The interface uses plain property names without repeated development labels.

The frontend uses **Angular 22.2.6**, **Tailwind CSS 4.3**, **Taiga UI 5.32** dropdowns and **Apache ECharts 6.1**. Angular's native `animate.enter` handles view entrances alongside CSS state transitions and reduced-motion support.

## Run

```sh
nvm use
npm install
npm start
```

Open http://127.0.0.1:4200. The default configuration calls the SQL-backed API at `https://api-juyo.cristiansarghe.com/api/v1`. Sign in with one of the [backend demo accounts](backend/README.md#authentication). Their email/password list is hardcoded only on the backend; Angular and browser storage contain no demo passwords.

Local development binds only to `127.0.0.1`. The active frontend lives in this `juyo-kassandra` checkout and is hosted on Cloudflare Pages Free at [juyo-demo.cristiansarghe.com](https://juyo-demo.cristiansarghe.com), with [juyo-demo.pages.dev](https://juyo-demo.pages.dev) retained as its fallback. The Cloudflare project name `juyo-demo` identifies the deployment destination. The API and Kassandra remain separate Workers. Fonts, artwork and map assets remain bundled with the frontend. For an explicit offline fixture session, run `npm start -- --configuration mock`; build it with `npx ng build --configuration mock`.

Dashboard opens at `/`. Sidebar destinations are `/rooms`, `/reservations` and `/hotel-configuration`; Room management has child routes `/rooms` and `/rooms/prices`. These are real Angular routes with nested outlets, lazy feature bundles, validated sign-in return URLs and legacy redirects. `npm run test:routing` checks those navigation contracts.

For frontend publishing, run `npm run build` in this checkout and upload the contents of `dist/` to the existing `juyo-demo` Pages project. The root `wrangler.jsonc` describes that static Pages destination; the independent Worker configurations remain under `backend/`. Build output and QA artifacts stay ignored, and publishing does not require a Git commit.

## Separate SQL Server database

The four-hotel dataset lives in the normalized SQL Server `juyo` schema. Offline migrations, import scripts, integrity checks and the verification report live in [database/](database/README.md). The API reads those canonical facts and stores users, sessions, room changes, rate updates and conversations separately in `juyo_api`. The Angular application has no SQL driver, credentials or direct database connection.

## API boundary

All runtime data enters through typed Angular `HttpClient` services. The default HTTP transport targets `https://api-juyo.cristiansarghe.com/api/v1`. The independent [backend](backend/README.md) runs on a standard Cloudflare Worker, using the existing SQL Server directly with verified TLS. The frontend uses Cloudflare Pages Free; the API and Kassandra retain their existing Free Worker deployment without D1 or paid hosting features.

The backend directly compares email/password against its hardcoded demo account catalog, without password hashing. Sessions use opaque bearer tokens whose SHA-256 hashes are stored in SQL; new demo identities store no database password. Rooms, rate updates and per-user conversations persist in SQL. Canonical bookings and financial facts remain immutable. Kassandra uses OpenAI Responses with `gpt-6.1-terra` and low reasoning effort, retrieving facts through an authenticated MCP server. The separate thin Worker at `https://mcp-juyo.cristiansarghe.com` owns model inference and the `/mcp` endpoint; its OpenAI key stays in server-side secrets. The API stages room/rate proposals for explicit Apply/Cancel decisions. See [MCP setup](backend/docs/MCP.md).

Sign-in restores only the session. A protected-shell resolver loads the small shared hotel/calendar catalog into NgRx, then each page requests only its required hotel/date data. Room management uses the current day; pricing loads the selected type over the chart's enclosing months; revenue day details load on demand. The frontend no longer downloads the network export at startup.

Shared selection, references, scoped query caches, notifications and operational overlays have explicit NgRx owners. Identical resource reads coalesce and expire; old filter requests are cancelled and cannot overwrite a newer selection. Page components load as separate JavaScript bundles. Canonical reporting history stays separate from edits, and writes publish only after confirmation without automatic retry. See [data ownership and page scopes](docs/api.md#ownership).

The explicit `mock` build keeps the browser-local interceptor and fixture repositories available for offline work. Mock routes are not a listening HTTP server and mock changes are independent of SQL. Static `public/data` exports are excluded from served build assets. Backend domain copies intentionally remain self-contained so the backend can be removed and the frontend switched to the mock configuration independently. See [API details](docs/api.md), [OpenAPI](docs/openapi.json) and [backend setup](backend/README.md).

## Development network

| Property              | City                   | Rooms | Restaurant            |
| --------------------- | ---------------------- | ----: | --------------------- |
| Meridian Brussels     | Brussels, Belgium      |    24 | Atelier Meridian      |
| Canal House Amsterdam | Amsterdam, Netherlands |    20 | Canal Table           |
| Spreehof Berlin       | Berlin, Germany        |    28 | Spree Kitchen         |
| Ribeira Porto         | Porto, Portugal        |    16 | Breakfast lounge only |

The fixture contains **88 rooms**, 16 room types, 23 facilities, three restaurants and 16 unit-cost references. Every day from **1 October through 31 December 2026** is covered: 92 calendar dates, 368 hotel-performance rows, 368 booking positions, 8,096 room-state records, and daily costs, channel totals and facility activity. Reservations have assigned rooms and nightly revenue lines; they form a complete ledger rather than a small workflow sample.

Schema **2.2.2** also includes WGS84 hotel/venue coordinates, **12 generated events** and **13 hotel-event assessments**. Event records are normalized separately from their hotel-specific importance, rationale, distance and provenance. Distances use the Haversine formula with a 6,371 km Earth radius, rounded to 0.01 km; they are straight-line distances, not routes. Importance combines proximity with event relevance rather than applying a universal distance threshold. These are local illustrative fixtures, not verified live listings or AI-generated assessments; the `kassandra` source value is reserved for a future integration.

Warnings and events open brief Taiga popovers, then individual detail dialogs. Event maps use bundled OpenStreetMap street/water geometry and local country outlines; no remote tiles, API keys or runtime map service are needed. Source and licences are in `public/maps/README.md`. Event detail dialogs retain fixture rationale and local rule-based estimates; the separate chat provides live model responses.

Kassandra's chat UI is a shared right-side helper, opened from the sidebar, warning details, Room management's repair banner or an event pricing action. Its three example prompts fill the composer. Help me fix prepares an editable request for local repair companies and verified public business contacts, without submitting it. The room repair banner estimates nightly potential revenue at risk using already loaded selling rates, assuming blocked rooms would sell. Warnings have no AI explainer. Event assessments use the shared speech-bubble presentation. Update with Kassandra automatically requests one combined review for the event dates and the globally selected hotel, or all relevant hotels in portfolio scope. It reviews justified room types and date bands, explains exclusions, and presents one Apply/Cancel before rates change. The explicit mock configuration supports the same batch event review using the transparent rate-suggestion heuristic. ChatService owns API conversations, real answers and action decisions, while the helper retains its draft and open state across page navigation. History loads on opening the helper; loading, errors, retry and Stop remain visible. Each message carries the selected hotel and inclusive dashboard dates without changing those filters. Proposed changes show their exact details and require explicit Apply/Cancel, then refresh the affected operational cache. MCP exposes hotel data, not a verified repair-provider directory or web search; Kassandra must not invent business contacts or urgent availability. Legacy `/chat` URLs redirect to the dashboard and open the helper. Use the explicit `mock` configuration for isolated UI browser checks.

Kassandra can prepare up to 20 exact hotel/room-type/date price changes together. For example: “Classic €220 for 20–22 November and Superior €260 for 23–25 November at Canal House Amsterdam.” The review shows each inclusive interval and current → proposed nightly rates. One Apply saves the entire batch in SQL; changed quotes reject the whole proposal so it can be refreshed. Same-type intervals cannot overlap. Existing bookings keep their accepted prices. Event actions use this same workflow, while general pricing remains independent of events.

Room management’s Room prices section (`/rooms/prices`) operates independently of events. Choose any inclusive interval in the available October–December calendar and a hotel/room type, inspect the current nightly quotes, then apply a new rate. Canonical `roomRates` contains **1,472 daily quotes** across sixteen room types and 92 dates, with modest weekday/month variation. Quotes are EUR excluding VAT, separate from booked ADR and financial ledgers. Confirmed API updates become the current selling rates; overlapping changes use the latest applied update. Optional reason/event metadata never restricts the interval. Event links only prefill editable context. HTTP updates persist in `juyo_api.RateUpdate`. In the explicit mock build, overrides use `juyo.room-rates.v1`; older `juyo.event-rate-plans.v1` proposals migrate without deleting the original key. Existing reservations keep their booked rates; no PMS is connected. Validate general pricing with `npx tsx scripts/validate-room-rates.ts`; `scripts/validate-event-rate-plans.ts` now checks event-insight helpers only.

The room-price history chart covers the full calendar months enclosing the editing interval for the selected hotel/type. It shows 10 days at a time with a keyboard-accessible scrollbar: shorter selections are centered where possible, longer selections start at From. Light-purple scatter dots inside the interval show each distinct nightly price from accepted existing bookings. The rounded purple booked average is the sum of accepted nightly room revenue divided by booked room nights; repeated prices carry their booking counts as weights. A date with a single booked price has its average exactly at that dot. Outside the interval, only the same computed average continues in light gray. The chart scale includes all plotted booked prices and context averages and stays fixed while scrolling. Hover shows a compact summary above the cursor; clicking opens and pins the full price breakdown until an outside click or Escape. Current selling quotes remain in the rates table and editor; editing them leaves booked dots and averages unchanged. The chart uses the immutable reservation-night ledger and gaps on dates without bookings. Future points reflect existing reservations, not forecasts. `npx tsx scripts/validate-price-history.ts` independently reconciles all sixteen room types and tests unequal weights, single-price equality, exclusions and empty dates.

Accepted booking prices use sparse arrival-date bands, with a November 16–21 peak and a limited one-night offer on November 18. Each reservation keeps its accepted flat nightly quote. Across occupied room-type/date records, 94.7% have one price; in November, 89.6% have one. The remaining dates have two or three prices, never more than three. Amsterdam Classic on November 14 has nine room nights at €198.90, so the average equals that one price. November 18 has one at €198.90, one at €210.60 and seven at €218.40, averaging €215.37. Berlin Classic on November 22 has a selling quote of €108.29 while existing bookings average €129.07. Room availability, reservations and their accepted nightly quote contracts are preserved; all revised fixture revenue reconciles through the canonical ledger.

The compact price-chart hover summary shows the weighted average, total bookings and free rooms above the cursor. Clicking a date pins a larger popup listing every booked price and its booking count, with the same average and availability. Moving the pointer leaves the clicked date unchanged; another date replaces it, while outside click or Escape closes it. Changing the hotel/type/interval or panning clears stale details. Availability is shared across prices and excludes out-of-order rooms. The full list scrolls on long days; the Daily prices disclosure provides the same prices, counts and availability without requiring hover.

Current room operations have filterable Available, Needs cleaning, Out of service and Reserved cards, plus a per-room Actions menu. Changes to housekeeping and service status persist through the API for the current business date; the explicit mock build uses `juyo.room-operations.v1` locally. Reserved is a manual inventory hold, with no guest reservation or revenue; booked rooms cannot be freed, held or blocked. Holds are shown separately from bookings in pricing availability, and warnings reflect manual service blocks. Reset changes restores a room’s canonical state. Other dates, accepted bookings, and period financial analytics remain unchanged. Run `npx tsx scripts/validate-room-operations.ts` to verify transitions, persistence, capacity reconciliation and booking protection.

All positions are captured as of **14 November 2026**, with **7 November** as the comparison for signed pickup. Dates before 14 November are actuals; today and later represent existing bookings, scheduled room states, planned operating costs and planned ancillary activity. Cancelled, pending and no-show reservations are excluded from occupied/booked room nights and revenue. Revenue targets are planning baselines, not forecasts.

All money is **EUR, excluding VAT**. Monthly cost and channel totals reconcile to the daily ledgers. Unit costs are planning references, separate from expenses. Actual operating result uses only closed-date revenue and actual costs, before depreciation, interest and tax; it never combines actual revenue with future planned costs.

Select October, November or December in the page header. Overview also offers Today and an inclusive custom range with a Taiga calendar; a range can be one day or span months. Apply commits custom dates; Cancel or dismissal preserves the current selection. Every dashboard total, target, occupancy figure, chart and hotel comparison uses those dates. Today means the fixed business date, 14 November 2026, and pulses when included. Custom ranges stay separate from the month/date used by other views. Room management contains only Rooms and Room prices. Rooms shows current physical inventory, housekeeping and maintenance; Room prices owns flexible date intervals, current nightly quotes and local rate updates. Reservations (`/reservations`) lists stays covering the fixed business date, with guest references, assigned rooms and pagination. Hotel configuration (`/hotel-configuration`) shows room types, inventory, capacities, areas, base rates and facilities. All pages share the hotel selector beside the Juyo logo in the toolbar, with no operational date filters. Room management and Hotel configuration show a centered hotel-choice screen while All hotels is selected; Continue applies the draft choice globally. Legacy `/room-prices` URLs redirect to the price section and retain event/hotel context. The former Costs & facilities and Data schema pages are removed; their legacy query URLs open Overview. Shared financial/facility facts and schema metadata remain available to Kassandra and development tooling. Kassandra supports the same months and explicit ISO dates in questions.

The revenue chart keeps complete calendar months around the selected interval. Excluded days display gray patterned target bars only and do not affect totals. Earned revenue uses purple; booked revenue uses light purple. Single-month views show every day; multi-month views show 30 days at a time with a bottom scrollbar.

Single-day filters show occupancy, rooms to sell, average rate, out-of-order rooms, arrivals and departures instead of a chart, alongside the day's revenue and target. Click a chart bar to open this day view locally; Back restores the applied period and chart position. The global filter and other dashboard cards stay unchanged during this drill-down. Arrival/departure figures count assigned rooms from accepted reservations. Past dates show unsold rooms rather than rooms to sell.

## Data and schema

- `src/app/core/network.models.ts`: domain types and enum values.
- `src/app/core/network.data.ts`: canonical deterministic fixtures.
- `src/app/core/network.selectors.ts`: shared hotel/portfolio calculations.
- `src/app/core/network.schema.ts`: JSON Schema 2020-12 and the field/enum dictionaries.
- `public/data/hotel-network.json`: complete exported data.
- `public/data/hotel-network.schema.json`: exported validation schema.

`npm run data:export` regenerates both JSON files from the canonical TypeScript source. It also runs before start/build. Edit the source fixture, not the generated JSON.

All charts use **Apache ECharts 6.1**, with a reusable SVG-rendered Angular component, resize/disposal handling and reduced-motion support. Kassandra grounds real model responses in this dataset through the authenticated MCP tools. The explicit offline mock retains deterministic fixture answers. No live PMS or external hotel source system is connected.

## Validation

```sh
npm run test:data
npm run test:chat
npm run test:api
npm run test:api:facades
npm run test:domain
npm run test:ranges
npm run test:ui
npm run typecheck
npm run build
```

Data validation checks JSON Schema, foreign keys, enums, inventories, availability, channel allocation, exact-cent ledger totals, weighted KPIs and hotel/portfolio aggregation. It also independently reconciles event distances, dates, scoped relevance and portfolio deduplication, and checks out-of-service warnings against every dated room inventory. Build output remains local in `dist/`.

HTTP conversation history is stored per account in SQL, with one row per message and atomic question/answer writes. Only the explicit mock build uses the versioned browser conversation store and fixture-answer refresh behavior. Old browser prototype data is preserved separately.

## Shared state

NgRx Signals 22.0.1 manages shared application state. The root `AppUiStore` owns the selected hotel and reporting calendar; existing scope services expose its validated actions and readonly selectors. Hotel selection persists under `juyo.ui-context.v1` across navigation and reloads. Auth, conversations, room operations and rate updates use feature-owned NgRx `signalState` with `patchState`; their caches update after API confirmation. Business-data browser persistence belongs only to mock repositories. HTTP bearer tokens use the separate, base-URL-scoped browser session store; booking safeguards remain unchanged. Component drafts, menus, table filters and chart viewports stay local. URL state remains in Angular Router.

Run `npx tsx scripts/validate-ui-state.ts` for context and reporting transitions.

## UI foundation

The supplied analytics reference guides the compact white dashboard on a light gray workspace, with Juyo purple accents (`#9D8DF1`, hover `#865CC8`). Global color, type and surface tokens live in `src/styles.css`; resolved ECharts colors live in `src/app/shared/chart-colors.ts`; the ongoing design rules live in `AGENTS.md`.

Tailwind 4 runs through `@tailwindcss/postcss` in `.postcssrc.json`. Its theme and utilities are imported without preflight so they coexist with Taiga's component styles. Angular compiles the Taiga theme Less entry before the application's token overrides. Use utilities for simple layout and spacing, and scoped CSS for specific product controls.

`AppSelectComponent` wraps the current Taiga `TuiSelect`, `TuiTextfield` and `TuiDataList` APIs. It accepts an accessible `label`, readonly `{ value, label }` options, a selected string `value`, and emits `valueChange`. `provideTaiga()` and `TuiRoot` are configured at application startup. Its chevron and selected/clear glyphs are local SVG, with no remote icon or font requests.

## Design references

The logo and original product context reference [Juyo](https://juyo.ai/) and [Kassandra](https://juyo.ai/kassandra-ai). Juyo owns its logo. DM Sans is bundled under the SIL Open Font License in `public/assets/DM-Sans-LICENSE.txt`. No commercial Juyo font files are included.

## Unit tests

Run `npm test` for the Angular Vitest suite, `npm run test:watch` during development, or `npm run test:coverage` for an HTML/LCOV report. Tests focus on services and component logic and use local mocked responses. See [Testing](docs/testing.md) for scope and conventions.

## Repository boundaries and private configuration

The Angular frontend lives in `src/` with its public assets in `public/`. The independent REST API and SQL gateway live under `backend/src/`, while `backend/src/kassandra-worker.ts` provides the separately deployed MCP and inference Worker. The two Worker entry points have separate Wrangler configs and remain outside the frontend build. Canonical database migrations and import tools live in `database/`.

Runtime credentials belong in ignored environment files or Cloudflare secrets; start from `backend/.env.example`. Filled environment files, local sessions and diagnostic reports, QA screenshots, generated database SQL, build output and dependencies are excluded from Git. The backend's deliberately public demo-account catalog and synthetic test credentials remain fixtures; they are not infrastructure credentials. No live SQL host/catalog identifiers, database passwords or API keys belong in committed configuration. Keep local private settings outside tracked files rather than temporarily deleting and restoring them around commits.

## Search indexing

The frontend ships a robots meta tag and a Cloudflare Pages `_headers` rule that sets `X-Robots-Tag: noindex, nofollow, nosnippet, noimageindex` on every asset and SPA route. Both public Workers apply the same header to success, authentication, preflight and error responses. Worker preview and `workers.dev` URLs remain disabled.

The live `cristiansarghe.com` zone also has the Free response-header Transform Rule **Prevent indexing of Juyo demo, API and MCP**. It sets the same header for exactly `juyo-demo.cristiansarghe.com`, `api-juyo.cristiansarghe.com` and `mcp-juyo.cristiansarghe.com`, including Worker and Cloudflare error responses. This independent edge policy protects the current API/MCP deployments without replacing their application code. The Pages `_headers` file separately covers `juyo-demo.pages.dev` and deployment URLs outside that zone. Preserve both layers during future deployments.

The public `robots.txt` files allow fetching so search engines can read the `noindex` directives and remove previously discovered URLs. Blocking those URLs in robots.txt can prevent that removal; see [Google's noindex documentation](https://developers.google.com/search/docs/crawling-indexing/block-indexing). Keep the policy on both frontend domains, the REST API and the MCP host when deploying. Search-engine removal follows their recrawl schedule; normal API authentication continues to protect hotel data.
