// POST /v1/services -- the operator endpoint for creating a service,
// guarded by X-Admin-Key / ADMIN_API_KEY. Deliberately distinguishes
// "this instance has no admin key at all" (503) from "you sent the wrong
// key" (401).
import test from 'node:test';
import assert from 'node:assert';

process.env.NODE_ENV = 'test';
process.env.AGENT_HMAC_SECRET = 'testsecret';
delete process.env.ADMIN_API_KEY;

const { app, resetServices, closeRepositories } = await import('../dist/api/src/index.js');

function post(base, body, headers = {}) {
  return fetch(`${base}/v1/services`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('POST /v1/services', async (t) => {
  await resetServices();
  const server = app.listen(0);
  t.after(async () => {
    server.close();
    await closeRepositories();
    delete process.env.ADMIN_API_KEY;
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const valid = { accountId: 'acct_admin', name: 'Deep clean', durationMinutes: 90, bufferMinutes: 15 };

  await t.test('503 when ADMIN_API_KEY is not configured', async () => {
    const res = await post(base, valid, { 'X-Admin-Key': 'anything' });
    assert.strictEqual(res.status, 503);
    assert.deepStrictEqual(await res.json(), { error: 'admin API not configured' });
  });

  process.env.ADMIN_API_KEY = 'super-secret-admin-key';

  await t.test('401 with no X-Admin-Key header', async () => {
    const res = await post(base, valid);
    assert.strictEqual(res.status, 401);
  });

  await t.test('401 with the wrong X-Admin-Key', async () => {
    const res = await post(base, valid, { 'X-Admin-Key': 'not-the-key' });
    assert.strictEqual(res.status, 401);
  });

  await t.test('201 with the right key, in the GET /v1/services shape', async () => {
    const res = await post(base, valid, { 'X-Admin-Key': 'super-secret-admin-key' });
    assert.strictEqual(res.status, 201);
    const json = await res.json();
    assert.ok(json.id.startsWith('svc_'));
    assert.deepStrictEqual(
      { ...json, id: undefined },
      {
        id: undefined,
        accountId: 'acct_admin',
        name: 'Deep clean',
        durationMinutes: 90,
        bufferMinutes: 15,
      }
    );
  });

  await t.test('bufferMinutes defaults to 0', async () => {
    const res = await post(
      base,
      { accountId: 'acct_admin', name: 'Quick check', durationMinutes: 15 },
      { 'X-Admin-Key': 'super-secret-admin-key' }
    );
    assert.strictEqual(res.status, 201);
    assert.strictEqual((await res.json()).bufferMinutes, 0);
  });

  await t.test('400 on a missing name or a non-positive durationMinutes', async () => {
    const headers = { 'X-Admin-Key': 'super-secret-admin-key' };
    assert.strictEqual((await post(base, { accountId: 'a', durationMinutes: 30 }, headers)).status, 400);
    assert.strictEqual((await post(base, { name: 'n', durationMinutes: 30 }, headers)).status, 400);
    assert.strictEqual(
      (await post(base, { accountId: 'a', name: 'n', durationMinutes: 0 }, headers)).status,
      400
    );
    assert.strictEqual(
      (await post(base, { accountId: 'a', name: 'n', durationMinutes: 'thirty' }, headers)).status,
      400
    );
    assert.strictEqual(
      (await post(base, { accountId: 'a', name: 'n', durationMinutes: 30, bufferMinutes: -5 }, headers))
        .status,
      400
    );
  });

  await t.test('created services show up on GET /v1/services', async () => {
    const res = await fetch(`${base}/v1/services?accountId=acct_admin`);
    const { services } = await res.json();
    assert.strictEqual(services.length, 2);
    assert.deepStrictEqual(services.map((s) => s.name).sort(), ['Deep clean', 'Quick check']);
  });

  await t.test('an explicit id is honoured, so operators can seed stable ids', async () => {
    const res = await post(
      base,
      { id: 'svc_stable_id', accountId: 'acct_admin', name: 'Stable', durationMinutes: 30 },
      { 'X-Admin-Key': 'super-secret-admin-key' }
    );
    assert.strictEqual(res.status, 201);
    assert.strictEqual((await res.json()).id, 'svc_stable_id');
  });
});
