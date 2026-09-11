// Booking flow rendered inside the widget iframe (packages/widget/src/app.html
// loads this as `<script type="module" src="./app.js">`).
//
// Flow: services -> day/time -> details form -> confirmation.
//
// Query string contract (set by loader.ts when it builds the iframe src):
//   account  - the account id to book against (required by the API)
//   api      - origin of the booking API (defaults to window.location.origin,
//              which is correct when this page is served by the same API
//              that implements /v1/*)
//   agent=1  - agent mode (see below)
//
// Agent mode (?agent=1):
//   - the root element gets `data-agent="1"`
//   - every interactive element / list container gets a stable
//     `data-agent-id` attribute so an agent can drive the flow without
//     relying on visual layout or generated ids:
//       service-list, service-<serviceId>,
//       day-list, day-<YYYY-MM-DD>,
//       slot-list, slot-<ISO start>,
//       name, email, phone, notes, book-btn,
//       confirmation, appointment-id, error
//   Keep this list in sync with the "Widget" section of the repo CLAUDE.md.
import { a11y } from './a11y.js';

interface Service {
  id: string;
  accountId: string;
  name: string;
  durationMinutes: number;
  bufferMinutes: number;
}

interface Slot {
  start: string;
  end: string;
}

interface AppointmentResult {
  id: string;
  status: string;
  startTime: string;
  endTime: string;
}

interface FlowState {
  agentMode: boolean;
  account: string;
  apiOrigin: string;
  services: Service[];
  selectedService: Service | null;
  selectedDayKey: string | null;
  slots: Slot[];
  selectedSlot: Slot | null;
  idempotencyKey: string | null;
}

const DAYS_AHEAD = 14;

function randomId(): string {
  const c = (globalThis as any).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // Fallback for environments without crypto.randomUUID (older browsers/tests).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string>,
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      node.setAttribute(key, value);
    }
  }
  for (const child of children) {
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function localMidnight(base: Date, offsetDays: number): Date {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + offsetDays, 0, 0, 0, 0);
}

