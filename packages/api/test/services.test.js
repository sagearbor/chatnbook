// Exercises GET /v1/services (real Postgres/in-memory-backed, see
// packages/api/src/repositories/services-repo.ts and
// migrations/003_create_services.sql) and the serviceId wiring in
// GET /v1/availability (honouring the service's own duration + buffer as
// the slot length).
import test from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';

process.env.NODE_ENV = 'test';
process.env.AGENT_HMAC_SECRET = 'testsecret';
process.env.TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret';
process.env.GOOGLE_REDIRECT_URI = 'http://localhost/unused';

const {
  app,
  resetServices,
  resetOAuthTokens,
  closeRepositories,
  setCalendarConnectorForTest,
  getOAuthTokensRepoForTest,
  getServicesRepoForTest,
} = await import('../dist/api/src/index.js');
const { encrypt } = await import('../dist/api/src/oauth/crypto.js');

class FakeCalendarConnector {
  constructor({ busy = [] } = {}) {
    this.busy = busy;
    this.computeAvailabilityCalls = [];
  }
  async getBusy() {
    return this.busy;
  }
  async createEvent() {
    return { eventId: 'unused' };
  }
  async deleteEvent() {}
  async computeAvailability(params) {
    this.computeAvailabilityCalls.push(params);
    return [{ start: params.start, end: params.end }];
  }
}

async function connectGoogleCalendar(accountId) {
  const repo = getOAuthTokensRepoForTest();
  await repo.upsert({
    accountId,
    provider: 'google',
    accessTokenEncrypted: encrypt('seeded-access-token'),
    refreshTokenEncrypted: encrypt('seeded-refresh-token'),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    scope: 'calendar',
  });
}

test('GET /v1/services', async (t) => {
  await resetServices();
  await resetOAuthTokens();
  const server = app.listen(0);
  t.after(async () => {
    server.close();
    await closeRepositories();
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  await t.test('requires accountId', async () => {
    const res = await fetch(`${base}/v1/services`);
    assert.strictEqual(res.status, 400);
  });

  await t.test('returns an empty list for an account with no services', async () => {
    const res = await fetch(`${base}/v1/services?accountId=acct_no_services`);
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.deepStrictEqual(json, { services: [] });
  });

  const servicesRepo = getServicesRepoForTest();
  await servicesRepo.create({
    id: 'svc_haircut',
    accountId: 'acct_services',
    name: 'Haircut',
    durationMinutes: 30,
    bufferMinutes: 10,
  });
  await servicesRepo.create({
    id: 'svc_other_acct',
    accountId: 'acct_other',
    name: 'Massage',
    durationMinutes: 60,
  });

  await t.test('lists services scoped to the given account, in the documented shape', async () => {
    const res = await fetch(`${base}/v1/services?accountId=acct_services`);
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.services.length, 1);
    assert.deepStrictEqual(json.services[0], {
      id: 'svc_haircut',
      accountId: 'acct_services',
      name: 'Haircut',
      durationMinutes: 30,
      bufferMinutes: 10,
    });
  });

  await t.test('does not leak another account\'s services', async () => {
    const res = await fetch(`${base}/v1/services?accountId=acct_other`);
    const json = await res.json();
    assert.strictEqual(json.services.length, 1);
    assert.strictEqual(json.services[0].id, 'svc_other_acct');
  });

  await t.test('a service with a zero/omitted buffer defaults bufferMinutes to 0', async () => {
    const res = await fetch(`${base}/v1/services?accountId=acct_other`);
    const json = await res.json();
    assert.strictEqual(json.services[0].bufferMinutes, 0);
  });
});

test('GET /v1/availability honours serviceId', async (t) => {
  await resetServices();
  await resetOAuthTokens();
  const server = app.listen(0);
  t.after(async () => {
    server.close();
    await closeRepositories();
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  await connectGoogleCalendar('acct_avail_svc');
  const servicesRepo = getServicesRepoForTest();
  await servicesRepo.create({
    id: 'svc_massage_45',
    accountId: 'acct_avail_svc',
    name: 'Massage',
    durationMinutes: 45,
    bufferMinutes: 15,
  });

  await t.test('uses the service\'s duration + buffer as slotMinutes, ignoring a client-supplied slotMinutes', async () => {
    const connector = new FakeCalendarConnector({ busy: [] });
    setCalendarConnectorForTest(connector);
    const res = await fetch(
      `${base}/v1/availability?accountId=acct_avail_svc&provider=google&calendarId=primary&serviceId=svc_massage_45&start=2026-12-20T09:00:00Z&end=2026-12-20T10:00:00Z&slotMinutes=5`
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(connector.computeAvailabilityCalls.length, 1);
    assert.strictEqual(connector.computeAvailabilityCalls[0].slotMinutes, 60); // 45 + 15
  });

  await t.test('unknown serviceId returns 404', async () => {
    const connector = new FakeCalendarConnector({ busy: [] });
    setCalendarConnectorForTest(connector);
    const res = await fetch(
      `${base}/v1/availability?accountId=acct_avail_svc&provider=google&calendarId=primary&serviceId=svc_does_not_exist&start=2026-12-20T09:00:00Z&end=2026-12-20T10:00:00Z`
    );
    assert.strictEqual(res.status, 404);
    assert.strictEqual(connector.computeAvailabilityCalls.length, 0);
  });

  await t.test('a serviceId belonging to a different account returns 400', async () => {
    await servicesRepo.create({
      id: 'svc_owned_by_other',
      accountId: 'acct_someone_else',
      name: 'Consult',
      durationMinutes: 20,
    });
    const connector = new FakeCalendarConnector({ busy: [] });
    setCalendarConnectorForTest(connector);
    const res = await fetch(
      `${base}/v1/availability?accountId=acct_avail_svc&provider=google&calendarId=primary&serviceId=svc_owned_by_other&start=2026-12-20T09:00:00Z&end=2026-12-20T10:00:00Z`
    );
    assert.strictEqual(res.status, 400);
    assert.strictEqual(connector.computeAvailabilityCalls.length, 0);
  });

  await t.test('no serviceId keeps the plain slotMinutes-based behavior', async () => {
    const connector = new FakeCalendarConnector({ busy: [] });
    setCalendarConnectorForTest(connector);
    const res = await fetch(
      `${base}/v1/availability?accountId=acct_avail_svc&provider=google&calendarId=primary&start=2026-12-20T09:00:00Z&end=2026-12-20T10:00:00Z&slotMinutes=15`
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(connector.computeAvailabilityCalls[0].slotMinutes, 15);
  });
});
