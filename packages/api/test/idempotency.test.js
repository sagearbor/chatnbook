import test from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';

process.env.NODE_ENV = 'test';
process.env.AGENT_HMAC_SECRET = 'testsecret';
const { app, resetIdempotency } = await import('../dist/api/src/index.js');

function sign(body) {
  return crypto
    .createHmac('sha256', process.env.AGENT_HMAC_SECRET)
    .update(JSON.stringify(body || ''))
    .digest('base64');
}

test('returns same response for repeated Idempotency-Key', async (t) => {
  resetIdempotency();
  const server = app.listen(0);
  t.after(() => server.close());
  const port = server.address().port;

  const body = { accountId: 'a1', serviceId: 's1', startTime: '2025-08-20T09:00:00Z', customer: { name: 'Ann', email: 'ann@example.com' } };
  const key = 'key123';
  const sig = sign(body);
  const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': key, 'X-Signature': sig };

  const res1 = await fetch(`http://127.0.0.1:${port}/v1/appointments`, { method: 'POST', headers, body: JSON.stringify(body) });
  const json1 = await res1.json();
  const res2 = await fetch(`http://127.0.0.1:${port}/v1/appointments`, { method: 'POST', headers, body: JSON.stringify(body) });
  const json2 = await res2.json();

  assert.strictEqual(res1.status, 201);
  assert.strictEqual(res2.status, 200);
  assert.deepStrictEqual(json1, json2);
});
