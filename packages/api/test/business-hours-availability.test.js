// Business-hours availability fallback: GET /v1/availability with
// accountId/start/end but no provider now computes real slots from the
// configured BUSINESS_HOURS/BUSINESS_TZ minus the account's existing
// non-canceled appointments, instead of returning the `{ slots: [] }` stub.
//
// Also unit-tests the slot engine itself (src/business-hours.ts), including
// the DST transition, since that's where the Intl-based timezone math earns
// its keep.
import test from 'node:test';
import assert from 'node:assert';

process.env.NODE_ENV = 'test';
process.env.AGENT_HMAC_SECRET = 'testsecret';

const {
  app,
  resetIdempotency,
  resetServices,
  closeRepositories,
  getServicesRepoForTest,
} = await import('../dist/api/src/index.js');
const { parseBusinessHours, computeBusinessHoursSlots } = await import(
  '../dist/api/src/business-hours.js'
);

// 2027-03-15 is a Monday, and America/New_York is already on EDT (UTC-4)
// by then -- 09:00-17:00 local is 13:00Z-21:00Z.
const MONDAY = '2027-03-15';
const MON_START = `${MONDAY}T00:00:00Z`;
const MON_END = '2027-03-16T00:00:00Z';

test('parseBusinessHours', async (t) => {
  await t.test('parses the default single range into Mon-Fri', () => {
    const windows = parseBusinessHours('Mon-Fri 09:00-17:00');
    assert.strictEqual(windows.length, 5);
    assert.deepStrictEqual(
      windows.map((w) => w.weekday).sort(),
      [1, 2, 3, 4, 5]
    );
    assert.ok(windows.every((w) => w.startMinutes === 540 && w.endMinutes === 1020));
  });

  await t.test('parses multiple comma-separated ranges', () => {
    const windows = parseBusinessHours('Mon-Fri 09:00-17:00,Sat 10:00-14:00');
    assert.strictEqual(windows.length, 6);
    const sat = windows.find((w) => w.weekday === 6);
    assert.deepStrictEqual({ start: sat.startMinutes, end: sat.endMinutes }, { start: 600, end: 840 });
  });

  await t.test('supports a day range that wraps the week', () => {
    const windows = parseBusinessHours('Fri-Mon 08:00-12:00');
    assert.deepStrictEqual(
      windows.map((w) => w.weekday),
      [5, 6, 0, 1]
    );
  });

  await t.test('skips malformed entries instead of throwing', () => {
    const windows = parseBusinessHours('nonsense,Mon 09:00-17:00,Tue 17:00-09:00');
    assert.strictEqual(windows.length, 1);
    assert.strictEqual(windows[0].weekday, 1);
  });
});

