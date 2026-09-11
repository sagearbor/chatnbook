// SEED_DEMO_ACCOUNT: the hosted demo runs with in-memory repositories, so
// every cold start needs its two demo services recreated with stable ids.
// This file sets the env var *before* importing the app, because the seed
// runs at module load.
import test from 'node:test';
import assert from 'node:assert';

process.env.NODE_ENV = 'test';
process.env.AGENT_HMAC_SECRET = 'testsecret';
process.env.SEED_DEMO_ACCOUNT = 'acct_demo';

const { app, demoSeedReady, seedDemoAccount, closeRepositories, getServicesRepoForTest } =
  await import('../dist/api/src/index.js');

test('demo account seed', async (t) => {
  await demoSeedReady();
  const server = app.listen(0);
  t.after(async () => {
    server.close();
    await closeRepositories();
    delete process.env.SEED_DEMO_ACCOUNT;
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  await t.test('creates exactly the two documented services with stable ids', async () => {
    const res = await fetch(`${base}/v1/services?accountId=acct_demo`);
    assert.strictEqual(res.status, 200);
    const { services } = await res.json();
    assert.strictEqual(services.length, 2);
    const byId = Object.fromEntries(services.map((s) => [s.id, s]));
    assert.deepStrictEqual(byId.svc_demo_consult, {
      id: 'svc_demo_consult',
      accountId: 'acct_demo',
      name: '30-minute consultation',
      durationMinutes: 30,
      bufferMinutes: 0,
    });
    assert.deepStrictEqual(byId.svc_demo_full, {
      id: 'svc_demo_full',
      accountId: 'acct_demo',
      name: '60-minute appointment',
      durationMinutes: 60,
      bufferMinutes: 10,
    });
  });

  await t.test('re-seeding is idempotent: nothing new is created', async () => {
    const created = await seedDemoAccount('acct_demo');
    assert.strictEqual(created, 0);
    const { services } = await (await fetch(`${base}/v1/services?accountId=acct_demo`)).json();
    assert.strictEqual(services.length, 2);
  });

  await t.test('the seeded services are immediately bookable through the public route', async () => {
    const res = await fetch(`${base}/v1/public/appointments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: 'acct_demo',
        serviceId: 'svc_demo_consult',
        startTime: '2027-07-01T14:00:00Z',
        customer: { name: 'Demo User', email: 'demo@example.com' },
      }),
    });
    assert.strictEqual(res.status, 201);
    const json = await res.json();
    assert.strictEqual(json.endTime, '2027-07-01T14:30:00.000Z');
  });

  await t.test('a partially-seeded account only fills in what is missing', async () => {
    const services = getServicesRepoForTest();
    await services.reset();
    await services.create({
      id: 'svc_demo_consult',
      accountId: 'acct_demo',
      name: '30-minute consultation',
      durationMinutes: 30,
      bufferMinutes: 0,
    });
    const created = await seedDemoAccount('acct_demo');
    assert.strictEqual(created, 1);
  });
});
