/**
 * Step definitions for packages/test-specs/features/desktop/config/server-address.feature
 * (#738 desktop server address configuration, #739 runtime network allowlist).
 *
 * `isPackagedTauri()` (src/client/lib/api-config.ts) is false for every OTHER
 * desktop scenario in this suite — they run under the Playwright IPC mock,
 * which satisfies `isTauriRuntime()` but not `isPackagedTauri()`, so the
 * first-run server-address gate never appears for them. These steps opt a
 * scenario INTO packaged-app behavior via `window.__TEST_SIMULATE_PACKAGED_TAURI__`,
 * set through `page.addInitScript` so it survives the reloads a server change
 * performs, like a real packaged app would.
 *
 * The IPC mock (tests/mocks/tauri-core.ts) mirrors apps/desktop/src/api_config.rs
 * and net.rs — exact-origin allowlist, first-run-only health probe — so these
 * scenarios assert the same policy the Rust unit tests pin down.
 */
import { expect } from '@playwright/test'
import { Given, When, Then, After } from '../fixtures'
import { TestIds } from '../../test-ids'
import { Timeouts } from '../../helpers'
import { startTestBackendServer, type TestBackendServer } from './test-backend-server'

// Scenario-scoped server registry, keyed by the `page` fixture instance (each
// scenario gets a fresh `page`, so this never leaks across scenarios) — avoids
// having to add a new fixture to the shared tests/steps/fixtures.ts, which
// other in-flight workers are actively editing for unrelated work.
const serversByPage = new WeakMap<object, TestBackendServer[]>()

function trackServer(page: object, server: TestBackendServer): void {
  const list = serversByPage.get(page) ?? []
  list.push(server)
  serversByPage.set(page, list)
}

function lastServer(page: object): TestBackendServer {
  const list = serversByPage.get(page)
  const server = list?.[list.length - 1]
  if (!server) throw new Error('No test backend server has been started for this scenario')
  return server
}

// A server the app must NOT be able to reach (see the health-probe scenario).
const secondServerByPage = new WeakMap<object, TestBackendServer>()

After(async ({ page }) => {
  const list = serversByPage.get(page)
  list?.forEach(s => s.close())
  secondServerByPage.get(page)?.close()
})

// --- Simulating a packaged desktop build ---

Given('the desktop app is simulating a packaged build with no server configured', async ({ page }) => {
  // Registered before any navigation — Playwright re-runs init scripts on
  // every subsequent navigation/reload of this page, matching how a real
  // packaged app's "am I Tauri" check would stay true across reloads.
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__TEST_SIMULATE_PACKAGED_TAURI__ = true
  })
})

Given('the desktop app is now simulating a packaged build connected to its own origin', async ({ page }) => {
  // The admin logged in against the relative /api default. A packaged app always
  // has an absolute backend configured, so configure this app's own origin (the
  // preview server proxies /api to the real backend) — traffic now flows through
  // the mocked Rust proxy exactly as in a packaged build — and only then flip the
  // packaged-build switch, for this page and for every reload that follows.
  const origin = new URL(page.url()).origin
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__TEST_SIMULATE_PACKAGED_TAURI__ = true
  })
  await page.evaluate(async (appOrigin) => {
    const apiConfig = (window as unknown as Record<string, unknown>).__TEST_API_CONFIG as
      { setApiBase: (url: string) => Promise<void> }
    await apiConfig.setApiBase(appOrigin)
    ;(window as unknown as Record<string, unknown>).__TEST_SIMULATE_PACKAGED_TAURI__ = true
  }, origin)
})

Given('the desktop app is now simulating a packaged build connected to its loopback address', async ({ page }) => {
  // As above, but configured under a DIFFERENT origin than the page's own: the
  // same preview server reached by IP literal instead of `localhost`. A packaged
  // build's webview origin (tauri://localhost) never equals its server's, so a
  // scenario asserting "built from the server address, not the page origin"
  // needs the two to differ here too. The preview server allows loopback-origin
  // CORS (Vite's default), which the mocked Rust proxy's real fetch needs.
  const page_ = new URL(page.url())
  const loopback = `${page_.protocol}//127.0.0.1:${page_.port}`
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__TEST_SIMULATE_PACKAGED_TAURI__ = true
  })
  await page.evaluate(async (server) => {
    const apiConfig = (window as unknown as Record<string, unknown>).__TEST_API_CONFIG as
      { setApiBase: (url: string) => Promise<void> }
    await apiConfig.setApiBase(server)
    ;(window as unknown as Record<string, unknown>).__TEST_SIMULATE_PACKAGED_TAURI__ = true
  }, loopback)
})

// --- Test backend server lifecycle ---

Given('a real test backend server is running', async ({ page }) => {
  trackServer(page, await startTestBackendServer())
})

Given('a second test backend server is running', async ({ page }) => {
  // Kept out of `serversByPage` so `lastServer` still means the configured one.
  secondServerByPage.set(page, await startTestBackendServer())
})

function secondServer(page: object): TestBackendServer {
  const server = secondServerByPage.get(page)
  if (!server) throw new Error('No second test backend server has been started for this scenario')
  return server
}

// --- Navigation ---

When('I load the app', async ({ page }) => {
  await page.goto('/')
})

// "I reload the page" is defined in tests/steps/auth/auth-guards-steps.ts (page.reload()) — reused as-is.

// --- First-run / server address screen ---

