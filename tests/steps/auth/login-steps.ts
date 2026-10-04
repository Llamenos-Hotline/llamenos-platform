/**
 * Login screen step definitions.
 * Matches steps from: packages/test-specs/features/auth/login.feature
 *
 * The desktop login page has three states:
 * 1. PIN unlock (when stored key exists)
 * 2. Bootstrap redirect (when no admin exists)
 * 3. Recovery / first-time login (device key entry, backup restore, device linking)
 *
 * There is NO "Create New Identity" button, no "Import Key" button, no #hub-url field,
 * and no data-testid="page-title" on the login page.
 *
 * Note: Steps like "the app is freshly installed", "no identity exists on the device",
 * "I am on the login screen", and "the app launches" are defined in auth-steps.ts.
 */
import { expect } from '@playwright/test'
import { When, Then } from '../fixtures'
import { TestIds, Timeouts } from '../../helpers'

Then('I should see the device key import input field', async ({ page }) => {
  await expect(page.getByTestId(TestIds.DEVICE_KEY_INPUT)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I enter {string} in the device key field', async ({ page }, value: string) => {
  await page.getByTestId(TestIds.DEVICE_KEY_INPUT).fill(value)
})

When('I enter {string} in the device key input', async ({ page }, value: string) => {
  await page.getByTestId(TestIds.DEVICE_KEY_INPUT).fill(value)
})

Then('the device key field should be a password field', async ({ page }) => {
  const keyInput = page.getByTestId(TestIds.DEVICE_KEY_INPUT)
  await expect(keyInput).toHaveAttribute('type', 'password')
})

When('I enter a valid 63-character device key', async ({ page }) => {
  // The login page validates via isValidSeedHex() which expects a 64-char hex string
  // (raw Ed25519 seed). Use the admin seed so the backend
  // recognizes the derived pubkey and getMe() succeeds after signIn().
  const { ADMIN_SEED } = await import('../../helpers')
  await page.getByTestId(TestIds.DEVICE_KEY_INPUT).fill(ADMIN_SEED)
  // The device-key form always pairs the key with a new PIN (#device-key-pin).
  const pinField = page.locator('#device-key-pin')
  await expect(pinField).toBeVisible({ timeout: Timeouts.ELEMENT })
  await pinField.fill('12345678')
})

// 'I start typing in the device key field' is defined in key-import-steps.ts (shared)
// 'the error should disappear' is defined in key-import-steps.ts (shared)

When('I see the error {string}', async ({ page }, _text: string) => {
  // Wait for any error to appear
  const error = page.getByTestId(TestIds.ERROR_MESSAGE)
    .or(page.locator('[role="alert"]'))
  await expect(error.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the PIN setup screen', async ({ page }) => {
  const pinInput = page.getByTestId(TestIds.PIN_INPUT).first()
  await expect(pinInput).toBeVisible({ timeout: Timeouts.AUTH })
})

// 'I tap {string} without entering a device key' is defined in interaction-steps.ts (shared)
