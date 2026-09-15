// Playwright config for the browser-surface E2E test (test/e2e/*.spec.ts).
//
// Closes the gap the 2026-09-12 deploy round found: every existing test
// (this package's jsdom-based test/*.test.mjs included) invokes App()
// itself, so none of them would have caught the real bug -- app.html
// loading a module that only *exports* App() without calling it, which
// rendered an empty <body> in an actual browser. This config boots the
// real, freshly-built @smb/api server (see pretest:e2e in package.json,
// which builds both @smb/api and this package first) serving the
// live-built widget bundle exactly the way Cloud Run does, then
// test/e2e/booking.spec.ts drives a real Chromium browser through it.
import { defineConfig, devices } from '@playwright/test';

const PORT = process.env.E2E_PORT ? Number(process.env.E2E_PORT) : 3947;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './test/e2e',
  timeout: 30_000,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list']] : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  webServer: {
    // Runs the *compiled* server (dist/), not ts-node -- this test exists
    // specifically to catch bugs that only show up in the built artifact a
    // real deployment serves, not in source.
    command: 'node ../api/dist/api/src/index.js',
    url: `${BASE_URL}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PORT: String(PORT),
      NODE_ENV: 'production',
      SEED_DEMO_ACCOUNT: 'acct_demo',
      AGENT_HMAC_SECRET: 'e2e-test-secret',
      // Wide-open business hours in a fixed timezone so the test never
      // depends on what real-world time it happens to run at (a booking
      // widget with the default Mon-Fri 9-5 America/New_York hours would
      // show "no openings" for a big chunk of any given week/weekend).
      BUSINESS_HOURS: 'Mon-Sun 00:00-23:30',
      BUSINESS_TZ: 'UTC',
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
