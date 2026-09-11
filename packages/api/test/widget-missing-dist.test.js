// The widget bundle is built by a separate package and may simply not be
// there (a fresh clone, or an API-only deployment). That must warn and
// 404 -- never crash the server, and never take the rest of the API down
// with it.
import test from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';

process.env.NODE_ENV = 'test';
process.env.AGENT_HMAC_SECRET = 'testsecret';
process.env.WIDGET_DIST_DIR = path.join(os.tmpdir(), 'definitely-not-a-real-widget-dist-dir');

const { app, closeRepositories } = await import('../dist/api/src/index.js');

test('missing widget dist directory', async (t) => {
  const server = app.listen(0);
  t.after(async () => {
    server.close();
    await closeRepositories();
    delete process.env.WIDGET_DIST_DIR;
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  await t.test('GET /widget.js 404s', async () => {
    const res = await fetch(`${base}/widget.js`);
    assert.strictEqual(res.status, 404);
  });

  await t.test('GET /widget/app.js 404s', async () => {
    const res = await fetch(`${base}/widget/app.js`);
    assert.strictEqual(res.status, 404);
  });

  await t.test('the rest of the API is unaffected', async () => {
    const res = await fetch(`${base}/health`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { ok: true });
  });

  await t.test('/demo still works -- it does not depend on the widget being built', async () => {
    const res = await fetch(`${base}/demo`);
    assert.strictEqual(res.status, 200);
  });
});
