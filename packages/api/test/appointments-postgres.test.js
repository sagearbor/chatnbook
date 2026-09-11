// Integration test: exercises the appointment endpoints against a real
// Postgres instance (infra/docker-compose.dev.yml), not the in-memory test
// double. Requires:
//   docker compose -f infra/docker-compose.dev.yml up -d
//   pnpm --filter @smb/api db:migrate
// (DATABASE_URL below matches the credentials in infra/docker-compose.dev.yml.)
import test from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import pg from 'pg';

process.env.NODE_ENV = 'test';
process.env.AGENT_HMAC_SECRET = 'testsecret';
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://user:pass@localhost:5432/smb';

const {
  app,
  resetIdempotency,
  closeRepositories,
  getServicesRepoForTest,
  getAppointmentsRepoForTest,
} = await import('../dist/api/src/index.js');

function sign(body) {
  return crypto
    .createHmac('sha256', process.env.AGENT_HMAC_SECRET)
    .update(JSON.stringify(body || ''))
    .digest('base64');
}

function headers(body, extra = {}) {
  return {
    'Content-Type': 'application/json',
    'X-Signature': sign(body),
    ...extra,
  };
}

test('appointment endpoints persist to Postgres', async (t) => {
  await resetIdempotency();
  const server = app.listen(0);
  // The repositories (and their pg pool) are shared with the second
  // top-level test below, so only the last one closes them.
  t.after(() => server.close());
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  // Unique per run: an account can no longer hold two overlapping
  // non-canceled appointments, so a fixed id would collide with leftover
  // rows (or with the same test running from another worktree against this
  // shared dev database).
  const accountId = `acct_test_${crypto.randomUUID().slice(0, 8)}`;
  const body = {
    accountId,
    serviceId: 'svc_haircut',
    startTime: '2026-10-01T15:00:00Z',
    customer: { name: 'Priya', email: 'priya@example.com' },
  };
  const idemKey = crypto.randomUUID();

  await t.test('create writes a row visible via a fresh direct DB connection', async () => {
    const res = await fetch(`${base}/v1/appointments`, {
      method: 'POST',
      headers: headers(body, { 'Idempotency-Key': idemKey }),
      body: JSON.stringify(body),
    });
    const json = await res.json();
    assert.strictEqual(res.status, 201);
    assert.strictEqual(json.status, 'requested');
    assert.ok(json.id);

    // Prove this is real persistence, not the process's in-memory Map:
    // query Postgres directly with a brand-new client.
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const { rows } = await client.query('SELECT * FROM appointments WHERE id = $1', [json.id]);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].account_id, accountId);
      assert.strictEqual(rows[0].customer_email, 'priya@example.com');
      assert.strictEqual(rows[0].idempotency_key, idemKey);
    } finally {
      await client.end();
    }
  });

  await t.test('repeated Idempotency-Key returns the same persisted row, not a duplicate', async () => {
    const res = await fetch(`${base}/v1/appointments`, {
      method: 'POST',
      headers: headers(body, { 'Idempotency-Key': idemKey }),
      body: JSON.stringify(body),
    });
    const json = await res.json();
    assert.strictEqual(res.status, 200);

    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const { rows } = await client.query(
        'SELECT count(*)::int AS n FROM appointments WHERE idempotency_key = $1',
        [idemKey]
      );
      assert.strictEqual(rows[0].n, 1, 'no duplicate row should be created');
      assert.ok(json.id);
    } finally {
      await client.end();
    }
  });

  let createdId;
  await t.test('cancel updates status in Postgres', async () => {
    // A *different* startTime from `body` above: an account can't hold two
    // overlapping non-canceled appointments any more (see the
    // listByAccountInRange 409 in src/index.ts), so reusing `body`'s slot
    // here would legitimately be rejected.
    const cancelBody = { ...body, startTime: '2026-10-03T15:00:00Z' };
    const createRes = await fetch(`${base}/v1/appointments`, {
      method: 'POST',
      headers: headers(cancelBody, { 'Idempotency-Key': crypto.randomUUID() }),
      body: JSON.stringify(cancelBody),
    });
    const created = await createRes.json();
    createdId = created.id;

    const cancelRes = await fetch(`${base}/v1/appointments/${createdId}/cancel`, {
      method: 'POST',
      headers: headers({}),
      body: JSON.stringify({}),
    });
    const canceled = await cancelRes.json();
    assert.strictEqual(cancelRes.status, 200);
    assert.strictEqual(canceled.status, 'canceled');

    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const { rows } = await client.query('SELECT status FROM appointments WHERE id = $1', [createdId]);
      assert.strictEqual(rows[0].status, 'canceled');
    } finally {
      await client.end();
    }
  });

  await t.test('reschedule updates start_time and status in Postgres', async () => {
    const newStartTime = '2026-10-02T16:00:00Z';
    const rescheduleBody = { newStartTime };
    const res = await fetch(`${base}/v1/appointments/${createdId}/reschedule`, {
      method: 'POST',
      headers: headers(rescheduleBody),
      body: JSON.stringify(rescheduleBody),
    });
    const json = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(json.status, 'confirmed');
    assert.strictEqual(new Date(json.startTime).toISOString(), new Date(newStartTime).toISOString());

    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const { rows } = await client.query(
        'SELECT status, start_time, end_time FROM appointments WHERE id = $1',
        [createdId]
      );
      assert.strictEqual(rows[0].status, 'confirmed');
      assert.strictEqual(new Date(rows[0].start_time).toISOString(), new Date(newStartTime).toISOString());
      // end_time moves with start_time, keeping the appointment's duration
      // (and therefore the overlap check) correct after a reschedule.
      assert.strictEqual(new Date(rows[0].end_time).toISOString(), '2026-10-02T16:30:00.000Z');
    } finally {
      await client.end();
    }
  });

  await t.test('cancel of unknown id returns 404', async () => {
    const res = await fetch(`${base}/v1/appointments/${crypto.randomUUID()}/cancel`, {
      method: 'POST',
      headers: headers({}),
      body: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 404);
  });
});

