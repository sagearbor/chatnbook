// Integration test: FirestoreOAuthTokensRepository against a real
// Firestore emulator. Run via `pnpm --filter @smb/api test:firestore`
// (firebase emulators:exec), same as appointments-firestore.test.js.
import test from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';

process.env.NODE_ENV = 'test';
process.env.AGENT_HMAC_SECRET = 'testsecret';
process.env.FIRESTORE_PROJECT_ID = process.env.FIRESTORE_PROJECT_ID || 'demo-chatnbook';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    'oauth-tokens-firestore.test.js must run against the Firestore emulator -- ' +
      'FIRESTORE_EMULATOR_HOST is not set. Run via `pnpm --filter @smb/api test:firestore`.'
  );
}

const { getOAuthTokensRepoForTest } = await import('../../dist/api/src/index.js');

test('FirestoreOAuthTokensRepository upsert/get round-trip', async () => {
  const repo = getOAuthTokensRepoForTest();
  const accountId = `acct_oauth_${crypto.randomUUID().slice(0, 8)}`;

  const created = await repo.upsert({
    accountId,
    provider: 'google',
    accessTokenEncrypted: 'enc-access-1',
    refreshTokenEncrypted: 'enc-refresh-1',
    expiresAt: '2026-11-01T00:00:00.000Z',
    scope: 'calendar.readonly',
  });
  assert.strictEqual(created.accessTokenEncrypted, 'enc-access-1');

  const fetched = await repo.getByAccountAndProvider(accountId, 'google');
  assert.ok(fetched);
  assert.strictEqual(fetched.accountId, accountId);
  assert.strictEqual(fetched.accessTokenEncrypted, 'enc-access-1');
  assert.strictEqual(fetched.createdAt, created.createdAt);

  // A second provider for the same account is a distinct row/document --
  // the composite (accountId, provider) key, not accountId alone.
  const microsoftLookup = await repo.getByAccountAndProvider(accountId, 'microsoft');
  assert.strictEqual(microsoftLookup, null);

  // Upsert on the same (accountId, provider) replaces the token but keeps
  // the original createdAt -- mirrors the Postgres/in-memory contract.
  await new Promise((r) => setTimeout(r, 5));
  const updated = await repo.upsert({
    accountId,
    provider: 'google',
    accessTokenEncrypted: 'enc-access-2',
    refreshTokenEncrypted: 'enc-refresh-2',
    expiresAt: '2026-12-01T00:00:00.000Z',
    scope: 'calendar.readonly',
  });
  assert.strictEqual(updated.accessTokenEncrypted, 'enc-access-2');
  assert.strictEqual(updated.createdAt, created.createdAt, 'createdAt should not change on update');
  assert.notStrictEqual(updated.updatedAt, created.updatedAt);

  const refetched = await repo.getByAccountAndProvider(accountId, 'google');
  assert.strictEqual(refetched.accessTokenEncrypted, 'enc-access-2');
});

test('getByAccountAndProvider returns null for an unknown account', async () => {
  const repo = getOAuthTokensRepoForTest();
  const result = await repo.getByAccountAndProvider(`acct_unknown_${crypto.randomUUID()}`, 'google');
  assert.strictEqual(result, null);
});
