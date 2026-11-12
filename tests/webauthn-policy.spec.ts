import { type Page } from '@playwright/test'
import { test, expect } from './console-guard'
import { loginAsAdmin, Timeouts } from './helpers'

/**
 * Mock all API endpoints the admin settings page loads on mount, so the
 * page renders deterministically regardless of real backend state. The
 * `webauthn` PATCH route is the one under test here (issue #677): it
 * returns 409 `WEBAUTHN_CREDENTIAL_REQUIRED` when the caller tries to turn
 * on `requireForAdmins` without a registered passkey of their own — this
 * mirrors the real server behavior added in `apps/worker/routes/settings.ts`
 * (#672/#674).
 */
async function mockAdminSettingsApi(page: Page) {
  await page.route('**/api/settings/messaging', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        enabledChannels: [],
        sms: null,
        whatsapp: null,
        signal: null,
        rcs: null,
        telegram: null,
        autoAssign: true,
        inactivityTimeout: 60,
        maxConcurrentPerUser: 3,
        preferSignalDelivery: true,
        smsContentMode: 'notification-only',
      }),
    })
  })

  await page.route('**/api/hubs/*/settings/spam', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ voiceCaptchaEnabled: false, rateLimitEnabled: false, maxCallsPerMinute: 10, banListEnabled: false }),
    })
  })

  await page.route('**/api/hubs/*/settings/call', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ queueTimeoutSeconds: 180, voicemailMaxSeconds: 120, parallelRingEnabled: true }),
    })
  })

  await page.route('**/api/settings/transcription', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ globalEnabled: false, allowUserOptOut: false }),
    })
  })

  await page.route('**/api/settings/ivr-languages', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ enabledLanguages: ['en', 'es'] }),
    })
  })

  await page.route('**/api/settings/ivr-audio', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ recordings: [] }),
    })
  })

  // WebAuthn settings — the route under test. GET always reports the policy
  // as off; PATCH returns 409 WEBAUTHN_CREDENTIAL_REQUIRED when the caller
  // tries to require passkeys for admins without one of their own, matching
  // the real backend contract in apps/worker/routes/settings.ts.
  await page.route('**/api/settings/webauthn', async (route) => {
    const req = route.request()
    if (req.method() === 'PATCH') {
      const body = req.postDataJSON() as { requireForAdmins?: boolean; requireForUsers?: boolean }
      if (body.requireForAdmins === true) {
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'Register a passkey before requiring passkeys for admins',
            code: 'WEBAUTHN_CREDENTIAL_REQUIRED',
          }),
        })
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ requireForAdmins: false, requireForUsers: false, ...body }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ requireForAdmins: false, requireForUsers: false }),
    })
  })

  await page.route(/\/api\/(hubs\/[^/]+\/)?settings\/custom-fields$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ fields: [] }),
    })
  })

  await page.route('**/api/settings/telephony-provider', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ type: 'twilio' }),
    })
  })

  await page.route('**/api/provider-setup/a2p/status*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'test-a2p',
        hubId: 'test-hub',
        providerType: 'twilio',
        brandStatus: 'not_submitted',
        campaignStatus: 'not_submitted',
      }),
    })
  })
}

test.describe('Passkey Policy errors', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page)
    await mockAdminSettingsApi(page)
    await page.getByTestId('nav-admin-settings').click()
    await page.getByTestId('page-title').waitFor({ state: 'visible', timeout: Timeouts.ELEMENT })
  })

  test('shows the specific error when enabling admin passkey requirement without a passkey (#677)', async ({ page, consoleWatch }) => {
    consoleWatch.expect({
      message: /^Failed to load resource: the server responded with a status of 409 \(Conflict\)$/,
      source: /\/api\/settings\/webauthn$/,
      reason: 'the mocked PATCH answers 409 WEBAUTHN_CREDENTIAL_REQUIRED, the real contract being exercised (#677)',
    })
    await page.getByTestId('webauthn-require-for-admins-toggle').click()
    await expect(page.getByTestId('toast-error')).toContainText(
      'Register a passkey before requiring passkeys for admins.',
      { timeout: Timeouts.ELEMENT },
    )
  })

  test('falls back to the generic error toast for unrelated webauthn failures', async ({ page, consoleWatch }) => {
    consoleWatch.expect({
      message: /^Failed to load resource: the server responded with a status of 500 \(Internal Server Error\)$/,
      source: /\/api\/settings\/webauthn$/,
      reason: 'the test injects an unrelated 500 from the PATCH to exercise the generic error toast',
    })
    // requireForUsers doesn't hit the credential-required branch server-side —
    // simulate an unrelated server failure to confirm the generic path still works.
    await page.route('**/api/settings/webauthn', async (route) => {
      if (route.request().method() === 'PATCH') {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Internal error' }),
        })
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ requireForAdmins: false, requireForUsers: false }),
      })
    })

    await page.getByTestId('webauthn-require-for-users-toggle').click()
    await expect(page.getByTestId('toast-error')).toHaveText('Error', { timeout: Timeouts.ELEMENT })
  })
})
