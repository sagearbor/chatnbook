# Reality Check — 2026-09-08

This document records what was actually verified by running the repo end to
end, as opposed to what `plan.yaml` claims. Every command below was run
against a clean local environment (macOS, Node v26, no prior Docker
install) so the results reflect what a new contributor would actually hit.

> **Update — 2026-09-08, later session:** the three items this doc flagged
> as gaps in the TL;DR and "Bottom line" table below have been addressed:
> `pnpm -r build` now exits 0 (packages/discovery/well_known.ts no longer
> depends on express -- see `fix/build-and-persistence` branch/PR); the
> appointment endpoints (`POST /v1/appointments`, `/cancel`, `/reschedule`)
> now read/write real Postgres via `packages/api/src/repositories/` and
> `packages/api/migrations/`, verified against the actual compose Postgres
> (the in-memory repo is kept as a fast test double, selected automatically
> when `DATABASE_URL` isn't set); and `packages/adapters/mcp` and
> `packages/widget` each went from zero tests to real smoke tests (the
> widget one caught and fixed a genuine shipped bug -- `dist/loader.js` had
> a trailing ESM `export {}` that would SyntaxError as the classic
> `<script>` tag it's actually loaded as on customer sites). Still
> unaddressed, as before: no OAuth flow, `/v1/services` and
> `/v1/availability` are still stubs, and nothing is deployed/hosted. See
> the newest `tmp/wrapups/*.yaml` for the full verification commands.

> **Update — 2026-09-08, next session:** the "no OAuth flow" and
> "`/v1/availability`/appointments never call the connectors" gaps below
> are now addressed. `GET /oauth/:provider/start` + `/callback` implement
> a real authorization-code flow for Google and Microsoft, with tokens
> encrypted at rest (AES-256-GCM, `TOKEN_ENCRYPTION_KEY`) in a new
> `oauth_tokens` Postgres table and transparent refresh via
> `getValidAccessToken()`. `POST /v1/appointments` (when `provider` is
> set) and `GET /v1/availability` (when `accountId`/`provider`/`calendarId`
> are set) now call the Python connectors through a JSON-over-stdio CLI
> bridge (`packages/connectors-py/src/connectors/cli.py`, invoked by
> `packages/api/src/connectors/python-calendar-connector.ts`) for real
> busy-checking (409 on conflict) and event creation, storing
> `provider_event_id`. Verified for real, not just "it compiles": a local
> mock OAuth provider drives the entire redirect chain and a genuine
> refresh-token exchange (`packages/api/test/oauth-flow.test.js`, no real
> Google/Microsoft client ids used), and one integration test
> (`appointments-connector-integration.test.js`) leaves the real
> `PythonCalendarConnector` in place and points `google.py` at a fake
> Google Calendar HTTP server, so it exercises the actual TS -> subprocess
> -> Python -> HTTP path end to end. `pnpm test` (all suites) is green.
> Both endpoints stay fully backward compatible when `provider` is
> omitted (existing callers like `packages/adapters/mcp` don't send one).
> `/v1/services` is still a stub (no services table); Microsoft's
> equivalent connector path is only unit-tested, not integration-tested
> the way Google's is (see `plan.yaml` P2-2); nothing is deployed/hosted.
> See the newest `tmp/wrapups/*.yaml`.

## TL;DR

- **The Python calendar-connector library and the WordPress plugin
  generator are real and tested.** Both work as documented once the
  documented CLI commands are actually fixed (see P7-2 below).
- **The TypeScript API is a stub.** `/v1/services` and `/v1/availability`
  return hardcoded empty arrays. `/v1/appointments` only writes to an
  in-memory `Map` — nothing is persisted, nothing touches Postgres/Redis,
  and nothing calls the Python calendar connectors. Restarting the process
  loses all bookings.
- **Postgres and Redis are provisioned but unused.** `infra/docker-compose.dev.yml`
  starts real Postgres 14 and Redis 6 containers, but there is no code
  anywhere in the repo (grepped `packages/`, `tools/`) that opens a
  connection to either — no `pg`, no `redis` client, no `DATABASE_URL` /
  `REDIS_URL` reads. `plan.yaml` marks P1-3 "Booking engine idempotent" and
  P2 "Calendar Connectors" as `done`; the booking engine's idempotency is
  in-memory only, and the calendar connectors are a disconnected Python
  library that the API never calls.
- **There is no OAuth flow.** `packages/connectors-py/src/connectors/google.py`
  and `microsoft.py` call the Google/Microsoft Calendar APIs given a bearer
  `token` argument, but nothing in the repo obtains that token — no
  authorization-code exchange, no client-secret usage, no redirect
  handling. `.env.example` documents `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `MS_CLIENT_ID`, etc., but a repo-wide grep for
  `process.env.` shows only `PORT`, `AGENT_HMAC_SECRET`, `API_BASE`, and
  `MCP_PORT` are ever actually read. `DATABASE_URL`, `REDIS_URL`,
  `JWT_SECRET`, `GOOGLE_*`, `MS_*`, `EMAIL_*`, `TWILIO_*`, `OPENAI_API_KEY`,
  `LLM_*`, and `STRIPE_*` are all declared in `.env.example` but unused.
- **The WordPress plugin generator and Docker test environment now work
  end to end** (previously they didn't, despite an Aug-2025 commit message
  claiming they did — see P7 section). Verified: generate → zip → `php -l`
  on every file → real `wp core install` → `wp plugin activate` → widget
  script and JSON-LD both render on the front end → clean deactivate/
  reactivate, no PHP errors in `debug.log`.
- **`pnpm -r build` fails** (exit 2) out of the box. `packages/api`'s
  `tsc` build pulls in `packages/discovery/well_known.ts`, which imports
  `express` — a dependency only installed inside `packages/api`, not
  `packages/discovery`. This is a real, reproducible build break, separate
  from the P7 items below (out of this task's scope to fix; recorded here
  so it isn't mistaken for "done").

## Environment used for this check

No prior installs existed on the machine that ran this check:

```
docker: not found
pnpm:   not found
corepack: not found
php:    not found
node:   v26.7.0 (present)
python3: 3.14.7 (present)
```

Installed via Homebrew / npm to run the checks (all local, no accounts,
no hosting, nothing deployed):

```bash
npm install -g pnpm@9
brew install colima docker docker-compose   # Docker Desktop not required
colima start --cpu 2 --memory 4 --disk 20
brew install php                             # for `php -l` linting only
```

If Docker/colima genuinely cannot be installed in your environment, the
Python test suite and the Node `--test` suites below still run without
it — only the two `docker compose up` steps require it.

## 1. Dependency install

```bash
pnpm i                                                   # OK, 105 packages
python3 -m venv .venv && source .venv/bin/activate
pip install -r packages/connectors-py/requirements.txt   # OK
```

## 2. Infra: `infra/docker-compose.dev.yml`

```bash
docker compose -f infra/docker-compose.dev.yml up -d
# -> infra-db-1 (postgres:14) and infra-redis-1 (redis:6) start cleanly
docker compose -f infra/docker-compose.dev.yml exec db pg_isready -U user -d smb
# -> /var/run/postgresql:5432 - accepting connections
docker compose -f infra/docker-compose.dev.yml exec redis redis-cli ping
# -> PONG
docker compose -f infra/docker-compose.dev.yml down
```

Both containers come up and respond correctly. **Nothing in the codebase
uses them** (see TL;DR). The compose file itself is fine; the gap is that
the API was never wired to it.

## 3. Full test suite

### Python (connectors / availability / DST)

```bash
source .venv/bin/activate && pytest
# 18 passed in 0.15s
```

All 18 tests pass — this is the most solid, real part of the repo. DST
handling, ICS busy-block parsing, Google/Microsoft busy-merge logic are
genuinely covered.

### TypeScript API

```bash
cd packages/api && npx tsc -p tsconfig.json
# ../discovery/well_known.ts(1,24): error TS2307: Cannot find module 'express'
# ../discovery/well_known.ts(3,48/54): error TS7006: implicit 'any'
# exit code 2 (but *does* still emit dist/, since noEmitOnError isn't set)
node --test test/*.test.js
# 2/2 pass (idempotency + PII redaction), because dist/ happened to be
# emitted despite the compile error above
```

`pnpm --filter @smb/api build` (the officially documented build command)
**fails outright** — see the `pnpm -r build` note in the TL;DR. The two
`node --test` cases pass today only because `tsc` emits JS on type errors
by default; a stricter build (`noEmitOnError: true`, or CI that checks the
build exit code) would correctly fail here.

### Widget

```bash
cd packages/widget && npx tsc -p tsconfig.json
# builds cleanly, no errors
```

No tests exist for `packages/widget`, `packages/discovery`, or
`packages/adapters/mcp` — zero test files in any of the three.

### WordPress adapter generator (new — see P7-2/P7-4 below)

```bash
pnpm test:adapter-gen
# ✔ generator produces a WordPress plugin from the manifest
# ✔ generated plugin packages into a zip
# ✔ every generated PHP file passes php -l
# 3 pass, 0 fail
```

## 4. P7 fixes

### P7-2 — Fix TypeScript adapter-generator compilation (done)

**What was actually broken:** the documented command in `CLAUDE.md`,

```bash
pnpm generate:adapter --manifest platforms/wordpress.manifest.yaml
```

silently produced garbage. The root `package.json` script was
`"generate:adapter": "ts-node tools/adapter-gen/index.ts --manifest"` —
it already baked in `--manifest`, so pnpm's forwarded args doubled it up
to `--manifest --manifest platforms/wordpress.manifest.yaml`. The
generator's naive `args.indexOf('--manifest')` then read `args[idx+1]` as
the literal string `"--manifest"` as the manifest **path**, and silently
generated a plugin with none of the manifest's content. Confirmed with the
actual output before the fix: `Loaded manifest: --manifest`.

On top of that, the generator never parsed the YAML manifest at all — it
just copied static templates and replaced a `{{PLUGIN_NAME}}` token that
didn't even exist in the templates. The manifest's `plugin.name`,
`plugin.version`, `plugin.description`, `plugin.author`, `plugin.php`,
`injection.script_url`, and `injection.jsonld` were all ignored.

**Fix:**
- `package.json`: `generate:adapter` script no longer hardcodes
  `--manifest`, so the documented CLI usage works.
- `tools/adapter-gen/index.ts`: now reads and parses the YAML manifest
  (added `yaml` as a root devDependency — it wasn't hoisted to the repo
  root before), validates required sections, and substitutes real
  placeholders (`{{PLUGIN_SLUG}}`, `{{PLUGIN_NAME}}`, `{{PLUGIN_VERSION}}`,
  `{{PLUGIN_DESCRIPTION}}`, `{{PLUGIN_AUTHOR}}`, `{{PLUGIN_MIN_PHP}}`,
  `{{SCRIPT_URL}}`, `{{JSONLD_DEFAULT_JSON}}`) into the four `.tmpl`
  templates.
- Output directory is cleared before each generation
  (`fs.rmSync(dest, { recursive: true, force: true })`), removing stale
  duplicate files that had accumulated from earlier broken runs
  (`platforms_out/wordpress-plugin/{AdminPage,JsonLdRenderer,ScriptInjector}.php`
  at the top level, alongside the correct `includes/` copies).

**Verification:**
```bash
pnpm generate:adapter --manifest platforms/wordpress.manifest.yaml
#  Loaded manifest: platforms/wordpress.manifest.yaml
#  Generated WordPress plugin at .../platforms_out/wordpress-plugin
#    slug: ai-smb-booker  version: 0.1.0
```
Generated `plugin.php` now has the real manifest values (`Plugin Name: AI
SMB Booker`, `Version: 0.1.0`, `Requires PHP: 7.4`, etc.) with **zero**
unresolved `{{...}}` tokens (asserted by the new test).

### P7-3 — Enable plugin volume mount in docker-compose (verified, already correct)

`platforms/wordpress-plugin/docker-compose.test.yml` already had the
correct volume mount:

```yaml
volumes:
  - ../../platforms_out/wordpress-plugin:/var/www/html/wp-content/plugins/ai-smb-booker
```

This line was added in commit `c1276f3` (Aug 2025), which also claimed to
have fixed P7-2 — but `plan.yaml` still listed both as `todo`, and neither
had ever actually been run against a live Docker daemon (no Docker was
installed on any machine that had touched this repo, based on the
absence of any `tmp/wrapups/` entry mentioning it). So the mount's
correctness had never been verified. It is now:

```bash
cd platforms/wordpress-plugin
docker compose -f docker-compose.test.yml up -d
docker compose -f docker-compose.test.yml exec wordpress \
  ls -la /var/www/html/wp-content/plugins/ai-smb-booker
#  includes/
#  plugin.php
```
The freshly generated files (matching the host-side regeneration) are
visible inside the container immediately, confirming the bind mount is
correctly wired.

### P7-4 — End-to-end WordPress plugin testing (done, real verification)

Beyond the automated `pnpm test:adapter-gen` suite (generate → zip →
`php -l` on every file — see above), a full live install was run against
a real WordPress 6.4 + MySQL 8 container using WP-CLI:

```bash
docker compose -f platforms/wordpress-plugin/docker-compose.test.yml up -d

# install WP-CLI inside the container
curl -s -o /usr/local/bin/wp \
  https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar
chmod +x /usr/local/bin/wp

wp core install --allow-root \
  --url=http://localhost:8080 --title="ChatNBook Test" \
  --admin_user=admin --admin_password=admin \
  --admin_email=admin@example.com --skip-email
#  Success: WordPress installed successfully.

wp plugin activate ai-smb-booker --allow-root
#  Plugin 'ai-smb-booker' activated.
#  Success: Activated 1 of 1 plugins.

tail /var/www/html/wp-content/debug.log
#  no such file — no PHP warnings/errors were logged

curl -s http://localhost:8080/ | grep -iE "ld\+json|widget.js"
#  <script type="application/ld+json">{"@context":"https:\/\/schema.org", ...
#  <script src="https://cdn.example.com/widget.js" async data-account="acct_demo"></script>

wp plugin deactivate ai-smb-booker --allow-root && \
wp plugin activate ai-smb-booker --allow-root
#  clean deactivate/reactivate, no errors

docker compose -f platforms/wordpress-plugin/docker-compose.test.yml down
```

This confirms the generated plugin: installs, activates without PHP
errors, injects the JSON-LD block in `<head>`, injects the widget
`<script>` tag in the footer, and deactivates/reactivates cleanly. This is
the strongest end-to-end evidence anywhere in the repo that something
actually works against a real running system (as opposed to a unit test
against in-memory stubs).

**What P7-4 does *not* cover** (out of scope for this task, flagged for
the next work item in `plan.yaml`/`chatnbook.md`): the admin settings page
still has no real OAuth connect flow (its `render()` just prints static
text), the widget script points at a placeholder CDN URL
(`https://cdn.example.com/widget.js`) rather than a hosted build of
`packages/widget`, and there's no automated browser test (e.g. a
Puppeteer check that the widget actually renders and completes a booking)
— only server-rendered HTML was inspected.

## Bonus find: `plan.yaml` itself didn't parse

`plan.yaml` line 70 had an unquoted `title: Agent DOM mode (?agent=1)`
inside a flow mapping (`{ id: ..., title: ..., ... }`). YAML's flow
mapping syntax treats a bare `?` specially, so any strict YAML parser
(Python's `pyyaml`, `js-yaml`, etc.) throws a `ParserError` on this file
as it existed before this change — confirmed with
`python3 -c "import yaml; yaml.safe_load(open('plan.yaml'))"` against
`git show HEAD:plan.yaml`. Nothing in this repo currently parses
`plan.yaml` programmatically (grepped for it — zero hits), so this had
gone unnoticed, but it means any future tooling built against this file
would break immediately. Fixed by quoting that one title.

## Bottom line for `chatnbook.md`'s "Definition of shipped"

| Requirement | Reality |
|---|---|
| Hosted API with Postgres+Redis, HTTPS | Not hosted. Postgres/Redis containers work locally but the API doesn't use them. |
| WP plugin a non-developer can install, real booking against Google Calendar | Plugin now generates/installs/activates cleanly (verified above). It renders a **stub** widget URL and stub JSON-LD; the API behind it doesn't create real Google Calendar events — `/v1/appointments` only writes to an in-memory Map. |
| Stripe Checkout | No billing code exists; `.env.example` has unused Stripe var names only. |
| One pilot customer | N/A — nothing is live to pilot. |

Estimate of remaining work to reach "useful enough to sell" is unchanged
from `chatnbook.md`'s prior estimate (35-40%) for the API/booking side;
the **WordPress packaging pipeline** (generate → zip → install → activate)
that this task covered is now solid and genuinely verified, not just
scaffolded.
