/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * PIN lockout step definitions.
 * Matches steps from: packages/test-specs/features/auth/pin-lockout.feature
 *
 * Uses the mock's lockout tracking (set_pin_failed_attempts, get_pin_lockout_state)
 * to seed failed attempt counts without actually entering wrong PINs N times.
 *
 * NOTE: "I have a stored identity with PIN {string}" and "the app is restarted"
 * are defined in tests/steps/common/auth-steps.ts — not duplicated here.
 */
import { expect } from '@playwright/test'
import { Given, When, Then } from '../fixtures'
import { enterPin, Timeouts } from '../../helpers'

/**
 * Invoke a Tauri IPC mock command via the browser's test platform shim.
 *
 * The tauri-core mock module is lazily loaded (dynamic import inside platform.ts).
 * We trigger it by calling isCryptoUnlocked() on __TEST_PLATFORM, which forces
 * the tauri-core chunk to load and register Symbol.for('llamenos_test_invoke').
 */
async function testInvoke(page: import('@playwright/test').Page, cmd: string, args?: Record<string, unknown>) {
  // Ensure __TEST_PLATFORM is available and trigger tauri-core lazy load
  await page.waitForFunction(() => !!(window as unknown as Record<string, unknown>).__TEST_PLATFORM, { timeout: Timeouts.AUTH })

  // Trigger tauri-core chunk load by calling a platform function
  await page.evaluate(async () => {
    const platform = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      isCryptoUnlocked: () => Promise<boolean>
    }
    await platform.isCryptoUnlocked()
  })

  // Now the symbol is guaranteed to be on window
  return page.evaluate(async ({ cmd, args }) => {
    const sym = Symbol.for('llamenos_test_invoke')
    const invoke = (window as unknown as Record<symbol, unknown>)[sym] as
      ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | undefined
    if (!invoke) throw new Error('llamenos_test_invoke not available — is the Tauri mock loaded?')
    return invoke(cmd, args)
  }, { cmd, args })
}

// Helper: seed N failed PIN attempts via the mock's test command
async function seedFailedAttempts(page: import('@playwright/test').Page, count: number) {
  await testInvoke(page, 'set_pin_failed_attempts', { count })
}

// NOTE: "I should see a PIN error message" is defined in assertion-steps.ts

Then('I should not see a lockout timer', async ({ page }) => {
  // Absence is only meaningful once the attempt has been answered: wait for the
  // wrong-PIN response first, then check it is not a lockout and the pad is live.
  await expect(page.getByRole('alert').first()).toBeVisible({ timeout: Timeouts.AUTH })
  await expect(page.locator('text=/locked out/i')).toHaveCount(0)
  await expect(page.getByTestId('pin-input').locator('input').first()).toBeEnabled()
})

Given('I have {int} failed PIN attempts', async ({ page }, count: number) => {
  // Seed the mock with N failed attempts.
  // Wait for __TEST_PLATFORM which is set in the same module that registers the test invoke symbol.
  await page.waitForFunction(() => !!(window as unknown as Record<string, unknown>).__TEST_PLATFORM, { timeout: Timeouts.AUTH })
  await seedFailedAttempts(page, count)
})

Then('I should see a lockout message', async ({ page }) => {
  // After lockout, the error message shows "Locked out for N seconds"
  const lockoutText = page.locator('text=/locked out/i')
  await expect(lockoutText.first()).toBeVisible({ timeout: Timeouts.AUTH })
})

Then('the lockout duration should be approximately {int} seconds', async ({ page }, seconds: number) => {
  const lockoutState = await testInvoke(page, 'get_pin_lockout_state') as { failedAttempts: number; lockoutUntil: number }
  const remainingMs = lockoutState.lockoutUntil - Date.now()
  // Allow 5 seconds of tolerance
  expect(remainingMs).toBeGreaterThan((seconds - 5) * 1000)
  expect(remainingMs).toBeLessThanOrEqual(seconds * 1000 + 5000)
})

