import { type Page } from '@playwright/test'
import { test, expect } from './console-guard'
import { loginAsAdmin, Timeouts } from './helpers'
import { mockAdminSettingsApi } from './admin-settings-api-mock'

// Issue #728: the telephony UI must say which providers carry in-app audio
// (Twilio, SignalWire) and never offer it for the rest.
test.setTimeout(90_000)

const IN_APP_AUDIO_PROVIDERS = ['twilio', 'signalwire'] as const
const PHONES_ONLY_PROVIDERS = ['vonage', 'plivo', 'telnyx', 'bandwidth', 'asterisk', 'freeswitch'] as const

async function openTelephonySection(page: Page) {
  await page.getByTestId('nav-admin-settings').click()
  await page.getByTestId('page-title').waitFor({ state: 'visible', timeout: Timeouts.ELEMENT })
  await page.getByTestId('telephony-provider-trigger').click()
  await expect(page.getByTestId('provider-select')).toBeVisible({ timeout: Timeouts.ELEMENT })
}

test.describe('Telephony provider in-app audio', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page)
    await mockAdminSettingsApi(page)
    await openTelephonySection(page)
  })

  for (const provider of IN_APP_AUDIO_PROVIDERS) {
    test(`${provider} is marked as carrying in-app audio and offers the WebRTC switch`, async ({ page }) => {
      await page.getByTestId('provider-select').selectOption(provider)

      const notice = page.getByTestId('in-app-audio-notice')
      await expect(notice).toHaveAttribute('data-provider', provider)
      await expect(notice).toHaveAttribute('data-in-app-audio', 'supported')
      await expect(page.getByTestId('webrtc-enabled-switch')).toBeVisible()
      await expect(page.getByTestId(`provider-option-${provider}`)).toHaveAttribute('data-in-app-audio', 'supported')
    })
  }

  for (const provider of PHONES_ONLY_PROVIDERS) {
    test(`${provider} is marked phones-only, stays selectable, and offers no in-app audio`, async ({ page }) => {
      await page.getByTestId('provider-select').selectOption(provider)

      const notice = page.getByTestId('in-app-audio-notice')
      await expect(notice).toHaveAttribute('data-provider', provider)
      await expect(notice).toHaveAttribute('data-in-app-audio', 'unsupported')
      await expect(page.getByTestId('webrtc-enabled-switch')).toHaveCount(0)
      await expect(page.getByTestId(`provider-option-${provider}`)).toHaveAttribute('data-in-app-audio', 'unsupported')
      // Still selectable: PSTN parallel ringing works for every provider.
      await expect(page.getByTestId('provider-select')).toHaveValue(provider)
    })
  }

  test('switching from a supported to an unsupported provider drops the WebRTC switch', async ({ page }) => {
    await page.getByTestId('provider-select').selectOption('twilio')
    await expect(page.getByTestId('webrtc-enabled-switch')).toBeVisible()
    await page.getByTestId('provider-select').selectOption('vonage')
    await expect(page.getByTestId('webrtc-enabled-switch')).toHaveCount(0)
  })
})
