# chatnbook API -- production container image.
#
# Runs the compiled @smb/api Express server (packages/api) plus the Python
# calendar connectors it shells out to (packages/connectors-py) and serves
# the pre-built widget bundle (packages/widget/dist) as static files. Built
# as a multi-stage image so the final runtime layer doesn't carry the full
# pnpm workspace, devDependencies, or TypeScript sources.
#
# Build:   docker build -t chatnbook-api .
# Run:     docker run -p 3000:3000 -e AGENT_HMAC_SECRET=... \
#            -e TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32) chatnbook-api
# See docs/DEPLOY.md for the full env var list and Cloud Run deployment.

# ---------------------------------------------------------------------------
# Stage 1: build. Installs the full pnpm workspace (incl. devDependencies),
# compiles every package, then produces a production-only, self-contained
# copy of @smb/api (its own node_modules with just express/cors/pg).
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9 --activate

# Copy just the manifests needed to resolve the dependency graph first, so
# `pnpm install` is cached across builds unless a package.json/lockfile
# actually changes (this pnpm workspace currently has package.json files
# only at the repo root and under packages/api, packages/widget and
# packages/adapters/mcp -- tools/adapter-gen and platforms_out/* are
# workspace globs with no package.json in them today, so there's nothing
# to copy for them here).
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/api/package.json packages/api/package.json
COPY packages/widget/package.json packages/widget/package.json
COPY packages/adapters/mcp/package.json packages/adapters/mcp/package.json

RUN pnpm install --frozen-lockfile

# Now bring in the rest of the source (.dockerignore trims node_modules,
# dist, .git, python venvs/caches, tmp, secrets, and the platforms*
# WordPress plugin tree, none of which are needed to build or run the API).
COPY . .

# Build every workspace package (tsc for api/widget; api's build also runs
# scripts/build-openapi.js, writing packages/api/openapi/openapi.json).
# Because packages/api/src imports ../../discovery, tsc's inferred rootDir
# spans both directories, so the compiled entrypoint lands at
# packages/api/dist/api/src/index.js (dist/discovery/*.js alongside it) --
# verified below rather than assumed.
RUN pnpm -r build \
 && test -f packages/api/dist/api/src/index.js \
 && test -f packages/widget/dist/loader.js \
 && test -f packages/widget/dist/app.js \
 && test -f packages/widget/dist/main.js \
 && test -f packages/widget/dist/app.html

# Produce a clean, production-only copy of @smb/api: its compiled dist/,
# migrations/, scripts/, openapi/ and package.json, plus a fresh
# node_modules containing only its runtime deps (express, cors, pg) -- no
# typescript/ts-node/turbo/jsdom etc. This is the officially supported pnpm
# 9 workflow for exactly this ("pnpm deploy"); a plain `pnpm prune --prod`
# was tried first and rejected because it strips the workspace's per-package
# node_modules symlinks (packages/api/node_modules/*), leaving `require()`
# unable to resolve express/cors/pg at runtime -- `pnpm deploy` doesn't have
# that problem since it builds a standalone node_modules from scratch.
RUN pnpm --filter @smb/api --prod deploy /deploy/api

# ---------------------------------------------------------------------------
# Stage 2: runtime. Node 22 + a Python venv for the calendar connectors
# (packages/connectors-py) that packages/api/src/connectors/
# python-calendar-connector.ts shells out to via `python3 -m connectors.cli`.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# python3-venv (rather than a bare `pip install`) sidesteps Debian
# bookworm's PEP 668 "externally-managed-environment" restriction on the
# system Python without needing --break-system-packages. Only the three
# runtime deps the connectors actually import go in -- pytest/responses
# from packages/connectors-py/requirements.txt are test-only and are never
# installed here.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir pytz icalendar requests

ENV NODE_ENV=production \
    PYTHON_BIN=/opt/venv/bin/python3 \
    CONNECTORS_PY_SRC=/app/packages/connectors-py/src \
    WIDGET_DIST_DIR=/app/packages/widget/dist \
    PORT=3000

# Keeps the workspace-relative layout (/app/packages/api, .../widget/dist,
# .../connectors-py/src) that python-calendar-connector.ts's repo-root
# search and the widget-static-file-serving route both expect, even though
# only @smb/api's own files actually needed pnpm's workspace machinery.
WORKDIR /app/packages/api

COPY --from=build --chown=node:node /deploy/api/ ./
COPY --from=build --chown=node:node /app/packages/widget/dist /app/packages/widget/dist
COPY --from=build --chown=node:node /app/packages/connectors-py/src /app/packages/connectors-py/src

COPY infra/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# node:22-bookworm-slim ships a non-root "node" user (uid 1000) already.
USER node

EXPOSE 3000

# Node 22 has a stable global fetch, so no curl needs installing just for
# this. --start-period gives the (rare) DATABASE_URL-set migration run room
# to finish before failed checks count against the container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
