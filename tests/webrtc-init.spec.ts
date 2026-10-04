import { test, expect } from '@playwright/test'
import { loginAsAdmin, loginAsVolunteer, createUserAndGetDeviceKey, dismissDeviceKeyCard, uniquePhone, Timeouts } from './helpers'

// Issue #1147: `@twilio/voice-sdk` is not a dependency anywhere in this repo,
// but the old `initTwilioWebRtc()` loaded it through a deliberately
// unresolvable `/* @vite-ignore */` dynamic import. On desktop, answering a
// call (`POST /calls/:id/answer`) is a pure database write with no media
// bridge — the PSTN leg carries audio for `phone`-preference volunteers, but
// a `browser`/`both` volunteer has nothing else to carry it. So whenever the
// configured provider claimed in-app audio (Twilio/SignalWire), the missing
// package turned "volunteer presses Answer" into "caller hears silence while
// the volunteer's status badge silently flips to an error state".
//
// initWebRtc() must never attempt to load a client SDK that isn't installed.
// Every provider is honestly reported `unsupported` until a real one ships —
// never `error` (a failed load) and never `ready` (nothing to carry audio).
test.describe('WebRTC init never claims a client SDK that is not installed (#1147)', () => {
  test('browser call preference against an in-app-audio-capable provider reports unsupported, not error', async ({ page }) => {
    await loginAsAdmin(page)
    const volunteerSeedHex = await createUserAndGetDeviceKey(page, `WebRTC-Vol-${Date.now()}`, uniquePhone())
    await dismissDeviceKeyCard(page)

    // Provider claims in-app audio is possible (Twilio) and issues a token —
    // exactly the state that used to reach the unresolvable dynamic import.
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
    // Force this volunteer's call preference to browser so the dashboard's
    // WebRtcStatus badge actually calls initWebRtc() on mount.
    await page.route('**/api/auth/me', async (route) => {
      const response = await route.fetch()
      const json = await response.json()
      await route.fulfill({ response, json: { ...json, callPreference: 'browser' } })
    })

    await loginAsVolunteer(page, volunteerSeedHex)

    const status = page.getByTestId('webrtc-status')
    await expect(status).toBeVisible({ timeout: Timeouts.ELEMENT })
    await expect(status).toHaveAttribute('data-state', 'unsupported', { timeout: Timeouts.API })
    // Never the failed-import error state, and never a false "ready" claim
    // with no client SDK actually installed to carry the audio.
    await expect(status).not.toHaveAttribute('data-state', 'error')
    await expect(status).not.toHaveAttribute('data-state', 'ready')
  })
})
