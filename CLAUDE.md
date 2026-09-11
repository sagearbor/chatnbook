# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview
AI-Native Chat + Agent-Ready Scheduling for SMBs. This is a monorepo that provides both human-friendly chat/booking widgets and agent-discoverable scheduling APIs. The system connects to existing calendars (Google/Microsoft) with ICS read-only fallback and ships as a one-click WordPress plugin.

## Development Commands

### Setup
```bash
# Prerequisites: Node 20+, Python 3.9+, Docker
corepack enable
corepack prepare pnpm@9 --activate
pnpm i
docker compose -f infra/docker-compose.dev.yml up -d  # Postgres + Redis
pnpm --filter @smb/api db:migrate  # DATABASE_URL=postgres://user:pass@localhost:5432/smb (matches the compose file)
pnpm -r build

# Python environment for connectors
python -m venv .venv
source .venv/bin/activate        # or .venv\Scripts\activate on Windows
pip install -r packages/connectors-py/requirements.txt
```

### Development
```bash
pnpm --filter @smb/api dev      # Start API server with OpenAPI endpoints
pnpm -r build                   # Build all packages
pnpm dev                        # Run all dev servers in parallel
```

### WordPress Plugin Generation
```bash
pnpm generate:adapter --manifest platforms/wordpress.manifest.yaml
# Output: platforms_out/wordpress-plugin/
```

### Testing
```bash
# Python tests (connectors/availability logic)
pytest                          # Run all tests with testdox output (default)
pytest -vv -rP                  # Verbose mode with detailed output
pytest --durations=5            # Show slowest tests

# TS API tests (unit tests use an in-memory repo; the Postgres
# integration test needs the compose DB up and migrated first)
docker compose -f infra/docker-compose.dev.yml up -d
pnpm --filter @smb/api db:migrate
pnpm --filter @smb/api test     # node --test test/*.test.js

# MCP adapter + widget smoke tests
pnpm --filter @smb/adapters-mcp test
pnpm --filter @smb/widget test

# Or run everything the way CI/merge verification does (needs the Python
# venv active and infra/docker-compose.dev.yml migrated as above first):
pnpm test

# WordPress plugin testing
cd platforms/wordpress-plugin
docker compose -f docker-compose.test.yml up -d  # Start WordPress + MySQL
# Access: http://localhost:8080 (WordPress), http://localhost:8081 (PHPMyAdmin)
```

