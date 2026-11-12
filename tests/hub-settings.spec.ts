import { test, expect } from './console-guard'
import { loginAsAdmin, mockConfigWithHub, navigateViaSpa, Timeouts } from './helpers'

/**
 * Mock API responses for a fully configured hub (post-onboarding state).
 * The hub-communications route shows settings panel instead of wizard
 * when onboardingComplete=true.
 */
async function mockConfiguredHub(
  page: import('@playwright/test').Page,
  overrides: {
    providerConnected?: boolean
    providerType?: string
    channelsConfigured?: string[]
    channelsPending?: string[]
    numbersProvisioned?: number
    a2pStatus?: string | null
    channelConfig?: Record<string, boolean>
    usage?: Record<string, number>
  } = {},
) {
  const {
    providerConnected = true,
    providerType = 'twilio',
    channelsConfigured = ['voice', 'sms'],
    channelsPending = ['signal'],
    numbersProvisioned = 2,
    a2pStatus = 'approved',
    channelConfig = {
      voice: true,
      sms: true,
      email: false,
      signal: true,
      whatsapp: false,
      telegram: false,
      rcs: false,
    },
    usage = {
      callsReceived: 42,
      smsSent: 128,
      signalMessagesSent: 15,
      whatsAppMessagesSent: 3,
    },
  } = overrides

  await page.route('**/api/hubs/*/onboard/provider-status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: {
          hubId: 'test-hub-1',
          onboardingComplete: true,
          providerConnected,
          providerType,
          channelsConfigured,
          channelsPending,
          numbersProvisioned,
          a2pStatus,
          quotas: {
            maxPhoneNumbers: 5,
            maxSmsPerMonth: 1000,
            maxCallsPerMonth: 500,
            maxSignalMessagesPerMonth: 500,
            maxWhatsAppMessagesPerMonth: 500,
            maxSubAccounts: 0,
          },
        },
      }),
    })
  })

  await page.route('**/api/hubs/*/onboard/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        onboarding: {
          hubId: 'test-hub-1',
          step: 'summary',
          channelConfig,
        },
      }),
    })
  })

  await page.route('**/api/hubs/*/onboard/usage', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ usage }),
    })
  })

  // Mock channel update endpoint for toggle tests
  await page.route('**/api/hubs/*/onboard/channels', async (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON()
      const updatedConfig = { ...channelConfig }
      if (body?.channel && typeof body.enabled === 'boolean') {
        updatedConfig[body.channel] = body.enabled
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ channels: updatedConfig }),
      })
    } else {
      await route.continue()
    }
  })
}

