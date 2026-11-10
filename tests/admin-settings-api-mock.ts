import type { Page } from '@playwright/test'

/**
 * Mock all API endpoints needed by the admin settings page so channel
 * configuration sections render without a real backend settings state.
 */
export async function mockAdminSettingsApi(
  page: Page,
  telephonyProvider: { type: string; [key: string]: unknown } = { type: 'twilio' },
) {
  // Messaging config — required for channel sections to render
  await page.route('**/api/settings/messaging', async (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON()
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
          ...body,
        }),
      })
    } else {
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
    }
  })

  // Messaging channel test endpoint
  await page.route('**/api/settings/messaging/test', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ connected: true }),
    })
  })

  // Spam settings — hub-owned (#1137): the client requests them under the hub
  // being edited, never the unscoped platform route.
  await page.route('**/api/hubs/*/settings/spam', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ voiceCaptchaEnabled: false, rateLimitEnabled: false, maxCallsPerMinute: 10, banListEnabled: false }),
    })
  })

  // Call settings — hub-owned (#1137), same scoping as spam.
  await page.route('**/api/hubs/*/settings/call', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ queueTimeoutSeconds: 180, voicemailMaxSeconds: 120, parallelRingEnabled: true }),
    })
  })

  // Transcription settings
  await page.route('**/api/settings/transcription', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ globalEnabled: false, allowUserOptOut: false }),
    })
  })

  // IVR languages
  await page.route('**/api/settings/ivr-languages', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ enabledLanguages: ['en', 'es'], uncoveredLanguageCount: 0 }),
    })
  })

  // IVR audio recordings
  await page.route('**/api/settings/ivr-audio', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ recordings: [] }),
    })
  })

  // WebAuthn settings
  await page.route('**/api/settings/webauthn', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ requireForAdmins: false, requireForUsers: false }),
    })
  })

  // Custom fields
  await page.route('**/api/settings/custom-fields', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ fields: [] }),
    })
  })

  // Telephony provider
  await page.route('**/api/settings/telephony-provider', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(telephonyProvider),
    })
  })

  // A2P registration status
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
