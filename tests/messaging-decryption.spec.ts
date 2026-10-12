/**
 * A server-encrypted message is readable in the real client, by both readers.
 *
 * Two defects made this impossible, and each one alone is enough to render
 * every message as `[Encrypted]`:
 *
 *  1. The desktop registered no device, so `devices.x25519_pubkey` was NULL for
 *     every desktop user and the server had no key to HPKE-wrap to. It now
 *     registers on unlock (`src/client/lib/device-registration.ts`), and the
 *     server resolves a user's recipients from that column
 *     (`apps/worker/lib/device-recipients.ts`) instead of sealing to their
 *     Ed25519 identity key.
 *
 *  2. The server and the desktop derived the envelope AAD independently and
 *     disagreed. Both now derive it from `@shared/envelope-aad`, per
 *     PROTOCOL.md §2.4.
 *
 * This spec asserts the outcome through the UI rather than either mechanism, so
 * it fails if either half regresses. It also fails on any console error: a
 * crypto failure that leaves no trace is the specific shape being fixed here.
 */
import { test, expect, type APIRequestContext, type ConsoleMessage, type Page } from '@playwright/test'
import {
  loginAsAdmin,
  loginAsVolunteer,
  createUserAndGetDeviceKey,
  dismissDeviceKeyCard,
  TestIds,
} from './helpers'
import {
  apiGet,
  createHubViaApi,
  deleteHubViaApi,
  enableMessagingViaApi,
  uniquePhone,
} from './api-helpers'
import { simulateIncomingMessage, uniqueCallerNumber } from './simulation-helpers'

interface DeviceRow {
  platform: string
  x25519Pubkey: string | null
  ed25519Pubkey: string | null
}

interface DeviceOverview {
  entries: Array<{ userPubkey: string; displayName: string | null; devices: DeviceRow[] }>
}

/** Collect console errors and uncaught page errors for the life of a page. */
function watchConsole(page: Page): string[] {
  const errors: string[] = []
  const record = (entry: string) => {
    errors.push(entry)
    // Surfaced immediately as well as asserted at the end: a crypto failure
    // mid-run is the thing this spec exists to catch, and a list printed only
    // on the final assertion arrives after the run has already failed elsewhere.
    if (process.env.DEBUG_PAGE_CONSOLE) console.log(`[page] ${entry}`)
  }
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') record(`console: ${msg.text()}`)
  })
  page.on('pageerror', (err) => record(`pageerror: ${err.message}`))
  return errors
}

/**
 * A hub this test can rely on, reusing the suite's if there is one.
 *
 * `chromium` runs fullyParallel over one database, and the hub list has long
 * windows carrying **no** hub at all while the hub specs work — measured at
 * over 60 seconds. So a hub cannot simply be waited for. Nor should one always
 * be created: other specs resolve "the" hub positionally, and an extra hub sent
 * `simulation.spec` looking for calls in the wrong one.
 *
 * Read from the authenticated `GET /hubs` (the admin's memberships) — the
 * public `/api/config` no longer publishes a hub roster (#1710).
 *
 * Reuse when there is something to reuse, create only when there is not, and
 * always clean up what was created.
 */
async function acquireHub(
  request: APIRequestContext,
): Promise<{ hubId: string; release: () => Promise<void> }> {
  const { data } = await apiGet<{ hubs?: Array<{ id: string }> }>(request, '/hubs')
  const existing = data?.hubs?.[0]?.id
  if (existing) return { hubId: existing, release: async () => {} }

  const hubId = await createHubViaApi(request, `decrypt-${Date.now()}`)
  return { hubId, release: () => deleteHubViaApi(request, hubId) }
}

/**
 * Pin the client to `hubId` before its first render.
 *
 * `ConfigProvider` treats `window.__TEST_WORKER_HUB` as a pin that membership
 * resolution never overrides (`chooseActiveHub` in `src/client/lib/config.tsx`)
 * — it is the mechanism the BDD suite's per-worker hub uses, and it is what
 * lets this spec browse a hub the shared admin may not be a member of.
 */
async function pinHubBeforeLoad(page: Page, hubId: string): Promise<void> {
  await page.addInitScript((id) => {
    (window as unknown as Record<string, unknown>).__TEST_WORKER_HUB = id
  }, hubId)
}

/** Confirm the client is browsing `hubId` after a login has completed. */
async function expectBrowsingHub(page: Page, hubId: string): Promise<void> {
  await page.waitForFunction(
    (id) => window.__TEST_GET_ACTIVE_HUB?.() === id,
    hubId,
    { timeout: 60_000 },
  )
}

/**
 * Open the conversation whose contact ends in `last4`, navigating in-app.
 *
 * Never `page.goto()`: a hard navigation re-locks the Rust/mock CryptoState and
 * drops the client back to the PIN screen, so a full-page navigation cannot
 * test anything that needs the device key.
 */