test.describe('Hub Provider Settings Panel', () => {
  test.beforeEach(async ({ page }) => {
    await mockConfigWithHub(page)
    await loginAsAdmin(page)
    await mockConfiguredHub(page)
    await navigateViaSpa(page, '/admin/hub-communications')
  })

  test('renders settings page with page title for configured hub', async ({ page }) => {
    const pageTitle = page.getByTestId('page-title')
    await expect(pageTitle).toBeVisible({ timeout: Timeouts.ELEMENT })
  })

  test('provider settings card shows connected status', async ({ page }) => {
    const settings = page.getByTestId('hub-provider-settings')
    await expect(settings).toBeVisible({ timeout: Timeouts.ELEMENT })

    // Should show connected status text
    await expect(settings.getByText(/connected/i).first()).toBeVisible()
  })

  test('provider settings card shows disconnected status', async ({ page }) => {
    // Layered over the beforeEach mocks: the most recently registered route wins.
    // (unrouteAll() here left a window in which the dashboard's own polls reached
    // the real API for a hub it has never heard of — #1858.)
    await mockConfiguredHub(page, { providerConnected: false })
    // Re-navigate via SPA to trigger refetch (page.reload() would drop auth state)
    await navigateViaSpa(page, '/')
    await navigateViaSpa(page, '/admin/hub-communications')

    const settings = page.getByTestId('hub-provider-settings')
    await expect(settings).toBeVisible({ timeout: Timeouts.ELEMENT })

    await expect(settings.getByText(/disconnected/i).first()).toBeVisible()
  })

  test('provider settings card shows phone number count', async ({ page }) => {
    const settings = page.getByTestId('hub-provider-settings')
    await expect(settings).toBeVisible({ timeout: Timeouts.ELEMENT })

    // Should show "2 numbers" for numbersProvisioned: 2
    await expect(settings.getByText(/2 numbers/)).toBeVisible()
  })

  test('provider settings card shows channel enabled/disabled state', async ({ page }) => {
    const settings = page.getByTestId('hub-provider-settings')
    await expect(settings).toBeVisible({ timeout: Timeouts.ELEMENT })

    // Voice and SMS are enabled; should show "Enabled" text at least twice
    const enabledLabels = settings.getByText(/enabled/i)
    await expect(enabledLabels.first()).toBeVisible()

    // Disabled channels should show "Disabled"
    const disabledLabels = settings.getByText(/disabled/i)
    await expect(disabledLabels.first()).toBeVisible()
  })

  test('provider settings card shows A2P registration status when available', async ({ page }) => {
    const settings = page.getByTestId('hub-provider-settings')
    await expect(settings).toBeVisible({ timeout: Timeouts.ELEMENT })

    // a2pStatus is 'approved' in the mock
    await expect(settings.getByText(/approved/i)).toBeVisible()
  })

  test('provider settings card hides A2P section when status is null', async ({ page }) => {
    // Layered over the beforeEach mocks: the most recently registered route wins.
    // (unrouteAll() here left a window in which the dashboard's own polls reached
    // the real API for a hub it has never heard of — #1858.)
    await mockConfiguredHub(page, { a2pStatus: null })
    await navigateViaSpa(page, '/')
    await navigateViaSpa(page, '/admin/hub-communications')

    const settings = page.getByTestId('hub-provider-settings')
    await expect(settings).toBeVisible({ timeout: Timeouts.ELEMENT })

    // A2P section should not be present
    await expect(settings.getByText(/A2P/i)).not.toBeVisible()
  })

  test('usage card renders with correct data', async ({ page }) => {
    const usageCard = page.getByTestId('hub-usage-card')
    await expect(usageCard).toBeVisible({ timeout: Timeouts.ELEMENT })

    // Should show call count from mock (42 / 500)
    await expect(usageCard.getByText('42 / 500')).toBeVisible()

    // Should show SMS count from mock (128 / 1000)
    await expect(usageCard.getByText('128 / 1000')).toBeVisible()
  })

  test('usage card shows zero values correctly', async ({ page }) => {
    // Layered over the beforeEach mocks: the most recently registered route wins.
    // (unrouteAll() here left a window in which the dashboard's own polls reached
    // the real API for a hub it has never heard of — #1858.)
    await mockConfiguredHub(page, {
      usage: {
        callsReceived: 0,
        smsSent: 0,
        signalMessagesSent: 0,
        whatsAppMessagesSent: 0,
      },
    })
    await navigateViaSpa(page, '/')
    await navigateViaSpa(page, '/admin/hub-communications')

    const usageCard = page.getByTestId('hub-usage-card')
    await expect(usageCard).toBeVisible({ timeout: Timeouts.ELEMENT })

    await expect(usageCard.getByText('0 / 500').first()).toBeVisible()
    await expect(usageCard.getByText('0 / 1000')).toBeVisible()
  })

  test('restart setup button visible for configured hub with admin permissions', async ({ page }) => {
    const restartBtn = page.getByTestId('restart-setup-btn')
    await expect(restartBtn).toBeVisible({ timeout: Timeouts.ELEMENT })
  })
})

test.describe('Hub Settings - Provider type variations', () => {
  test('shows correct provider label for signalwire', async ({ page }) => {
    await mockConfigWithHub(page)
    await loginAsAdmin(page)
    await mockConfiguredHub(page, { providerType: 'signalwire' })
    await navigateViaSpa(page, '/admin/hub-communications')

    const settings = page.getByTestId('hub-provider-settings')
    await expect(settings).toBeVisible({ timeout: Timeouts.ELEMENT })

    // SignalWire provider label
    await expect(settings.getByText(/SignalWire/i)).toBeVisible()
  })

  test('shows correct provider label for vonage', async ({ page }) => {
    await mockConfigWithHub(page)
    await loginAsAdmin(page)
    await mockConfiguredHub(page, { providerType: 'vonage' })
    await navigateViaSpa(page, '/admin/hub-communications')

    const settings = page.getByTestId('hub-provider-settings')
    await expect(settings).toBeVisible({ timeout: Timeouts.ELEMENT })

    await expect(settings.getByText(/Vonage/i)).toBeVisible()
  })
})

test.describe('Hub Settings - Channel configured/pending state', () => {
  test('shows configured channels with checkmark', async ({ page }) => {
    await mockConfigWithHub(page)
    await loginAsAdmin(page)
    await mockConfiguredHub(page, {
      channelsConfigured: ['voice', 'sms'],
      channelsPending: [],
    })
    await navigateViaSpa(page, '/admin/hub-communications')

    const settings = page.getByTestId('hub-provider-settings')
    await expect(settings).toBeVisible({ timeout: Timeouts.ELEMENT })
  })

  test('shows pending channels with pending label', async ({ page }) => {
    await mockConfigWithHub(page)
    await loginAsAdmin(page)
    await mockConfiguredHub(page, {
      channelsConfigured: ['voice'],
      channelsPending: ['signal', 'whatsapp'],
      channelConfig: {
        voice: true,
        sms: false,
        email: false,
        signal: true,
        whatsapp: true,
        telegram: false,
        rcs: false,
      },
    })
    await navigateViaSpa(page, '/admin/hub-communications')

    const settings = page.getByTestId('hub-provider-settings')
    await expect(settings).toBeVisible({ timeout: Timeouts.ELEMENT })

    // Pending channels should show "Pending" text
    const pendingLabels = settings.getByText(/pending/i)
    await expect(pendingLabels.first()).toBeVisible()
  })
})
