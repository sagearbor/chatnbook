// Integration test: exercises the appointment/service endpoints against a
// real Firestore emulator (Firestore Native mode, matching arborfam-hub's
// production database), not the in-memory test double or Postgres. Run via:
//
//   pnpm run test:firestore   (repo root -- wraps this in firebase emulators:exec)
//
// (see the repo-root package.json's "test:firestore" script and
// packages/api/package.json's "test:firestore" script, which it wraps.)
// `firebase emulators:exec` sets FIRESTORE_EMULATOR_HOST itself; the Admin
// SDK auto-detects it and talks to the emulator instead of real Firestore,
// so this never touches (or needs credentials for) the real GCP project.
import test from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import admin from 'firebase-admin';

process.env.NODE_ENV = 'test';
process.env.AGENT_HMAC_SECRET = 'testsecret';
process.env.FIRESTORE_PROJECT_ID = process.env.FIRESTORE_PROJECT_ID || 'demo-chatnbook';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    'appointments-firestore.test.js must run against the Firestore emulator -- ' +
      'FIRESTORE_EMULATOR_HOST is not set. Run via `pnpm --filter @smb/api test:firestore` ' +
      '(wraps `firebase emulators:exec`), not directly with `node --test`.'
  );
}

const {
  app,
  resetIdempotency,
  resetServices,
  closeRepositories,
  getServicesRepoForTest,
  getAppointmentsRepoForTest,
} = await import('../../dist/api/src/index.js');

// A second, independent Admin SDK app pointed at the same emulator, used
// only to read Firestore directly -- proving persistence went through the
// real Firestore wire protocol, not just the process's own repository
// instance (mirrors appointments-postgres.test.js's pattern of opening a
// fresh pg.Client for verification).
const verifyApp = admin.initializeApp(
  { projectId: process.env.FIRESTORE_PROJECT_ID },
  'firestore-verify'
);
const verifyDb = admin.firestore(verifyApp);

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

test('appointment endpoints persist to Firestore', async (t) => {
  await resetIdempotency();
  const server = app.listen(0);
  t.after(() => server.close());
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const accountId = `acct_test_${crypto.randomUUID().slice(0, 8)}`;
  const body = {
    accountId,
    serviceId: 'svc_haircut',
    startTime: '2026-10-01T15:00:00Z',
    customer: { name: 'Priya', email: 'priya@example.com' },
  };
  const idemKey = crypto.randomUUID();

  await t.test('create writes a document visible via a fresh Firestore client', async () => {
    const res = await fetch(`${base}/v1/appointments`, {
      method: 'POST',
      headers: headers(body, { 'Idempotency-Key': idemKey }),
      body: JSON.stringify(body),
    });
    const json = await res.json();
    assert.strictEqual(res.status, 201);
    assert.strictEqual(json.status, 'requested');
    assert.ok(json.id);

    // Prove this is real Firestore persistence, not the process's own
    // in-memory Map: read the document with a brand-new Admin SDK client.
    const snap = await verifyDb.collection('appointments').doc(json.id).get();
    assert.ok(snap.exists, 'appointment document must exist in Firestore');
    assert.strictEqual(snap.data().accountId, accountId);
    assert.strictEqual(snap.data().customerEmail, 'priya@example.com');
    assert.strictEqual(snap.data().idempotencyKey, idemKey);
  });

  await t.test('repeated Idempotency-Key returns the same document, not a duplicate', async () => {
    const res = await fetch(`${base}/v1/appointments`, {
      method: 'POST',
      headers: headers(body, { 'Idempotency-Key': idemKey }),
      body: JSON.stringify(body),
    });
    const json = await res.json();
    assert.strictEqual(res.status, 200);

    const snap = await verifyDb
      .collection('appointments')
      .where('idempotencyKey', '==', idemKey)
      .get();
    assert.strictEqual(snap.size, 1, 'no duplicate document should be created');
    assert.ok(json.id);
  });

  let createdId;
  await t.test('cancel updates status in Firestore', async () => {
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

    const snap = await verifyDb.collection('appointments').doc(createdId).get();
    assert.strictEqual(snap.data().status, 'canceled');
  });

  await t.test('reschedule updates startTime/status in Firestore', async () => {
    const newStartTime = '2026-10-02T16:00:00Z';
    const res = await fetch(`${base}/v1/appointments/${createdId}/reschedule`, {
      method: 'POST',
      headers: headers({ newStartTime }),
      body: JSON.stringify({ newStartTime }),
    });
    const json = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(json.status, 'confirmed');

    const snap = await verifyDb.collection('appointments').doc(createdId).get();
    assert.strictEqual(snap.data().status, 'confirmed');
    assert.strictEqual(
      new Date(snap.data().startTime).toISOString(),
      new Date(newStartTime).toISOString()
    );
    // endTime moves with startTime, keeping the appointment's duration
    // (and therefore the overlap check) correct after a reschedule.
    assert.strictEqual(
      new Date(snap.data().endTime).toISOString(),
      '2026-10-02T16:30:00.000Z'
    );
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

test('overlap detection (listByAccountInRange) against real Firestore', async (t) => {
  await resetServices();
  const server = app.listen(0);
  t.after(async () => {
    server.close();
    await closeRepositories();
    await verifyApp.delete();
  });
  const base = `http://127.0.0.1:${server.address().port}`;

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
  await t.test('booking persists endTime in the Firestore document', async () => {
    const res = await bookPublic('2027-04-05T15:00:00Z');
    assert.strictEqual(res.status, 201);
    const json = await res.json();
    bookedId = json.id;
    assert.strictEqual(json.endTime, '2027-04-05T16:00:00.000Z');

    const snap = await verifyDb.collection('appointments').doc(bookedId).get();
    assert.strictEqual(
      new Date(snap.data().endTime).toISOString(),
      '2027-04-05T16:00:00.000Z',
      'endTime must be persisted, not left null'
    );
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

test('tryClaim/releaseClaim guard concurrent first requests (idempotency race)', async (t) => {
  const repo = getAppointmentsRepoForTest();
  const key = `claim_${crypto.randomUUID()}`;
  t.after(async () => {
    await repo.releaseClaim(key);
  });

  const first = await repo.tryClaim(key);
  const second = await repo.tryClaim(key);
  assert.strictEqual(first, true, 'first claim should win');
  assert.strictEqual(second, false, 'second concurrent claim on the same key should lose');

  await repo.releaseClaim(key);
  const third = await repo.tryClaim(key);
  assert.strictEqual(third, true, 'a claim can be retaken after release');
});