async function openConversation(page: Page, last4: string) {
  await page.getByTestId(TestIds.NAV_CONVERSATIONS).click()
  await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible()
  const card = page.getByTestId(TestIds.CONVERSATION_ITEM).filter({ hasText: last4 })
  await expect(card.first()).toBeVisible()
  await card.first().click()
  await expect(page.getByTestId(TestIds.CONVERSATION_THREAD)).toBeVisible()
  return page.getByTestId(TestIds.CONVERSATION_THREAD)
}

/** Leave and re-enter the thread in-app, so the message list refetches. */
async function reopenConversation(page: Page, last4: string) {
  await page.getByTestId(TestIds.NAV_DASHBOARD).click()
  await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible()
  return openConversation(page, last4)
}

test.describe('server-written messages decrypt in the real client', () => {
  // Three UI logins, each one a PBKDF2 device-key import, plus two inbound
  // webhooks and a claim. The default 30s cannot hold it.
  test.slow()
  test.setTimeout(180_000)

  let releaseHub: (() => Promise<void>) | null = null
  test.afterEach(async () => {
    const release = releaseHub
    releaseHub = null
    if (release) await release()
  })

  test('the assigned volunteer and an admin both read the plaintext', async ({ page, request }) => {
    const consoleErrors = watchConsole(page)

    // --- A hub, pinned on every client this test logs in ------------------
    const { hubId, release } = await acquireHub(request)
    releaseHub = release
    await pinHubBeforeLoad(page, hubId)
    await loginAsAdmin(page)
    await expectBrowsingHub(page, hubId)
    await enableMessagingViaApi(request, ['sms'])

    // Created through the admin UI so the volunteer lands in this hub with the
    // Volunteer role, exactly as a real invite would.
    const volunteerName = `DecryptVol-${Date.now()}`
    const volunteerSeed = await createUserAndGetDeviceKey(page, volunteerName, uniquePhone())
    await dismissDeviceKeyCard(page)

    // --- Logging in registers this device as an HPKE recipient -----------
    // Without this the server has no X25519 key for the volunteer and cannot
    // address them at all, whatever the AAD convention is.
    await loginAsVolunteer(page, volunteerSeed)
    await expectBrowsingHub(page, hubId)

    // --- An inbound message arrives, and the volunteer claims it ---------
    const senderNumber = uniqueCallerNumber()
    const firstBody = `First inbound ${Date.now()}`
    const inbound = await simulateIncomingMessage(request, {
      senderNumber,
      body: firstBody,
      channel: 'sms',
      hubId,
    })
    expect(inbound.conversationId, 'inbound message produced no conversation').toBeTruthy()
    const last4 = senderNumber.slice(-4)

    await openConversation(page, last4)
    await page.getByTestId('conv-assign-btn').click()
    await expect(page.getByTestId('conv-assign-btn')).toBeHidden()

    // --- A second message arrives into the now-assigned conversation -----
    // This one is sealed to the volunteer's registered X25519 device key.
    const claimedBody = `Caller follow-up ${Date.now()}`
    await simulateIncomingMessage(request, {
      senderNumber,
      body: claimedBody,
      channel: 'sms',
      hubId,
    })

    // --- Proof 1: the volunteer's client renders the plaintext -----------
    const volunteerThread = await reopenConversation(page, last4)
    await expect(volunteerThread).toContainText(claimedBody, { timeout: 20_000 })

    // The pre-claim message is still sealed to admins only. `claim()` writes no
    // envelopes, and the server cannot add one — it discarded the content key at
    // write time. Tracked as #1512, which is a protocol decision, not a missing
    // line. Asserting the exact count records the gap rather than tolerating it:
    // when #1512 lands this must become 0, and the test will say so.
    await expect(volunteerThread.getByText('[Encrypted]')).toHaveCount(1)
    await expect(volunteerThread).not.toContainText(firstBody)

    // --- Proof 2: the admin reads it too, through the client -------------
    await loginAsAdmin(page)
    await expectBrowsingHub(page, hubId)

    // The volunteer's desktop registered its X25519 key — the only thing the
    // server can seal to for them. Read through the admin's device overview.
    await expect.poll(async () => {
      const { data } = await apiGet<DeviceOverview>(request, '/admin/devices/overview')
      const entry = data?.entries?.find((e) => e.displayName === volunteerName)
      return entry?.devices?.find((d) => d.platform === 'desktop')?.x25519Pubkey ?? null
    }, {
      message: 'the volunteer desktop never registered an X25519 key',
      timeout: 10_000,
    }).toMatch(/^[0-9a-f]{64}$/i)

    const adminThread = await openConversation(page, last4)
    await expect(adminThread).toContainText(claimedBody, { timeout: 20_000 })
    await expect(adminThread).toContainText(firstBody)
    await expect(adminThread.getByText('[Encrypted]')).toHaveCount(0)

    // --- Proof 3: no silent crypto failure ------------------------------
    expect(consoleErrors, `console was not clean:\n${consoleErrors.join('\n')}`).toEqual([])
  })
})
