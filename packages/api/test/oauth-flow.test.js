// Exercises the real OAuth authorization-code flow (GET /oauth/:provider/start
// -> redirect -> GET /oauth/:provider/callback -> token exchange -> encrypted
// storage), plus refresh handling, against a local mock OAuth provider (see
// test/helpers/mock-oauth-provider.mjs) -- no real Google/Microsoft client
// ids or network access required. Also confirms the stored tokens are
// actually encrypted at rest (not plaintext) and are usable end to end by
// wiring a fake CalendarConnector and checking it receives the decrypted
// access token minted by the mock provider.
import test from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { startMockOAuthProvider } from './helpers/mock-oauth-provider.mjs';

process.env.NODE_ENV = 'test';
process.env.AGENT_HMAC_SECRET = 'testsecret';
process.env.TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
// Real client id/secret aren't needed -- the mock provider doesn't check
// them -- but they must be *set* since providers.ts requires the env vars
// to exist (mirrors the real Google/Microsoft requirement).
process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret';
process.env.MS_CLIENT_ID = 'test-ms-client-id';
process.env.MS_CLIENT_SECRET = 'test-ms-client-secret';

const {
  app,
  resetOAuthTokens,
  closeRepositories,
  setCalendarConnectorForTest,
  getOAuthTokensRepoForTest,
} = await import('../dist/api/src/index.js');
const { decrypt } = await import('../dist/api/src/oauth/crypto.js');

