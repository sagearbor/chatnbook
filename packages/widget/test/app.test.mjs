// Smoke test for the widget's chat/booking UI (packages/widget/src/app.tsx).
// There were zero tests for this package before (see docs/REALITY-CHECK.md).
// Uses jsdom to give App() a real `document`/`window` to render into, then
// exercises the actual rendered DOM the way a browser (or an agent driving
// ?agent=1 mode) would: read attributes, fire form submit / click events.
import test from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';

const { App } = await import('../dist/app.js');

// app.js references the bare globals `document`/`window` (it's built to run
// directly in a browser, not passed a document). Keep the globals pointed
// at this test's JSDOM window for the whole test body -- including later
// event dispatches -- and only restore them when the test is done, via
// `t.after`.
function mountApp(t, url) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  t.after(() => {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  });
  App();
  return dom.window.document;
}

test('App() renders the chat/booking widget with human-mode DOM (no agent selectors)', (t) => {
  const doc = mountApp(t, 'http://localhost/');
  const root = doc.getElementById('smb-widget');
  assert.ok(root, 'root widget element should be appended to body');
  assert.strictEqual(root.getAttribute('role'), 'dialog');
  assert.strictEqual(root.dataset.agent, undefined);

  assert.ok(doc.getElementById('chat-log'));
  assert.ok(doc.getElementById('chat-form'));
  assert.ok(doc.getElementById('chat-input'));
  assert.ok(doc.getElementById('send-btn'));
  assert.ok(doc.getElementById('check-availability'));
  assert.ok(doc.getElementById('book-appointment'));

  // Human mode: no data-agent-id selectors should be present.
  assert.strictEqual(doc.getElementById('chat-log').dataset.agentId, undefined);
  assert.strictEqual(doc.getElementById('send-btn').dataset.agentId, undefined);
});

test('App() exposes stable data-agent-id selectors when ?agent=1', (t) => {
  const doc = mountApp(t, 'http://localhost/?agent=1');
  const root = doc.getElementById('smb-widget');
  assert.strictEqual(root.dataset.agent, '1');
  assert.strictEqual(doc.getElementById('chat-log').dataset.agentId, 'chat-log');
  assert.strictEqual(doc.getElementById('chat-input').dataset.agentId, 'chat-input');
  assert.strictEqual(doc.getElementById('send-btn').dataset.agentId, 'send-btn');
  assert.strictEqual(doc.getElementById('check-availability').dataset.agentId, 'check-availability');
  assert.strictEqual(doc.getElementById('book-appointment').dataset.agentId, 'book-appointment');
});

test('submitting the chat form appends the message to the chat log', (t) => {
  const doc = mountApp(t, 'http://localhost/');
  const input = doc.getElementById('chat-input');
  const form = doc.getElementById('chat-form');
  const chatLog = doc.getElementById('chat-log');

  input.value = 'hello there';
  form.dispatchEvent(new doc.defaultView.Event('submit', { bubbles: true, cancelable: true }));

  assert.match(chatLog.textContent, /You: hello there/);
  assert.strictEqual(input.value, '', 'input should be cleared after submit');
});

test('clicking check-availability and book-appointment buttons log messages', (t) => {
  const doc = mountApp(t, 'http://localhost/');
  const chatLog = doc.getElementById('chat-log');

  doc.getElementById('check-availability').dispatchEvent(new doc.defaultView.Event('click', { bubbles: true }));
  assert.match(chatLog.textContent, /Checking availability\.\.\./);

  doc.getElementById('book-appointment').dispatchEvent(new doc.defaultView.Event('click', { bubbles: true }));
  assert.match(chatLog.textContent, /Booking appointment\.\.\./);
});
