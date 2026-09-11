// Exercises POST /v1/public/appointments -- the browser booking path used
// by the embeddable widget. No X-Signature (a browser can't hold a shared
// secret), Idempotency-Key optional, provider/calendarId never honoured
// from the body, and the double-booking 409 backed by
// AppointmentsRepository.listByAccountInRange.
//
// In-memory repositories (DATABASE_URL deliberately not set here).
import test from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';

process.env.NODE_ENV = 'test';
process.env.AGENT_HMAC_SECRET = 'testsecret';

const {
  app,
  resetIdempotency,
  resetServices,
  closeRepositories,
  getServicesRepoForTest,
  setCalendarConnectorForTest,
} = await import('../dist/api/src/index.js');

class ExplodingCalendarConnector {
  constructor() {
    this.calls = 0;
  }
  async getBusy() {
    this.calls++;
    throw new Error('the public route must never touch a calendar');
  }
  async createEvent() {
    this.calls++;
    throw new Error('the public route must never touch a calendar');
  }
  async deleteEvent() {}
  async computeAvailability() {
    return [];
  }
}

function post(base, body, extraHeaders = {}) {
  return fetch(`${base}/v1/public/appointments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
}

test('POST /v1/public/appointments', async (t) => {
  await resetIdempotency();
  await resetServices();
  const connector = new ExplodingCalendarConnector();
  setCalendarConnectorForTest(connector);

  const server = app.listen(0);
  t.after(async () => {
    server.close();
    await closeRepositories();
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const services = getServicesRepoForTest();
  await services.create({
    id: 'svc_pub_consult',
    accountId: 'acct_pub',
    name: 'Consultation',
    durationMinutes: 30,
    bufferMinutes: 10,
  });
  await services.create({
    id: 'svc_other_account',
    accountId: 'acct_someone_else',
    name: 'Not yours',
    durationMinutes: 45,
  });

  const customer = { name: 'Rae', email: 'rae@example.com', phone: '+15555550123' };

  await t.test('books without any Idempotency-Key header and returns the standard shape', async () => {
    const res = await post(base, {
      accountId: 'acct_pub',
      serviceId: 'svc_pub_consult',
      startTime: '2027-05-03T14:00:00Z',
      customer,
      notes: 'first visit',
    });
    assert.strictEqual(res.status, 201);
    const json = await res.json();
    assert.ok(json.id);
    assert.strictEqual(json.status, 'requested');
    assert.strictEqual(json.startTime, '2027-05-03T14:00:00Z');
    // endTime is startTime + the *service's* durationMinutes (not + buffer).
    assert.strictEqual(json.endTime, '2027-05-03T14:30:00.000Z');
    assert.strictEqual(json.provider_event_id, undefined);
  });

  await t.test('rejects a body missing required fields with 400', async () => {
    const res = await post(base, { accountId: 'acct_pub', serviceId: 'svc_pub_consult' });
    assert.strictEqual(res.status, 400);
  });

  await t.test('rejects a customer without an email with 400', async () => {
    const res = await post(base, {
      accountId: 'acct_pub',
      serviceId: 'svc_pub_consult',
      startTime: '2027-05-04T14:00:00Z',
      customer: { name: 'No Email' },
    });
    assert.strictEqual(res.status, 400);
  });

  await t.test('rejects an unparseable startTime with 400', async () => {
    const res = await post(base, {
      accountId: 'acct_pub',
      serviceId: 'svc_pub_consult',
      startTime: 'next tuesday-ish',
      customer,
    });
    assert.strictEqual(res.status, 400);
  });

  await t.test('unknown serviceId returns 404', async () => {
    const res = await post(base, {
      accountId: 'acct_pub',
      serviceId: 'svc_does_not_exist',
      startTime: '2027-05-05T14:00:00Z',
      customer,
    });
    assert.strictEqual(res.status, 404);
  });

  await t.test('a serviceId belonging to another account returns 404', async () => {
    const res = await post(base, {
      accountId: 'acct_pub',
      serviceId: 'svc_other_account',
      startTime: '2027-05-06T14:00:00Z',
      customer,
    });
    assert.strictEqual(res.status, 404);
  });

  await t.test('an overlapping slot returns 409 slot no longer available', async () => {
    // 14:15 falls inside the 14:00-14:30 booking made above.
    const res = await post(base, {
      accountId: 'acct_pub',
      serviceId: 'svc_pub_consult',
      startTime: '2027-05-03T14:15:00Z',
      customer,
    });
    assert.strictEqual(res.status, 409);
    assert.deepStrictEqual(await res.json(), { error: 'slot no longer available' });
  });

  await t.test('the same slot for a *different* account is still bookable', async () => {
    await services.create({
      id: 'svc_pub_other',
      accountId: 'acct_pub_two',
      name: 'Consultation',
      durationMinutes: 30,
    });
    const res = await post(base, {
      accountId: 'acct_pub_two',
      serviceId: 'svc_pub_other',
      startTime: '2027-05-03T14:00:00Z',
      customer,
    });
    assert.strictEqual(res.status, 201);
  });

  await t.test('a slot that merely abuts the existing booking is bookable', async () => {
    const res = await post(base, {
      accountId: 'acct_pub',
      serviceId: 'svc_pub_consult',
      startTime: '2027-05-03T14:30:00Z',
      customer,
    });
    assert.strictEqual(res.status, 201);
  });

  await t.test('a supplied Idempotency-Key replays with 200 instead of double-booking', async () => {
    const key = crypto.randomUUID();
    const body = {
      accountId: 'acct_pub',
      serviceId: 'svc_pub_consult',
      startTime: '2027-05-07T14:00:00Z',
      customer,
    };
    const first = await post(base, body, { 'Idempotency-Key': key });
    assert.strictEqual(first.status, 201);
    const second = await post(base, body, { 'Idempotency-Key': key });
    assert.strictEqual(second.status, 200);
    assert.deepStrictEqual(await first.json(), await second.json());
  });

  await t.test('provider/calendarId in the body are ignored, not honoured', async () => {
    const res = await post(base, {
      accountId: 'acct_pub',
      serviceId: 'svc_pub_consult',
      startTime: '2027-05-08T14:00:00Z',
      customer,
      provider: 'google',
      calendarId: 'attacker-controlled-calendar',
    });
    assert.strictEqual(res.status, 201);
    const json = await res.json();
    assert.strictEqual(json.provider_event_id, undefined);
    assert.strictEqual(connector.calls, 0, 'no calendar connector call may originate from the public route');
  });

  await t.test('durationMinutes in the body cannot override the service duration', async () => {
    const res = await post(base, {
      accountId: 'acct_pub',
      serviceId: 'svc_pub_consult',
      startTime: '2027-05-09T14:00:00Z',
      customer,
      durationMinutes: 600,
    });
    assert.strictEqual(res.status, 201);
    const json = await res.json();
    assert.strictEqual(json.endTime, '2027-05-09T14:30:00.000Z');
  });

  await t.test('no X-Signature is required (this is the whole point of the route)', async () => {
    const res = await post(base, {
      accountId: 'acct_pub',
      serviceId: 'svc_pub_consult',
      startTime: '2027-05-10T14:00:00Z',
      customer,
    });
    assert.strictEqual(res.status, 201);
  });
});

test('POST /v1/appointments (HMAC) keeps working unchanged', async (t) => {
  await resetIdempotency();
  await resetServices();
  const server = app.listen(0);
  t.after(async () => {
    server.close();
    await closeRepositories();
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  function signedHeaders(body, extra = {}) {
    return {
      'Content-Type': 'application/json',
      'X-Signature': crypto
        .createHmac('sha256', process.env.AGENT_HMAC_SECRET)
        .update(JSON.stringify(body || ''))
        .digest('base64'),
      ...extra,
    };
  }

  await t.test('still rejects an unsigned request with 401', async () => {
    const body = {
      accountId: 'acct_hmac',
      serviceId: 'svc_unknown_to_the_db',
      startTime: '2027-06-01T14:00:00Z',
      customer: { name: 'Sig', email: 'sig@example.com' },
    };
    const res = await fetch(`${base}/v1/appointments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify(body),
    });
    assert.strictEqual(res.status, 401);
  });

  await t.test('still requires an Idempotency-Key', async () => {
    const body = {
      accountId: 'acct_hmac',
      serviceId: 'svc_unknown_to_the_db',
      startTime: '2027-06-01T14:00:00Z',
      customer: { name: 'Sig', email: 'sig@example.com' },
    };
    const res = await fetch(`${base}/v1/appointments`, {
      method: 'POST',
      headers: signedHeaders(body),
      body: JSON.stringify(body),
    });
    assert.strictEqual(res.status, 400);
  });

  await t.test('still books a serviceId that has no services row (MCP adapter compat)', async () => {
    const body = {
      accountId: 'acct_hmac',
      serviceId: 'svc_unknown_to_the_db',
      startTime: '2027-06-01T14:00:00Z',
      customer: { name: 'Sig', email: 'sig@example.com' },
      durationMinutes: 45,
    };
    const res = await fetch(`${base}/v1/appointments`, {
      method: 'POST',
      headers: signedHeaders(body, { 'Idempotency-Key': crypto.randomUUID() }),
      body: JSON.stringify(body),
    });
    assert.strictEqual(res.status, 201);
    const json = await res.json();
    // Falls back to the body's durationMinutes when no service row exists.
    assert.strictEqual(json.endTime, '2027-06-01T14:45:00.000Z');
  });

  await t.test('also returns the 409 on an overlapping slot', async () => {
    const body = {
      accountId: 'acct_hmac',
      serviceId: 'svc_unknown_to_the_db',
      startTime: '2027-06-01T14:30:00Z',
      customer: { name: 'Sig', email: 'sig@example.com' },
      durationMinutes: 45,
    };
    const res = await fetch(`${base}/v1/appointments`, {
      method: 'POST',
      headers: signedHeaders(body, { 'Idempotency-Key': crypto.randomUUID() }),
      body: JSON.stringify(body),
    });
    assert.strictEqual(res.status, 409);
    assert.deepStrictEqual(await res.json(), { error: 'slot no longer available' });
  });

  await t.test('prefers the service row duration over the body when the service exists', async () => {
    await getServicesRepoForTest().create({
      id: 'svc_hmac_real',
      accountId: 'acct_hmac',
      name: 'Real service',
      durationMinutes: 20,
    });
    const body = {
      accountId: 'acct_hmac',
      serviceId: 'svc_hmac_real',
      startTime: '2027-06-02T14:00:00Z',
      customer: { name: 'Sig', email: 'sig@example.com' },
      durationMinutes: 600,
    };
    const res = await fetch(`${base}/v1/appointments`, {
      method: 'POST',
      headers: signedHeaders(body, { 'Idempotency-Key': crypto.randomUUID() }),
      body: JSON.stringify(body),
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual((await res.json()).endTime, '2027-06-02T14:20:00.000Z');
  });
});