### Appointment persistence
`packages/api/src/repositories/` defines an `AppointmentsRepository` interface
with two implementations: `PgAppointmentsRepository` (real Postgres, used
whenever `DATABASE_URL` is set -- the normal/production case) and
`InMemoryAppointmentsRepository` (a fast test double used when it isn't).
Schema lives in `packages/api/migrations/*.sql`, applied via
`pnpm --filter @smb/api db:migrate`.

### OAuth calendar connect flow
`GET /oauth/:provider/start?accountId=...` (provider is `google` or
`microsoft`) 302-redirects to the provider's consent screen; the provider
redirects back to `GET /oauth/:provider/callback`, which exchanges the
code for tokens and stores them encrypted (AES-256-GCM, key from
`TOKEN_ENCRYPTION_KEY`) in the `oauth_tokens` table (see
`packages/api/migrations/002_create_oauth_tokens.sql`), one row per
`(accountId, provider)`. Same Pg/in-memory-repository split as
appointments (`packages/api/src/repositories/{oauth-tokens-repo,pg-oauth-tokens-repo,memory-oauth-tokens-repo}.ts`).
`packages/api/src/oauth/routes.ts`'s `getValidAccessToken()` transparently
refreshes an expired access token using the stored refresh token before
handing it to a caller. State is a signed (HMAC, using
`AGENT_HMAC_SECRET`), self-contained token -- no server-side session
storage needed. Provider auth/token URLs default to the real
Google/Microsoft endpoints but are overridable
(`GOOGLE_OAUTH_AUTH_URL`/`GOOGLE_OAUTH_TOKEN_URL`, `MS_OAUTH_AUTH_URL`/`MS_OAUTH_TOKEN_URL`),
which is how `packages/api/test/oauth-flow.test.js` points the whole flow
at a local mock OAuth provider (`test/helpers/mock-oauth-provider.mjs`)
instead of the real thing -- no real client ids/secrets needed to test it.

### Services
`GET /v1/services?accountId=...` lists real services (id, accountId, name,
durationMinutes, bufferMinutes) backed by Postgres/in-memory (see
`packages/api/src/repositories/services-repo.ts` and
`migrations/003_create_services.sql`). accountId is required. There's no
admin HTTP endpoint to create a service yet -- seed rows directly through
the repository (see `getServicesRepoForTest()` in `src/index.ts`, used by
`test/services.test.js`). `GET /v1/availability` honours a `serviceId`
query param by looking the service up (404 if unknown, 400 if it belongs
to a different account) and using its `durationMinutes + bufferMinutes` as
the slot length, overriding any client-supplied `slotMinutes`.

### Calendar connector wiring (availability + event creation)
`POST /v1/appointments` and `GET /v1/availability` call the Python
connectors (`packages/connectors-py`) through `CalendarConnector`
(`packages/api/src/connectors/calendar-connector.ts`). The production
implementation, `PythonCalendarConnector`, shells out to
`python -m connectors.cli` (`packages/connectors-py/src/connectors/cli.py`,
a JSON-over-stdio bridge) rather than reimplementing Google/Microsoft
calendar logic in TypeScript. Both endpoints are backward compatible: a
request with no `provider` field behaves exactly as before (in-memory/
Postgres only, no calendar call) -- required because
`packages/adapters/mcp`'s existing calls don't send one.
- `POST /v1/appointments` with `provider`/`calendarId` set: looks up the
  account's stored OAuth token, calls the connector's `getBusy` to check
  for conflicts (409 if the slot overlaps an existing busy interval), then
  `createEvent` to create the real calendar event, storing the result as
  `provider_event_id` (plus `provider`/`calendar_id`, needed later for
  cancellation) on the appointment row. The idempotency-key replay check
  happens *before* any of this, so retries never touch the calendar -- and
  a DB-level claim (see "Idempotency-key concurrency" below) closes the
  remaining race where two truly concurrent first requests could otherwise
  both reach the calendar.
- `POST /v1/appointments/:id/cancel`: when the appointment has a stored
  `provider`/`calendar_id`/`provider_event_id`, calls the connector's
  `deleteEvent` to remove the real calendar event before marking the
  appointment canceled. Tolerates the event already being gone (a
  duplicate cancel, or someone deleting it directly on the provider) --
  `google.delete_event`/`microsoft.delete_event` treat a 404/410 from the
  provider as success rather than raising, so this never blocks
  cancellation. Appointments booked with no `provider` are unaffected (the
  calendar is never touched, exactly as before this existed).
- `GET /v1/availability` with `accountId`/`provider`/`calendarId`/`start`/`end`
  all set: calls `getBusy` then `computeAvailability` (wrapping
  `packages/connectors-py/src/connectors/availability.py`) to return real
  free slots; falls back to `{ slots: [] }` when they're not all given. A
  `serviceId` query param (see "Services" above) overrides the slot length
  with that service's own duration + buffer.
- Tests: `packages/api/test/appointments-connector.test.js` and
  `test/appointments-cancel-connector.test.js` inject a fake
  `CalendarConnector` via `setCalendarConnectorForTest` (never spawn
  python). `test/appointments-connector-integration.test.js` and
  `test/appointments-cancel-connector-integration.test.js` are the real
  integration tests -- they leave the real `PythonCalendarConnector` in
  place and point `google.py`'s `GOOGLE_CALENDAR_API_BASE` at a fake
  Google Calendar HTTP backend (`test/helpers/fake-calendar-backend.mjs`,
  which also implements DELETE), so they're a genuine end-to-end exercise
  of TS -> subprocess -> Python -> HTTP -> fake Google API, including the
  already-deleted-event tolerance path.

### Idempotency-key concurrency
Two concurrent *first* `POST /v1/appointments` requests sharing the same
`Idempotency-Key` are guarded at the DB level, not just by the
idempotency_key unique constraint on the `appointments` table itself:
before doing any calendar work, a request must win an atomic claim
(`appointmentsRepo.tryClaim`, backed by a unique constraint on a small
`idempotency_claims` table -- `migrations/005_create_idempotency_claims.sql`).
Only the winner calls the calendar connector; the loser polls briefly for
the winner's row (`releaseClaim` always runs, success or failure, so a
genuine retry after a failure can claim the key again). See
`test/idempotency-concurrency.test.js` for a real-Postgres test that fires
two genuinely concurrent requests and asserts exactly one calendar event
and one DB row are created.

