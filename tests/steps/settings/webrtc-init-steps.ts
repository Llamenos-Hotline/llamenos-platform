/**
 * WebRTC init honesty step definitions (issue #1741).
 * Matches the "Browser-preference volunteer is told calls ring their phone,
 * never an error" scenario in:
 *   packages/test-specs/features/platform/desktop/settings/webrtc-settings.feature
 *
 * These steps exist because the rest of the feature only exercises the
 * settings panel — nothing asserted that initWebRtc() reaches an honest
 * state, which is how the unresolvable `@twilio/voice-sdk` dynamic import
 * (a dependency declared in no package.json) shipped and turned Answer into
 * caller silence for browser/both volunteers.
 */
import { expect } from '@playwright/test'
import { Given, Then } from '../fixtures'
import {
  Timeouts,
  createUserAndGetDeviceKey,
  dismissDeviceKeyCard,
  loginAsVolunteer,
  uniquePhone,
} from '../../helpers'
import { Navigation } from '../../pages/index'

Given(
  'a volunteer with call preference {string} is logged in',
  async ({ page }, callPreference: string) => {
    // Background already logged in an admin; create the volunteer through the UI.
    await Navigation.goToVolunteers(page)
    const deviceKey = await createUserAndGetDeviceKey(page, `WebRTC-Vol-${Date.now()}`, uniquePhone())
    await dismissDeviceKeyCard(page)

    // Force this volunteer's call preference so the dashboard's WebRtcStatus
    // badge actually calls initWebRtc() on mount. Must be installed BEFORE
    // loginAsVolunteer, which fetches /api/auth/me during login.
    await page.route('**/api/auth/me', async (route) => {
      const response = await route.fetch()
      const json = await response.json()
      await route.fulfill({ response, json: { ...json, callPreference } })
    })

    await loginAsVolunteer(page, deviceKey)
  },
)

Given('the configured provider claims in-app audio', async ({ page }) => {
  // Provider claims in-app audio is possible (Twilio) and would issue a
  // token — exactly the state that used to reach the unresolvable dynamic
  // import. initWebRtc() must not even attempt the token/SDK path today.
  await page.route('**/api/telephony/webrtc-status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ available: true, provider: 'twilio' }),
    })
  })
  await page.route('**/api/telephony/webrtc-token', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ token: 'fake-webrtc-token', provider: 'twilio', identity: 'vol_test' }),
    })
  })
})

Then('the WebRTC status badge should be {string}', async ({ page }, state: string) => {
  const status = page.getByTestId('webrtc-status')
  await expect(status).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(status).toHaveAttribute('data-state', state, { timeout: Timeouts.API })
})

Then('the WebRTC status badge should not be {string}', async ({ page }, state: string) => {
  const status = page.getByTestId('webrtc-status')
  await expect(status).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(status).not.toHaveAttribute('data-state', state)
})

Then('the WebRTC status badge should say that calls ring the phone', async ({ page }) => {
  // The phone-rings path (#728): telephonyProvider.inAppAudioUnsupported =
  // "Calls ring volunteers' phones; no in-app audio." The PSTN leg genuinely
  // carries the audio — the volunteer must see that, not a dead end.
  const status = page.getByTestId('webrtc-status')
  await expect(status).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(status).toContainText("Calls ring volunteers' phones")
})