test('computeBusinessHoursSlots', async (t) => {
  const windows = parseBusinessHours('Mon-Fri 09:00-17:00');
  const tz = 'America/New_York';
  const now = new Date('2020-01-01T00:00:00Z');

  await t.test('fills one weekday with back-to-back slots in the right timezone', () => {
    const slots = computeBusinessHoursSlots({
      start: MON_START,
      end: MON_END,
      slotMinutes: 30,
      windows,
      timeZone: tz,
      now,
    });
    assert.strictEqual(slots.length, 16); // 8 hours / 30 min
    assert.strictEqual(slots[0].start, '2027-03-15T13:00:00.000Z'); // 09:00 EDT
    assert.strictEqual(slots[15].end, '2027-03-15T21:00:00.000Z'); // 17:00 EDT
  });

  await t.test('skips a weekend day entirely', () => {
    const slots = computeBusinessHoursSlots({
      start: '2027-03-20T00:00:00Z', // Saturday
      end: '2027-03-21T00:00:00Z',
      slotMinutes: 30,
      windows,
      timeZone: tz,
      now,
    });
    assert.deepStrictEqual(slots, []);
  });

  await t.test('tracks the DST change: the same local 09:00 is a different UTC hour', () => {
    // 2027-03-12 is a Friday on EST (UTC-5); the Monday after is EDT (UTC-4).
    const est = computeBusinessHoursSlots({
      start: '2027-03-12T00:00:00Z',
      end: '2027-03-13T00:00:00Z',
      slotMinutes: 60,
      windows,
      timeZone: tz,
      now,
    });
    assert.strictEqual(est[0].start, '2027-03-12T14:00:00.000Z'); // 09:00 EST
    const edt = computeBusinessHoursSlots({
      start: MON_START,
      end: MON_END,
      slotMinutes: 60,
      windows,
      timeZone: tz,
      now,
    });
    assert.strictEqual(edt[0].start, '2027-03-15T13:00:00.000Z'); // 09:00 EDT
  });

  await t.test('never returns a slot that starts in the past', () => {
    const slots = computeBusinessHoursSlots({
      start: MON_START,
      end: MON_END,
      slotMinutes: 30,
      windows,
      timeZone: tz,
      now: new Date('2027-03-15T17:00:00Z'), // 13:00 EDT, halfway through the day
    });
    assert.ok(slots.length > 0);
    assert.ok(slots.every((s) => new Date(s.start).getTime() >= Date.parse('2027-03-15T17:00:00Z')));
    assert.strictEqual(slots[0].start, '2027-03-15T17:00:00.000Z');
  });

  await t.test('subtracts busy intervals', () => {
    const slots = computeBusinessHoursSlots({
      start: MON_START,
      end: MON_END,
      slotMinutes: 30,
      windows,
      timeZone: tz,
      busy: [{ start: '2027-03-15T13:15:00Z', end: '2027-03-15T14:00:00Z' }],
      now,
    });
    // Removes the 13:00 and 13:30 slots.
    assert.strictEqual(slots.length, 14);
    assert.strictEqual(slots[0].start, '2027-03-15T14:00:00.000Z');
  });

  await t.test('does not emit a partial slot that would run past the window', () => {
    const slots = computeBusinessHoursSlots({
      start: MON_START,
      end: MON_END,
      slotMinutes: 50, // 8h / 50min = 9.6
      windows,
      timeZone: tz,
      now,
    });
    assert.strictEqual(slots.length, 9);
    assert.ok(new Date(slots[8].end).getTime() <= Date.parse('2027-03-15T21:00:00Z'));
  });
});

