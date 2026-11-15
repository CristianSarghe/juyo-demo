# Unit tests

The Angular app uses Vitest 4 through Angular CLI's native `@angular/build:unit-test`
builder, with jsdom and Angular TestBed. There is no separate Vite configuration
or hand-built Angular injection harness.

```sh
npm test                 # Run once (also suitable for CI)
npm run test:watch       # Re-run relevant tests while editing
npm run test:coverage    # Terminal summary + HTML and LCOV reports in coverage/
```

Use a supported Node version from `package.json`. Install locked dependencies with
`npm ci`. To run one area:

```sh
npm test -- --include='src/app/core/room-rate.service.spec.ts'
```

## Scope

The suite favors a few useful behavior tests per unit over exhaustive permutations:

- API client requests, session persistence, authentication and reference loading.
- Shared hotel/date context, scoped page loading, resource caching and notifications.
- Room operations and inclusive rate changes, confirmed by the mocked API.
- Conversation loading, message sending, reviewed Apply/Cancel actions and assistant drafts.
- Navigation loading feedback and retry.
- Login, custom date selection and room-price editor logic.
- Booking-weighted room-price averages, single-price equality and unbooked dates.

All requests are intercepted with `HttpTestingController` or replaced by explicit
dependency doubles. Tests do not contact the deployed API, database or AI providers.
Small typed fixtures live in `src/testing`; mutable room data is recreated per test.
Browser storage is cleared by the specs that use it, and fake timers are restored.

## Adding tests

Put `*.spec.ts` next to the source. Use public TestBed APIs and mock only a unit's
dependencies. Assert meaningful results, request bodies and pending/confirmed state,
not private members. For component logic, replace the template with an empty one;
keep real signals, inputs, outputs and lifecycle behavior. Test actual rendered
controls separately when DOM interaction itself matters.

Use Subjects or deferred promises for asynchronous responses and fake timers for
time-based behavior. Avoid real delays, snapshots and tests that only check that a
class can be constructed. Add an error or boundary case when it protects a concrete
workflow; do not build a large edge-case matrix by default.

Coverage reports identify gaps; there is no blanket percentage gate that encourages
markup tests or trivial assertions. Existing `test:data`, `test:api`, `test:domain`,
`test:loading` and other validation scripts remain broader integration/data checks.
Backend tests keep their separate runner in `backend`.
