/**
 * Calls today dashboard step definitions.
 * Matches steps from: packages/test-specs/features/dashboard/calls-today.feature
 */
import { expect } from '@playwright/test'
import { Given, When, Then } from '../fixtures'
import { TestIds } from '../../test-ids'
import { Timeouts, loginAsAdmin } from '../../helpers'

Given('the app is launched', async ({ page }) => {
  // In CI, loginAsAdmin may take longer due to PBKDF2 + Docker overhead.
  // Use AUTH timeout for the page-title assertion.
  await loginAsAdmin(page)
  // loginAsAdmin already asserts PAGE_TITLE visibility, but add extra wait for dashboard data
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
})

Then('I should see the calls today count on the dashboard', async ({ page }) => {
  // After reload + PIN re-entry, dashboard may still be mounting.
  // Wait for page title first (proves auth + layout rendered), then check calls card.
  const pageTitle = page.getByTestId(TestIds.PAGE_TITLE)
  await expect(pageTitle).toBeVisible({ timeout: Timeouts.AUTH })
  // '-' is the card's loading placeholder, so it is not a count.
  const callsCard = page.getByTestId(TestIds.DASHBOARD_CALLS_TODAY)
  await expect(callsCard).toContainText(/\d+/, { timeout: Timeouts.ELEMENT })
})

When('I pull to refresh the dashboard', async ({ page }) => {
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  // Full re-login needed — page.reload() clears in-memory keyManager,
  // so PIN re-entry is required to unlock the encrypted device keys.
  const { reenterPinAfterReload } = await import('../../helpers')
  await reenterPinAfterReload(page)
})
