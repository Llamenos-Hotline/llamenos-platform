/**
 * Admin retention settings step definitions.
 * Matches steps from: packages/test-specs/features/platform/desktop/admin/retention-settings.feature
 */
import { expect } from '@playwright/test'
import { Then } from '../fixtures'
import { Timeouts } from '../../helpers'

Then('I should see the retention categories', async ({ page }) => {
  // The old version also accepted the admin shell's `admin-section` wrapper,
  // which renders for every section, so it could not fail.
  await expect(page.getByTestId('retention-categories')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see retention settings for {string}', async ({ page }, category: string) => {
  const categoryEl = page.getByTestId(`retention-category-${category}`)
  await expect(categoryEl).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('each retention category should have a days input and save button', async ({ page }) => {
  await page.waitForLoadState('domcontentloaded')
  const categories = ['call_records', 'notes', 'messages', 'audit_log']
  // Every category renders (retention-section.tsx CATEGORIES). The old loop
  // skipped any category that was not visible yet, so it passed with none.
  for (const category of categories) {
    await expect(page.getByTestId(`retention-category-${category}`)).toBeVisible({ timeout: Timeouts.ELEMENT })
    await expect(page.getByTestId(`retention-days-${category}`)).toBeVisible({ timeout: Timeouts.ELEMENT })
    await expect(page.getByTestId(`retention-save-${category}`)).toBeVisible({ timeout: Timeouts.ELEMENT })
  }
})
