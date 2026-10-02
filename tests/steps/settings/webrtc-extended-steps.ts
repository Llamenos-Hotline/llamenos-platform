/**
 * Extended WebRTC settings step definitions.
 * Matches additional steps from: packages/test-specs/features/desktop/settings/webrtc-settings.feature
 * not covered by desktop-admin-steps.ts or interaction-steps.ts
 *
 * Reused from common steps:
 *   - "I expand the {string} section" (interaction-steps.ts)
 *   - "I should see/not see {string}" (interaction-steps.ts)
 *   - "I should see a success message" (interaction-steps.ts)
 *   - "I click {string}" (interaction-steps.ts)
 *   - "I reload and re-authenticate" (interaction-steps.ts)
 *   - "I navigate to the {string} page" (navigation-steps.ts)
 *   - "I navigate to {string}" (navigation-steps.ts)
 */
import { expect } from '@playwright/test'
import { When, Then } from '../fixtures'
import { TestIds } from '../../test-ids'
import { Timeouts } from '../../helpers'

Then('the {string} option should be selected', async ({ page }, optionText: string) => {
  const option = page.locator('button').filter({ hasText: optionText })
  await expect(option).toHaveClass(/border-primary/)
})

Then('I should see a message that browser calling is not available', async ({ page }) => {
  await expect(page.getByText(/browser calling is not available/i)).toBeVisible()
})

Then('the {string} option should be disabled', async ({ page }, optionText: string) => {
  const option = page.locator('button').filter({ hasText: optionText })
  await expect(option).toBeDisabled()
})

When('I enable the WebRTC toggle', async ({ page }) => {
  const toggle = page.getByTestId(TestIds.WEBRTC_ENABLED_SWITCH)
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
})

Then('the WebRTC toggle should not be offered', async ({ page }) => {
  await expect(page.getByTestId(TestIds.WEBRTC_ENABLED_SWITCH)).toHaveCount(0)
})

Then(
  'the in-app audio notice should mark {string} as {string}',
  async ({ page }, provider: string, inAppAudio: string) => {
    const notice = page.getByTestId(TestIds.IN_APP_AUDIO_NOTICE)
    await expect(notice).toHaveAttribute('data-provider', provider)
    await expect(notice).toHaveAttribute('data-in-app-audio', inAppAudio)
  },
)

When('I switch the provider to {string}', async ({ page }, provider: string) => {
  const select = page.getByTestId(TestIds.PROVIDER_SELECT)
  await select.selectOption(provider)
  await expect(select).toHaveValue(provider)
})

When('I fill in Twilio credentials with WebRTC config', async ({ page }) => {
  // Must match ^AC[0-9a-f]{32}$ — AC prefix + exactly 32 lowercase hex chars
  await page.getByTestId(TestIds.ACCOUNT_SID).fill('AC00000000000000000000000000000001')
  await page.getByTestId(TestIds.AUTH_TOKEN).fill('webrtc-auth-token')

  // Provider phone number (required for the save button to be enabled).
  // react-phone-number-input needs typed input to fire onChange.
  const phoneInput = page.locator('#provider-phone')
  await expect(phoneInput).toBeVisible({ timeout: Timeouts.ELEMENT })
  await phoneInput.click({ clickCount: 3 })
  await phoneInput.pressSequentially('+12121234567', { delay: 30 })
  await phoneInput.blur()

  // Turn WebRTC on without toggling it OFF when a previous scenario left it on.
  const toggle = page.getByTestId(TestIds.WEBRTC_ENABLED_SWITCH)
  await expect(toggle).toHaveAttribute('aria-checked', /^(true|false)$/, { timeout: Timeouts.ELEMENT })
  if ((await toggle.getAttribute('aria-checked')) !== 'true') {
    await toggle.click()
  }
  await expect(toggle).toHaveAttribute('aria-checked', 'true')

  // The API key fields render only once WebRTC is on.
  await page.getByTestId(TestIds.API_KEY_SID).fill('SKtestkey123')
  await page.getByTestId(TestIds.TWIML_APP_SID).fill('APtestapp456')
})

Then('the WebRTC API key fields should be populated', async ({ page }) => {
  // This runs after a reload: the saved config must come back with WebRTC still
  // enabled and both values intact. The previous version switched WebRTC back
  // on itself when it had not persisted, and passed on the page title when the
  // fields were missing — i.e. it passed precisely when persistence failed.
  await expect(page.getByTestId(TestIds.WEBRTC_ENABLED_SWITCH)).toHaveAttribute('aria-checked', 'true', { timeout: Timeouts.ELEMENT })
  await expect(page.getByTestId(TestIds.API_KEY_SID)).toHaveValue('SKtestkey123')
  await expect(page.getByTestId(TestIds.TWIML_APP_SID)).toHaveValue('APtestapp456')
})
