import { test, expect } from './console-guard'
import { loginAsAdmin, Timeouts, TestIds } from './helpers'

// Blast delivery tests need longer timeout for auth PBKDF2 + API round trips
test.setTimeout(90_000)

const MOCK_BLAST_ID = 'blast-e2e-001'
const MOCK_BLAST_DRAFT: Record<string, unknown> = {
  id: MOCK_BLAST_ID,
  name: 'Test E2E Blast',
  hubId: 'hub-1',
  status: 'draft',
  targetChannels: ['sms'],
  content: { text: 'Hello from E2E test', mediaUrl: null },
  scheduledAt: null,
  stats: { totalRecipients: 3, sent: 0, delivered: 0, failed: 0, optedOut: 0 },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

const MOCK_BLAST_SENDING: Record<string, unknown> = {
  ...MOCK_BLAST_DRAFT,
  status: 'sending',
  stats: { totalRecipients: 3, sent: 2, delivered: 1, failed: 1, optedOut: 0 },
}

const MOCK_BLAST_SCHEDULED: Record<string, unknown> = {
  ...MOCK_BLAST_DRAFT,
  status: 'scheduled',
  scheduledAt: new Date(Date.now() + 86400000).toISOString(),
}

const MOCK_DELIVERIES = [
  { id: 'del-1', blastId: MOCK_BLAST_ID, subscriberId: 'sub-1', channel: 'sms', status: 'sent', attempts: 1, error: null, lastAttemptAt: new Date().toISOString() },
  { id: 'del-2', blastId: MOCK_BLAST_ID, subscriberId: 'sub-2', channel: 'sms', status: 'delivered', attempts: 1, error: null, lastAttemptAt: new Date().toISOString() },
  { id: 'del-3', blastId: MOCK_BLAST_ID, subscriberId: 'sub-3', channel: 'sms', status: 'failed', attempts: 2, error: 'Carrier rejected', lastAttemptAt: new Date().toISOString() },
]

async function mockBlastsApi(page: import('@playwright/test').Page, blast: Record<string, unknown> = MOCK_BLAST_DRAFT) {
  // List blasts
  await page.route('**/api/blasts', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ blasts: [blast], total: 1 }),
      })
    } else if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ blast: { ...blast, id: 'new-blast-123', name: 'Created' } }),
      })
    } else {
      await route.continue()
    }
  })

  // Get single blast
  await page.route(`**/api/blasts/${MOCK_BLAST_ID}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ blast }),
    })
  })

  // Blast stats
  await page.route(`**/api/blasts/${MOCK_BLAST_ID}/stats`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(blast.stats),
    })
  })

  // Blast deliveries
  await page.route(`**/api/blasts/${MOCK_BLAST_ID}/deliveries*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ deliveries: MOCK_DELIVERIES, total: MOCK_DELIVERIES.length }),
    })
  })

  // Send blast
  await page.route(`**/api/blasts/${MOCK_BLAST_ID}/send`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ blast: MOCK_BLAST_SENDING }),
    })
  })

  // Schedule blast (via create with scheduledAt)
  await page.route(`**/api/blasts/${MOCK_BLAST_ID}/schedule`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ blast: MOCK_BLAST_SCHEDULED }),
    })
  })

  // Cancel blast
  await page.route(`**/api/blasts/${MOCK_BLAST_ID}/cancel`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ blast: { ...blast, status: 'cancelled' } }),
    })
  })

  // Retry individual delivery
  await page.route(`**/api/blasts/${MOCK_BLAST_ID}/deliveries/*/retry`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, delivery: { ...MOCK_DELIVERIES[2], status: 'pending' } }),
    })
  })

  // Retry all failed
  await page.route(`**/api/blasts/${MOCK_BLAST_ID}/retry-failed`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, retriedCount: 1 }),
    })
  })

  // Blast settings
  await page.route('**/api/blasts/settings', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        optOutFooter: '\nReply STOP to unsubscribe.',
        rateLimitPerSecond: 10,
        subscribeKeyword: 'JOIN',
        unsubscribeKeyword: 'STOP',
        confirmationMessage: 'Subscribed!',
        unsubscribeMessage: 'Unsubscribed.',
        doubleOptIn: false,
        maxBlastsPerDay: 5,
      }),
    })
  })

  // Blast subscribers
  await page.route('**/api/blasts/subscribers*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ subscribers: [], total: 0, active: 0 }),
    })
  })
}

