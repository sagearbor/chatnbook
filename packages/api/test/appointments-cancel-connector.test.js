// Exercises POST /v1/appointments/:id/cancel deleting the real calendar
// event when one was created, using a fake CalendarConnector injected via
// setCalendarConnectorForTest -- the real Python connector is never
// spawned here (that's covered by
// test/appointments-cancel-connector-integration.test.js). Focuses on the
// API-level contract: deleteEvent gets the right provider/calendarId/
// eventId/token, appointments booked with no provider are unaffected, and
// an appointment whose connector delete "fails" because the event is
// already gone is still tolerated (does not block cancellation).
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
  constructor({ busy = [], deleteBehavior = 'succeed' } = {}) {
    this.busy = busy;
    this.deleteBehavior = deleteBehavior; // 'succeed' | 'already-deleted' | 'error'
    this.getBusyCalls = [];
    this.createEventCalls = [];
    this.deleteEventCalls = [];
  }
  async getBusy(params) {
    this.getBusyCalls.push(params);
    return this.busy;
  }
  async createEvent(params) {
    this.createEventCalls.push(params);
    return { eventId: `fake_evt_${this.createEventCalls.length}` };
  }
  async deleteEvent(params) {
    this.deleteEventCalls.push(params);
    if (this.deleteBehavior === 'error') {
      throw new Error('simulated connector failure');
    }
    // 'already-deleted' resolves normally too -- this mirrors the real
    // connector (google.py/microsoft.py delete_event) tolerating a 404/410
    // from the provider by returning instead of raising, so the TS layer
    // never even sees an error for that case.
  }
  async computeAvailability({ start, end }) {
    return [{ start, end }];
  }
}

async function bookAppointment(base, { accountId, connector, idemKey = crypto.randomUUID() }) {
  setCalendarConnectorForTest(connector);
  const body = {
    accountId,
    serviceId: 'svc_haircut',
    startTime: '2026-12-10T10:00:00Z',
    customer: { name: 'Jordan', email: 'jordan@example.com' },
    provider: 'google',
    calendarId: 'primary',
  };
  const res = await fetch(`${base}/v1/appointments`, {
    method: 'POST',
    headers: headers(body, { 'Idempotency-Key': idemKey }),
    body: JSON.stringify(body),
  });
  assert.strictEqual(res.status, 201);
  return res.json();
}

test('POST /v1/appointments/:id/cancel deletes the real calendar event', async (t) => {
  await resetIdempotency();
  await resetOAuthTokens();
  const server = app.listen(0);
  t.after(async () => {
    server.close();
    await closeRepositories();
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  await connectGoogleCalendar('acct_cancel');

  await t.test('cancel calls deleteEvent with provider/token/calendarId/eventId and marks canceled', async () => {
    const connector = new FakeCalendarConnector();
    const created = await bookAppointment(base, { accountId: 'acct_cancel', connector });
    assert.strictEqual(created.provider_event_id, 'fake_evt_1');

    const res = await fetch(`${base}/v1/appointments/${created.id}/cancel`, {
      method: 'POST',
      headers: headers({}),
      body: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.status, 'canceled');

    assert.strictEqual(connector.deleteEventCalls.length, 1);
    assert.deepStrictEqual(connector.deleteEventCalls[0], {
      provider: 'google',
      token: 'seeded-access-token',
      calendarId: 'primary',
      eventId: 'fake_evt_1',
    });
  });

  await t.test('cancelling an appointment with no provider does not call the connector at all', async () => {
    const connector = new FakeCalendarConnector();
    setCalendarConnectorForTest(connector);
    const body = {
      accountId: 'acct_cancel',
      serviceId: 'svc_haircut',
      startTime: '2026-12-11T10:00:00Z',
      customer: { name: 'No Calendar', email: 'nocal@example.com' },
    };
    const createRes = await fetch(`${base}/v1/appointments`, {
      method: 'POST',
      headers: headers(body, { 'Idempotency-Key': crypto.randomUUID() }),
      body: JSON.stringify(body),
    });
    const created = await createRes.json();
    assert.strictEqual(created.provider_event_id, undefined);

    const res = await fetch(`${base}/v1/appointments/${created.id}/cancel`, {
      method: 'POST',
      headers: headers({}),
      body: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(connector.deleteEventCalls.length, 0, 'no provider/calendarId stored -- calendar is never touched');
  });

  await t.test('cancelling an already-deleted event is tolerated (connector resolves, cancel still succeeds)', async () => {
    const connector = new FakeCalendarConnector({ deleteBehavior: 'already-deleted' });
    const created = await bookAppointment(base, { accountId: 'acct_cancel', connector });

    const res = await fetch(`${base}/v1/appointments/${created.id}/cancel`, {
      method: 'POST',
      headers: headers({}),
      body: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.status, 'canceled');
    assert.strictEqual(connector.deleteEventCalls.length, 1);
  });

  await t.test('a genuine connector error deleting the event returns 502, and a retry with a working connector still cancels', async () => {
    const brokenConnector = new FakeCalendarConnector({ deleteBehavior: 'error' });
    const created = await bookAppointment(base, { accountId: 'acct_cancel', connector: brokenConnector });

    const failedRes = await fetch(`${base}/v1/appointments/${created.id}/cancel`, {
      method: 'POST',
      headers: headers({}),
      body: JSON.stringify({}),
    });
    assert.strictEqual(failedRes.status, 502);
    assert.strictEqual(brokenConnector.deleteEventCalls.length, 1);

    // The appointment row is untouched by the failed attempt (still not
    // canceled) -- retrying with a working connector succeeds.
    const workingConnector = new FakeCalendarConnector();
    setCalendarConnectorForTest(workingConnector);
    const retryRes = await fetch(`${base}/v1/appointments/${created.id}/cancel`, {
      method: 'POST',
      headers: headers({}),
      body: JSON.stringify({}),
    });
    assert.strictEqual(retryRes.status, 200);
    const retryJson = await retryRes.json();
    assert.strictEqual(retryJson.status, 'canceled');
    assert.strictEqual(workingConnector.deleteEventCalls.length, 1);
  });

  await t.test('cancel of an unknown id returns 404 without touching the connector', async () => {
    const connector = new FakeCalendarConnector();
    setCalendarConnectorForTest(connector);
    const res = await fetch(`${base}/v1/appointments/${crypto.randomUUID()}/cancel`, {
      method: 'POST',
      headers: headers({}),
      body: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(connector.deleteEventCalls.length, 0);
  });
});
