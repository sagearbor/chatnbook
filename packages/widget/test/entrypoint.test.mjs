// Regression test for the widget's *browser entry point*.
//
// packages/widget/test/app.test.mjs imports App from dist/app.js and calls
// it itself, so it passes whether or not anything mounts the widget in a
// real browser. That gap shipped: dist/app.html loaded dist/app.js, which
// only exports App() without calling it, so the deployed iframe rendered an
// empty <body> while all 13 widget unit tests stayed green.
//
// These tests close that gap from both ends: the HTML must point at an
// entry module, and loading that entry module the way a browser does (no
// manual App() call) must actually render the booking UI.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const distDir = path.join(process.cwd(), 'dist');
const html = fs.readFileSync(path.join(distDir, 'app.html'), 'utf-8');

test('app.html loads a module entry point that exists in dist/', () => {
  const match = html.match(/<script[^>]*type="module"[^>]*src="\.\/([\w.-]+\.js)"/);
  assert.ok(match, 'app.html must load a type="module" script from ./<file>.js');
  const entry = match[1];
  assert.ok(
    fs.existsSync(path.join(distDir, entry)),
    `app.html references ./${entry}, which is missing from dist/`
  );
});

test('loading the entry module the way a browser does renders the widget', async (t) => {
  const match = html.match(/<script[^>]*type="module"[^>]*src="\.\/([\w.-]+\.js)"/);
  const entry = match[1];

  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://api.example/widget/app.html?account=acct_demo&api=https%3A%2F%2Fapi.example',
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  // The entry mounts immediately and fetches the service list; answer with
  // an empty list so the render path completes without network access.
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ services: [] }) });
  t.after(() => {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    globalThis.fetch = previousFetch;
  });

  // Cache-busting query so the module's top-level App() call runs on this
  // import rather than being skipped as an already-evaluated module.
  await import(`${path.join(distDir, entry)}?entrypointtest=${Date.now()}`);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const root = dom.window.document.getElementById('smb-widget');
  assert.ok(root, 'importing the entry module must mount #smb-widget into <body>');
  assert.ok(
    dom.window.document.getElementById('smb-header'),
    'the mounted widget must render its header'
  );
});
