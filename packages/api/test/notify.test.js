import test from 'node:test';
import assert from 'node:assert';

process.env.NODE_ENV = 'test';
const { sendNotification } = await import('../dist/api/src/notify.js');

test('redacts PII in logs', async () => {
  const logs = [];
  const orig = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  await sendNotification({
    to: { email: 'user@example.com', phone: '123-456' },
    type: 'appointment_requested',
    payload: { ok: true },
  });
  console.log = orig;
  const joined = logs.join(' ');
  assert(!joined.includes('user@example.com'));
  assert(!joined.includes('123-456'));
  assert(joined.includes('[redacted]'));
});
