// The race this file exists to close: two concurrent *first* requests
// (not a retry after the first has finished) with the same
// Idempotency-Key header used to both pass the getByIdempotencyKey replay
// check (since neither had created a row yet) and both proceed to do the
// (side-effecting) calendar work -- see docs/REALITY-CHECK.md. The fix is
// a DB-level guard (appointmentsRepo.tryClaim/releaseClaim, backed by a
// unique constraint on idempotency_claims -- see
// migrations/005_create_idempotency_claims.sql): only one of two
// concurrent requests may win the claim and do the calendar work; the
// other polls for the winner's row.
//
// This test runs against real Postgres (not the in-memory repo) so the
// guarantee comes from the database's unique constraint under real
// concurrent connections from the same pool, not just single-threaded
// event-loop ordering within one process -- see
// test/appointments-postgres.test.js for the same DATABASE_URL pattern.
import test from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import pg from 'pg';

process.env.NODE_ENV = 'test';
process.env.AGENT_HMAC_SECRET = 'testsecret';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://user:pass@localhost:5432/smb';
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
const { PgAppointmentsRepository } = await import('../dist/api/src/repositories/pg-appointments-repo.js');

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

/** A fake connector with an artificial delay on createEvent, so both
 * concurrent requests are reliably still in flight around the same time --
 * makes the race actually race instead of the first request finishing
 * before the second even starts. */
class SlowFakeCalendarConnector {
  constructor() {
    this.createEventCalls = 0;
  }
  async getBusy() {
    return [];
  }
  async createEvent() {
    this.createEventCalls++;
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { eventId: `slow_evt_${this.createEventCalls}` };
  }
  async deleteEvent() {}
  async computeAvailability() {
    return [];
  }
}

test('POST /v1/appointments Idempotency-Key concurrency', async (t) => {
  await resetIdempotency();
  await resetOAuthTokens();
  const server = app.listen(0);
  t.after(async () => {
    server.close();
    await closeRepositories();
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  await t.test(
    'two concurrent first requests with the same Idempotency-Key create exactly one appointment and one calendar event',
    async () => {
      await connectGoogleCalendar('acct_race');
      const connector = new SlowFakeCalendarConnector();
      setCalendarConnectorForTest(connector);

      const idemKey = crypto.randomUUID();
      const body = {
        accountId: 'acct_race',
        serviceId: 'svc_haircut',
        startTime: '2026-12-25T10:00:00Z',
        customer: { name: 'Concurrent Casey', email: 'casey.concurrent@example.com' },
        provider: 'google',
        calendarId: 'primary',
      };
      const opts = {
        method: 'POST',
        headers: headers(body, { 'Idempotency-Key': idemKey }),
        body: JSON.stringify(body),
      };

      // Fire both requests genuinely concurrently -- neither has created a
      // row yet when the other starts.
      const [res1, res2] = await Promise.all([
        fetch(`${base}/v1/appointments`, opts),
        fetch(`${base}/v1/appointments`, opts),
      ]);
      const [json1, json2] = await Promise.all([res1.json(), res2.json()]);

      // Exactly one calendar event was created -- this is the actual race
      // the DB-level claim closes. Before the fix, both requests could
      // reach createEvent since neither had won an atomic claim yet.
      assert.strictEqual(connector.createEventCalls, 1, 'the calendar connector must only be called once, not twice');

      // Both responses describe the same appointment (one 201 for
      // whichever request's INSERT actually won, one 200 for the other --
      // which order depends on timing, so just check they agree, not
      // which status came from which fetch).
      assert.strictEqual(json1.id, json2.id);
      assert.strictEqual(json1.provider_event_id, json2.provider_event_id);
      assert.ok(json1.provider_event_id, 'a real provider_event_id was stored');
      assert.deepStrictEqual([res1.status, res2.status].sort(), [200, 201]);

      // Prove there's exactly one row in Postgres for this key -- not a
      // duplicate insert, and not two separate appointments.
      const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      try {
        const { rows } = await client.query(
          'SELECT count(*)::int AS n, count(DISTINCT provider_event_id)::int AS distinct_events FROM appointments WHERE idempotency_key = $1',
          [idemKey]
        );
        assert.strictEqual(rows[0].n, 1, 'exactly one appointment row for this idempotency key');
        assert.strictEqual(rows[0].distinct_events, 1);

        const claims = await client.query(
          'SELECT count(*)::int AS n FROM idempotency_claims WHERE idempotency_key = $1',
          [idemKey]
        );
        assert.strictEqual(claims.rows[0].n, 0, 'the claim is released once processing finishes');
      } finally {
        await client.end();
      }
    }
  );

  await t.test('a request that loses the claim race but times out waiting for the winner gets a 409, not a duplicate booking', async () => {
    // Simulate a request that claimed the key and then crashed before
    // finishing (no appointment row ever created, claim never released) by
    // claiming it directly through the repository, bypassing the HTTP
    // layer entirely.
    const repo = new PgAppointmentsRepository(process.env.DATABASE_URL);
    const idemKey = crypto.randomUUID();
    try {
      const claimed = await repo.tryClaim(idemKey);
      assert.strictEqual(claimed, true);

      const body = {
        accountId: 'acct_race_timeout',
        serviceId: 'svc_haircut',
        startTime: '2026-12-26T10:00:00Z',
        customer: { name: 'Loser', email: 'loser@example.com' },
      };
      const res = await fetch(`${base}/v1/appointments`, {
        method: 'POST',
        headers: headers(body, { 'Idempotency-Key': idemKey }),
        body: JSON.stringify(body),
      });
      assert.strictEqual(res.status, 409);
      const json = await res.json();
      assert.match(json.error, /already being processed/);
    } finally {
      await repo.releaseClaim(idemKey);
      await repo.close();
    }
  });
});
