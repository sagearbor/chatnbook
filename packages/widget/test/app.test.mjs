// Smoke test for the widget's booking flow (packages/widget/src/app.ts),
// rendered inside the iframe app.html loads. Uses jsdom to give App() a
// real `document`/`window` to render into, mocks global fetch to stand in
// for the API (services / availability / public appointments endpoints),
// and drives the flow the way a human (or an agent in ?agent=1 mode) would:
// click through service -> day -> slot -> form -> confirmation.
import test from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';

const { App } = await import('../dist/app.js');

const ACCOUNT = 'acct_demo';
const API = 'https://api.example';

const SERVICES = [
  { id: 'svc_1', accountId: ACCOUNT, name: 'Haircut', durationMinutes: 30, bufferMinutes: 5 },
  { id: 'svc_2', accountId: ACCOUNT, name: 'Color', durationMinutes: 90, bufferMinutes: 10 },
];

function isoInDays(days, hour) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

function flush() {
  // Let queued microtasks (fetch/json promise chains) resolve before the
  // next assertion -- App()'s handlers are async but not awaited by tests.
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// Mounts App() with globalThis.window/document pointed at a fresh jsdom
// window (app.js references the bare `document`/`window` globals -- it's
// built to run directly in a browser, not passed a document) and
// globalThis.fetch mocked per-test. Restores all globals via t.after.
function mountApp(t, { url, fetchImpl }) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.fetch = fetchImpl;
  t.after(() => {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    globalThis.fetch = previousFetch;
  });
  App();
  return dom.window.document;
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function click(doc, el) {
  el.dispatchEvent(new doc.defaultView.Event('click', { bubbles: true, cancelable: true }));
}

test('renders services fetched from the API', async (t) => {
  const calls = [];
  const doc = mountApp(t, {
    url: `http://localhost/?account=${ACCOUNT}&api=${API}`,
    fetchImpl: async (url) => {
      calls.push(url);
      return jsonResponse(200, { services: SERVICES });
    },
  });
  await flush();

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0], `${API}/v1/services?accountId=${ACCOUNT}`);

  const list = doc.querySelector('.smb-list');
  assert.ok(list, 'service list should render');
  assert.match(list.textContent, /Haircut/);
  assert.match(list.textContent, /Color/);
});

test('shows a friendly message when there are no services', async (t) => {
  const doc = mountApp(t, {
    url: `http://localhost/?account=${ACCOUNT}&api=${API}`,
    fetchImpl: async () => jsonResponse(200, { services: [] }),
  });
  await flush();
  assert.match(doc.getElementById('smb-step').textContent, /No services are available/);
});

