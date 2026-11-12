/**
 * Proves the Playwright session-reuse pattern actually works, end to end.
 *
 * See tests/fixtures/auth.ts and tests/bootstrap.spec.ts for the mechanics.
 * This file exists because the reuse infrastructure (per-role storageState
 * fixtures) previously existed but was never consumed anywhere — nothing
 * imported `../fixtures/auth`, so it silently bit-rotted (dead code) while
 * every real caller re-implemented a parallel, ad-hoc version in
 * tests/helpers.ts's `loginAsAdmin`. Fixed here; this spec is the load-bearing
 * proof that the fixture works, not just documentation of intent.
 */
import { test, expect } from './fixtures/auth'
import { TestIds } from './test-ids'
import { settleConsoleWatch, watchConsole } from './console-guard'

test.describe('Session reuse via cached storageState', () => {
  test('a test body that never calls enterPin() still runs fully authenticated', async ({ adminPage }) => {
    // `adminPage` is handed to us already logged in — the fixture drove the PIN
    // UI exactly once, before this test body ran. Nothing below this line
    // touches the PIN input at all, yet the page is a real, authenticated
    // session capable of real API calls (not a mock/stub of "authenticated").
    await expect(adminPage.getByTestId(TestIds.NAV_SIDEBAR)).toBeVisible()
    await expect(adminPage.getByTestId(TestIds.NAV_ADMIN_SECTION)).toBeVisible()

    // Prove it is a *working* session, not just a rendered shell: navigate to
    // an admin-only page and confirm real data loads (a 401/403 would leave
    // this either redirected away or showing an empty/error state instead).
    await adminPage.getByTestId(TestIds.NAV_VOLUNTEERS).click()
    await expect(adminPage.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: 15000 })
  })

  test('the cached storageState restores an already-encrypted key, no import step required', async ({ browser }) => {
    // This is the mechanism that makes the fast path fast: a fresh context
    // created from the cache already has the device key in localStorage
    // *before* the app's first paint — nothing on the page has to call
    // deviceImportAndLoad() (the slow, PBKDF2-heavy path) to put it there.
    // Assert that directly, independent of the enterPin() UI flow.
    const { STORAGE_PATHS } = await import('./fixtures/auth')
    const context = await browser.newContext({ storageState: STORAGE_PATHS.admin })
    const watch = watchConsole(context)
    try {
      const page = await context.newPage()
      await page.goto('/login', { waitUntil: 'domcontentloaded' })
      // The mock Tauri Store (tests/mocks/tauri-store.ts) prefixes every key
      // with `tauri-store:<name>:`, and the desktop key-manager store is named
      // "stronghold" — so the real on-disk key is
      // `stronghold:llamenos:llamenos-encrypted-device-keys`. Check the
      // unprefixed legacy names too (same defensive check as
      // pin-lockout-steps.ts's "the stored keys should be wiped" step).
      const hasEncryptedKey = await page.evaluate(() =>
        localStorage.getItem('stronghold:llamenos:llamenos-encrypted-device-keys') !== null ||
        localStorage.getItem('llamenos:llamenos-encrypted-device-keys') !== null ||
        localStorage.getItem('llamenos:llamenos-encrypted-key') !== null
      )
      expect(hasEncryptedKey).toBe(true)
      await settleConsoleWatch(watch)
    } finally {
      await context.close()
    }
  })
})
