#!/bin/sh
# Container entrypoint for the @smb/api image (see ../Dockerfile).
#
# Applies pending SQL migrations (packages/api/scripts/migrate.js, which
# reads migrations/*.sql relative to process.cwd()) only when DATABASE_URL
# is set -- i.e. only when there's a real Postgres to migrate. With
# DATABASE_URL unset the app falls back to its in-memory repositories (see
# packages/api/src/repositories/), which is the expected/normal mode for
# the Cloud Run demo instance: no schema to migrate, and no data survives a
# cold start.
#
# Runs as WORKDIR /app/packages/api (set in the Dockerfile), which is why
# both `node scripts/migrate.js` and the final `dist/api/src/index.js` path
# below are relative rather than absolute.
set -eu

if [ -n "${DATABASE_URL:-}" ]; then
  echo "docker-entrypoint: DATABASE_URL is set -- applying migrations" >&2
  node scripts/migrate.js
else
  echo "docker-entrypoint: DATABASE_URL is not set -- running with in-memory repositories (data resets on every restart/cold start)" >&2
fi

exec node dist/api/src/index.js
