/**
 * A server-encrypted message is readable in the real client, by every reader —
 * including a volunteer who claimed the conversation AFTER the message arrived.
 *
 * Three defects made this impossible, and each one alone is enough to render
 * messages as `[Encrypted]`:
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
 *  3. A message that arrived before the claim was sealed to the admins alone,
 *     and nothing ever added the claimer (#1512, #2046). An admin client now
 *     re-wraps those content keys for the assignee's devices
 *     (`src/client/lib/assignee-rewrap.ts`, PROTOCOL.md §2.4.1) — on the
 *     assignment event when an admin is online, and on the next admin client
 *     to connect when none is.
 *
 * This spec asserts the outcome — the claiming volunteer's client renders the
 * plaintext — rather than any envelope count, so it fails if any of the three
 * regresses. It also fails on any console error: a crypto failure that leaves
 * no trace is the specific shape being fixed here.
 */
import { test, expect, type APIRequestContext, type Browser, type ConsoleMessage, type Page } from '@playwright/test'
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

/**
 * Log in as admin in a browser context of its own, pinned to `hubId`, and
 * leave it running: an admin client that stays online alongside the
 * volunteer's, the way a staffed hotline has one.
 */
async function openAdminClient(browser: Browser, hubId: string) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const consoleErrors = watchConsole(page)
  await pinHubBeforeLoad(page, hubId)
  await loginAsAdmin(page)
  await expectBrowsingHub(page, hubId)
  return { context, page, consoleErrors }
}

/**
 * Everything up to the claim: messaging on, a volunteer created through the
 * admin UI and logged in on `page` (which registers their X25519 device key),
 * and one inbound message that arrives BEFORE anyone is assigned — so it is
 * sealed to the admin recipient only.
 */
async function volunteerWithUnclaimedMessage(
  page: Page,
  adminPage: Page,
  request: APIRequestContext,
  hubId: string,
) {
  await enableMessagingViaApi(request, ['sms'])

  // Created through the admin UI so the volunteer lands in this hub with the
  // Volunteer role, exactly as a real invite would.
  const volunteerName = `DecryptVol-${Date.now()}`
  const volunteerSeed = await createUserAndGetDeviceKey(adminPage, volunteerName, uniquePhone())
  await dismissDeviceKeyCard(adminPage)

  await pinHubBeforeLoad(page, hubId)
  await loginAsVolunteer(page, volunteerSeed)
  await expectBrowsingHub(page, hubId)

  // Logging in registers this device as an HPKE recipient. Without it the
  // server has no X25519 key for the volunteer: nothing could be sealed to
  // them at write time, and the re-wrap would have no key to seal to either.
  await expect.poll(async () => {
    const { data } = await apiGet<DeviceOverview>(request, '/admin/devices/overview')
    const entry = data?.entries?.find((e) => e.displayName === volunteerName)
    return entry?.devices?.find((d) => d.platform === 'desktop')?.x25519Pubkey ?? null
  }, {
    message: 'the volunteer desktop never registered an X25519 key',
    timeout: 10_000,
  }).toMatch(/^[0-9a-f]{64}$/i)

  const senderNumber = uniqueCallerNumber()
  const preClaimBody = `Before claim ${Date.now()}`
  const inbound = await simulateIncomingMessage(request, {
    senderNumber,
    body: preClaimBody,
    channel: 'sms',
    hubId,
  })
  expect(inbound.conversationId, 'inbound message produced no conversation').toBeTruthy()
  return { senderNumber, last4: senderNumber.slice(-4), preClaimBody }
}

/** Claim the open conversation from the volunteer's client. */
async function claimOpenConversation(page: Page) {
  await page.getByTestId(TestIds.CONV_ASSIGN_BTN).click()
  await expect(page.getByTestId(TestIds.CONV_ASSIGN_BTN)).toBeHidden()
}

/**
 * The claiming volunteer's client renders `body` as plaintext and has nothing
 * left it cannot open. Decryptability by the claimer is the property under
 * test, so this is asserted through their real client, never through an
 * envelope count.
 */
async function expectVolunteerReads(thread: ReturnType<Page['getByTestId']>, ...bodies: string[]) {
  for (const body of bodies) {
    await expect(thread.getByTestId(TestIds.MESSAGE_PLAINTEXT).filter({ hasText: body })).toHaveCount(1, { timeout: 30_000 })
  }
  await expect(thread.getByTestId(TestIds.MESSAGE_ENCRYPTED)).toHaveCount(0)
}

