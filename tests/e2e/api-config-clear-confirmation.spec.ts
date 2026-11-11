import { test, expect } from '../console-guard'
import { TestIds } from '../test-ids'

/**
 * Proves the `api_config_clear` confirmation gate (#788) in a real Playwright
 * browser, using the same packaged-Tauri simulation technique as
 * `tests/steps/config/server-address-steps.ts` (which exercises the BDD
 * "Desktop server address configuration" feature's happy path, including the
 * "Changing the address from settings" scenario that calls through
 * `platform.ts::clearConfiguredApiBase` today).
 *
 * That existing feature proves the confirmed path still works end-to-end.
 * This spec adds the negative-path proof it doesn't cover: a caller that
 * skips `platform.ts` entirely and invokes the raw IPC command directly —
 * exactly the bypass #788 flagged — is rejected without ever touching the
 * configured address.
 */
test.describe('api_config_clear confirmation gate', () => {
  test.beforeEach(async ({ page }) => {
    // Registered before any navigation, so it also survives the reloads this
    // spec performs — same technique server-address-steps.ts uses.
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__TEST_SIMULATE_PACKAGED_TAURI__ = true
    })
  })

  test('invoking api_config_clear directly, without ever requesting a token, is rejected', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async () => {
      const invoke = (window as unknown as Record<symbol, unknown>)[Symbol.for('llamenos_test_invoke')] as
        (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
      try {
        await invoke('api_config_clear', { token: 'forged-token' })
        return { rejected: false, message: '' }
      } catch (err) {
        return { rejected: true, message: err instanceof Error ? err.message : String(err) }
      }
    })
    expect(result.rejected).toBe(true)
    expect(result.message).toMatch(/confirm/i)
  })

  test('the confirmed path clears the address and re-shows first-run on reload', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId(TestIds.SERVER_ADDRESS_TITLE)).toBeVisible()

    // Configure an address through the real platform module (the same one
    // production code uses) so there is something to clear.
    await page.evaluate(async () => {
      const platform = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
        persistApiBase: (origin: string) => Promise<string>
      }
      await platform.persistApiBase('https://example.org')
    })
    await page.reload()
    await expect(page.getByTestId(TestIds.SERVER_ADDRESS_TITLE)).not.toBeVisible()

    // The confirmed path: platform.ts requests the (mock-auto-confirmed)
    // token, then clears with it — the same two-call chain Settings triggers
    // via resetApiBase().
    await page.evaluate(async () => {
      const platform = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
        clearConfiguredApiBase: () => Promise<void>
      }
      await platform.clearConfiguredApiBase()
    })
    await page.reload()
    await expect(page.getByTestId(TestIds.SERVER_ADDRESS_TITLE)).toBeVisible({ timeout: 10_000 })
  })
})