test('full booking flow: service -> day -> slot -> form -> confirm, with correct availability URL and POST body/headers', async (t) => {
  const slotStart = isoInDays(2, 9);
  const slotEnd = isoInDays(2, 9.5);
  const availabilityCalls = [];
  let postCall = null;

  const doc = mountApp(t, {
    url: `http://localhost/?account=${ACCOUNT}&api=${API}`,
    fetchImpl: async (url, init) => {
      if (url.startsWith(`${API}/v1/services`)) {
        return jsonResponse(200, { services: SERVICES });
      }
      if (url.startsWith(`${API}/v1/availability`)) {
        availabilityCalls.push(url);
        return jsonResponse(200, { slots: [{ start: slotStart, end: slotEnd }] });
      }
      if (url === `${API}/v1/public/appointments`) {
        postCall = { url, init };
        return jsonResponse(201, {
          id: 'appt_123',
          status: 'confirmed',
          startTime: slotStart,
          endTime: slotEnd,
        });
      }
      throw new Error(`unexpected fetch to ${url}`);
    },
  });
  await flush();

  // Step 1: pick a service.
  const serviceBtn = doc.querySelector('.smb-list .smb-item-btn');
  click(doc, serviceBtn);
  await flush();

  // Step 2: pick a day (the 3rd chip, i.e. 2 days from now, to be safely
  // inside the mocked slot's day regardless of "now").
  const dayButtons = Array.from(doc.querySelectorAll('.smb-day-btn'));
  assert.strictEqual(dayButtons.length, 14, 'should render 14 day chips');
  click(doc, dayButtons[2]);
  await flush();

  assert.strictEqual(availabilityCalls.length, 1);
  const availUrl = new URL(availabilityCalls[0]);
  assert.strictEqual(availUrl.pathname, '/v1/availability');
  assert.strictEqual(availUrl.searchParams.get('accountId'), ACCOUNT);
  assert.strictEqual(availUrl.searchParams.get('serviceId'), 'svc_1');
  assert.ok(availUrl.searchParams.get('start'));
  assert.ok(availUrl.searchParams.get('end'));
  // start/end should span exactly one day (24h).
  const startMs = new Date(availUrl.searchParams.get('start')).getTime();
  const endMs = new Date(availUrl.searchParams.get('end')).getTime();
  assert.strictEqual(endMs - startMs, 24 * 60 * 60 * 1000);

  // Slot should now be visible.
  const slotBtn = doc.querySelector('.smb-slot-btn');
  assert.ok(slotBtn, 'a slot button should render');
  click(doc, slotBtn);
  await flush();

  // Step 3: fill out and submit the form.
  const nameInput = doc.getElementById('smb-name');
  const emailInput = doc.getElementById('smb-email');
  const phoneInput = doc.getElementById('smb-phone');
  const notesInput = doc.getElementById('smb-notes');
  assert.ok(nameInput && emailInput && phoneInput && notesInput);

  nameInput.value = 'Ada Lovelace';
  emailInput.value = 'ada@example.com';
  phoneInput.value = '555-1234';
  notesInput.value = 'First visit';

  const form = doc.querySelector('form');
  form.dispatchEvent(new doc.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await flush();

  assert.ok(postCall, 'POST to /v1/public/appointments should have fired');
  assert.strictEqual(postCall.init.method, 'POST');
  assert.strictEqual(postCall.init.headers['Content-Type'], 'application/json');
  assert.ok(postCall.init.headers['Idempotency-Key'], 'Idempotency-Key header should be present');

  const body = JSON.parse(postCall.init.body);
  assert.strictEqual(body.accountId, ACCOUNT);
  assert.strictEqual(body.serviceId, 'svc_1');
  assert.strictEqual(body.startTime, slotStart);
  assert.deepStrictEqual(body.customer, { name: 'Ada Lovelace', email: 'ada@example.com', phone: '555-1234' });
  assert.strictEqual(body.notes, 'First visit');

  // Step 4: confirmation.
  assert.match(doc.getElementById('smb-step').textContent, /appt_123/);
});

test('409 on booking shows a retry message and returns to the slot list', async (t) => {
  const slotStart = isoInDays(2, 9);
  let postAttempts = 0;

  const doc = mountApp(t, {
    url: `http://localhost/?account=${ACCOUNT}&api=${API}`,
    fetchImpl: async (url) => {
      if (url.startsWith(`${API}/v1/services`)) return jsonResponse(200, { services: SERVICES });
      if (url.startsWith(`${API}/v1/availability`)) {
        return jsonResponse(200, { slots: [{ start: slotStart, end: isoInDays(2, 9.5) }] });
      }
      if (url === `${API}/v1/public/appointments`) {
        postAttempts++;
        return jsonResponse(409, { error: 'slot taken' });
      }
      throw new Error(`unexpected fetch to ${url}`);
    },
  });
  await flush();

  click(doc, doc.querySelector('.smb-list .smb-item-btn'));
  await flush();
  click(doc, doc.querySelectorAll('.smb-day-btn')[2]);
  await flush();
  click(doc, doc.querySelector('.smb-slot-btn'));
  await flush();

  doc.getElementById('smb-name').value = 'Ada';
  doc.getElementById('smb-email').value = 'ada@example.com';
  doc.querySelector('form').dispatchEvent(new doc.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await flush();

  assert.strictEqual(postAttempts, 1);
  assert.match(doc.getElementById('smb-error').textContent, /just taken/);
  // Should be back on the day/time step, not the confirmation step.
  assert.ok(doc.querySelector('.smb-day-btn'), 'should return to the day/time step after a 409');
  assert.ok(!doc.getElementById('smb-name'), 'should not still be showing the form step');
});

test('?agent=1 exposes stable data-agent-id selectors through the flow', async (t) => {
  const slotStart = isoInDays(2, 9);
  const doc = mountApp(t, {
    url: `http://localhost/?account=${ACCOUNT}&api=${API}&agent=1`,
    fetchImpl: async (url) => {
      if (url.startsWith(`${API}/v1/services`)) return jsonResponse(200, { services: SERVICES });
      if (url.startsWith(`${API}/v1/availability`)) {
        return jsonResponse(200, { slots: [{ start: slotStart, end: isoInDays(2, 9.5) }] });
      }
      if (url === `${API}/v1/public/appointments`) {
        return jsonResponse(201, { id: 'appt_agent', status: 'confirmed', startTime: slotStart, endTime: isoInDays(2, 9.5) });
      }
      throw new Error(`unexpected fetch to ${url}`);
    },
  });
  await flush();

  const root = doc.getElementById('smb-widget');
  assert.strictEqual(root.dataset.agent, '1');
  assert.strictEqual(doc.querySelector('[data-agent-id="service-list"]')?.dataset.agentId, 'service-list');
  const serviceBtn = doc.querySelector('[data-agent-id="service-svc_1"]');
  assert.ok(serviceBtn);
  click(doc, serviceBtn);
  await flush();

  assert.ok(doc.querySelector('[data-agent-id="day-list"]'));
  const dayButtons = doc.querySelectorAll('.smb-day-btn');
  assert.strictEqual(dayButtons.length, 14);
  for (const btn of dayButtons) assert.match(btn.dataset.agentId, /^day-\d{4}-\d{2}-\d{2}$/);
  click(doc, dayButtons[2]);
  await flush();

  assert.ok(doc.querySelector('[data-agent-id="slot-list"]'));
  const slotBtn = doc.querySelector(`[data-agent-id="slot-${slotStart}"]`);
  assert.ok(slotBtn, 'slot data-agent-id should be keyed by the slot start ISO string');
  click(doc, slotBtn);
  await flush();

  assert.ok(doc.querySelector('[data-agent-id="name"]'));
  assert.ok(doc.querySelector('[data-agent-id="email"]'));
  assert.ok(doc.querySelector('[data-agent-id="phone"]'));
  assert.ok(doc.querySelector('[data-agent-id="notes"]'));
  assert.ok(doc.querySelector('[data-agent-id="book-btn"]'));

  doc.querySelector('[data-agent-id="name"]').value = 'Ada';
  doc.querySelector('[data-agent-id="email"]').value = 'ada@example.com';
  doc.querySelector('form').dispatchEvent(new doc.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await flush();

  assert.ok(doc.querySelector('[data-agent-id="confirmation"]'));
  assert.strictEqual(doc.querySelector('[data-agent-id="appointment-id"]').textContent, 'appt_agent');
});