### Health Checks
```bash
curl http://localhost:3000/health
curl http://localhost:3000/openapi.json
```

### Widget
`packages/widget/` builds three files with `pnpm --filter @smb/widget build`
(plain `tsc` + two small Node scripts, no bundler): `dist/loader.js`,
`dist/app.js`/`dist/a11y.js` (real ESM), and `dist/app.html` (copied
verbatim from `src/app.html` by `scripts/copy-static.js`). The API serves
these statically: `GET /widget.js` -> `dist/loader.js`, and
`GET /widget/app.html`, `/widget/app.js`, `/widget/a11y.js` -> `dist/*`. A
WordPress (or any) page embeds exactly
`<script src="https://<api>/widget.js" data-account="acct_demo" async></script>`.

- **Loader** (`src/loader.ts`, classic script -- see
  `scripts/strip-loader-export.js` for why): derives the API origin from its
  own `<script src>` (`new URL(document.currentScript.src).origin`),
  falling back to `window.WIDGET_APP_ORIGIN` and then the page's own origin.
  It renders a fixed bottom-right round "Book now" launcher button
  (`#smb-widget-button`) that toggles a normally-closed iframe
  (`#smb-widget-frame`, `data-smb-open="0"|"1"`) pointed at
  `${origin}/widget/app.html?account=<account>&api=<origin>`. The widget
  auto-opens when the host page has `?agent=1` or `?smb=open`, and `?agent=1`
  also propagates into the iframe src/dataset. `data-csp-nonce` on the
  loader script tag is applied to the injected `<style>` element. On narrow
  viewports the iframe expands to fill the screen instead of a fixed
  360x520 box.
- **App** (`src/app.html` + `src/app.ts`, vanilla TS/DOM, no framework):
  runs inside the iframe and drives a 4-step booking flow --
  services (`GET /v1/services`) -> day/time (`GET /v1/availability` for the
  picked day's local `[00:00,24:00)` window) -> a details form (name,
  email, phone optional, notes optional) -> confirmation
  (`POST /v1/public/appointments` with a per-attempt `Idempotency-Key`,
  reused on retry). A 409 (slot just taken) bounces back to the day/time
  step with a fresh slot list; 400/429/network errors show an inline
  message, 429/network errors offer a Retry button that resends the same
  request.
- **Agent mode** (`?agent=1`, propagated by the loader): sets
  `data-agent="1"` on the widget root and stable `data-agent-id` attributes
  on every interactive element/list container so an agent can drive the
  flow without relying on layout: `service-list`, `service-<id>`,
  `day-list`, `day-<YYYY-MM-DD>`, `slot-list`, `slot-<ISO start>`, `name`,
  `email`, `phone`, `notes`, `book-btn`, `confirmation`, `appointment-id`,
  `error`. This list is also documented at the top of `src/app.ts` -- keep
  both in sync if it changes.
- **Accessibility**: the widget root is `role="dialog"` with an
  `aria-label`; there's an `aria-live="polite"` status region plus a
  `role="alert"` error region; every step's heading receives focus when
  that step renders; inputs have `<label>`s; interactive controls are real
  `<button>`s.
- **Tests** (`test/*.test.mjs`, `node --test` + jsdom, run via
  `pnpm --filter @smb/widget test`; `pretest` builds first):
  `loader.test.mjs` loads the built `dist/loader.js` as a classic script
  and asserts the launcher/iframe wiring; `app.test.mjs` mocks
  `globalThis.fetch` and drives the full flow (including the 409 and
  agent-mode paths) against `dist/app.js`.

## Architecture

### Core Components
- **API** (`packages/api/`): OpenAPI-first booking endpoints, availability engine, notification service
- **Connectors** (`packages/connectors-py/`): Python package for Google/Microsoft OAuth + ICS read-only calendar integration
- **Discovery** (`packages/discovery/`): JSON-LD generation and well-known endpoints for agent discoverability
- **Widget** (`packages/widget/`): Web widget with human-friendly chat UI and agent-friendly DOM mode
- **Adapters** (`packages/adapters/mcp/`): MCP tool server for agent integrations
- **WordPress Plugin** (`platforms/wordpress-plugin/`): Generated wrapper that injects widget + JSON-LD