// Lives in this file rather than its own so the suite doesn't gain a third
// Postgres process that TRUNCATEs the shared tables concurrently with the
// other two -- top-level tests within one file run sequentially.
test('overlap detection (listByAccountInRange) against real Postgres', async (t) => {
  const server = app.listen(0);
  t.after(async () => {
    server.close();
    await closeRepositories();
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  // Unique per run so a concurrently-running Postgres test elsewhere can't
  // be mistaken for our data.
  const account = `acct_overlap_${crypto.randomUUID().slice(0, 8)}`;
  const serviceId = `svc_overlap_${crypto.randomUUID().slice(0, 8)}`;

  const bookPublic = (startTime) =>
    fetch(`${base}/v1/public/appointments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: account,
        serviceId,
        startTime,
        customer: { name: 'Overlap', email: 'overlap@example.com' },
      }),
    });

  await getServicesRepoForTest().create({
    id: serviceId,
    accountId: account,
    name: 'Overlap check',
    durationMinutes: 60,
    bufferMinutes: 0,
  });
  const repo = getAppointmentsRepoForTest();

  let bookedId;
  await t.test('booking persists end_time in the appointments table', async () => {
    const res = await bookPublic('2027-04-05T15:00:00Z');
    assert.strictEqual(res.status, 201);
    const json = await res.json();
    bookedId = json.id;
    assert.strictEqual(json.endTime, '2027-04-05T16:00:00.000Z');

    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const { rows } = await client.query('SELECT end_time FROM appointments WHERE id = $1', [bookedId]);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(
        new Date(rows[0].end_time).toISOString(),
        '2027-04-05T16:00:00.000Z',
        'end_time must be persisted, not left null'
      );
    } finally {
      await client.end();
    }
  });

  await t.test('listByAccountInRange finds an overlapping appointment', async () => {
    const rows = await repo.listByAccountInRange(account, '2027-04-05T15:30:00Z', '2027-04-05T16:30:00Z');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].id, bookedId);
  });

  await t.test('a merely-abutting range is not an overlap', async () => {
    assert.deepStrictEqual(
      await repo.listByAccountInRange(account, '2027-04-05T14:00:00Z', '2027-04-05T15:00:00Z'),
      []
    );
    assert.deepStrictEqual(
      await repo.listByAccountInRange(account, '2027-04-05T16:00:00Z', '2027-04-05T17:00:00Z'),
      []
    );
  });

  await t.test("another account's appointments are not returned", async () => {
    const rows = await repo.listByAccountInRange(
      `${account}_someone_else`,
      '2027-04-05T00:00:00Z',
      '2027-04-06T00:00:00Z'
    );
    assert.deepStrictEqual(rows, []);
  });

  await t.test('the booking route turns an overlap into a 409', async () => {
    const res = await bookPublic('2027-04-05T15:30:00Z');
    assert.strictEqual(res.status, 409);
    assert.deepStrictEqual(await res.json(), { error: 'slot no longer available' });
  });

  await t.test('a legacy row with a null end_time falls back to its service duration', async () => {
    const legacyId = crypto.randomUUID();
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO appointments
           (id, idempotency_key, account_id, service_id, start_time, status,
            customer_name, customer_email)
         VALUES ($1, $2, $3, $4, $5, 'requested', 'Legacy', 'legacy@example.com')`,
        [legacyId, `legacy_${legacyId}`, account, serviceId, '2027-04-06T15:00:00Z']
      );
    } finally {
      await client.end();
    }

    // 60-minute service, so the null end_time is treated as ending 16:00Z.
    const inside = await repo.listByAccountInRange(
      account,
      '2027-04-06T15:45:00Z',
      '2027-04-06T16:15:00Z'
    );
    assert.deepStrictEqual(inside.map((r) => r.id), [legacyId]);
    const outside = await repo.listByAccountInRange(
      account,
      '2027-04-06T16:00:00Z',
      '2027-04-06T17:00:00Z'
    );
    assert.deepStrictEqual(outside, []);
  });

  await t.test('a canceled appointment stops blocking its slot', async () => {
    const cancelRes = await fetch(`${base}/v1/appointments/${bookedId}/cancel`, {
      method: 'POST',
      headers: headers({}),
      body: JSON.stringify({}),
    });
    assert.strictEqual(cancelRes.status, 200);
    assert.deepStrictEqual(
      await repo.listByAccountInRange(account, '2027-04-05T15:00:00Z', '2027-04-05T16:00:00Z'),
      []
    );
    const rebooked = await bookPublic('2027-04-05T15:00:00Z');
    assert.strictEqual(rebooked.status, 201);
  });
});