function formatDayLabel(d: Date): { weekday: string; dateNum: string } {
  const weekday = d.toLocaleDateString(undefined, { weekday: 'short' });
  const dateNum = d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
  return { weekday, dateNum };
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function formatDayHeading(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

export function App(): void {
  const params = new URLSearchParams(window.location.search);
  const state: FlowState = {
    agentMode: params.get('agent') === '1',
    account: params.get('account') || '',
    apiOrigin: params.get('api') || window.location.origin,
    services: [],
    selectedService: null,
    selectedDayKey: null,
    slots: [],
    selectedSlot: null,
    idempotencyKey: null,
  };

  const root = el('div', { id: 'smb-widget', role: a11y.roleDialog, 'aria-label': 'Book an appointment', 'aria-modal': 'true' });
  if (state.agentMode) root.dataset.agent = '1';

  const heading = el('h1', { tabindex: '-1' }, 'Book an appointment');
  const header = el('div', { id: 'smb-header' }, heading);

  const status = el('div', { id: 'smb-status', role: 'status', 'aria-live': 'polite' });
  const errorBox = el('div', { id: 'smb-error', role: 'alert' });
  errorBox.hidden = true;
  if (state.agentMode) errorBox.dataset.agentId = 'error';

  const stepContainer = el('div', { id: 'smb-step' });

  root.appendChild(header);
  root.appendChild(status);
  root.appendChild(errorBox);
  root.appendChild(stepContainer);
  document.body.appendChild(root);

  function setStatus(msg: string) {
    status.textContent = msg;
  }

  function showError(msg: string, onRetry?: () => void) {
    errorBox.innerHTML = '';
    errorBox.hidden = false;
    errorBox.appendChild(document.createTextNode(msg));
    if (onRetry) {
      const retryBtn = el('button', { type: 'button', class: 'smb-link-btn' }, 'Retry');
      retryBtn.style.marginLeft = '8px';
      retryBtn.addEventListener('click', onRetry);
      errorBox.appendChild(retryBtn);
    }
    setStatus(msg);
  }

  function clearError() {
    errorBox.hidden = true;
    errorBox.innerHTML = '';
  }

  function focusHeading(h: HTMLElement) {
    h.focus();
  }

  function setStep(...nodes: Array<Node>) {
    stepContainer.innerHTML = '';
    for (const n of nodes) stepContainer.appendChild(n);
  }

  async function fetchJson<T>(url: string, init?: RequestInit): Promise<{ ok: true; status: number; data: T } | { ok: false; status: number; data: any }> {
    const res = await fetch(url, init);
    let data: any = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data } as any;
  }

  // ---- Step 1: services ------------------------------------------------

  function renderServicesLoading() {
    const h = el('h2', { tabindex: '-1' }, 'Choose a service');
    setStep(h, el('p', {}, 'Loading services…'));
    focusHeading(h);
  }

  async function loadServices() {
    renderServicesLoading();
    clearError();
    setStatus('Loading services…');
    try {
      const url = `${state.apiOrigin}/v1/services?accountId=${encodeURIComponent(state.account)}`;
      const result = await fetchJson<{ services: Service[] }>(url);
      if (!result.ok) {
        showError('Could not load services. Please try again.', loadServices);
        return;
      }
      state.services = result.data?.services || [];
      setStatus('');
      renderServices();
    } catch {
      showError('Could not load services. Please check your connection and try again.', loadServices);
    }
  }

  function renderServices() {
    const h = el('h2', { tabindex: '-1' }, 'Choose a service');
    if (state.services.length === 0) {
      setStep(h, el('p', {}, 'No services are available for booking right now. Please check back later.'));
      focusHeading(h);
      return;
    }
    const list = el('div', { class: 'smb-list', role: 'list' });
    if (state.agentMode) list.dataset.agentId = 'service-list';
    for (const svc of state.services) {
      const btn = el(
        'button',
        { type: 'button', class: 'smb-item-btn' },
        `${svc.name} (${svc.durationMinutes} min)`
      );
      if (state.agentMode) btn.dataset.agentId = `service-${svc.id}`;
      btn.addEventListener('click', () => {
        state.selectedService = svc;
        state.selectedDayKey = null;
        state.slots = [];
        state.selectedSlot = null;
        renderDayAndTime();
      });
      list.appendChild(btn);
    }
    setStep(h, list);
    focusHeading(h);
  }

  // ---- Step 2: day + time -----------------------------------------------

  let renderSlotsInto: ((container: HTMLElement) => void) | null = null;

  function renderDayAndTime() {
    const service = state.selectedService!;
    const h = el('h2', { tabindex: '-1' }, `Choose a day and time for ${service.name}`);
    const back = el('button', { type: 'button', class: 'smb-back' }, '← Back to services');
    back.addEventListener('click', () => {
      clearError();
      renderServices();
    });

    const dayList = el('div', { class: 'smb-day-list', role: 'list' });
    if (state.agentMode) dayList.dataset.agentId = 'day-list';

    const now = new Date();
    const dayButtons: HTMLButtonElement[] = [];
    for (let i = 0; i < DAYS_AHEAD; i++) {
      const day = localMidnight(now, i);
      const key = dateKey(day);
      const { weekday, dateNum } = formatDayLabel(day);
      const dayBtn = el(
        'button',
        { type: 'button', class: 'smb-day-btn', 'aria-pressed': 'false' },
        el('div', {}, weekday),
        el('div', {}, dateNum)
      );
      if (state.agentMode) dayBtn.dataset.agentId = `day-${key}`;
      dayBtn.addEventListener('click', () => {
        state.selectedDayKey = key;
        state.selectedSlot = null;
        for (const b of dayButtons) b.setAttribute('aria-pressed', 'false');
        dayBtn.setAttribute('aria-pressed', 'true');
        loadSlots();
      });
      dayButtons.push(dayBtn);
      dayList.appendChild(dayBtn);
    }

    const slotSection = el('div', { id: 'smb-slot-section' });

    renderSlotsInto = (container: HTMLElement) => {
      container.innerHTML = '';
      if (state.slots.length === 0) {
        container.appendChild(el('p', {}, 'No openings that day. Try another day.'));
        return;
      }
      const grid = el('div', { class: 'smb-slot-grid', role: 'list' });
      if (state.agentMode) grid.dataset.agentId = 'slot-list';
      for (const slot of state.slots) {
        const btn = el('button', { type: 'button', class: 'smb-slot-btn' }, formatTime(slot.start));
        if (state.agentMode) btn.dataset.agentId = `slot-${slot.start}`;
        btn.addEventListener('click', () => {
          state.selectedSlot = slot;
          renderForm();
        });
        grid.appendChild(btn);
      }
      container.appendChild(grid);
    };

    setStep(h, back, dayList, slotSection);
    focusHeading(h);

    if (state.selectedDayKey) {
      const idx = dayButtons.findIndex((_, i) => dateKey(localMidnight(now, i)) === state.selectedDayKey);
      if (idx >= 0) dayButtons[idx].setAttribute('aria-pressed', 'true');
      renderSlotsInto(slotSection);
    } else {
      slotSection.appendChild(el('p', {}, 'Pick a day to see available times.'));
    }
  }

  async function loadSlots() {
    const service = state.selectedService!;
    const dayKey = state.selectedDayKey!;
    const slotSection = document.getElementById('smb-slot-section');
    clearError();
    setStatus('Loading available times…');
    if (slotSection) slotSection.innerHTML = '<p>Loading available times…</p>';
    try {
      const [y, m, d] = dayKey.split('-').map(Number);
      const start = new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
      const end = new Date(y, m - 1, d + 1, 0, 0, 0, 0).toISOString();
      const url =
        `${state.apiOrigin}/v1/availability?accountId=${encodeURIComponent(state.account)}` +
        `&serviceId=${encodeURIComponent(service.id)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
      const result = await fetchJson<{ slots: Slot[] }>(url);
      if (!result.ok) {
        showError('Could not load available times. Please try again.', loadSlots);
        if (slotSection) slotSection.innerHTML = '';
        return;
      }
      state.slots = result.data?.slots || [];
      setStatus('');
      if (slotSection && renderSlotsInto) renderSlotsInto(slotSection);
    } catch {
      showError('Could not load available times. Please check your connection and try again.', loadSlots);
      if (slotSection) slotSection.innerHTML = '';
    }
  }

  // ---- Step 3: details form ----------------------------------------------

  function renderForm() {
    const service = state.selectedService!;
    const slot = state.selectedSlot!;
    const h = el('h2', { tabindex: '-1' }, 'Your details');
    const back = el('button', { type: 'button', class: 'smb-back' }, '← Back to times');
    back.addEventListener('click', () => {
      clearError();
      renderDayAndTime();
    });

    const summary = el(
      'div',
      { class: 'smb-summary' },
      `${service.name} on ${formatDayHeading(state.selectedDayKey!)} at ${formatTime(slot.start)}`
    );

    const form = el('form', {});

    const nameField = el('div', { class: 'smb-field' });
    const nameLabel = el('label', { for: 'smb-name' }, 'Name');
    const nameInput = el('input', { type: 'text', id: 'smb-name', name: 'name', required: 'true', autocomplete: 'name' });
    if (state.agentMode) nameInput.dataset.agentId = 'name';
    nameField.appendChild(nameLabel);
    nameField.appendChild(nameInput);

    const emailField = el('div', { class: 'smb-field' });
    const emailLabel = el('label', { for: 'smb-email' }, 'Email');
    const emailInput = el('input', { type: 'email', id: 'smb-email', name: 'email', required: 'true', autocomplete: 'email' });
    if (state.agentMode) emailInput.dataset.agentId = 'email';
    emailField.appendChild(emailLabel);
    emailField.appendChild(emailInput);

    const phoneField = el('div', { class: 'smb-field' });
    const phoneLabel = el('label', { for: 'smb-phone' }, 'Phone (optional)');
    const phoneInput = el('input', { type: 'tel', id: 'smb-phone', name: 'phone', autocomplete: 'tel' });
    if (state.agentMode) phoneInput.dataset.agentId = 'phone';
    phoneField.appendChild(phoneLabel);
    phoneField.appendChild(phoneInput);

    const notesField = el('div', { class: 'smb-field' });
    const notesLabel = el('label', { for: 'smb-notes' }, 'Notes (optional)');
    const notesInput = el('textarea', { id: 'smb-notes', name: 'notes' });
    if (state.agentMode) notesInput.dataset.agentId = 'notes';
    notesField.appendChild(notesLabel);
    notesField.appendChild(notesInput);

    const bookBtn = el('button', { type: 'submit', class: 'smb-primary-btn' }, 'Book');
    if (state.agentMode) bookBtn.dataset.agentId = 'book-btn';

    form.appendChild(nameField);
    form.appendChild(emailField);
    form.appendChild(phoneField);
    form.appendChild(notesField);
    form.appendChild(bookBtn);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submitBooking({
        name: nameInput.value.trim(),
        email: emailInput.value.trim(),
        phone: phoneInput.value.trim(),
        notes: notesInput.value.trim(),
        bookBtn,
      });
    });

    setStep(h, back, summary, form);
    focusHeading(h);
  }

  async function submitBooking(fields: { name: string; email: string; phone: string; notes: string; bookBtn: HTMLButtonElement }) {
    const service = state.selectedService!;
    const slot = state.selectedSlot!;
    clearError();
    if (!state.idempotencyKey) state.idempotencyKey = randomId();

    fields.bookBtn.disabled = true;
    setStatus('Booking…');

    const customer: Record<string, string> = { name: fields.name, email: fields.email };
    if (fields.phone) customer.phone = fields.phone;

    const body: Record<string, unknown> = {
      accountId: state.account,
      serviceId: service.id,
      startTime: slot.start,
      customer,
    };
    if (fields.notes) body.notes = fields.notes;

    const retry = () => {
      fields.bookBtn.disabled = false;
      submitBooking(fields);
    };

    try {
      const res = await fetch(`${state.apiOrigin}/v1/public/appointments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': state.idempotencyKey,
        },
        body: JSON.stringify(body),
      });
      let data: any = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }

      if (res.status === 201) {
        setStatus('');
        renderConfirmation(data as AppointmentResult);
        return;
      }
      if (res.status === 409) {
        fields.bookBtn.disabled = false;
        state.idempotencyKey = null;
        state.selectedSlot = null;
        renderDayAndTime();
        await loadSlots();
        showError('That time was just taken — please pick another.');
        return;
      }
      if (res.status === 400) {
        fields.bookBtn.disabled = false;
        showError((data && data.error) || 'Please check your details and try again.');
        return;
      }
      if (res.status === 429) {
        fields.bookBtn.disabled = false;
        showError('Too many requests — please wait a moment and try again.', retry);
        return;
      }
      fields.bookBtn.disabled = false;
      showError('Something went wrong. Please try again.', retry);
    } catch {
      fields.bookBtn.disabled = false;
      showError('Could not reach the booking service. Please check your connection and try again.', retry);
    }
  }

  // ---- Step 4: confirmation ----------------------------------------------

  function renderConfirmation(appointment: AppointmentResult) {
    const h = el('h2', { tabindex: '-1' }, 'You’re booked!');
    const container = el('div', {});
    if (state.agentMode) container.dataset.agentId = 'confirmation';

    const idLine = el('p', {}, `Confirmation: `, el('span', {}, appointment?.id || ''));
    const idSpan = idLine.querySelector('span')!;
    if (state.agentMode) idSpan.dataset.agentId = 'appointment-id';

    const timeLine = el(
      'p',
      {},
      appointment?.startTime ? `Time: ${formatTime(appointment.startTime)} on ${new Date(appointment.startTime).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}` : ''
    );

    const again = el('button', { type: 'button', class: 'smb-link-btn' }, 'Book another');
    again.addEventListener('click', () => {
      state.selectedService = null;
      state.selectedDayKey = null;
      state.slots = [];
      state.selectedSlot = null;
      state.idempotencyKey = null;
      clearError();
      renderServices();
    });

    container.appendChild(idLine);
    container.appendChild(timeLine);
    container.appendChild(again);

    setStep(h, container);
    focusHeading(h);
  }

  loadServices();
}
