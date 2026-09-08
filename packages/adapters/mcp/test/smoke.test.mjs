// Smoke test for the MCP adapter (packages/adapters/mcp/server.ts). There
// were zero tests for this package before (see docs/REALITY-CHECK.md).
//
// This spawns the *real* processes -- the actual @smb/api express app and
// the actual MCP server (via ts-node, exactly how it's run in dev/prod) --
// and drives them over real HTTP, rather than importing internals. That
// way the test also exercises the wiring (env vars, HMAC signing, JSON
// bodies) an in-process unit test would paper over.
//
// Requires packages/api to have been built (`pnpm --filter @smb/api build`)
// so dist/api/src/index.js exists.
import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const apiDir = path.join(repoRoot, 'packages', 'api');
const mcpDir = path.join(repoRoot, 'packages', 'adapters', 'mcp');

const HMAC_SECRET = 'mcp-smoke-secret';

function waitForHttp(url, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try {
        const res = await fetch(url);
        if (res.status < 500) return resolve();
      } catch {
        // not up yet
      }
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`timed out waiting for ${url}`));
      }
      setTimeout(attempt, 150);
    };
    attempt();
  });
}

function spawnAndCollect(cmd, args, opts) {
  const proc = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  proc.stdout.on('data', (d) => (output += d.toString()));
  proc.stderr.on('data', (d) => (output += d.toString()));
  proc.getOutput = () => output;
  return proc;
}

test('MCP adapter: list/create/cancel tools round-trip through a real API server', async (t) => {
  const apiPort = 4600 + Math.floor(Math.random() * 500);
  const mcpPort = apiPort + 500;

  const apiProc = spawnAndCollect('node', ['dist/api/src/index.js'], {
    cwd: apiDir,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(apiPort),
      AGENT_HMAC_SECRET: HMAC_SECRET,
      DATABASE_URL: '', // force the in-memory repository -- this is a fast smoke test, not the Postgres integration test
    },
  });
  t.after(() => apiProc.kill());

  const mcpProc = spawnAndCollect('npx', ['ts-node', 'server.ts'], {
    cwd: mcpDir,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      MCP_PORT: String(mcpPort),
      API_BASE: `http://127.0.0.1:${apiPort}`,
      AGENT_HMAC_SECRET: HMAC_SECRET,
    },
  });
  t.after(() => mcpProc.kill());

  try {
    await waitForHttp(`http://127.0.0.1:${apiPort}/health`);
    await waitForHttp(`http://127.0.0.1:${mcpPort}/schema`);
  } catch (err) {
    throw new Error(`${err.message}\n--- api output ---\n${apiProc.getOutput()}\n--- mcp output ---\n${mcpProc.getOutput()}`);
  }

  const base = `http://127.0.0.1:${mcpPort}`;

  await t.test('GET /schema lists the three tools', async () => {
    const res = await fetch(`${base}/schema`);
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.deepStrictEqual(
      [...json.tools].sort(),
      ['cancelAppointment', 'createAppointment', 'listAvailability'].sort()
    );
  });

  await t.test('call/listAvailability proxies to the API', async () => {
    const res = await fetch(`${base}/call/listAvailability`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serviceId: 'svc_test',
        start: '2026-11-01T00:00:00Z',
        end: '2026-11-02T00:00:00Z',
        tz: 'UTC',
      }),
    });
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.deepStrictEqual(json, { slots: [] });
  });

  let createdId;
  await t.test('call/createAppointment creates a real appointment via the API (HMAC-signed)', async () => {
    const res = await fetch(`${base}/call/createAppointment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: 'acct_mcp',
        serviceId: 'svc_test',
        startTime: '2026-11-01T10:00:00Z',
        customer: { name: 'Jordan', email: 'jordan@example.com' },
      }),
    });
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.status, 'requested');
    assert.ok(json.id, 'response should include the created appointment id');
    createdId = json.id;
  });

  await t.test('call/cancelAppointment cancels the appointment created above', async () => {
    const res = await fetch(`${base}/call/cancelAppointment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: createdId }),
    });
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.status, 'canceled');
    assert.strictEqual(json.id, createdId);
  });

  await t.test('call to an unknown tool 404s', async () => {
    const res = await fetch(`${base}/call/notARealTool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.strictEqual(res.status, 404);
  });
});
