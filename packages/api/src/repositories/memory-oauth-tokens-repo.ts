import type {
  OAuthProvider,
  OAuthTokenRecord,
  OAuthTokensRepository,
  UpsertOAuthTokenInput,
} from './oauth-tokens-repo.js';

function key(accountId: string, provider: OAuthProvider): string {
  return `${accountId}::${provider}`;
}

export class InMemoryOAuthTokensRepository implements OAuthTokensRepository {
  private byKey = new Map<string, OAuthTokenRecord>();

  async upsert(input: UpsertOAuthTokenInput): Promise<OAuthTokenRecord> {
    const now = new Date().toISOString();
    const existing = this.byKey.get(key(input.accountId, input.provider));
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
    this.byKey.set(key(input.accountId, input.provider), record);
    return record;
  }

  async getByAccountAndProvider(
    accountId: string,
    provider: OAuthProvider
  ): Promise<OAuthTokenRecord | null> {
    return this.byKey.get(key(accountId, provider)) ?? null;
  }

  async reset(): Promise<void> {
    this.byKey.clear();
  }

  async close(): Promise<void> {
    // no-op
  }
}