test('OAuth authorization-code flow (Google, via mock provider)', async (t) => {
  await resetOAuthTokens();
  const mock = await startMockOAuthProvider();
  t.after(() => mock.close());

  const server = app.listen(0);
  t.after(() => server.close());
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  process.env.GOOGLE_REDIRECT_URI = `${base}/oauth/google/callback`;
  process.env.GOOGLE_OAUTH_AUTH_URL = mock.authUrl;
  process.env.GOOGLE_OAUTH_TOKEN_URL = mock.tokenUrl;

  await t.test('start redirects to the provider auth URL with client_id/state/redirect_uri', async () => {
    const res = await fetch(`${base}/oauth/google/start?accountId=acct_flow`, { redirect: 'manual' });
    assert.strictEqual(res.status, 302);
    const location = new URL(res.headers.get('location'));
    assert.strictEqual(`${location.origin}${location.pathname}`, mock.authUrl);
    assert.strictEqual(location.searchParams.get('client_id'), 'test-google-client-id');
    assert.strictEqual(location.searchParams.get('redirect_uri'), process.env.GOOGLE_REDIRECT_URI);
    assert.strictEqual(location.searchParams.get('response_type'), 'code');
    assert.ok(location.searchParams.get('state'), 'state param present');
  });

  await t.test('start requires accountId', async () => {
    const res = await fetch(`${base}/oauth/google/start`, { redirect: 'manual' });
    assert.strictEqual(res.status, 400);
  });

  await t.test('unknown provider is 404 on both routes', async () => {
    const startRes = await fetch(`${base}/oauth/dropbox/start?accountId=x`, { redirect: 'manual' });
    assert.strictEqual(startRes.status, 404);
    const cbRes = await fetch(`${base}/oauth/dropbox/callback?code=x&state=y`);
    assert.strictEqual(cbRes.status, 404);
  });

  let issuedAccessToken;

  await t.test('full redirect chain (start -> mock provider -> callback) stores an encrypted token', async () => {
    // Follow the whole chain like a browser would: our /start redirects to
    // the mock provider's /authorize, which redirects back to our
    // /callback, which does the code<->token exchange and responds JSON.
    const res = await fetch(`${base}/oauth/google/start?accountId=acct_flow`);
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.deepStrictEqual(
      { accountId: json.accountId, provider: json.provider, connected: json.connected },
      { accountId: 'acct_flow', provider: 'google', connected: true }
    );
    assert.ok(json.expiresAt);

    const repo = getOAuthTokensRepoForTest();
    const record = await repo.getByAccountAndProvider('acct_flow', 'google');
    assert.ok(record, 'token row was persisted');
    assert.ok(mock.issuedAccessTokens.size > 0, 'mock provider actually issued a token');

    // Encrypted at rest: the stored ciphertext must not contain the
    // plaintext access token, but decrypting it must recover exactly what
    // the mock provider issued.
    const decrypted = decrypt(record.accessTokenEncrypted);
    assert.ok(mock.issuedAccessTokens.has(decrypted), 'decrypted value matches an issued access token');
    assert.ok(!record.accessTokenEncrypted.includes(decrypted), 'stored value is not the plaintext token');
    assert.ok(record.refreshTokenEncrypted, 'refresh token was stored');
    const decryptedRefresh = decrypt(record.refreshTokenEncrypted);
    assert.ok(mock.issuedRefreshTokens.has(decryptedRefresh));

    issuedAccessToken = decrypted;
  });

  await t.test('callback rejects a tampered state signature', async () => {
    const res = await fetch(`${base}/oauth/google/start?accountId=acct_tamper`, { redirect: 'manual' });
    const location = new URL(res.headers.get('location'));
    const goodState = location.searchParams.get('state');
    const tamperedState = goodState.slice(0, -2) + (goodState.at(-2) === 'A' ? 'B' : 'A') + goodState.at(-1);
    const cbRes = await fetch(`${base}/oauth/google/callback?code=whatever&state=${tamperedState}`);
    assert.strictEqual(cbRes.status, 400);
    const body = await cbRes.json();
    assert.match(body.error, /invalid state/);
  });

  await t.test('callback requires code and state', async () => {
    const noCode = await fetch(`${base}/oauth/google/callback?state=x`);
    assert.strictEqual(noCode.status, 400);
    const noState = await fetch(`${base}/oauth/google/callback?code=x`);
    assert.strictEqual(noState.status, 400);
  });

  await t.test('stored token is usable end to end by the calendar connector', async () => {
    let receivedToken;
    setCalendarConnectorForTest({
      async getBusy(params) {
        receivedToken = params.token;
        return [];
      },
      async createEvent() {
        return { eventId: 'evt_from_fake' };
      },
      async computeAvailability({ start, end }) {
        return [{ start, end }];
      },
    });
    t.after(() => setCalendarConnectorForTest(new (class {
      async getBusy() { return []; }
      async createEvent() { return { eventId: 'unused' }; }
      async computeAvailability() { return []; }
    })()));

    const res = await fetch(
      `${base}/v1/availability?accountId=acct_flow&provider=google&calendarId=cal1&start=2026-11-01T09:00:00Z&end=2026-11-01T10:00:00Z`
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(receivedToken, issuedAccessToken);
  });

  await t.test('refresh: an expired access token is transparently refreshed using the stored refresh token', async () => {
    const repo = getOAuthTokensRepoForTest();
    const before = await repo.getByAccountAndProvider('acct_flow', 'google');
    // Force expiry so getValidAccessToken() must refresh.
    await repo.upsert({
      accountId: 'acct_flow',
      provider: 'google',
      accessTokenEncrypted: before.accessTokenEncrypted,
      refreshTokenEncrypted: before.refreshTokenEncrypted,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      scope: before.scope,
    });

    let receivedToken;
    setCalendarConnectorForTest({
      async getBusy(params) {
        receivedToken = params.token;
        return [];
      },
      async createEvent() {
        return { eventId: 'unused' };
      },
      async computeAvailability() {
        return [];
      },
    });

    const res = await fetch(
      `${base}/v1/availability?accountId=acct_flow&provider=google&calendarId=cal1&start=2026-11-01T09:00:00Z&end=2026-11-01T10:00:00Z`
    );
    assert.strictEqual(res.status, 200);
    assert.ok(mock.issuedAccessTokens.has(receivedToken), 'refreshed token was actually minted by the provider');
    assert.notStrictEqual(receivedToken, issuedAccessToken, 'a *new* access token was issued, not the stale one');

    const after = await repo.getByAccountAndProvider('acct_flow', 'google');
    assert.ok(new Date(after.expiresAt).getTime() > Date.now(), 'stored expiry was updated to a future time');
  });

  await t.test('availability for an unconnected account/provider returns 400, not a 500 or empty stub', async () => {
    const res = await fetch(
      `${base}/v1/availability?accountId=acct_never_connected&provider=google&calendarId=cal1&start=2026-11-01T09:00:00Z&end=2026-11-01T10:00:00Z`
    );
    assert.strictEqual(res.status, 400);
    const json = await res.json();
    assert.match(json.error, /no google calendar connected/);
  });

  t.after(async () => {
    await closeRepositories();
  });
});
