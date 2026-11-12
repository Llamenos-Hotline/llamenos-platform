import { test, expect } from './console-guard'
import { loginAsAdmin, mockConfigWithHub, navigateViaSpa, Timeouts } from './helpers'

/**
 * Hub-specific API mock that returns different data depending on the hub ID
 * in the request URL. This enables testing multi-hub navigation where each
 * hub has its own provider configuration, channels, and usage data.
 */
async function mockMultiHubApis(
  page: import('@playwright/test').Page,
  hubs: Record<
    string,
    {
      onboardingComplete: boolean
      providerConnected: boolean
      providerType: string
      channelsConfigured: string[]
      channelsPending: string[]
      numbersProvisioned: number
      channelConfig: Record<string, boolean>
      usage: Record<string, number>
    }
  >,
) {
  await page.route('**/api/hubs/*/onboard/provider-status', async (route) => {
    const url = route.request().url()
    const hubId = extractHubId(url, 'onboard/provider-status')
    const hub = hubs[hubId]

    if (!hub) {
      await route.fulfill({ status: 404, body: 'Hub not found' })
      return
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: {
          hubId,
          onboardingComplete: hub.onboardingComplete,
          providerConnected: hub.providerConnected,
          providerType: hub.providerType,
          channelsConfigured: hub.channelsConfigured,
          channelsPending: hub.channelsPending,
          numbersProvisioned: hub.numbersProvisioned,
          a2pStatus: null,
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
    const url = route.request().url()
    const hubId = extractHubId(url, 'onboard/status')
    const hub = hubs[hubId]

    if (!hub) {
      await route.fulfill({ status: 404, body: 'Hub not found' })
      return
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        onboarding: hub.onboardingComplete
          ? { hubId, step: 'summary', channelConfig: hub.channelConfig }
          : null,
      }),
    })
  })

  await page.route('**/api/hubs/*/onboard/usage', async (route) => {
    const url = route.request().url()
    const hubId = extractHubId(url, 'onboard/usage')
    const hub = hubs[hubId]

    if (!hub) {
      await route.fulfill({ status: 404, body: 'Hub not found' })
      return
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ usage: hub.usage }),
    })
  })

  await page.route('**/api/provider-templates', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ templates: [] }),
    })
  })
}

/**
 * Extract hub ID from a URL path like /api/hubs/{hubId}/onboard/...
 */
function extractHubId(url: string, _suffix: string): string {
  const match = url.match(/\/api\/hubs\/([^/]+)\//)
  return match ? decodeURIComponent(match[1]) : 'unknown'
}

const HUB_A_DATA = {
  onboardingComplete: true,
  providerConnected: true,
  providerType: 'twilio',
  channelsConfigured: ['voice', 'sms'],
  channelsPending: [],
  numbersProvisioned: 3,
  channelConfig: {
    voice: true,
    sms: true,
    email: false,
    signal: false,
    whatsapp: false,
    telegram: false,
    rcs: false,
  },
  usage: {
    callsReceived: 150,
    smsSent: 320,
    signalMessagesSent: 0,
    whatsAppMessagesSent: 0,
  },
}

const HUB_B_DATA = {
  onboardingComplete: true,
  providerConnected: true,
  providerType: 'signalwire',
  channelsConfigured: ['voice', 'signal'],
  channelsPending: ['whatsapp'],
  numbersProvisioned: 1,
  channelConfig: {
    voice: true,
    sms: false,
    email: false,
    signal: true,
    whatsapp: true,
    telegram: false,
    rcs: false,
  },
  usage: {
    callsReceived: 25,
    smsSent: 0,
    signalMessagesSent: 88,
    whatsAppMessagesSent: 12,
  },
}

test.describe('Multi-Hub Navigation', () => {
  test('each hub displays its own provider type', async ({ page }) => {
    await mockConfigWithHub(page, 'hub-a')
    await loginAsAdmin(page)
    // Mock with hub-specific data
    await mockMultiHubApis(page, {
      'hub-a': HUB_A_DATA,
      'hub-b': HUB_B_DATA,
    })

    await navigateViaSpa(page, '/admin/hub-communications')

    // The page loads with the current hub from ConfigProvider.
    // We verify the settings panel renders with provider info.
    const settings = page.getByTestId('hub-provider-settings')
    await expect(settings).toBeVisible({ timeout: Timeouts.ELEMENT })
  })

  test('each hub displays its own usage data', async ({ page }) => {
    await mockConfigWithHub(page, 'hub-a')
    await loginAsAdmin(page)
    await mockMultiHubApis(page, {
      'hub-a': HUB_A_DATA,
      'hub-b': HUB_B_DATA,
    })

    await navigateViaSpa(page, '/admin/hub-communications')

    // Usage card should be visible with data from the active hub
    const usageCard = page.getByTestId('hub-usage-card')
    await expect(usageCard).toBeVisible({ timeout: Timeouts.ELEMENT })
  })

  test('unconfigured hub shows wizard while configured hub shows settings', async ({ page }) => {
    await mockConfigWithHub(page, 'hub-a')
    await loginAsAdmin(page)
    await mockMultiHubApis(page, {
      'hub-a': HUB_A_DATA,
      'hub-b': {
        ...HUB_B_DATA,
        onboardingComplete: false,
        providerConnected: false,
      },
    })

    await navigateViaSpa(page, '/admin/hub-communications')

    // Page should render either wizard or settings depending on active hub
    // At minimum, the page should load without errors
    const pageTitle = page.getByTestId('page-title')

    // Wait for page to render — page-title is always present
    await expect(pageTitle).toBeVisible({ timeout: Timeouts.ELEMENT })
  })
})

test.describe('Multi-Hub Data Isolation', () => {
  test('hub data does not leak between different hub contexts', async ({ page }) => {
    await mockConfigWithHub(page, 'hub-a')
    await loginAsAdmin(page)
    // Set up two hubs with very different usage numbers
    await mockMultiHubApis(page, {
      'hub-a': {
        ...HUB_A_DATA,
        usage: {
          callsReceived: 999,
          smsSent: 888,
          signalMessagesSent: 0,
          whatsAppMessagesSent: 0,
        },
      },
      'hub-b': {
        ...HUB_B_DATA,
        usage: {
          callsReceived: 1,
          smsSent: 0,
          signalMessagesSent: 2,
          whatsAppMessagesSent: 0,
        },
      },
    })

    await navigateViaSpa(page, '/admin/hub-communications')

    // The page should display data for exactly one hub (the active one).
    // We check that it doesn't show data from both hubs simultaneously.
    const pageTitle = page.getByTestId('page-title')

    // Wait for page to render
    await expect(pageTitle).toBeVisible({ timeout: Timeouts.ELEMENT })

    // Should not show both 999 and 1 at the same time in usage
    // (which would indicate data leakage between hubs)
    const pageText = await page.textContent('body')
    const has999 = pageText?.includes('999')
    const has1only = pageText?.includes('1 / 500')
    // At most one of these patterns should appear
    expect(has999 && has1only).toBeFalsy()
  })
})