test.describe('Blast Composer', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page)
    await mockBlastsApi(page)
    await page.getByTestId(TestIds.NAV_BLASTS).click()
    await page.waitForLoadState('domcontentloaded')
  })

  test('shows blast list on page load', async ({ page }) => {
    await expect(page.getByTestId('blast-list')).toBeVisible({ timeout: Timeouts.ELEMENT })
    await expect(page.getByTestId('blast-card').first()).toBeVisible()
  })

  test('opens composer when New Blast clicked', async ({ page }) => {
    await page.getByTestId(TestIds.BLAST_NEW_BTN).click()
    await expect(page.getByTestId(TestIds.BLAST_NAME)).toBeVisible({ timeout: Timeouts.ELEMENT })
    await expect(page.getByTestId(TestIds.BLAST_TEXT)).toBeVisible()
  })

  test('composer shows media URL field', async ({ page }) => {
    await page.getByTestId(TestIds.BLAST_NEW_BTN).click()
    await expect(page.getByTestId('blast-media-url')).toBeVisible({ timeout: Timeouts.ELEMENT })
  })

  test('composer shows schedule picker', async ({ page }) => {
    await page.getByTestId(TestIds.BLAST_NEW_BTN).click()
    await expect(page.getByTestId('blast-schedule-input')).toBeVisible({ timeout: Timeouts.ELEMENT })
  })

  test('invalid media URL shows error', async ({ page }) => {
    await page.getByTestId(TestIds.BLAST_NEW_BTN).click()
    await page.getByTestId('blast-media-url').fill('not-a-url')
    await expect(page.getByText(/valid https/i)).toBeVisible({ timeout: Timeouts.ELEMENT })
  })

  test('valid https media URL is accepted', async ({ page }) => {
    await page.getByTestId(TestIds.BLAST_NEW_BTN).click()
    await page.getByTestId('blast-media-url').fill('https://example.com/image.jpg')
    await expect(page.getByText(/valid https/i)).not.toBeVisible({ timeout: Timeouts.ELEMENT })
  })

  test('schedule button appears when date is set', async ({ page }) => {
    await page.getByTestId(TestIds.BLAST_NEW_BTN).click()
    await page.getByTestId(TestIds.BLAST_NAME).fill('Scheduled Blast')
    await page.getByTestId(TestIds.BLAST_TEXT).fill('Hello subscribers!')
    // Set schedule to tomorrow
    const tomorrow = new Date(Date.now() + 86400000)
    const offset = tomorrow.getTimezoneOffset() * 60000
    const tomorrowLocal = new Date(tomorrow.getTime() - offset).toISOString().slice(0, 16)
    await page.getByTestId('blast-schedule-input').fill(tomorrowLocal)
    // Schedule Send button should appear (replacing Save Draft)
    await expect(page.getByTestId('blast-schedule-btn')).toBeVisible({ timeout: Timeouts.ELEMENT })
  })

  test('save draft button visible without schedule', async ({ page }) => {
    await page.getByTestId(TestIds.BLAST_NEW_BTN).click()
    await expect(page.getByTestId('blast-send-btn')).toBeVisible({ timeout: Timeouts.ELEMENT })
  })
})

test.describe('Blast Detail Panel', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page)
    await mockBlastsApi(page)
    await page.getByTestId(TestIds.NAV_BLASTS).click()
    await page.waitForLoadState('domcontentloaded')
    // Click the first blast card to open detail panel
    await page.getByTestId(TestIds.BLAST_CARD).first().click()
  })

  test('shows Send Now button for draft blast', async ({ page }) => {
    await expect(page.getByTestId('blast-send-btn')).toBeVisible({ timeout: Timeouts.ELEMENT })
  })

  test('Send Now triggers send API call', async ({ page }) => {
    const sendPromise = page.waitForResponse('**/api/blasts/**/send')
    await page.getByTestId('blast-send-btn').click()
    const response = await sendPromise
    expect(response.status()).toBe(200)
  })
})

test.describe('Blast Delivery Sheet', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page)
    await mockBlastsApi(page, MOCK_BLAST_SENDING)
    await page.getByTestId(TestIds.NAV_BLASTS).click()
    await page.waitForLoadState('domcontentloaded')
    await page.getByTestId(TestIds.BLAST_CARD).first().click()
  })

  test('delivery details toggle shows delivery rows', async ({ page }) => {
    await page.getByTestId('toggle-deliveries').click()
    // Delivery rows should appear (status badges)
    await expect(page.getByText(/sent|delivered|failed/i).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
  })

  test('Deliveries button opens delivery sheet', async ({ page }) => {
    const deliveriesBtn = page.getByText('Delivery Status', { exact: true })
    await expect(deliveriesBtn).toBeVisible({ timeout: Timeouts.ELEMENT })
    await deliveriesBtn.click()
    // Sheet should open showing delivery count
    await expect(page.getByText(/recipient/i).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
  })

  test('Retry All Failed button visible when there are failures', async ({ page }) => {
    await expect(page.getByText(/Retry All Failed/i).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
  })

  test('retry all failed triggers API call', async ({ page }) => {
    const retryPromise = page.waitForResponse('**/api/blasts/**/retry-failed')
    await page.getByText(/Retry All Failed/i).first().click()
    const response = await retryPromise
    expect(response.status()).toBe(200)
  })
})