Then('I should see the server address screen', async ({ page }) => {
  await expect(page.getByTestId(TestIds.SERVER_ADDRESS_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should still see the server address screen', async ({ page }) => {
  await expect(page.getByTestId(TestIds.SERVER_ADDRESS_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should not see the server address screen', async ({ page }) => {
  await expect(page.getByTestId(TestIds.SERVER_ADDRESS_TITLE)).not.toBeVisible()
})

Then('I should see the server address input', async ({ page }) => {
  await expect(page.getByTestId(TestIds.SERVER_ADDRESS_INPUT)).toBeVisible()
})

Then('I should see a server address error', async ({ page }) => {
  await expect(page.getByTestId(TestIds.SERVER_ADDRESS_ERROR)).toBeVisible({ timeout: Timeouts.API })
})

Then('the server address error says https is required', async ({ page }) => {
  // The refusal comes from local validation (normalizeServerInput), before any
  // probe: an unreachable-host error here would mean the insecure address was
  // contacted.
  await expect(page.getByTestId(TestIds.SERVER_ADDRESS_ERROR)).toContainText('https://', { timeout: Timeouts.API })
})

When('I enter {string} as the server address and submit', async ({ page }, address: string) => {
  await page.getByTestId(TestIds.SERVER_ADDRESS_INPUT).fill(address)
  await page.getByTestId(TestIds.SERVER_ADDRESS_SUBMIT).click()
})

When("I enter the test backend server's address and submit", async ({ page }) => {
  const server = lastServer(page)
  await page.getByTestId(TestIds.SERVER_ADDRESS_INPUT).fill(server.origin)
  await page.getByTestId(TestIds.SERVER_ADDRESS_SUBMIT).click()
})

Given('I have configured that server and reached the login screen', async ({ page }) => {
  await page.goto('/')
  const server = lastServer(page)
  await page.getByTestId(TestIds.SERVER_ADDRESS_INPUT).fill(server.origin)
  await page.getByTestId(TestIds.SERVER_ADDRESS_SUBMIT).click()
  await page.waitForURL(/\/login/, { timeout: Timeouts.AUTH })
})

Then('I should be on the login screen', async ({ page }) => {
  await page.waitForURL(/\/login/, { timeout: Timeouts.AUTH })
})

Then('the test backend server should have received a request to {string}', async ({ page }, path: string) => {
  const server = lastServer(page)
  await expect.poll(
    () => server.requests.some(r => r.path === path),
    { timeout: Timeouts.API },
  ).toBe(true)
})

// --- Runtime allowlist enforcement (#739) ---

interface BlockResult { blocked: boolean; message?: string }
const blockResultByPage = new WeakMap<object, BlockResult>()

When('the app attempts a network request to an unconfigured origin', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const invokeSymbol = Symbol.for('llamenos_test_invoke')
    const invoke = (window as unknown as Record<symbol, unknown>)[invokeSymbol] as
      (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
    try {
      await invoke('net_fetch', {
        method: 'GET',
        url: 'https://attacker.invalid/steal',
        headers: {},
        bodyBase64: null,
      })
      return { blocked: false }
    } catch (err) {
      return { blocked: true, message: err instanceof Error ? err.message : String(err) }
    }
  })
  blockResultByPage.set(page, result)
})

Then('the request is blocked by the runtime allowlist', async ({ page }) => {
  const result = blockResultByPage.get(page)
  expect(result?.blocked).toBe(true)
  expect(result?.message).toMatch(/blocked/i)
})

const probeResultByPage = new WeakMap<object, BlockResult>()

When('the app attempts a health probe of the second server', async ({ page }) => {
  const url = secondServer(page).origin
  const result = await page.evaluate(async (target) => {
    const invoke = (window as unknown as Record<symbol, unknown>)[Symbol.for('llamenos_test_invoke')] as
      (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
    try {
      await invoke('net_probe_health', { url: target })
      return { blocked: false }
    } catch (err) {
      return { blocked: true, message: err instanceof Error ? err.message : String(err) }
    }
  }, url)
  probeResultByPage.set(page, result)
})

Then('the probe is refused because a server is already configured', async ({ page }) => {
  const result = probeResultByPage.get(page)
  expect(result?.blocked).toBe(true)
  expect(result?.message).toMatch(/already configured/i)
})

Then('the second test backend server should have received no requests', async ({ page }) => {
  expect(secondServer(page).requests).toEqual([])
})

// --- Changing the address later from Settings ---

When('I open the settings server address section', async ({ page }) => {
  // In-app navigation, not page.goto: a full reload would lock the device key
  // and bounce to the unlock screen before Settings is reachable.
  await page.evaluate(() => {
    const router = (window as unknown as Record<string, unknown>).__TEST_ROUTER as
      { navigate: (opts: { to: string; search: Record<string, string> }) => Promise<void> }
    void router.navigate({ to: '/settings', search: { section: 'server-connection' } })
  })
  await expect(page.getByTestId(TestIds.SETTINGS_SERVER_ADDRESS_INPUT)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I enter the test backend server\'s address and save', async ({ page }) => {
  const server = lastServer(page)
  await page.getByTestId(TestIds.SETTINGS_SERVER_ADDRESS_INPUT).fill(server.origin)
  await page.getByTestId(TestIds.SETTINGS_SERVER_ADDRESS_SUBMIT).click()
})

Then('my session is cleared', async ({ page }) => {
  const sessionToken = await page.evaluate(() => sessionStorage.getItem('llamenos-session-token'))
  expect(sessionToken).toBeNull()
  const unlocked = await page.evaluate(async () => {
    const km = (window as unknown as Record<string, unknown>).__TEST_KEY_MANAGER as { isUnlocked: () => boolean }
    return km.isUnlocked()
  })
  expect(unlocked).toBe(false)
})