test.describe('server-written messages decrypt in the real client', () => {
  // Two concurrent clients, three UI logins (each a PBKDF2 device-key import),
  // inbound webhooks and a claim. The default 30s cannot hold it.
  test.slow()
  test.setTimeout(240_000)

  let releaseHub: (() => Promise<void>) | null = null
  test.afterEach(async () => {
    const release = releaseHub
    releaseHub = null
    if (release) await release()
  })

  test('an online admin re-wraps pre-claim messages for the claiming volunteer', async ({ browser, page, request }) => {
    const consoleErrors = watchConsole(page)
    const { hubId, release } = await acquireHub(request)
    releaseHub = release

    // --- An admin client is online for the whole exchange ----------------
    const admin = await openAdminClient(browser, hubId)
    try {
      const { senderNumber, last4, preClaimBody } =
        await volunteerWithUnclaimedMessage(page, admin.page, request, hubId)

      // --- The volunteer claims ------------------------------------------
      // `POST /claim` publishes `conversation:assigned`; the admin client
      // answers it by re-wrapping the pre-claim message's content key for the
      // volunteer's device, and the server's `conversation:envelopes-added`
      // makes the volunteer's open thread re-read its messages.
      await openConversation(page, last4)
      await claimOpenConversation(page)

      // A message after the claim is sealed to the volunteer at write time.
      const postClaimBody = `After claim ${Date.now()}`
      await simulateIncomingMessage(request, { senderNumber, body: postClaimBody, channel: 'sms', hubId })

      // --- Proof 1: the claimer reads BOTH, in the thread they claimed from
      // No navigation: the pre-claim message must open in place.
      await expectVolunteerReads(page.getByTestId(TestIds.CONVERSATION_THREAD), preClaimBody, postClaimBody)

      // --- Proof 2: the admin is still a reader of both -------------------
      // The re-wrap appends envelopes; it must never cost an existing reader.
      const adminThread = await openConversation(admin.page, last4)
      await expect(adminThread.getByTestId(TestIds.MESSAGE_PLAINTEXT).filter({ hasText: preClaimBody })).toHaveCount(1, { timeout: 20_000 })
      await expect(adminThread.getByTestId(TestIds.MESSAGE_PLAINTEXT).filter({ hasText: postClaimBody })).toHaveCount(1)
      await expect(adminThread.getByTestId(TestIds.MESSAGE_ENCRYPTED)).toHaveCount(0)

      // --- Proof 3: no silent crypto failure, on either client ------------
      expect(consoleErrors, `volunteer console was not clean:\n${consoleErrors.join('\n')}`).toEqual([])
      expect(admin.consoleErrors, `admin console was not clean:\n${admin.consoleErrors.join('\n')}`).toEqual([])
    } finally {
      await admin.context.close()
    }
  })

  test('the first admin client to come online re-wraps a claim made while none was', async ({ browser, page, request }) => {
    const consoleErrors = watchConsole(page)
    const { hubId, release } = await acquireHub(request)
    releaseHub = release

    // The admin client exists only to create the volunteer, then goes away
    // before anything is claimed.
    const setupAdmin = await openAdminClient(browser, hubId)
    let fixture: Awaited<ReturnType<typeof volunteerWithUnclaimedMessage>>
    try {
      fixture = await volunteerWithUnclaimedMessage(page, setupAdmin.page, request, hubId)
    } finally {
      await setupAdmin.context.close()
    }
    const { last4, preClaimBody } = fixture

    await openConversation(page, last4)
    await claimOpenConversation(page)

    // --- An admin client connects AFTER the claim -------------------------
    // It never saw the `conversation:assigned` event. Its reconnect sweep of
    // the hub's active conversations is what closes the gap (PROTOCOL.md
    // §2.4.1, "Availability").
    const lateAdmin = await openAdminClient(browser, hubId)
    try {
      // --- Proof: the claimer's open thread now reads the pre-claim message
      await expectVolunteerReads(page.getByTestId(TestIds.CONVERSATION_THREAD), preClaimBody)

      expect(consoleErrors, `volunteer console was not clean:\n${consoleErrors.join('\n')}`).toEqual([])
      expect(lateAdmin.consoleErrors, `admin console was not clean:\n${lateAdmin.consoleErrors.join('\n')}`).toEqual([])
    } finally {
      await lateAdmin.context.close()
    }
  })
})
