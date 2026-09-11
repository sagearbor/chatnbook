// The real integration test for cancellation deleting a calendar event:
// exercises POST /v1/appointments/:id/cancel end to end through the REAL
// Python connector (packages/connectors-py/src/connectors/google.py,
// invoked via the real PythonCalendarConnector spawning
// `python -m connectors.cli` -- see
// packages/api/src/connectors/python-calendar-connector.ts) against a
// fake Google Calendar HTTP backend (test/helpers/fake-calendar-backend.mjs)
// standing in for the real Google API. No mocking of the connector layer
// here -- if the TS<->Python bridge or google.py's DELETE handling
// (including tolerating an already-deleted event) were broken, this test
// would fail.
//
// Requires a Python 3 environment with packages/connectors-py's
// requirements installed -- see README "Python environment for
// connectors". Skips itself with a clear message if that venv isn't
// present, rather than failing CI machines that haven't set it up (same
// pattern as test/appointments-connector-integration.test.js).
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

test(
  'cancellation deletes the real calendar event via the real python connector + a fake calendar HTTP backend',
  { skip: !pythonAvailable() && 'no python venv with requests found (see packages/connectors-py/requirements.txt)' },
  async (t) => {
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

    const oauthRepo = getOAuthTokensRepoForTest();
    await oauthRepo.upsert({
      accountId: 'acct_cancel_real',
      provider: 'google',
      accessTokenEncrypted: encrypt('real-cancel-access-token'),
      refreshTokenEncrypted: encrypt('real-cancel-refresh-token'),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scope: 'calendar',
    });

    let appointmentId;

    await t.test('books an appointment, creating a real event via the real connector', async () => {
      const body = {
        accountId: 'acct_cancel_real',
        serviceId: 'svc_massage',
        startTime: '2026-12-20T10:00:00Z',
        customer: { name: 'Riley', email: 'riley@example.com' },
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
      appointmentId = json.id;
      assert.strictEqual(fakeCalendar.createdEvents.length, 1);
    });

    await t.test('cancel deletes the real event on the fake backend', async () => {
      const res = await fetch(`${base}/v1/appointments/${appointmentId}/cancel`, {
        method: 'POST',
        headers: headers({}),
        body: JSON.stringify({}),
      });
      const json = await res.json();
      assert.strictEqual(res.status, 200, JSON.stringify(json));
      assert.strictEqual(json.status, 'canceled');
      assert.strictEqual(fakeCalendar.createdEvents.length, 0, 'the event is gone from the fake backend');
      assert.strictEqual(fakeCalendar.deletedEvents.length, 1);
    });

    await t.test('cancelling again (event already deleted on the provider) is tolerated, not an error', async () => {
      // Second cancel: the fake backend now 404s on DELETE for this event
      // id (already removed above) -- google.py's delete_event must treat
      // that as success, not raise, so this still returns 200.
      const res = await fetch(`${base}/v1/appointments/${appointmentId}/cancel`, {
        method: 'POST',
        headers: headers({}),
        body: JSON.stringify({}),
      });
      const json = await res.json();
      assert.strictEqual(res.status, 200, JSON.stringify(json));
      assert.strictEqual(json.status, 'canceled');
    });
  }
);
