// Repository interface for OAuth calendar token persistence. Mirrors
// AppointmentsRepository's pattern: PgOAuthTokensRepository (real Postgres,
// used whenever DATABASE_URL is set) and InMemoryOAuthTokensRepository (a
// fast test double). Access/refresh tokens are always stored encrypted
// (see ../oauth/crypto.ts) -- this repository never sees plaintext tokens.

export type OAuthProvider = 'google' | 'microsoft';

export interface OAuthTokenRecord {
  accountId: string;
  provider: OAuthProvider;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string | null;
  expiresAt: string; // ISO-8601
  scope: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertOAuthTokenInput {
  accountId: string;
  provider: OAuthProvider;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string | null;
  expiresAt: string;
  scope: string | null;
}

export interface OAuthTokensRepository {
  /** Creates or replaces the token row for (accountId, provider). */
  upsert(input: UpsertOAuthTokenInput): Promise<OAuthTokenRecord>;
  getByAccountAndProvider(
    accountId: string,
    provider: OAuthProvider
  ): Promise<OAuthTokenRecord | null>;
  /** Test-only: clears all data. */
  reset(): Promise<void>;
  close(): Promise<void>;
}