### Key Data Flow
1. **Discovery**: Agents find scheduling capabilities via JSON-LD at `/.well-known/ai-actions.json`
2. **Availability**: Query `/v1/availability` with service/time parameters 
3. **Booking**: Create appointments via `/v1/appointments` with idempotency tokens
4. **Calendar Sync**: Connectors handle OAuth writes or ICS read-only with confirmation workflow

### Platform Generation
The `tools/adapter-gen/` generates platform-specific wrappers from YAML manifests. WordPress is the primary target, with templates in `tools/adapter-gen/templates/wordpress/`.

### WordPress plugin settings
`platforms/wordpress.manifest.yaml`'s `injection.api_base` (currently the
live Cloud Run deployment, `https://chatnbook-api-664594784582.us-central1.run.app`)
and `injection.account_id` are baked into the generated plugin as the
*defaults* for two WordPress options (`{slug}_api_base`, `{slug}_account_id`),
not hardcoded endpoints -- a non-developer can repoint the plugin at their
own server from **Settings -> AI SMB Booker** in wp-admin without touching
code or regenerating anything. That settings page (generated from
`tools/adapter-gen/templates/wordpress/includes/AdminPage.php.tmpl`) is a
real WordPress Settings API page (`register_setting`/`add_options_page`,
`esc_url_raw` + a strict `[A-Za-z0-9_-]{1,64}` sanitizer, `manage_options`
capability, nonces via `settings_fields()`), and shows a read-only "Status"
block with the exact `<script>` tag that will be injected and a link to
`<api_base>/health`. `ScriptInjector` reads the options at request time
(front end only, and only once `api_base` is non-empty) and `JsonLdRenderer`
rewrites the baked JSON-LD's `urlTemplate`/`instrument` to the configured
`api_base` at render time. `plugin.php`'s activation hook seeds the two
options with `add_option()` (never overwrites an existing value on
reactivate/update); `uninstall.php` removes them. Manifest's `script_url`
and the JSON-LD's `urlTemplate`/`instrument` support a `${api_base}`
template token that `tools/adapter-gen/index.ts` resolves against
`injection.api_base` (validated as an http(s) URL) at generation time --
see `tools/adapter-gen/test/generate.test.mjs` for the full contract
(no `example.com` anywhere in generated output, `uninstall.php`/`readme.txt`
present, `php -l` clean, zip contains `readme.txt`).

## Testing Strategy
- **Python tests** in `packages/connectors-py/tests/` focus on availability math, DST handling, and calendar connector logic
- **pytest-testdox** provides readable test output grouped by functionality
- **WordPress testing** via Docker environment in `platforms/wordpress-plugin/` with live WordPress + MySQL
- Critical test areas: double-booking prevention, OAuth token refresh, ICS confirmation workflow, plugin activation/deactivation

## Security & Agent Integration
- **HMAC authentication** required for agent API calls (X-Signature header)
- **Rate limiting** per IP (human GUI) and per account (agent API)
- **OAuth-only calendar writes**; ICS is read-only with manual confirmation
- **Agent mode**: Widget supports `?agent=1` query param for simplified DOM with stable data-* selectors

## Configuration
- Copy `.env.example` to `.env` and configure OAuth credentials, database URLs, HMAC secrets
- `TOKEN_ENCRYPTION_KEY` (generate with `openssl rand -base64 32`) encrypts
  OAuth calendar tokens at rest in Postgres -- required for the
  `/oauth/:provider/*` routes and any `/v1/appointments`/`/v1/availability`
  call that sets `provider`.
- See `agents/agent_instructions.yaml` for comprehensive environment variable requirements
- WordPress plugin handles OAuth setup UI for non-technical users

## Development Principles
- **API-first**: JSON-LD advertises capabilities, OpenAPI specifies implementation
- **Agent-friendly**: Stable DOM selectors, deterministic responses, clear error messages  
- **Security-by-default**: HMAC for agents, OAuth for calendar writes, PII scrubbing in logs
- **Monorepo structure**: Use `pnpm --filter` for package-specific commands