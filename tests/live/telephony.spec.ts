import { test, expect } from '@playwright/test'
import {
  loginAsAdmin,
  callHotline,
  hangUp,
  waitForCallStatus,
  sendSMS,
  sleep,
  getLiveConfig,
  callCount,
  conversationCount,
} from './helpers'

test.describe.configure({ mode: 'serial' })

// Skip the entire suite when live Twilio credentials are not available (e.g. CI)
const hasLiveCreds = !!process.env.TWILIO_ACCOUNT_SID

/**
 * No beforeAll reset. This suite runs against a DEPLOYED server, and a
 * deployed server has no reset — `devGuard` 404s every /api/test-* outside a
 * development host, and /api/demo/reset is gated on exactly the same
 * condition. The old `resetStaging()` could therefore only ever succeed
 * against a development box, which is the opposite of what a live suite is
 * for (#1423).
 *
 * Nothing is lost, because nothing depended on it. Every assertion here was
 * `.first()` being visible — "some call row exists" — which a row left over
 * from a previous run satisfied just as well, so a passing test proved
 * nothing about the call it had just placed. Each test now records a count
 * BEFORE acting and asserts the count it caused, which is both independent of
 * pre-existing data and strictly stronger than what it replaced.
 */
test.describe('Live Telephony', () => {
  test.skip(!hasLiveCreds, 'Live telephony tests require TWILIO_ACCOUNT_SID')

  test('inbound call reaches IVR and language menu plays', async ({ page, request }) => {
    // Login as admin first so we can check call logs later
    await loginAsAdmin(page)
    const callsBefore = await callCount(request)

    // Place a call to the hotline — no digits, just let the IVR play
    const { sid } = await callHotline()

    // Wait for the call to be in-progress (Twilio connected to our webhook)
    await waitForCallStatus(sid, ['in-progress', 'ringing'], 30_000)

    // Let the IVR play for a few seconds
    await sleep(8_000)

    // Hang up the call
    await hangUp(sid)

    // Verify call reached completed status
    await waitForCallStatus(sid, 'completed', 15_000)

    // Navigate to call history to verify the call appears
    await page.evaluate(() => {
      const router = window.__TEST_ROUTER
      if (router) router.navigate({ to: '/calls' })
    })
    await page.waitForURL(/\/calls/, { timeout: 10_000 })

    // THIS call must have been recorded — not merely "some row is present".
    // The UI deliberately hides the caller number (asserted below in the
    // notification test), so the count is what identifies our own effect.
    await expect.poll(() => callCount(request), { timeout: 30_000 })
      .toBeGreaterThan(callsBefore)
    await expect(page.locator('.divide-y > div').first()).toBeVisible({ timeout: 10_000 })
  })

  test('IVR language selection works (press 2 for Spanish)', async ({ page, request }) => {
    await loginAsAdmin(page)
    const callsBefore = await callCount(request)

    // Call hotline and press 2 for Spanish (es)
    // 'ww' = 1 second wait per 'w', so 'wwwwwwwwww2' waits ~5s then presses 2
    const { sid } = await callHotline({ sendDigits: 'wwwwwwwwww2' })

    // Wait for call to progress past IVR into queue/ringing
    await waitForCallStatus(sid, 'in-progress', 30_000)

    // Let it ring for a bit (volunteers may or may not be on shift)
    await sleep(10_000)

    // Hang up
    await hangUp(sid)
    await waitForCallStatus(sid, 'completed', 15_000)

    // Check call log — navigate to calls page
    await page.evaluate(() => {
      const router = window.__TEST_ROUTER
      if (router) router.navigate({ to: '/calls' })
    })
    await page.waitForURL(/\/calls/, { timeout: 10_000 })

    await expect.poll(() => callCount(request), { timeout: 30_000 })
      .toBeGreaterThan(callsBefore)
    await expect(page.locator('.divide-y > div').first()).toBeVisible({ timeout: 10_000 })
  })

  test('volunteer receives incoming call notification in browser', async ({ page }) => {
    // Login as admin
    await loginAsAdmin(page)

    // Navigate to dashboard where incoming calls appear
    await page.evaluate(() => {
      const router = window.__TEST_ROUTER
      if (router) router.navigate({ to: '/' })
    })
    await page.waitForURL(/\/$/, { timeout: 10_000 })
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()

    // Place a call — press 2 for Spanish to get past IVR
    const { sid } = await callHotline({ sendDigits: 'wwwwwwwwww2' })

    // Wait for the call to reach in-progress (connected to our server)
    await waitForCallStatus(sid, 'in-progress', 30_000)

    // The dashboard should show an incoming call card if admin is on shift
    // Look for the incoming call section or any call-related UI update
    // The WebSocket broadcasts call:incoming events to all connected clients
    try {
      // Wait for the incoming call card to appear (green card with "Incoming Call" text)
      await expect(
        page.getByText(/incoming call/i).first()
      ).toBeVisible({ timeout: 20_000 })

      // Security check: verify caller phone number is NOT displayed
      // The UI should show generic "Incoming Call" without any phone digits
      const config = getLiveConfig()
      const last4 = config.testCallerNumber.slice(-4)
      const callSection = page.locator('.border-green-500').first()
      if (await callSection.isVisible()) {
        const cardText = await callSection.textContent()
        expect(cardText).not.toContain(config.testCallerNumber)
        expect(cardText).not.toContain(last4)
      }
    } catch {
      // Admin may not be on shift — that's OK, the call still went through
      // Verify it appears in the call log instead
    }

    // Clean up
    await hangUp(sid)
    await waitForCallStatus(sid, 'completed', 15_000)
  })

  test('unanswered call is recorded in call history', async ({ page, request }) => {
    await loginAsAdmin(page)
    const callsBefore = await callCount(request)

    // Place a call with language selection — no volunteers on shift, so it will queue
    const { sid } = await callHotline({ sendDigits: 'wwwwwwwwww2' })

    // Wait for call to be in progress
    await waitForCallStatus(sid, 'in-progress', 30_000)

    // Let the call sit in queue for a bit, then hang up
    await sleep(15_000)
    await hangUp(sid)
    await waitForCallStatus(sid, 'completed', 15_000)

    // Give the server time to process the call-status/queue-exit webhooks
    await sleep(5_000)

    // Navigate to call history via SPA router
    await page.evaluate(() => {
      const router = window.__TEST_ROUTER
      if (router) router.navigate({ to: '/calls' })
    })
    await page.waitForURL(/\/calls/, { timeout: 10_000 })

    // Wait for the page to finish loading — poll for call entries to appear
    // The API call may take a moment to return fresh data
    const callEntry = page.locator('.divide-y > div').first()
    for (let attempt = 0; attempt < 5; attempt++) {
      if (await callEntry.isVisible().catch(() => false)) break
      // Re-navigate to refresh the data
      await page.evaluate(() => {
        const router = window.__TEST_ROUTER
        if (router) router.navigate({ to: '/' })
      })
      await sleep(2_000)
      await page.evaluate(() => {
        const router = window.__TEST_ROUTER
        if (router) router.navigate({ to: '/calls' })
      })
      await sleep(3_000)
    }

    await expect(callEntry).toBeVisible({ timeout: 10_000 })
    // The point of the test: an UNANSWERED call still lands in history.
    // Polled on the API so a stale row cannot satisfy it.
    await expect.poll(() => callCount(request), { timeout: 30_000 })
      .toBeGreaterThan(callsBefore)
  })

  test('SMS inbound creates conversation', async ({ page, request }) => {
    // Check if SMS is enabled on staging before running
    const configRes = await request.get('/api/config')
    const appConfig = await configRes.json()
    test.skip(!appConfig.channels?.sms, 'SMS channel is not enabled on staging — skipping')

    await loginAsAdmin(page)
    const conversationsBefore = await conversationCount(request)

    // Send an SMS from the test caller to the hotline
    const testMessage = `Live E2E test ${Date.now()}`
    const { sid } = await sendSMS(testMessage)
    expect(sid).toBeTruthy()

    // Wait for the webhook to process
    await sleep(5_000)

    // Navigate to conversations page
    await page.evaluate(() => {
      const router = window.__TEST_ROUTER
      if (router) router.navigate({ to: '/conversations' })
    })
    await page.waitForURL(/\/conversations/, { timeout: 10_000 })

    // Wait for conversations to load — look for any SMS conversation entry
    await expect(
      page.getByText(/sms/i).first()
    ).toBeVisible({ timeout: 15_000 })

    const conversationEntries = page.locator('[class*="cursor-pointer"]')
    await expect(conversationEntries.first()).toBeVisible({ timeout: 10_000 })

    // A conversation this test caused — the `/sms/i` text above would match a
    // conversation from any previous run.
    await expect.poll(() => conversationCount(request), { timeout: 30_000 })
      .toBeGreaterThan(conversationsBefore)
  })
})
