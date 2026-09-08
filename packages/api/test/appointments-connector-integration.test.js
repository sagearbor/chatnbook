// The one *real* integration test called for by the task: exercises
// POST /v1/appointments end to end through the REAL Python connector
// (packages/connectors-py/src/connectors/google.py, invoked via the real
// PythonCalendarConnector spawning `python -m connectors.cli` -- see
// packages/api/src/connectors/python-calendar-connector.ts) against a
// fake Google Calendar HTTP backend (test/helpers/fake-calendar-backend.mjs)
// standing in for the real Google API. No mocking of the connector layer
// here -- if the TS<->Python bridge, google.py's request/response
// handling, or the availability math were broken, this test would fail.
//
// Requires a Python 3 environment with packages/connectors-py's
// requirements installed -- see README "Python environment for
// connectors" (python -m venv .venv && pip install -r
// packages/connectors-py/requirements.txt at the repo root). Skips itself
// with a clear message if that venv isn't present, rather than failing
// CI machines that haven't set it up.
import test from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'node:child_process';
import { startFakeCalendarBackend } from './helpers/fake-calendar-backend.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const venvPython = path.join(repoRoot, '.venv', 'bin', 'python3');

process.env.NODE_ENV = 'test';
process.env.AGENT_HMAC_SECRET = 'testsecret';
process.env.TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret';
process.env.GOOGLE_REDIRECT_URI = 'http://localhost/unused';
// Ensure the connector shells out to the venv python (has `requests`
// installed) even if a bare `python3` on PATH doesn't.
if (fs.existsSync(venvPython)) {
  process.env.PYTHON_BIN = venvPython;
}

const { app, resetIdempotency, resetOAuthTokens, closeRepositories, getOAuthTokensRepoForTest } =
  await import('../dist/api/src/index.js');
const { encrypt } = await import('../dist/api/src/oauth/crypto.js');

function sign(body) {
  return crypto.createHmac('sha256', process.env.AGENT_HMAC_SECRET).update(JSON.stringify(body || '')).digest('base64');
}
function headers(body, extra = {}) {
  return { 'Content-Type': 'application/json', 'X-Signature': sign(body), ...extra };
}

function pythonAvailable() {
  if (fs.existsSync(venvPython)) return true;
  const result = spawnSync('python3', ['-c', 'import requests'], { stdio: 'ignore' });
  return result.status === 0;
}

test('appointment creation against the real python connector + a fake calendar HTTP backend', { skip: !pythonAvailable() && 'no python venv with requests found (see packages/connectors-py/requirements.txt)' }, async (t) => {
  await resetIdempotency();
  await resetOAuthTokens();

  const fakeCalendar = await startFakeCalendarBackend();
  t.after(() => fakeCalendar.close());
  process.env.GOOGLE_CALENDAR_API_BASE = fakeCalendar.base;

  const server = app.listen(0);
  t.after(async () => {
    server.close();
    await closeRepositories();
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  // Seed a connected Google calendar directly (the OAuth dance itself is
  // covered by test/oauth-flow.test.js) -- this test is about the
  // connector wiring, not OAuth.
  const oauthRepo = getOAuthTokensRepoForTest();
  await oauthRepo.upsert({
    accountId: 'acct_real_connector',
    provider: 'google',
    accessTokenEncrypted: encrypt('real-connector-access-token'),
    refreshTokenEncrypted: encrypt('real-connector-refresh-token'),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    scope: 'calendar',
  });

  await t.test('books an appointment and creates a real event via the real connector', async () => {
    const body = {
      accountId: 'acct_real_connector',
      serviceId: 'svc_massage',
      startTime: '2026-12-15T10:00:00Z',
      customer: { name: 'Taylor', email: 'taylor@example.com' },
      provider: 'google',
      calendarId: 'primary',
    };
    const res = await fetch(`${base}/v1/appointments`, {
      method: 'POST',
      headers: headers(body, { 'Idempotency-Key': crypto.randomUUID() }),
      body: JSON.stringify(body),
    });
    const json = await res.json();
    assert.strictEqual(res.status, 201, JSON.stringify(json));
    assert.ok(json.provider_event_id, 'response includes a provider_event_id');
    assert.strictEqual(json.provider_event_id, fakeCalendar.createdEvents[0]?.id);

    assert.strictEqual(fakeCalendar.createdEvents.length, 1);
    const created = fakeCalendar.createdEvents[0];
    assert.strictEqual(created.calendarId, 'primary');
    assert.strictEqual(created.summary, 'svc_massage - Taylor');
    assert.strictEqual(created.start, '2026-12-15T10:00:00+00:00');
  });

  await t.test('a real busy interval reported by the fake backend blocks booking with 409', async () => {
    fakeCalendar.setBusy('primary', [
      { start: '2026-12-16T09:30:00+00:00', end: '2026-12-16T10:30:00+00:00' },
    ]);
    const body = {
      accountId: 'acct_real_connector',
      serviceId: 'svc_massage',
      startTime: '2026-12-16T10:00:00Z',
      customer: { name: 'Morgan', email: 'morgan@example.com' },
      provider: 'google',
      calendarId: 'primary',
    };
    const res = await fetch(`${base}/v1/appointments`, {
      method: 'POST',
      headers: headers(body, { 'Idempotency-Key': crypto.randomUUID() }),
      body: JSON.stringify(body),
    });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(
      fakeCalendar.createdEvents.length,
      1,
      'still only the one event from the previous sub-test -- nothing created on conflict'
    );
  });

  await t.test('GET /v1/availability computes real free slots from the real connector', async () => {
    fakeCalendar.setBusy('primary', [
      { start: '2026-12-17T09:30:00+00:00', end: '2026-12-17T10:00:00+00:00' },
    ]);
    const res = await fetch(
      `${base}/v1/availability?accountId=acct_real_connector&provider=google&calendarId=primary&start=2026-12-17T09:00:00Z&end=2026-12-17T10:30:00Z&slotMinutes=30`
    );
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    // 09:00-09:30 free, 09:30-10:00 busy (excluded), 10:00-10:30 free.
    assert.strictEqual(json.slots.length, 2);
    assert.ok(json.slots[0].start.startsWith('2026-12-17T09:00:00'));
    assert.ok(json.slots[1].start.startsWith('2026-12-17T10:00:00'));
  });
});
