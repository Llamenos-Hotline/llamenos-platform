/**
 * Extended telephony provider step definitions.
 * Matches additional steps from: packages/test-specs/features/desktop/calls/telephony-provider.feature
 * not covered by desktop-admin-steps.ts
 */
import { expect, type Page } from '@playwright/test'
import type { DataTable } from 'playwright-bdd'
import { When, Then } from '../fixtures'
import { TestIds } from '../../test-ids'
import { Timeouts } from '../../helpers'

// Asserts on the provider identity each option carries (its `value` and
// `data-in-app-audio`), not its display text — the label is i18n-decorated
// (e.g. "Vonage — phones only") and would break on any copy change.
Then(
  'the provider dropdown should offer exactly these providers:',
  async ({ page }, table: DataTable) => {
    const expected = table.hashes()
    const options = page.getByTestId(TestIds.PROVIDER_SELECT).locator('option')
    await expect(options).toHaveCount(expected.length)
    for (const [i, row] of expected.entries()) {
      await expect(options.nth(i)).toHaveAttribute('value', row.provider)
      await expect(options.nth(i)).toHaveAttribute('data-in-app-audio', row.inAppAudio)
    }
  },
)

// "the {string} button should be disabled" is defined in interaction-steps.ts

When('I fill in Twilio credentials with phone number', async ({ page }) => {
  // Use #provider-phone to avoid matching other tel inputs (e.g. Signal notification phone).
  // Triple-click to select all, then type — more reliable than clear() for react-phone-number-input.
  const telInput = page.locator('#provider-phone')
  await telInput.click({ clickCount: 3 })
  await telInput.pressSequentially('+12125551234', { delay: 30 })
  await telInput.blur()
  await page.getByPlaceholder('AC...').fill('AC00000000000000000000000000000001')
  const authTokenInput = page.locator('input[type="password"]').first()
  await authTokenInput.fill('test-auth-token-123')
})

Then('I should see {string} with {string}', async ({ page }, text1: string, text2: string) => {
  // The previous fallback ("backend may not be available — the page loaded")
  // passed whenever the saved provider was NOT shown.
  const combined = page.getByText(new RegExp(`${text1}.*${text2}|${text2}.*${text1}`, 'i')).first()
  await expect(combined).toBeVisible({ timeout: Timeouts.ELEMENT })
})

/** Fill the provider credential fields. Every field must be present: a skipped fill saves a different config than the scenario describes. */
async function fillProviderCredentials(
  page: Page,
  creds: { phone: string; accountSid: string; authToken: string; signalwireSpace?: string },
) {
  // #provider-phone, not any tel input (the Signal notification phone is one too).
  // react-phone-number-input ignores clear(): select-all by triple-click, then type.
  const telInput = page.locator('#provider-phone')
  await expect(telInput).toBeVisible({ timeout: Timeouts.ELEMENT })
  await telInput.click({ clickCount: 3 })
  await telInput.pressSequentially(creds.phone, { delay: 30 })
  await telInput.blur()
  await page.getByTestId(TestIds.ACCOUNT_SID).fill(creds.accountSid)
  await page.getByTestId(TestIds.AUTH_TOKEN).fill(creds.authToken)
  if (creds.signalwireSpace !== undefined) {
    await page.getByPlaceholder('myspace').fill(creds.signalwireSpace)
  }
}

When('I fill in Twilio credentials with a different phone number', async ({ page }) => {
  // Use #provider-phone to avoid matching other tel inputs (e.g. Signal notification phone).
  // react-phone-number-input doesn't reliably respond to clear() + pressSequentially().
  // Use triple-click to select all text, then type the replacement value.
  const telInput = page.locator('#provider-phone')
  await expect(telInput).toBeVisible({ timeout: Timeouts.ELEMENT })
  await telInput.click({ clickCount: 3 })
  await telInput.pressSequentially('+12125559876', { delay: 30 })
  await telInput.blur()
  // Verify the fill actually worked before proceeding to save
  await expect(telInput).toHaveValue(/555.*987/, { timeout: 3000 })
  await page.getByTestId(TestIds.ACCOUNT_SID).fill('AC00000000000000000000000000000002')
  await page.getByTestId(TestIds.AUTH_TOKEN).fill('test-auth-token-456')
})

Then('the phone number field should be pre-filled', async ({ page }) => {
  // Use the specific provider phone input (id="provider-phone") to avoid matching
  // other tel inputs on the page (e.g. Signal notification phone field).
  await expect(page.locator('#provider-phone')).toHaveValue(/555\s*987\s*6/)
})

When('I fill in SignalWire credentials', async ({ page }) => {
  // SignalWire project IDs are UUIDs, not Twilio AC... SIDs.
  await fillProviderCredentials(page, {
    phone: '+12125551122',
    accountSid: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    authToken: 'sw-auth-token-789',
    signalwireSpace: 'myhotline',
  })
})

When('I fill in fake Twilio credentials', async ({ page }) => {
  await fillProviderCredentials(page, {
    phone: '+12125551456',
    accountSid: 'AC00000000000000000000000000000003',
    authToken: 'fake-token',
  })
})

Then('the provider dropdown should be visible', async ({ page }) => {
  await expect(page.locator('select').first()).toBeVisible({ timeout: 10000 })
})
