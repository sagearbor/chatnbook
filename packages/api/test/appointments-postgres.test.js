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

const { app, resetIdempotency, closeRepositories } = await import('../dist/api/src/index.js');

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
  t.after(async () => {
    server.close();
    await closeRepositories();
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const body = {
    accountId: 'acct_test',
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
      assert.strictEqual(rows[0].account_id, 'acct_test');
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
    const createRes = await fetch(`${base}/v1/appointments`, {
      method: 'POST',
      headers: headers(body, { 'Idempotency-Key': crypto.randomUUID() }),
      body: JSON.stringify(body),
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
        'SELECT status, start_time FROM appointments WHERE id = $1',
        [createdId]
      );
      assert.strictEqual(rows[0].status, 'confirmed');
      assert.strictEqual(new Date(rows[0].start_time).toISOString(), new Date(newStartTime).toISOString());
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
