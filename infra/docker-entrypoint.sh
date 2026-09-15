#!/bin/sh
# Container entrypoint for the @smb/api image (see ../Dockerfile).
#
# Applies pending SQL migrations (packages/api/scripts/migrate.js, which
# reads migrations/*.sql relative to process.cwd()) only when DATABASE_URL
# is set -- i.e. only when there's a real Postgres to migrate. Firestore
# needs no migration step (no schema to apply -- see
# packages/api/src/repositories/firestore-*.ts). With neither DATABASE_URL
# nor FIRESTORE_PROJECT_ID set, the app falls back to its in-memory
# repositories (see packages/api/src/repositories/memory-*.ts): no data
# survives a cold start. src/index.ts logs which backend it actually picked
# ("repository backend: ...") right after this.
#
# Runs as WORKDIR /app/packages/api (set in the Dockerfile), which is why
# both `node scripts/migrate.js` and the final `dist/api/src/index.js` path
# below are relative rather than absolute.
set -eu

if [ -n "${DATABASE_URL:-}" ]; then
  echo "docker-entrypoint: DATABASE_URL is set -- applying migrations" >&2
  node scripts/migrate.js
elif [ -n "${FIRESTORE_PROJECT_ID:-}" ]; then
  echo "docker-entrypoint: FIRESTORE_PROJECT_ID is set ($FIRESTORE_PROJECT_ID) -- no migration needed" >&2
else
  echo "docker-entrypoint: neither DATABASE_URL nor FIRESTORE_PROJECT_ID is set -- running with in-memory repositories (data resets on every restart/cold start)" >&2
fi

exec node dist/api/src/index.js
