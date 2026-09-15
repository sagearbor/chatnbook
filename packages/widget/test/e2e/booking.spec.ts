// Real-browser regression test for the class of bug the 2026-09-12 deploy
// round found: packages/widget/test/app.test.mjs and entrypoint.test.mjs
// both import the widget's JS directly and call it themselves, so a
// silently-broken app.html <-> entry-module wiring can pass every unit
// test while rendering an empty <body> in an actual browser. This test
// loads the live-built widget (packages/widget/dist, served by the real
// @smb/api server -- see playwright.config.ts) in Chromium via Playwright
// and drives a complete booking through the real UI, the same click path
// used in last round's manual CDP verification (launcher -> service ->
// day -> time -> name/email -> submit -> confirmation), so a future
// regression like it fails CI instead of only showing up after a manual
// deploy check.
import { test, expect } from '@playwright/test';

test('completes a booking through the live-built widget in a real browser', async ({ page, baseURL }) => {
  await page.goto(`${baseURL}/demo`);

  // The launcher button + iframe are injected by packages/widget/dist's
  // loader.js (served as /widget.js) -- confirms that script actually ran.
  const launcher = page.locator('#smb-widget-button');
  await expect(launcher).toBeVisible();
  await launcher.click();

  const widget = page.frameLocator('#smb-widget-frame');

  await expect(widget.getByRole('heading', { name: 'Choose a service' })).toBeVisible();
  const firstService = widget.locator('.smb-item-btn').first();
  await expect(firstService).toBeVisible();
  const serviceLabel = await firstService.textContent();
  await firstService.click();

  await expect(widget.getByRole('heading', { name: /Choose a day and time/ })).toBeVisible();
  // playwright.config.ts sets BUSINESS_HOURS to nearly 24/7 UTC specifically
  // so the very first day button always has openings, regardless of what
  // real-world time this runs at.
  await widget.locator('.smb-day-btn').first().click();
  const firstSlot = widget.locator('.smb-slot-btn').first();
  await expect(firstSlot).toBeVisible({ timeout: 10_000 });
  const slotLabel = await firstSlot.textContent();
  await firstSlot.click();

  await expect(widget.getByRole('heading', { name: 'Your details' })).toBeVisible();
  const uniqueEmail = `pw-e2e-${Date.now()}@example.com`;
  await widget.locator('#smb-name').fill('Playwright E2E');
  await widget.locator('#smb-email').fill(uniqueEmail);
  await widget.locator('.smb-primary-btn').click();

  // The real assertion: a genuine POST /v1/public/appointments 201 came
  // back and the widget rendered it -- not a jsdom stand-in, not a status
  // code check against curl.
  await expect(widget.getByRole('heading', { name: /booked/i })).toBeVisible({ timeout: 10_000 });
  const confirmationText = await widget.locator('#smb-step').textContent();
  expect(confirmationText).toContain('Confirmation:');
  // A non-empty confirmation id proves the appointment record round-tripped
  // through the real API, not just that the UI transitioned to step 4.
  expect(confirmationText).toMatch(/Confirmation:\s*\S+/);

  test.info().annotations.push(
    { type: 'booked', description: `${serviceLabel} @ ${slotLabel} (${uniqueEmail})` }
  );
});
