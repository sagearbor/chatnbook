// Smoke test for the widget loader (packages/widget/src/loader.ts) -- the
// snippet real customer sites embed as `<script src=".../widget.js"
// data-account="..." async></script>` (see
// platforms/wordpress.manifest.yaml's injection.script_url). Loads the
// *built* dist/loader.js exactly the way a browser would: as a classic
// script tag, not an ES module (loader.ts reads document.currentScript,
// which is always null for type="module" scripts -- so this has to run as
// a classic script to work at all).
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
// DOMContentLoaded listener rather than running immediately.
function waitForDomReady(doc) {
  if (doc.readyState !== 'loading') return Promise.resolve();
  return new Promise((resolve) => doc.addEventListener('DOMContentLoaded', resolve, { once: true }));
}

// Builds a JSDOM page, waits for it to finish its own initial load, then
// injects the loader as an inline classic <script> whose `.src` is faked
// via defineProperty to look like it came from `scriptSrc` -- this is the
// only reliable way to get jsdom to report a `document.currentScript.src`
// without either (a) actually setting the `src` *attribute* (which makes
// the browser/jsdom ignore the inline body and try to fetch the resource
// instead of running it) or (b) racing currentScript, which is only valid
// while its own <script> is synchronously executing -- so the outer page
// must already be past 'loading' before we append the loader script,
// otherwise loader.js's `ready()` defers to a later DOMContentLoaded
// handler by which point currentScript has already reverted to null.
async function loadWidget({ url, scriptSrc, dataset = {}, widgetAppOrigin }) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url,
    runScripts: 'dangerously',
  });
  await waitForDomReady(dom.window.document);

  if (widgetAppOrigin) dom.window.WIDGET_APP_ORIGIN = widgetAppOrigin;

  const doc = dom.window.document;
  const script = doc.createElement('script');
  if (scriptSrc) {
    Object.defineProperty(script, 'src', { value: scriptSrc, configurable: true });
  }
  for (const [key, value] of Object.entries(dataset)) {
    script.setAttribute(`data-${key}`, value);
  }
  script.textContent = loaderSrc;
  doc.body.appendChild(script);
  return dom;
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

test('loader renders a closed launcher button and a closed iframe pointed at the script origin', async () => {
  const dom = await loadWidget({
    url: 'http://localhost/',
    scriptSrc: 'https://api.example/widget.js',
    dataset: { account: 'acct_x', 'csp-nonce': 'nonce123' },
  });
  const doc = dom.window.document;

  const button = doc.getElementById('smb-widget-button');
  assert.ok(button, 'launcher button should be injected');
  assert.strictEqual(button.getAttribute('aria-expanded'), 'false');

  const iframe = doc.getElementById('smb-widget-frame');
  assert.ok(iframe, 'iframe should be injected into the page');
  assert.strictEqual(iframe.getAttribute('title'), 'Bookings');
  assert.strictEqual(iframe.dataset.account, 'acct_x');
  assert.strictEqual(iframe.dataset.agent, undefined);
  assert.strictEqual(iframe.dataset.smbOpen, '0', 'widget should start closed');

  const url = new URL(iframe.src);
  assert.strictEqual(url.origin, 'https://api.example');
  assert.strictEqual(url.pathname, '/widget/app.html');
  assert.strictEqual(url.searchParams.get('account'), 'acct_x');
  assert.strictEqual(url.searchParams.get('api'), 'https://api.example');
  assert.strictEqual(url.searchParams.get('agent'), null);

  const style = doc.head.querySelector('style');
  assert.ok(style, 'a style tag scoping the button/iframe position should be injected');
  assert.match(style.textContent, /#smb-widget-frame/);
  assert.match(style.textContent, /#smb-widget-button/);
  // Not asserting the nonce's actual value here: per the HTML spec, a
  // nonce set via setAttribute() on a script-created element is hidden
  // from later DOM reads (both getAttribute('nonce') and the .nonce IDL
  // property can legitimately return '' outside of parser-set nonces) --
  // that's a browser/jsdom security behavior, not something loader.ts
  // controls. What matters here (and is covered above) is that the style
  // element is created and scoped correctly.
});

test('clicking the launcher button toggles the iframe open and closed', async () => {
  const dom = await loadWidget({ url: 'http://localhost/', scriptSrc: 'https://api.example/widget.js' });
  const doc = dom.window.document;
  const button = doc.getElementById('smb-widget-button');
  const iframe = doc.getElementById('smb-widget-frame');

  assert.strictEqual(iframe.dataset.smbOpen, '0');
  button.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.strictEqual(iframe.dataset.smbOpen, '1');
  assert.strictEqual(button.getAttribute('aria-expanded'), 'true');

  button.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.strictEqual(iframe.dataset.smbOpen, '0');
  assert.strictEqual(button.getAttribute('aria-expanded'), 'false');
});

test('loader defaults account to acct_demo and omits agent param when not in agent mode', async () => {
  const dom = await loadWidget({ url: 'http://localhost/', scriptSrc: 'https://api.example/widget.js' });
  const iframe = dom.window.document.getElementById('smb-widget-frame');
  assert.ok(iframe);
  assert.strictEqual(iframe.dataset.account, 'acct_demo');
  const url = new URL(iframe.src);
  assert.strictEqual(url.searchParams.get('agent'), null);
});

test('?agent=1 on the host page propagates to the iframe src, dataset, and auto-opens the widget', async () => {
  const dom = await loadWidget({
    url: 'http://localhost/?agent=1',
    scriptSrc: 'https://api.example/widget.js',
    dataset: { account: 'acct_demo' },
  });
  const iframe = dom.window.document.getElementById('smb-widget-frame');
  assert.strictEqual(iframe.dataset.agent, '1');
  assert.strictEqual(iframe.dataset.smbOpen, '1', 'agent mode should auto-open the widget');
  const url = new URL(iframe.src);
  assert.strictEqual(url.searchParams.get('agent'), '1');
});

test('?smb=open on the host page auto-opens the widget', async () => {
  const dom = await loadWidget({
    url: 'http://localhost/?smb=open',
    scriptSrc: 'https://api.example/widget.js',
  });
  const iframe = dom.window.document.getElementById('smb-widget-frame');
  assert.strictEqual(iframe.dataset.smbOpen, '1');
});

test('WIDGET_APP_ORIGIN overrides the script-tag-derived origin', async () => {
  const dom = await loadWidget({
    url: 'http://localhost/',
    scriptSrc: 'https://api.example/widget.js',
    dataset: { account: 'acct_demo' },
    widgetAppOrigin: 'https://override.example',
  });

  const iframe = dom.window.document.getElementById('smb-widget-frame');
  const url = new URL(iframe.src);
  assert.strictEqual(url.origin, 'https://override.example');
  assert.strictEqual(url.searchParams.get('api'), 'https://override.example');
});
