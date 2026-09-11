// Static serving of the built browser widget (packages/widget/dist) and the
// /demo page. WIDGET_DIST_DIR is read at module load, so it's pointed at a
// throwaway directory of stand-in files here -- packages/widget is built by
// its own package and may or may not be present.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NODE_ENV = 'test';
process.env.AGENT_HMAC_SECRET = 'testsecret';

const widgetDist = fs.mkdtempSync(path.join(os.tmpdir(), 'widget-dist-'));
fs.writeFileSync(path.join(widgetDist, 'loader.js'), '/* fake loader bundle */\n');
fs.writeFileSync(path.join(widgetDist, 'app.html'), '<!doctype html><title>widget app</title>\n');
fs.writeFileSync(path.join(widgetDist, 'app.js'), '/* fake app bundle */\n');
fs.writeFileSync(path.join(widgetDist, 'a11y.js'), '/* fake a11y bundle */\n');
process.env.WIDGET_DIST_DIR = widgetDist;

const { app, closeRepositories } = await import('../dist/api/src/index.js');

test('static widget + demo serving', async (t) => {
  const server = app.listen(0);
  t.after(async () => {
    server.close();
    await closeRepositories();
    fs.rmSync(widgetDist, { recursive: true, force: true });
    delete process.env.WIDGET_DIST_DIR;
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  await t.test('GET /widget.js serves the loader bundle', async () => {
    const res = await fetch(`${base}/widget.js`);
    assert.strictEqual(res.status, 200);
    assert.match(await res.text(), /fake loader bundle/);
  });

  for (const file of ['app.html', 'app.js', 'a11y.js']) {
    await t.test(`GET /widget/${file} serves from the widget dist dir`, async () => {
      const res = await fetch(`${base}/widget/${file}`);
      assert.strictEqual(res.status, 200);
      assert.match(await res.text(), /widget app|fake/);
    });
  }

  await t.test('a widget asset that does not exist 404s rather than crashing', async () => {
    const res = await fetch(`${base}/widget/not-a-real-file.js`);
    assert.strictEqual(res.status, 404);
  });

  await t.test('the widget mount does not escape its directory', async () => {
    const res = await fetch(`${base}/widget/..%2f..%2fpackage.json`);
    assert.ok(res.status >= 400, `expected a client error, got ${res.status}`);
  });

  await t.test('GET /demo serves the demo page with the WordPress-style embed', async () => {
    const res = await fetch(`${base}/demo`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.match(html, /<title>chatnbook demo<\/title>/);
    assert.match(html, /live demo booking against the hosted API/);
    assert.match(html, /<script src="\/widget\.js" data-account="acct_demo" async><\/script>/);
    for (const link of ['/health', '/openapi.json', '/.well-known/ai-actions.json']) {
      assert.match(html, new RegExp(`href="${link.replace(/[./]/g, '\\$&')}"`), `missing link to ${link}`);
    }
  });

  await t.test('GET / redirects to /demo', async () => {
    const res = await fetch(`${base}/`, { redirect: 'manual' });
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get('location'), '/demo');
  });
});
