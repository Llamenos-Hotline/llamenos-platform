/**
 * Extended device linking step definitions.
 * Matches additional steps from: packages/test-specs/features/settings/device-link.feature
 * not covered by settings-steps.ts
 *
 * Behavioral depth: Hard assertions, no expect(true).toBe(true).
 */
import { expect } from '@playwright/test'
import { When, Then } from '../fixtures'
import { TestIds } from '../../test-ids'
import { Timeouts } from '../../helpers'

// On desktop, Settings is the APPROVING side of device linking: it takes a
// code produced by the new device (/link-device, which shows the QR). These
// steps drive that flow and assert the scenario's claims as written. Each used
// to end in "the page title is visible" (or nothing at all), so the QR, progress,
// cancel and timeout scenarios all passed without any of those things existing.

When('I start the device linking process', async ({ page }) => {
  const codeInput = page.getByTestId('link-code-input')
  await expect(codeInput).toBeVisible({ timeout: Timeouts.ELEMENT })
  await codeInput.fill('{"r":"test-room","t":"test-token"}')
  await page.getByTestId('link-device-button').click()
})

Then('I should see a QR code displayed', async ({ page }) => {
  await expect(page.getByTestId(TestIds.PROVISIONING_QR)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the linking progress indicator', async ({ page }) => {
  await expect(page.getByRole('progressbar').first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I cancel the linking', async ({ page }) => {
  const cancelBtn = page.getByTestId(TestIds.FORM_CANCEL_BTN)
  await expect(cancelBtn).toBeVisible({ timeout: Timeouts.ELEMENT })
  await cancelBtn.click()
})

When('the provisioning room expires', async ({ page }) => {
  // Simulate a timeout via custom event
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('provisioning-timeout'))
  })
})

Then('I should see a timeout error message', async ({ page }) => {
  const timeoutError = page.getByTestId(TestIds.ERROR_MESSAGE)
    .or(page.getByRole('alert'))
    .filter({ hasText: /timeout|expired|timed out/i })
  await expect(timeoutError.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})
