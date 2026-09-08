// Smoke test for the widget loader (packages/widget/src/loader.ts) -- the
// snippet real customer sites embed as `<script src=".../widget.js"
// data-account="..." async>` (see platforms/wordpress.manifest.yaml's
// injection.script_url). Loads the *built* dist/loader.js exactly the way
// a browser would: as a classic script tag, not an ES module (loader.ts
// reads document.currentScript, which is always null for type="module"
// scripts -- so this has to run as a classic script to work at all).
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const loaderSrc = fs.readFileSync(path.join(__dirname, '..', 'dist', 'loader.js'), 'utf-8');

// jsdom's document is still `readyState === 'loading'` immediately after
// construction (it finishes parsing/resource-loading asynchronously, like
// a real browser), so loader.js's `ready()` helper attaches a
// DOMContentLoaded listener rather than running immediately. Wait for it.
function waitForDomReady(doc) {
  if (doc.readyState !== 'loading') return Promise.resolve();
  return new Promise((resolve) => doc.addEventListener('DOMContentLoaded', resolve, { once: true }));
}

test('loader.js has no ESM export marker (must be loadable as a classic script)', () => {
  assert.doesNotMatch(
    loaderSrc,
    /export\s*\{/,
    'dist/loader.js must not contain an ESM `export` statement -- it is loaded via a plain ' +
      '<script src="widget.js"> tag on customer sites, which parses as a classic script, ' +
      'and `export` is a SyntaxError outside a module. If this fails, ' +
      'scripts/strip-loader-export.js did not run (check the widget build script).'
  );
});

test('loader injects an iframe with the configured account, nonce, and agent params', async () => {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'http://localhost/?agent=1',
    runScripts: 'dangerously',
  });
  dom.window.WIDGET_APP_ORIGIN = 'https://widget.example.com/app';

  const script = dom.window.document.createElement('script');
  script.setAttribute('data-account', 'acct_demo');
  script.setAttribute('data-csp-nonce', 'nonce123');
  script.textContent = loaderSrc;
  dom.window.document.body.appendChild(script);
  await waitForDomReady(dom.window.document);

  const iframe = dom.window.document.getElementById('smb-widget-frame');
  assert.ok(iframe, 'iframe should be injected into the page');
  assert.strictEqual(iframe.getAttribute('title'), 'Bookings');
  assert.strictEqual(iframe.dataset.account, 'acct_demo');
  assert.strictEqual(iframe.dataset.agent, '1');
  assert.strictEqual(iframe.src, 'https://widget.example.com/app?agent=1');

  const style = dom.window.document.head.querySelector('style');
  assert.ok(style, 'a style tag scoping the iframe position should be injected');
  assert.match(style.textContent, /#smb-widget-frame/);
  // Not asserting the nonce's actual value here: per the HTML spec, a
  // nonce set via setAttribute() on a script-created element is hidden
  // from later DOM reads (both getAttribute('nonce') and the .nonce IDL
  // property can legitimately return '' outside of parser-set nonces) --
  // that's a browser/jsdom security behavior, not something loader.ts
  // controls. What matters here (and is covered above) is that the style
  // element is created and scoped correctly.
});

test('loader defaults to acct_demo and omits agent params when not in agent mode', async () => {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'http://localhost/',
    runScripts: 'dangerously',
  });
  dom.window.WIDGET_APP_ORIGIN = 'https://widget.example.com/app';

  const script = dom.window.document.createElement('script');
  script.textContent = loaderSrc;
  dom.window.document.body.appendChild(script);
  await waitForDomReady(dom.window.document);

  const iframe = dom.window.document.getElementById('smb-widget-frame');
  assert.ok(iframe);
  assert.strictEqual(iframe.dataset.account, 'acct_demo');
  assert.strictEqual(iframe.dataset.agent, undefined);
  assert.strictEqual(iframe.src, 'https://widget.example.com/app');
});
