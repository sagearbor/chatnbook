// GET /openapi.json used to throw: index.ts joined onto __dirname, which
// doesn't exist in an ESM ("type": "module") package. This covers the fix
// plus the serve-time rewrite of servers[0].url / the well-known action
// URLs, so a deployed instance advertises its own host instead of a
// hard-coded example.com or localhost.
import test from 'node:test';
import assert from 'node:assert';

process.env.NODE_ENV = 'test';
process.env.AGENT_HMAC_SECRET = 'testsecret';
delete process.env.PUBLIC_API_BASE;

const { app, closeRepositories } = await import('../dist/api/src/index.js');

test('GET /openapi.json', async (t) => {
  const server = app.listen(0);
  t.after(async () => {
    server.close();
    await closeRepositories();
    delete process.env.PUBLIC_API_BASE;
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  await t.test('returns 200 JSON with paths', async () => {
    const res = await fetch(`${base}/openapi.json`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const spec = await res.json();
    assert.strictEqual(spec.openapi, '3.0.3');
    assert.ok(spec.paths && typeof spec.paths === 'object');
    assert.ok(Object.keys(spec.paths).length > 0);
  });

  await t.test('documents the new public and admin routes', async () => {
    const spec = await (await fetch(`${base}/openapi.json`)).json();
    assert.ok(spec.paths['/v1/public/appointments']?.post, 'public booking route is documented');
    assert.ok(spec.paths['/v1/services']?.post, 'admin service-create route is documented');
    assert.ok(spec.paths['/v1/appointments']?.post, 'the signed route is still documented');
  });

  await t.test('/.well-known/openapi.json serves the same document', async () => {
    const res = await fetch(`${base}/.well-known/openapi.json`);
    assert.strictEqual(res.status, 200);
    const spec = await res.json();
    assert.ok(spec.paths['/v1/appointments']);
  });

  await t.test('servers[0].url is derived from the request when PUBLIC_API_BASE is unset', async () => {
    const spec = await (await fetch(`${base}/openapi.json`)).json();
    assert.strictEqual(spec.servers[0].url, `http://127.0.0.1:${port}`);
  });

  await t.test('servers[0].url honours PUBLIC_API_BASE when it is set', async () => {
    process.env.PUBLIC_API_BASE = 'https://chatnbook-api.example.run.app/';
    const spec = await (await fetch(`${base}/openapi.json`)).json();
    assert.strictEqual(spec.servers[0].url, 'https://chatnbook-api.example.run.app');
    delete process.env.PUBLIC_API_BASE;
  });

  await t.test('the spec never keeps a hard-coded api.example.com server', async () => {
    const spec = await (await fetch(`${base}/openapi.json`)).json();
    assert.ok(!JSON.stringify(spec.servers).includes('api.example.com'));
  });
});

test('GET /.well-known/ai-actions.json', async (t) => {
  const server = app.listen(0);
  t.after(async () => {
    server.close();
    await closeRepositories();
    delete process.env.PUBLIC_API_BASE;
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  await t.test('advertises absolute URLs derived from the request', async () => {
    const doc = await (await fetch(`${base}/.well-known/ai-actions.json`)).json();
    const names = doc.actions.map((a) => a.name);
    assert.ok(names.includes('createAppointment'));
    assert.ok(names.includes('createPublicAppointment'));
    for (const action of doc.actions) {
      assert.ok(action.url.startsWith(`http://127.0.0.1:${port}/`), `not absolute: ${action.url}`);
      assert.strictEqual(action.openapi, `http://127.0.0.1:${port}/openapi.json`);
    }
  });

  await t.test('the public booking action is marked as needing no signature', async () => {
    const doc = await (await fetch(`${base}/.well-known/ai-actions.json`)).json();
    const publicAction = doc.actions.find((a) => a.name === 'createPublicAppointment');
    assert.strictEqual(publicAction.auth, 'none');
    assert.ok(publicAction.url.endsWith('/v1/public/appointments'));
    const signed = doc.actions.find((a) => a.name === 'createAppointment');
    assert.strictEqual(signed.auth, 'hmac');
  });

  await t.test('honours PUBLIC_API_BASE', async () => {
    process.env.PUBLIC_API_BASE = 'https://chatnbook-api.example.run.app';
    const doc = await (await fetch(`${base}/.well-known/ai-actions.json`)).json();
    assert.ok(
      doc.actions.every((a) => a.url.startsWith('https://chatnbook-api.example.run.app/')),
      JSON.stringify(doc.actions)
    );
    delete process.env.PUBLIC_API_BASE;
  });
});