Then('the lockout duration should be approximately {int} minutes', async ({ page }, minutes: number) => {
  const lockoutState = await testInvoke(page, 'get_pin_lockout_state') as { failedAttempts: number; lockoutUntil: number }
  const remainingMs = lockoutState.lockoutUntil - Date.now()
  const expectedMs = minutes * 60 * 1000
  // Allow 10 seconds of tolerance
  expect(remainingMs).toBeGreaterThan(expectedMs - 10_000)
  expect(remainingMs).toBeLessThanOrEqual(expectedMs + 10_000)
})

/**
 * Lockout as the desktop enforces it. The desktop PIN pad is not disabled during
 * a lockout (see PinUnlockInline in src/client/routes/login.tsx): the Rust side
 * rejects every attempt until the deadline. So assert the enforcement itself —
 * the lockout message is shown and the lockout deadline is in the future — not
 * "disabled OR message", whose first branch can never hold here.
 */
async function expectLockedOut(page: import('@playwright/test').Page) {
  await expect(page.locator('text=/locked out/i').first()).toBeVisible({ timeout: Timeouts.AUTH })
  const lockoutState = await testInvoke(page, 'get_pin_lockout_state') as { failedAttempts: number; lockoutUntil: number }
  expect(lockoutState.lockoutUntil, 'lockout deadline').toBeGreaterThan(Date.now())
}

Then('the PIN pad should be disabled', async ({ page }) => {
  await expectLockedOut(page)
})

Then('the stored keys should be wiped', async ({ page }) => {
  // The wipe is asynchronous (keyManager.wipeKey after the tenth failure): poll
  // storage until the encrypted device keys are gone. The previous version slept
  // a second and then accepted "keys gone OR a message mentioning 'wiped'".
  await expect.poll(
    () => page.evaluate(() =>
      localStorage.getItem('stronghold:llamenos:llamenos-encrypted-device-keys') !== null ||
      localStorage.getItem('llamenos:llamenos-encrypted-device-keys') !== null,
    ),
    { message: 'encrypted device keys still stored after the wipe', timeout: Timeouts.AUTH },
  ).toBe(false)
})

Then('I should be redirected to the setup or login screen', async ({ page }) => {
  // After wipe, user should see recovery options or login screen
  await page.waitForURL(/\/(login|setup)/, { timeout: Timeouts.NAVIGATION })
})

Then('the failed attempt counter should be reset', async ({ page }) => {
  const lockoutState = await testInvoke(page, 'get_pin_lockout_state') as { failedAttempts: number; lockoutUntil: number }
  expect(lockoutState.failedAttempts).toBe(0)
})

Given('I see the lockout message', async ({ page }) => {
  // Enter a wrong PIN to trigger lockout (attempts already seeded)
  await enterPin(page, '00000000')
  const lockoutText = page.locator('text=/locked out/i')
  await expect(lockoutText.first()).toBeVisible({ timeout: Timeouts.AUTH })
})

Then('I should still see the lockout message', async ({ page }) => {
  // After app restart, the lockout message only appears when a PIN attempt is made.
  // Enter a dummy PIN to trigger the lockout check.
  await enterPin(page, '00000000')
  const lockoutText = page.locator('text=/locked out/i')
  await expect(lockoutText.first()).toBeVisible({ timeout: Timeouts.AUTH })
})

Then('I should not be able to enter a PIN until lockout expires', async ({ page }) => {
  await expectLockedOut(page)
})

Given('the lockout has expired', async ({ page }) => {
  // Wait for test platform to be ready
  await page.waitForFunction(() => !!(window as unknown as Record<string, unknown>).__TEST_PLATFORM, { timeout: Timeouts.AUTH })
  // Clear the lockout timer (simulates timer expiry) — keeps attempt count unchanged
  await testInvoke(page, 'expire_pin_lockout')
})
