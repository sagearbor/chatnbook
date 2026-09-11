# Deploying the API

This covers building/running the `@smb/api` server as a container, and
deploying it to Google Cloud Run. See the repo-root `Dockerfile` (multi-stage
Node 22 build + a Python venv for the calendar connectors),
`infra/docker-compose.dev.yml` (an `api` service for local end-to-end runs
against Postgres/Redis), and `infra/deploy-cloudrun.sh` (the Cloud Run
deploy script).

## What's in the image

- `packages/api` compiled with `tsc` and deployed production-only via
  `pnpm --filter @smb/api --prod deploy` (dist/, migrations/, scripts/,
  openapi/, and a node_modules with just its runtime deps: express, cors,
  pg -- no TypeScript/devDependencies).
- `packages/widget/dist` (the pre-built chat/booking widget bundle), served
  as static files by the API. Its path defaults to
  `/app/packages/widget/dist`, overridable via `WIDGET_DIST_DIR`.
- `packages/connectors-py/src`, the Python package the API shells out to
  (`python3 -m connectors.cli`) for Google/Microsoft/ICS calendar reads and
  writes. Only its runtime deps -- `pytz`, `icalendar`, `requests` -- are
  installed into an image-local virtualenv at `/opt/venv`; `pytest`/
  `responses` (test-only, see `packages/connectors-py/requirements.txt`)
  are not part of the image.

The three pieces are kept at their normal workspace-relative paths inside
the image (`/app/packages/api`, `/app/packages/widget/dist`,
`/app/packages/connectors-py/src`) because
`packages/api/src/connectors/python-calendar-connector.ts` locates the
connectors by walking up from its own file looking for
`packages/connectors-py/src` (or the `CONNECTORS_PY_SRC` override).

## Local: build and run with plain Docker

```bash
docker build -t chatnbook-api .
docker run -d --name chatnbook-api -p 3000:3000 \
  -e AGENT_HMAC_SECRET=dev-secret \
  -e TOKEN_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  chatnbook-api

curl http://localhost:3000/health
curl 'http://localhost:3000/v1/services?accountId=acct_demo'
docker rm -f chatnbook-api
```

With `DATABASE_URL` unset (as above), the API runs on its in-memory
repositories -- see "In-memory mode" below.

## Local: build and run via docker compose

`infra/docker-compose.dev.yml` gets a Postgres (`db`) and Redis (`redis`)
for local dev; the `api` service builds and runs this repo's Dockerfile
against them. It's behind a `profiles: ["api"]` gate so the default
`docker compose up -d` (just db + redis, used by the test suite) is
unaffected:

```bash
# db + redis only (existing default behaviour, unchanged):
docker compose -f infra/docker-compose.dev.yml up -d

# also build and run the API container against them:
docker compose -f infra/docker-compose.dev.yml --profile api up -d --build api

curl http://localhost:3000/health

# tear down just the api container, leaving db/redis running:
docker compose -f infra/docker-compose.dev.yml --profile api rm -sf api
```

The compose `api` service sets `DATABASE_URL` to the compose `db` service,
so this path runs and applies real migrations (`scripts/migrate.js`) rather
than the in-memory repositories.

## Deploying to Cloud Run

```bash
./infra/deploy-cloudrun.sh
# or override project/region/service:
GCP_PROJECT=my-project ./infra/deploy-cloudrun.sh
./infra/deploy-cloudrun.sh my-project us-central1 chatnbook-api
```

This deploys `--source .` so Cloud Build builds the repo-root `Dockerfile`
-- no local Docker required to deploy. It resolves `AGENT_HMAC_SECRET`,
`TOKEN_ENCRYPTION_KEY`, and `ADMIN_API_KEY` from (in order) the real
environment, then a repo-root `.env`, generating fresh random values with
`openssl rand -base64 32` for anything still missing -- printing a warning
and saving generated values to `tmp/cloudrun-secrets.env` (chmod 600,
gitignored) so they aren't lost, and can be copied into `.env` to keep them
stable across future deploys. It prints the deployed service URL and curls
`/health` to confirm the deploy is live.

Prerequisites: `gcloud` installed and authenticated (`gcloud auth login`),
and a GCP project with billing enabled. The script does not create either.

## In-memory mode (default demo config)

With `DATABASE_URL` unset, `@smb/api` falls back to its in-memory
repositories (`packages/api/src/repositories/memory-*.ts`) instead of
Postgres. **This is the mode the Cloud Run demo instance runs in by
default.** It means:

- No database to provision or migrate for the demo.
- **All data resets on every cold start** (and on every deploy/restart) --
  appointments, OAuth tokens, and services are held only in the running
  process's memory.

## Attaching a real Postgres later

To move a deployed instance off in-memory storage, provision a Postgres
(e.g. Cloud SQL) and point `DATABASE_URL` at it:

```bash
gcloud run services update chatnbook-api --region us-central1 \
  --update-env-vars DATABASE_URL=postgres://user:pass@host:5432/smb
```

Run `pnpm --filter @smb/api db:migrate` (with `DATABASE_URL` pointed at
that database) before or right after the update to apply
`packages/api/migrations/*.sql`, or restart the container the same way
`infra/docker-entrypoint.sh` does: it runs `node scripts/migrate.js`
automatically on container start whenever `DATABASE_URL` is set.

**Note:** `gcloud run deploy --set-env-vars` (used by
`infra/deploy-cloudrun.sh`) *replaces* the service's entire env var set on
every deploy. If you attach `DATABASE_URL` via `services update` as above,
keep it in your repo-root `.env` too (the deploy script passes it through
when present), or a later run of `infra/deploy-cloudrun.sh` will silently
drop it back to in-memory mode.

## Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `PORT` | no | Cloud Run injects this itself; defaults to `3000` locally. |
| `AGENT_HMAC_SECRET` | yes | Signs/verifies agent API calls and the OAuth state parameter. |
| `TOKEN_ENCRYPTION_KEY` | yes | `openssl rand -base64 32`; AES-256-GCM key for OAuth tokens at rest. |
| `ADMIN_API_KEY` | for admin routes | Passed through by `infra/deploy-cloudrun.sh`; generated ephemerally if unset. |
| `DATABASE_URL` | no | Unset = in-memory repositories (see above). Set = Postgres, migrated on start. |
| `SEED_DEMO_ACCOUNT` | no | Set to `acct_demo` by the compose service and deploy script. |
| `PUBLIC_API_BASE` | no | Public base URL of the deployed API. |
| `BUSINESS_TZ` | no | Default business timezone, e.g. `America/New_York`. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | for Google OAuth | See `.env.example`; passed through when set. |
| `MS_CLIENT_ID` / `MS_CLIENT_SECRET` / `MS_REDIRECT_URI` / `MS_TENANT` | for Microsoft OAuth | See `.env.example`; passed through when set. |
| `PYTHON_BIN` | no | Set inside the image to the venv Python (`/opt/venv/bin/python3`); override only if replacing the connectors runtime. |
| `CONNECTORS_PY_SRC` | no | Set inside the image; override only for non-standard layouts. |
| `WIDGET_DIST_DIR` | no | Set inside the image to `/app/packages/widget/dist`; override to serve a different widget build. |

See `.env.example` for the full local-dev env var list and
`agents/agent_instructions.yaml` for the broader environment variable
reference.
