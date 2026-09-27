import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { loginAsAdmin, TEST_PIN, Timeouts } from '../helpers'
import { apiDelete, apiPost, uniqueName } from '../api-helpers'
import { TestIds } from '../test-ids'

/**
 * #1166 — the invite-code screen (/onboarding) and its "Use a different server"
 * button, on a packaged desktop build.
 *
 * Forgetting the server reloads the webview, and in production that reload does
 * NOT end the Rust process: CryptoState stays unlocked unless something locked
 * it, and sessionStorage survives. A signed-in volunteer talked into switching
 * servers there would reach an attacker's first-run screen still holding a live
 * session token and a device key that signs whatever the new host asks for.
 *
 * The IPC mock keeps CryptoState (and the active hub is plain module state) in
 * page JS, so a reload wipes both — an assertion made after the reload passes
 * whether or not anything was locked. The teardown test instead records what the
 * page still holds as it begins to unload, which is the state production carries
 * forward into the next server's first-run screen.
 */

const SESSION_TOKEN_KEY = 'llamenos-session-token'

interface LiveSession {
  /** Rust CryptoState, as mirrored by the IPC mock. */
  cryptoUnlocked: boolean
  activeHub: string | null
  sessionToken: string | null
}

/**
 * A hub of this test's own, created through the real admin API and pinned as
 * the page's active hub (the same `__TEST_WORKER_HUB` hook the BDD fixture uses),
 * so the active-hub assertions never depend on what other suites have created.
 */
async function useOwnHub(page: Page, request: APIRequestContext): Promise<string> {
  const { status, data } = await apiPost<{ hub: { id: string } }>(request, '/hubs', { name: uniqueName('Server switch') })
  expect(status, 'admin could not create a hub').toBe(201)
  const hubId = data.hub.id
  await page.addInitScript((id) => {
    (window as unknown as Record<string, unknown>).__TEST_WORKER_HUB = id
  }, hubId)
  return hubId
}

async function readLiveSession(page: Page): Promise<LiveSession> {
  return page.evaluate(async (tokenKey) => ({
    cryptoUnlocked: await window.__TEST_PLATFORM.isCryptoUnlocked(),
    activeHub: window.__TEST_GET_ACTIVE_HUB(),
    sessionToken: sessionStorage.getItem(tokenKey),
  }), SESSION_TOKEN_KEY)
}

/**
 * Make this page behave like a packaged build pointed at this app's own origin
 * (the preview server proxies /api to the real backend), for this page and every
 * reload after it — the same technique as tests/steps/config/server-address-steps.ts.
 */
async function simulatePackagedBuildOnOwnOrigin(page: Page): Promise<string> {
  const origin = new URL(page.url()).origin
  await page.addInitScript(() => {
    window.__TEST_SIMULATE_PACKAGED_TAURI__ = true
  })
  await page.evaluate(async (appOrigin) => {
    await window.__TEST_API_CONFIG.setApiBase(appOrigin)
    window.__TEST_SIMULATE_PACKAGED_TAURI__ = true
  }, origin)
  return origin
}

/** In-app navigation: a full page load would itself end the session under the mock. */
async function navigateInApp(page: Page, to: string, search: Record<string, string> = {}): Promise<void> {
  await page.evaluate(({ to, search }) => {
    const router = window.__TEST_ROUTER as unknown as {
      navigate: (opts: { to: string; search: Record<string, string> }) => Promise<void>
    }
    void router.navigate({ to, search })
  }, { to, search })
}

/**
 * Record, from inside the page, what it still holds at the instant it starts to
 * unload — after the server switch has done all it does and called reload().
 * Playwright cannot evaluate into a page while a navigation is in flight, so the
 * page writes its own snapshot to sessionStorage (which survives the reload, as
 * it does in production) for the test to read once the reload has landed. The
 * CryptoState read is the mock's own `is_crypto_unlocked`, whose handler is
 * synchronous: it settles in the microtask checkpoint right after the handler,
 * long before the reloaded document commits.
 */
const UNLOAD_SNAPSHOT_KEY = '__test_state_at_unload'

async function recordStateAtUnload(page: Page): Promise<void> {
  await page.evaluate(({ tokenKey, snapshotKey }) => {
    const invoke = (window as unknown as Record<symbol, (cmd: string) => Promise<boolean>>)[Symbol.for('llamenos_test_invoke')]
    window.addEventListener('beforeunload', () => {
      const activeHub = window.__TEST_GET_ACTIVE_HUB()
      const sessionToken = sessionStorage.getItem(tokenKey)
      void invoke('is_crypto_unlocked').then(cryptoUnlocked => {
        sessionStorage.setItem(snapshotKey, JSON.stringify({ cryptoUnlocked, activeHub, sessionToken }))
      })
    }, { once: true })
  }, { tokenKey: SESSION_TOKEN_KEY, snapshotKey: UNLOAD_SNAPSHOT_KEY })
}

async function readStateAtUnload(page: Page): Promise<LiveSession | null> {
  const raw = await page.evaluate((key) => sessionStorage.getItem(key), UNLOAD_SNAPSHOT_KEY)
  return raw === null ? null : JSON.parse(raw) as LiveSession
}

