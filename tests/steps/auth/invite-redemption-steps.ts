/**
 * Invite redemption entry point step definitions (#1128).
 * Matches steps from:
 *   - packages/test-specs/features/platform/desktop/auth/invite-redemption.feature
 *
 * A packaged Tauri webview has no address bar, so a volunteer holding an
 * invite code has no way to reach /onboarding?code=... unless the app itself
 * provides an entry point. These steps drive the real "Redeem an invite"
 * control on the login screen (src/client/routes/login.tsx) — never
 * `page.goto()` straight to the onboarding URL, which would pass even if the
 * UI control never existed.
 */
import { expect } from '@playwright/test'
import { When } from '../fixtures'
import { TestIds, Timeouts } from '../../helpers'

When('I open the redeem invite form', async ({ page }) => {
  const redeemBtn = page.getByTestId(TestIds.REDEEM_INVITE_BTN)
  await expect(redeemBtn).toBeVisible({ timeout: Timeouts.ELEMENT })
  await redeemBtn.click()
  await expect(page.getByTestId(TestIds.REDEEM_INVITE_CODE_INPUT)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I submit the invite code {string}', async ({ page }, code: string) => {
  await page.getByTestId(TestIds.REDEEM_INVITE_CODE_INPUT).fill(code)
  await page.getByTestId(TestIds.REDEEM_INVITE_SUBMIT_BTN).click()
})

When('the volunteer redeems their invite code from the login screen', async ({ page }) => {
  // Extract just the CODE, not the full link. A real volunteer may only ever
  // receive the code itself (read aloud, texted, written down) — the whole
  // point of #1128 is that the copied link's host may not resolve on their
  // machine at all, so a test that only ever follows the link would never
  // catch that. getOnboardingUrl() (src/client/lib/api-config.ts) falls back
  // to window.location.origin in this test build, so the link is a real,
  // fetchable URL here — extracting the code keeps the assertion meaningful
  // in a packaged build too, where it would not be.
  const link = (await page.getByTestId('invite-link-code').textContent())?.trim() ?? ''
  expect(link, 'invite link').toMatch(/\/onboarding\?code=\S+/)
  const code = new URL(link).searchParams.get('code') ?? ''
  expect(code, 'invite code').toBeTruthy()

  // Preserve the volunteer name set by "I create an invite for a new volunteer"
  // across the storage reset below — later steps read it back out.
  const volName = (await page.evaluate(() =>
    (window as unknown as Record<string, unknown>).__test_invite_vol_name || localStorage.getItem('__test_invite_vol_name'),
  )) as string

  // Simulate a brand-new device with no admin session and no stored key — the
  // real starting point for a volunteer who has never opened the app before.
  await page.evaluate(() => { sessionStorage.clear(); localStorage.clear() })
  await page.goto('/login')
  await page.waitForLoadState('domcontentloaded')
  if (volName) {
    await page.evaluate((n) => localStorage.setItem('__test_invite_vol_name', n), volName)
  }

  const redeemBtn = page.getByTestId(TestIds.REDEEM_INVITE_BTN)
  await expect(redeemBtn).toBeVisible({ timeout: Timeouts.ELEMENT })
  await redeemBtn.click()
  await page.getByTestId(TestIds.REDEEM_INVITE_CODE_INPUT).fill(code)
  await page.getByTestId(TestIds.REDEEM_INVITE_SUBMIT_BTN).click()
  await expect(page).toHaveURL(/\/onboarding\?code=/, { timeout: Timeouts.NAVIGATION })
})
