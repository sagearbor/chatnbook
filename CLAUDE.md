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
  `provider_event_id` on the appointment row. The idempotency-key replay
  check happens *before* any of this, so retries never touch the
  calendar.
- `GET /v1/availability` with `accountId`/`provider`/`calendarId`/`start`/`end`
  all set: calls `getBusy` then `computeAvailability` (wrapping
  `packages/connectors-py/src/connectors/availability.py`) to return real
  free slots; falls back to `{ slots: [] }` when they're not all given.
- Tests: `packages/api/test/appointments-connector.test.js` injects a fake
  `CalendarConnector` via `setCalendarConnectorForTest` (never spawns
  python). `packages/api/test/appointments-connector-integration.test.js`
  is the one real integration test -- it leaves the real
  `PythonCalendarConnector` in place and points
  `google.py`'s `GOOGLE_CALENDAR_API_BASE` at a fake Google Calendar HTTP
  backend (`test/helpers/fake-calendar-backend.mjs`), so it's a genuine
  end-to-end exercise of TS -> subprocess -> Python -> HTTP -> fake
  Google API.

### Health Checks
```bash
curl http://localhost:3000/health
curl http://localhost:3000/openapi.json
```

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