test('GET /v1/availability business-hours fallback', async (t) => {
  await resetIdempotency();
  await resetServices();
  process.env.BUSINESS_HOURS = 'Mon-Fri 09:00-17:00';
  process.env.BUSINESS_TZ = 'America/New_York';

  const server = app.listen(0);
  t.after(async () => {
    server.close();
    await closeRepositories();
    delete process.env.BUSINESS_HOURS;
    delete process.env.BUSINESS_TZ;
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  await getServicesRepoForTest().create({
    id: 'svc_bh_consult',
    accountId: 'acct_bh',
    name: 'Consultation',
    durationMinutes: 45,
    bufferMinutes: 15,
  });

  await t.test('with accountId/start/end and no provider, returns business-hour slots', async () => {
    const res = await fetch(
      `${base}/v1/availability?accountId=acct_bh&start=${MON_START}&end=${MON_END}`
    );
    assert.strictEqual(res.status, 200);
    const { slots } = await res.json();
    assert.strictEqual(slots.length, 16); // default 30-minute slots
    assert.strictEqual(slots[0].start, '2027-03-15T13:00:00.000Z');
  });

  await t.test('honours an explicit slotMinutes when no serviceId is given', async () => {
    const res = await fetch(
      `${base}/v1/availability?accountId=acct_bh&start=${MON_START}&end=${MON_END}&slotMinutes=60`
    );
    const { slots } = await res.json();
    assert.strictEqual(slots.length, 8);
  });

  await t.test('a serviceId sets the slot length to durationMinutes + bufferMinutes', async () => {
    const res = await fetch(
      `${base}/v1/availability?accountId=acct_bh&serviceId=svc_bh_consult&start=${MON_START}&end=${MON_END}&slotMinutes=5`
    );
    const { slots } = await res.json();
    assert.strictEqual(slots.length, 8); // 8h / (45 + 15)min
    assert.strictEqual(slots[0].start, '2027-03-15T13:00:00.000Z');
    assert.strictEqual(slots[0].end, '2027-03-15T14:00:00.000Z');
  });

  await t.test('an unknown serviceId still 404s on this path', async () => {
    const res = await fetch(
      `${base}/v1/availability?accountId=acct_bh&serviceId=svc_nope&start=${MON_START}&end=${MON_END}`
    );
    assert.strictEqual(res.status, 404);
  });

  await t.test('a serviceId from another account still 400s on this path', async () => {
    await getServicesRepoForTest().create({
      id: 'svc_bh_elsewhere',
      accountId: 'acct_bh_other',
      name: 'Elsewhere',
      durationMinutes: 30,
    });
    const res = await fetch(
      `${base}/v1/availability?accountId=acct_bh&serviceId=svc_bh_elsewhere&start=${MON_START}&end=${MON_END}`
    );
    assert.strictEqual(res.status, 400);
  });

  await t.test('an existing booking removes the slots it overlaps', async () => {
    const booking = await fetch(`${base}/v1/public/appointments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: 'acct_bh',
        serviceId: 'svc_bh_consult',
        startTime: '2027-03-15T13:00:00Z',
        customer: { name: 'Booked', email: 'booked@example.com' },
      }),
    });
    assert.strictEqual(booking.status, 201);

    const res = await fetch(
      `${base}/v1/availability?accountId=acct_bh&serviceId=svc_bh_consult&start=${MON_START}&end=${MON_END}`
    );
    const { slots } = await res.json();
    assert.strictEqual(slots.length, 7, 'the 13:00Z slot is gone');
    assert.strictEqual(slots[0].start, '2027-03-15T14:00:00.000Z');
  });

  await t.test("another account's bookings do not affect these slots", async () => {
    const res = await fetch(
      `${base}/v1/availability?accountId=acct_bh_other&serviceId=svc_bh_elsewhere&start=${MON_START}&end=${MON_END}`
    );
    const { slots } = await res.json();
    assert.strictEqual(slots.length, 16);
  });

  await t.test('a weekend window returns no slots', async () => {
    const res = await fetch(
      `${base}/v1/availability?accountId=acct_bh&start=2027-03-20T00:00:00Z&end=2027-03-21T00:00:00Z`
    );
    assert.deepStrictEqual(await res.json(), { slots: [] });
  });

  await t.test('BUSINESS_HOURS with a Saturday range opens Saturday', async () => {
    process.env.BUSINESS_HOURS = 'Mon-Fri 09:00-17:00,Sat 10:00-14:00';
    const res = await fetch(
      `${base}/v1/availability?accountId=acct_bh&start=2027-03-20T00:00:00Z&end=2027-03-21T00:00:00Z`
    );
    const { slots } = await res.json();
    assert.strictEqual(slots.length, 8); // 4h / 30min
    assert.strictEqual(slots[0].start, '2027-03-20T14:00:00.000Z'); // 10:00 EDT
    process.env.BUSINESS_HOURS = 'Mon-Fri 09:00-17:00';
  });

  await t.test('BUSINESS_TZ moves the slots', async () => {
    process.env.BUSINESS_TZ = 'UTC';
    const res = await fetch(
      `${base}/v1/availability?accountId=acct_bh_other&start=${MON_START}&end=${MON_END}&slotMinutes=60`
    );
    const { slots } = await res.json();
    assert.strictEqual(slots[0].start, '2027-03-15T09:00:00.000Z');
    process.env.BUSINESS_TZ = 'America/New_York';
  });

  await t.test('without accountId it still returns the historical empty stub', async () => {
    const res = await fetch(
      `${base}/v1/availability?serviceId=svc_bh_consult&start=${MON_START}&end=${MON_END}`
    );
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { slots: [] });
  });

  await t.test('without start/end it still returns the historical empty stub', async () => {
    const res = await fetch(`${base}/v1/availability?accountId=acct_bh`);
    assert.deepStrictEqual(await res.json(), { slots: [] });
  });
});
