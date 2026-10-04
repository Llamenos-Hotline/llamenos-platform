/**
 * Security step definitions.
 * Matches steps from:
 *   - packages/test-specs/features/security/https-enforcement.feature
 *   - packages/test-specs/features/security/relay-url-validation.feature
 */
import { expect } from '@playwright/test'
import { Given, When, Then } from '../fixtures'
import { Timeouts } from '../../helpers'

// ── HTTPS Enforcement ──────────────────────────────────────────────

Given('I am on the setup or identity creation screen', async ({ page }) => {
  // These tests validate hub URL input on the identity step — skip bootstrap
  // and clear any stored device keys so the PIN-unlock gate doesn't block the wizard.
  await page.addInitScript(() => {
    sessionStorage.setItem('bootstrapComplete', '1')
    // Clear mock Tauri store keys so hasStoredKey() returns false
    for (const key of Object.keys(localStorage)) {
      if (key.includes('encrypted') || key.includes('device-key')) {
        localStorage.removeItem(key)
      }
    }
  })
  await page.goto('/setup')
  await page.waitForLoadState('domcontentloaded')
  // Wait for the setup wizard to render (past loading/bootstrap/PIN states)
  await page.getByTestId('setup-wizard').waitFor({ state: 'visible', timeout: 10_000 })
})

When('I enter hub URL {string}', async ({ page }, url: string) => {
  const hubInput = page.getByTestId('hub-url-input')
  await expect(hubInput).toBeVisible({ timeout: 5000 })
  await hubInput.fill(url)
})

When('I submit the form', async ({ page }) => {
  const submitBtn = page.getByTestId('setup-next-btn')
    .or(page.getByRole('button', { name: /next|submit|continue|save/i }))
  const visible = submitBtn.filter({ visible: true })
  // Wait for exactly one visible candidate instead of blindly taking `.first()` —
  // `force: true` below skips Playwright's own actionability wait (needed to click a
  // disabled button), so without this assertion a hidden or ambiguous match could be
  // force-clicked, silently no-op'ing the submit.
  await expect(visible).toHaveCount(1, { timeout: Timeouts.ELEMENT })
  // If button is disabled (validation prevents submit), attempt click anyway —
  // Playwright clicks disabled buttons without error, but no navigation occurs.
  await visible.click({ force: true })
})

Then('I should see an error about insecure connection', async ({ page }) => {
  const errorText = page.locator('[role="alert"]').filter({ hasText: /https|insecure|secure connection/i })
  await expect(errorText.first()).toBeVisible({ timeout: 5000 })
})

Then('the connection should not be established', async ({ page }) => {
  // Verify we're still on the setup screen (no navigation occurred)
  expect(page.url()).toMatch(/\/(setup|login)/)
})

Then('I should not see a connection security error', async ({ page }) => {
  const errorText = page.locator('[role="alert"]').filter({ hasText: /insecure|secure connection/i })
  await expect(errorText).not.toBeVisible({ timeout: 2000 })
})

// ── Relay URL Validation ───────────────────────────────────────────

When('a QR code with relay URL {string} is scanned', async ({ page }, relayUrl: string) => {
  // Simulate QR scan result by injecting it into the device link flow
  // The actual QR scanning requires camera access — mock the result
  await page.evaluate((url) => {
    (window as unknown as { __test_scanned_relay_url?: string }).__test_scanned_relay_url = url
    // Dispatch a custom event that the link-device page can listen to
    window.dispatchEvent(new CustomEvent('test-qr-scan', { detail: { relayUrl: url } }))
  }, relayUrl)
})

// NOTE: "I should see the error state" is defined in settings-steps.ts

Then('the error message should mention private or local network', async ({ page }) => {
  const errorText = page.locator('[role="alert"]').filter({ hasText: /private|local|localhost|reserved/i })
  await expect(errorText.first()).toBeVisible({ timeout: 5000 })
})

Then('I should not see a relay URL error', async ({ page }) => {
  // (Only @requires-camera scenarios use this.) An absence check over any text
  // on the page; asserted web-first rather than sampled once.
  await expect(page.getByRole('alert').filter({ hasText: /private|local|invalid relay/i })).toHaveCount(0)
})

Then('the step should advance to {string}', async ({ page }, stepName: string) => {
  const stepIndicator = page.locator(`text=/${stepName}/i`).first()
  await expect(stepIndicator).toBeVisible({ timeout: 5000 })
})
