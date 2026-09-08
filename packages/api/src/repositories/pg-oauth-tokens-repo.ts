import pg from 'pg';
import type {
  OAuthProvider,
  OAuthTokenRecord,
  OAuthTokensRepository,
  UpsertOAuthTokenInput,
} from './oauth-tokens-repo.js';

const { Pool } = pg;

interface OAuthTokenRow {
  account_id: string;
  provider: OAuthProvider;
  access_token_encrypted: string;
  refresh_token_encrypted: string | null;
  expires_at: Date;
  scope: string | null;
  created_at: Date;
  updated_at: Date;
}

function toRecord(row: OAuthTokenRow): OAuthTokenRecord {
  return {
    accountId: row.account_id,
    provider: row.provider,
    accessTokenEncrypted: row.access_token_encrypted,
    refreshTokenEncrypted: row.refresh_token_encrypted,
    expiresAt: row.expires_at.toISOString(),
    scope: row.scope,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Real Postgres-backed OAuthTokensRepository. One row per (account_id,
 * provider) -- see migrations/002_create_oauth_tokens.sql for the unique
 * constraint. Tokens are stored pre-encrypted by the caller (see
 * ../oauth/crypto.ts); this class never encrypts/decrypts.
 */
export class PgOAuthTokensRepository implements OAuthTokensRepository {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async upsert(input: UpsertOAuthTokenInput): Promise<OAuthTokenRecord> {
    const result = await this.pool.query<OAuthTokenRow>(
      `INSERT INTO oauth_tokens
         (account_id, provider, access_token_encrypted, refresh_token_encrypted, expires_at, scope)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (account_id, provider) DO UPDATE SET
         access_token_encrypted = EXCLUDED.access_token_encrypted,
         refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
         expires_at = EXCLUDED.expires_at,
         scope = EXCLUDED.scope,
         updated_at = now()
       RETURNING *`,
      [
        input.accountId,
        input.provider,
        input.accessTokenEncrypted,
        input.refreshTokenEncrypted,
        input.expiresAt,
        input.scope,
      ]
    );
    return toRecord(result.rows[0]);
  }

  async getByAccountAndProvider(
    accountId: string,
    provider: OAuthProvider
  ): Promise<OAuthTokenRecord | null> {
    const result = await this.pool.query<OAuthTokenRow>(
      'SELECT * FROM oauth_tokens WHERE account_id = $1 AND provider = $2',
      [accountId, provider]
    );
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async reset(): Promise<void> {
    await this.pool.query('TRUNCATE oauth_tokens');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