test.describe('invite-code screen on a packaged desktop build (#1166)', () => {
  const createdHubs: string[] = []

  test.afterEach(async ({ request }) => {
    for (const hubId of createdHubs.splice(0)) await apiDelete(request, `/hubs/${hubId}`)
  })

  test('a signed-in user sent to the invite-code screen is returned to the app without the page ever loading', async ({ page, request }) => {
    const hubId = await useOwnHub(page, request)
    createdHubs.push(hubId)
    await loginAsAdmin(page)
    const origin = await simulatePackagedBuildOnOwnOrigin(page)

    const inviteChecks: string[] = []
    page.on('request', request => {
      if (new URL(request.url()).pathname.startsWith('/api/invites/validate/')) inviteChecks.push(request.url())
    })

    // Redeeming an invite mints a new device key and stores it over this
    // device's own; the page also offers to forget the server. Neither is for a
    // signed-in user — even one who arrives with a well-formed code.
    await navigateInApp(page, '/onboarding', { code: crypto.randomUUID() })

    await page.waitForURL(url => url.pathname === '/', { timeout: Timeouts.NAVIGATION })
    await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible()
    expect(inviteChecks, 'the invite-code page mounted and checked a code for a signed-in user').toEqual([])

    // Being sent on is not a sign-out: the session and the server are untouched.
    const session = await readLiveSession(page)
    expect(session.cryptoUnlocked).toBe(true)
    expect(session.activeHub).toBe(hubId)
    expect(await page.evaluate(() => window.__TEST_API_CONFIG.getApiBase())).toBe(origin)
  })

  test('using a different server from the invite-code screen locks the key, drops the session token and clears the hub before reloading', async ({ page, request }) => {
    const hubId = await useOwnHub(page, request)
    createdHubs.push(hubId)
    await loginAsAdmin(page)
    await simulatePackagedBuildOnOwnOrigin(page)

    // The live-credential state that can still reach this screen: the webview
    // has reloaded mid-session, so it starts signed out — but the Rust process
    // did not reload, and its CryptoState is still unlocked. Under the mock the
    // reload wiped CryptoState too; unlock it again beneath the webview (which
    // is not told), exactly as Rust would have kept it.
    await page.reload()
    await page.waitForURL(url => url.pathname === '/login', { timeout: Timeouts.AUTH })
    await page.evaluate(async (pin) => {
      if (!await window.__TEST_PLATFORM.unlockStoredKeys(pin)) throw new Error('stored device key did not unlock')
    }, TEST_PIN)
    // And a passkey session token still in sessionStorage (passkey login is the
    // only thing that writes one); what it holds is irrelevant — it must not
    // outlive the server it was issued by.
    await page.evaluate((tokenKey) => sessionStorage.setItem(tokenKey, 'passkey-session-issued-by-the-old-server'), SESSION_TOKEN_KEY)

    await navigateInApp(page, '/onboarding')
    await expect(page.getByTestId(TestIds.INVITE_CODE_CHANGE_SERVER)).toBeVisible({ timeout: Timeouts.ELEMENT })
    // /api/config names the hubs for signed-out clients too, so one is active here.
    await page.waitForFunction((id) => window.__TEST_GET_ACTIVE_HUB() === id, hubId, { timeout: Timeouts.API })

    const before = await readLiveSession(page)
    expect(before.cryptoUnlocked, 'precondition: CryptoState must start unlocked').toBe(true)
    expect(before.activeHub, 'precondition: the hub must start active').toBe(hubId)
    expect(before.sessionToken, 'precondition: a session token must start present').not.toBeNull()

    await recordStateAtUnload(page)
    await page.getByTestId(TestIds.INVITE_CODE_CHANGE_SERVER).click()
    // The reload lands on the first-run screen: the old address is forgotten.
    await expect(page.getByTestId(TestIds.SERVER_ADDRESS_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })

    // What the next server's first-run screen inherits.
    expect(await readStateAtUnload(page)).toEqual({ cryptoUnlocked: false, activeHub: null, sessionToken: null })
  })

  test('an invite code the server could not be reached to check is not reported as invalid', async ({ page }) => {
    // A fresh install, configured through the real first-run screen.
    await page.addInitScript(() => {
      window.__TEST_SIMULATE_PACKAGED_TAURI__ = true
    })
    await page.goto('/')
    await page.getByTestId(TestIds.SERVER_ADDRESS_INPUT).fill(new URL(page.url()).origin)
    await page.getByTestId(TestIds.SERVER_ADDRESS_SUBMIT).click()
    await page.waitForURL(url => url.pathname === '/login', { timeout: Timeouts.AUTH })
    await page.getByTestId(TestIds.HAVE_INVITE_CODE_BTN).click()
    await expect(page.getByTestId(TestIds.INVITE_CODE_INPUT)).toBeVisible({ timeout: Timeouts.ELEMENT })

    // A refused connection reaches the webview exactly as a TLS pin mismatch or
    // an allowlist refusal does: the proxied request rejects, and no answer
    // about the code ever arrives.
    await page.route('**/api/invites/validate/**', route => route.abort('connectionrefused'))

    await page.getByTestId(TestIds.INVITE_CODE_INPUT).fill(crypto.randomUUID())
    await page.getByTestId(TestIds.INVITE_CODE_SUBMIT).click()

    await expect(page.getByTestId(TestIds.INVITE_CODE_ERROR)).toHaveAttribute('data-reason', 'unreachable', { timeout: Timeouts.API })
  })
})
