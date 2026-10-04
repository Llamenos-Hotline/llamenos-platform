/**
 * Platform bans admin step definitions.
 * Matches steps from: packages/test-specs/features/platform/desktop/admin/platform-bans.feature
 */
import { expect } from '@playwright/test'
import { When, Then } from '../fixtures'
import { Timeouts } from '../../helpers'

Then('I should see the platform bans list or empty state', async ({ page }) => {
  // Exactly one of the two settled states. The old version also accepted the
  // admin shell's `admin-section` wrapper, so it passed before (or without)
  // the bans list ever loading.
  const bansList = page.getByTestId('platform-bans-list')
  const empty = page.getByTestId('platform-bans-empty')
  await expect(bansList.or(empty)).toBeVisible({ timeout: Timeouts.API })
})

Then('I should see the platform bans create button', async ({ page }) => {
  const btn = page.getByTestId('platform-bans-create-btn')
  await expect(btn).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the platform bans bulk import button', async ({ page }) => {
  const btn = page.getByTestId('platform-bans-bulk-btn')
  await expect(btn).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I click the platform bans create button', async ({ page }) => {
  await page.getByTestId('platform-bans-create-btn').click()
})

Then('I should see a dialog for entering phone hash and reason', async ({ page }) => {
  const hashInput = page.getByTestId('ban-phone-hash-input')
  const reasonInput = page.getByTestId('ban-reason-input')
  await expect(hashInput).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(reasonInput).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the platform bans search input', async ({ page }) => {
  const searchInput = page.getByTestId('platform-bans-search')
  await expect(searchInput).toBeVisible({ timeout: Timeouts.ELEMENT })
})
