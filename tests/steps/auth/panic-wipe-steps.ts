/**
 * Panic wipe step definitions.
 * Matches steps from: packages/test-specs/features/auth/panic-wipe.feature
 */
import { expect } from '@playwright/test'
import { When, Then } from '../fixtures'
import { TestIds } from '../../test-ids'
import { Timeouts } from '../../helpers'

When('I press Escape three times quickly', async ({ page }) => {
  // The panic wipe keyboard listener is disabled in PLAYWRIGHT_TEST builds to
  // prevent accidental triggers from Radix Select Escape handlers in other
  // scenarios. Use the test-only direct trigger when available; fall back to
  // real keyboard events in non-PLAYWRIGHT_TEST environments.
  const hasTrigger = await page.evaluate(
    () => typeof (window as unknown as Record<string, unknown>).__TEST_TRIGGER_PANIC_WIPE__ === 'function',
  )
  if (hasTrigger) {
    await page.evaluate(() => {
      ;((window as unknown as Record<string, unknown>).__TEST_TRIGGER_PANIC_WIPE__ as () => void)()
    })
  } else {
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
  }
})

Then('the panic wipe overlay should appear', async ({ page }) => {
  await expect(page.getByTestId(TestIds.PANIC_WIPE_OVERLAY)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('all local storage should be cleared', async ({ page }) => {
  await page.waitForURL(/\/login/, { timeout: Timeouts.NAVIGATION })
  // Panic wipe may trigger multiple redirects after landing on /login (e.g.
  // SPA router push). Wrap evaluate in toPass() so that if page.evaluate()
  // throws "execution context destroyed" mid-redirect, the whole block retries
  // after domcontentloaded confirms the context is fresh.
  await expect(async () => {
    await page.waitForLoadState('domcontentloaded', { timeout: 3000 })
    const count = await page.evaluate(() => localStorage.length)
    expect(count).toBe(0)
  }).toPass({ timeout: Timeouts.ELEMENT })
})

Then('all session storage should be cleared', async ({ page }) => {
  await page.waitForURL(/\/login/, { timeout: Timeouts.NAVIGATION })
  await expect(async () => {
    await page.waitForLoadState('domcontentloaded', { timeout: 3000 })
    const count = await page.evaluate(() => sessionStorage.length)
    expect(count).toBe(0)
  }).toPass({ timeout: Timeouts.ELEMENT })
})

When('I press Escape twice then wait over one second', async ({ page }) => {
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  // Wait >1 second so the panic wipe window expires before the next Escape.
  // Use 2s in CI to account for event loop lag under heavy parallel load.
  await page.waitForTimeout(2000)
})

When('I press Escape once more', async ({ page }) => {
  await page.keyboard.press('Escape')
})

Then('the encrypted key should still be in storage', async ({ page }) => {
  const hasKey = await page.evaluate(() => {
    return (
      localStorage.getItem('stronghold:llamenos:llamenos-encrypted-device-keys') !== null ||
      localStorage.getItem('llamenos:llamenos-encrypted-device-keys') !== null
    )
  })
  expect(hasKey).toBe(true)
})
