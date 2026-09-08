// Exercises POST /v1/appointments and GET /v1/availability wired to a
// calendar (Google/Microsoft), using a fake CalendarConnector injected via
// setCalendarConnectorForTest -- the real Python connector is never
// spawned here (that's covered by test/appointments-connector-integration.test.js).
// This file focuses on the API-level contract: token acquisition, the
// double-booking 409, provider_event_id persistence, and that requests
// with no `provider` field are completely unaffected (backward compat
// with existing callers like packages/adapters/mcp).
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
  resetIdempotency,
  resetOAuthTokens,
  closeRepositories,
  setCalendarConnectorForTest,
  getOAuthTokensRepoForTest,
} = await import('../dist/api/src/index.js');
const { encrypt } = await import('../dist/api/src/oauth/crypto.js');

function sign(body) {
  return crypto.createHmac('sha256', process.env.AGENT_HMAC_SECRET).update(JSON.stringify(body || '')).digest('base64');
}

function headers(body, extra = {}) {
  return { 'Content-Type': 'application/json', 'X-Signature': sign(body), ...extra };
}

/** Seeds a connected google calendar for accountId, bypassing the OAuth
 * dance entirely (that flow is covered by test/oauth-flow.test.js) -- this
 * file only cares about what happens once a calendar IS connected. */
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

class FakeCalendarConnector {
  constructor({ busy = [] } = {}) {
    this.busy = busy;
    this.getBusyCalls = [];
    this.createEventCalls = [];
  }
  async getBusy(params) {
    this.getBusyCalls.push(params);
    return this.busy;
  }
  async createEvent(params) {
    this.createEventCalls.push(params);
    return { eventId: `fake_evt_${this.createEventCalls.length}` };
  }
  async computeAvailability({ start, end }) {
    return [{ start, end }];
  }
}

