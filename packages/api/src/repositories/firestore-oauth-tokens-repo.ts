import type { Firestore } from 'firebase-admin/firestore';
import type {
  OAuthProvider,
  OAuthTokenRecord,
  OAuthTokensRepository,
  UpsertOAuthTokenInput,
} from './oauth-tokens-repo.js';
import { getFirestoreDb, closeFirestoreClient } from './firestore-client.js';
import { deleteCollection } from './firestore-appointments-repo.js';

const OAUTH_TOKENS_COLLECTION = 'oauth_tokens';

/** One document per (accountId, provider), matching the Postgres unique
 * constraint (migrations/002_create_oauth_tokens.sql). Doc id is a
 * composite key since Firestore documents need a single string id. */
function docId(accountId: string, provider: OAuthProvider): string {
  return `${accountId}__${provider}`;
}

/** Firestore-backed OAuthTokensRepository -- same selection rule and
 * database as the other Firestore repositories (see index.ts). Tokens
 * arrive already encrypted (see ../oauth/crypto.ts); this class never
 * sees plaintext, same as the Pg/in-memory implementations. */
export class FirestoreOAuthTokensRepository implements OAuthTokensRepository {
  private db: Firestore;

  constructor(projectId: string) {
    this.db = getFirestoreDb(projectId);
  }

  async upsert(input: UpsertOAuthTokenInput): Promise<OAuthTokenRecord> {
    const ref = this.db.collection(OAUTH_TOKENS_COLLECTION).doc(docId(input.accountId, input.provider));
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const now = new Date().toISOString();
      const existing = snap.exists ? (snap.data() as OAuthTokenRecord) : null;
      const record: OAuthTokenRecord = {
        accountId: input.accountId,
        provider: input.provider,
        accessTokenEncrypted: input.accessTokenEncrypted,
        refreshTokenEncrypted: input.refreshTokenEncrypted,
        expiresAt: input.expiresAt,
        scope: input.scope,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      tx.set(ref, record);
      return record;
    });
  }

  async getByAccountAndProvider(
    accountId: string,
    provider: OAuthProvider
  ): Promise<OAuthTokenRecord | null> {
    const snap = await this.db.collection(OAUTH_TOKENS_COLLECTION).doc(docId(accountId, provider)).get();
    return snap.exists ? (snap.data() as OAuthTokenRecord) : null;
  }

  async reset(): Promise<void> {
    await deleteCollection(this.db, OAUTH_TOKENS_COLLECTION);
  }

  async close(): Promise<void> {
    await closeFirestoreClient();
  }
}
