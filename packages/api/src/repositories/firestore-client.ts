// Shared Firestore client for the Firestore-backed repositories
// (firestore-appointments-repo.ts, firestore-services-repo.ts,
// firestore-oauth-tokens-repo.ts). Selected instead of Postgres/in-memory
// when FIRESTORE_PROJECT_ID is set and DATABASE_URL isn't (see index.ts).
//
// Cloud Run: the default compute service account already has
// `roles/editor` on arborfam-hub, which covers Firestore read/write, so no
// service-account key/credentials file is needed in production --
// `admin.credential.applicationDefault()` picks up the attached identity
// automatically.
//
// Local/CI tests: point FIRESTORE_EMULATOR_HOST (e.g. 127.0.0.1:8080, what
// `firebase emulators:exec` sets) at a running Firestore emulator. The
// Admin SDK auto-detects that env var and talks to the emulator instead of
// real Firestore -- no credentials needed either way, since the emulator
// doesn't check them.
import admin from 'firebase-admin';
import type { Firestore } from 'firebase-admin/firestore';

let cachedApp: admin.app.App | null = null;
let cachedProjectId: string | null = null;

/** Returns a singleton Firestore client for `projectId`. Safe to call
 * repeatedly (each repository constructor calls it) -- only initializes
 * the underlying admin app once. Throws if called twice with two
 * *different* project ids within the same process, since that would mean
 * two repositories disagree about which Firestore database to use. */
export function getFirestoreDb(projectId: string): Firestore {
  if (cachedApp) {
    if (cachedProjectId !== projectId) {
      throw new Error(
        `getFirestoreDb: already initialized for project "${cachedProjectId}", cannot also use "${projectId}"`
      );
    }
    return admin.firestore(cachedApp);
  }
  cachedApp = admin.initializeApp({
    projectId,
    credential: admin.credential.applicationDefault(),
  });
  cachedProjectId = projectId;
  const db = admin.firestore(cachedApp);
  // Undefined fields (e.g. an optional field left out of an object spread)
  // should be dropped rather than throwing -- matches how the Pg/in-memory
  // repositories silently treat "not provided" the same as "null" in most
  // places.
  db.settings({ ignoreUndefinedProperties: true });
  return db;
}

/** Test-only: drops the cached app so a test file can re-initialize
 * against a different project id (e.g. the Firestore emulator's demo
 * project) without leaking state between test files/processes. */
export async function resetFirestoreClientForTest(): Promise<void> {
  if (cachedApp) {
    await cachedApp.delete();
    cachedApp = null;
    cachedProjectId = null;
  }
}

/** The three Firestore repositories (appointments/services/oauth-tokens)
 * share this one cached app, so `close()` is idempotent and safe to call
 * from all three -- only the first call actually tears the gRPC channel
 * down (needed so a `node --test` process can exit cleanly instead of
 * hanging on an open connection), the rest are no-ops. */
export async function closeFirestoreClient(): Promise<void> {
  if (!cachedApp) return;
  const app = cachedApp;
  cachedApp = null;
  cachedProjectId = null;
  await app.delete();
}