test('appointments wired to a fake calendar connector', async (t) => {
  await resetIdempotency();
  await resetOAuthTokens();
  const server = app.listen(0);
  t.after(async () => {
    server.close();
    await closeRepositories();
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  await connectGoogleCalendar('acct_connector');

  await t.test('create with provider set calls getBusy + createEvent and stores provider_event_id', async () => {
    const connector = new FakeCalendarConnector({ busy: [] });
    setCalendarConnectorForTest(connector);

    const body = {
      accountId: 'acct_connector',
      serviceId: 'svc_haircut',
      startTime: '2026-12-01T10:00:00Z',
      customer: { name: 'Sam', email: 'sam@example.com' },
      provider: 'google',
      calendarId: 'primary',
    };
    const res = await fetch(`${base}/v1/appointments`, {
      method: 'POST',
      headers: headers(body, { 'Idempotency-Key': crypto.randomUUID() }),
      body: JSON.stringify(body),
    });
    assert.strictEqual(res.status, 201);
    const json = await res.json();
    assert.strictEqual(json.provider_event_id, 'fake_evt_1');

    assert.strictEqual(connector.getBusyCalls.length, 1);
    assert.strictEqual(connector.getBusyCalls[0].token, 'seeded-access-token');
    assert.strictEqual(connector.getBusyCalls[0].calendarId, 'primary');
    assert.strictEqual(connector.createEventCalls.length, 1);
    assert.strictEqual(connector.createEventCalls[0].summary, 'svc_haircut - Sam');
  });

  await t.test('create with a conflicting busy interval returns 409 and does not create an event', async () => {
    const connector = new FakeCalendarConnector({
      busy: [{ start: '2026-12-02T09:45:00.000Z', end: '2026-12-02T10:15:00.000Z' }],
    });
    setCalendarConnectorForTest(connector);

    const body = {
      accountId: 'acct_connector',
      serviceId: 'svc_haircut',
      startTime: '2026-12-02T10:00:00Z', // overlaps the busy interval above
      customer: { name: 'Robin', email: 'robin@example.com' },
      provider: 'google',
      calendarId: 'primary',
    };
    const res = await fetch(`${base}/v1/appointments`, {
      method: 'POST',
      headers: headers(body, { 'Idempotency-Key': crypto.randomUUID() }),
      body: JSON.stringify(body),
    });
    assert.strictEqual(res.status, 409);
    const json = await res.json();
    assert.match(json.error, /not available/);
    assert.strictEqual(connector.createEventCalls.length, 0, 'no calendar event should be created on conflict');
  });

  await t.test('a non-overlapping busy interval does not block booking', async () => {
    const connector = new FakeCalendarConnector({
      busy: [{ start: '2026-12-03T14:00:00.000Z', end: '2026-12-03T15:00:00.000Z' }],
    });
    setCalendarConnectorForTest(connector);

    const body = {
      accountId: 'acct_connector',
      serviceId: 'svc_haircut',
      startTime: '2026-12-03T10:00:00Z',
      customer: { name: 'Casey', email: 'casey@example.com' },
      provider: 'google',
      calendarId: 'primary',
    };
    const res = await fetch(`${base}/v1/appointments`, {
      method: 'POST',
      headers: headers(body, { 'Idempotency-Key': crypto.randomUUID() }),
      body: JSON.stringify(body),
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(connector.createEventCalls.length, 1);
  });

  await t.test('replaying the same Idempotency-Key does not call the connector again', async () => {
    const connector = new FakeCalendarConnector({ busy: [] });
    setCalendarConnectorForTest(connector);
    const idemKey = crypto.randomUUID();
    const body = {
      accountId: 'acct_connector',
      serviceId: 'svc_haircut',
      startTime: '2026-12-04T10:00:00Z',
      customer: { name: 'Drew', email: 'drew@example.com' },
      provider: 'google',
      calendarId: 'primary',
    };
    const first = await fetch(`${base}/v1/appointments`, {
      method: 'POST',
      headers: headers(body, { 'Idempotency-Key': idemKey }),
      body: JSON.stringify(body),
    });
    assert.strictEqual(first.status, 201);
    assert.strictEqual(connector.createEventCalls.length, 1);

    const second = await fetch(`${base}/v1/appointments`, {
      method: 'POST',
      headers: headers(body, { 'Idempotency-Key': idemKey }),
      body: JSON.stringify(body),
    });
    assert.strictEqual(second.status, 200);
    const firstJson = await first.json();
    const secondJson = await second.json();
    assert.deepStrictEqual(firstJson, secondJson);
    assert.strictEqual(connector.createEventCalls.length, 1, 'replay must not touch the calendar again');
  });

  await t.test('create with an unconnected account/provider returns 400, calendar never touched', async () => {
    const connector = new FakeCalendarConnector({ busy: [] });
    setCalendarConnectorForTest(connector);
    const body = {
      accountId: 'acct_never_connected',
      serviceId: 'svc_haircut',
      startTime: '2026-12-05T10:00:00Z',
      customer: { name: 'Jamie', email: 'jamie@example.com' },
      provider: 'google',
      calendarId: 'primary',
    };
    const res = await fetch(`${base}/v1/appointments`, {
      method: 'POST',
      headers: headers(body, { 'Idempotency-Key': crypto.randomUUID() }),
      body: JSON.stringify(body),
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(connector.getBusyCalls.length, 0);
    assert.strictEqual(connector.createEventCalls.length, 0);
  });

  await t.test('create with no provider field behaves exactly as before (no calendar work at all)', async () => {
    const connector = new FakeCalendarConnector({ busy: [] });
    setCalendarConnectorForTest(connector);
    const body = {
      accountId: 'acct_connector',
      serviceId: 'svc_haircut',
      startTime: '2026-12-06T10:00:00Z',
      customer: { name: 'No Calendar', email: 'nocal@example.com' },
    };
    const res = await fetch(`${base}/v1/appointments`, {
      method: 'POST',
      headers: headers(body, { 'Idempotency-Key': crypto.randomUUID() }),
      body: JSON.stringify(body),
    });
    assert.strictEqual(res.status, 201);
    const json = await res.json();
    assert.strictEqual(json.provider_event_id, undefined);
    assert.strictEqual(connector.getBusyCalls.length, 0);
    assert.strictEqual(connector.createEventCalls.length, 0);
  });

  await t.test('an unsupported provider value is rejected with 400', async () => {
    const body = {
      accountId: 'acct_connector',
      serviceId: 'svc_haircut',
      startTime: '2026-12-07T10:00:00Z',
      customer: { name: 'Bad Provider', email: 'bad@example.com' },
      provider: 'yahoo-calendar',
      calendarId: 'primary',
    };
    const res = await fetch(`${base}/v1/appointments`, {
      method: 'POST',
      headers: headers(body, { 'Idempotency-Key': crypto.randomUUID() }),
      body: JSON.stringify(body),
    });
    assert.strictEqual(res.status, 400);
  });

  await t.test('GET /v1/availability returns real slots from the connector when fully specified', async () => {
    const connector = new FakeCalendarConnector({ busy: [] });
    setCalendarConnectorForTest(connector);
    const res = await fetch(
      `${base}/v1/availability?accountId=acct_connector&provider=google&calendarId=primary&start=2026-12-08T09:00:00Z&end=2026-12-08T10:00:00Z`
    );
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.deepStrictEqual(json, { slots: [{ start: '2026-12-08T09:00:00Z', end: '2026-12-08T10:00:00Z' }] });
  });

  await t.test('GET /v1/availability with no accountId/provider/calendarId keeps the historical empty-stub shape', async () => {
    const res = await fetch(`${base}/v1/availability?serviceId=svc_test&start=2026-01-01T00:00:00Z&end=2026-01-02T00:00:00Z`);
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.deepStrictEqual(json, { slots: [] });
  });
});
