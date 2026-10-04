/**
 * Language selection step definitions.
 * Matches steps from: packages/test-specs/features/admin/settings.feature
 *
 * The desktop has no language section in Settings: the UI language is chosen
 * with the LanguageSelect combobox in the sidebar footer, and spoken languages
 * are toggle chips in the Settings profile section. These steps drive those
 * controls. The previous versions probed for chips/radios the desktop never
 * renders and, finding none, passed on "the page title is visible".
 */
import { expect, type Page } from '@playwright/test'
import { When, Then } from '../fixtures'
import { TestIds } from '../../test-ids'
import { Timeouts } from '../../helpers'
import { LANGUAGES } from '../../../packages/shared/languages'
import { expandSettingsSection } from '../common/ui-helpers'

/** The sidebar language combobox; its accessible name is localised, its role is not. */
function languageSelect(page: Page) {
  return page.getByTestId(TestIds.NAV_SIDEBAR).getByRole('combobox').filter({ has: page.locator('svg.lucide-globe') })
}

When('I expand the language section', async ({ page }) => {
  const select = languageSelect(page)
  await expect(select).toBeVisible({ timeout: Timeouts.ELEMENT })
  await select.click()
})

Then('I should see the language options', async ({ page }) => {
  await expect(page.getByRole('option').first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see language chips for all supported locales', async ({ page }) => {
  await expect(page.getByRole('option')).toHaveCount(LANGUAGES.length, { timeout: Timeouts.ELEMENT })
})

When('I tap a language chip', async ({ page }) => {
  await page.getByRole('option', { name: /Español/ }).click()
})

Then('the language chip should be selected', async ({ page }) => {
  await expect(languageSelect(page)).toContainText('Español', { timeout: Timeouts.ELEMENT })
  await expect(page.locator('html')).toHaveAttribute('lang', /^es/, { timeout: Timeouts.ELEMENT })
})

When('I expand the profile section', async ({ page }) => {
  await expandSettingsSection(page, TestIds.SETTINGS_PROFILE)
})

/** A spoken-language chip in the profile section, by its visible label. */
function spokenLanguageChip(page: Page, label: RegExp) {
  return page.getByTestId(TestIds.SETTINGS_PROFILE).getByRole('button', { name: label })
}

Then('I should see the spoken languages chips', async ({ page }) => {
  const profile = page.getByTestId(TestIds.SETTINGS_PROFILE)
  for (const lang of LANGUAGES) {
    await expect(profile.getByRole('button', { name: lang.label, exact: false }).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
  }
})

When('I tap a spoken language chip', async ({ page }) => {
  const chip = spokenLanguageChip(page, /Español/)
  await expect(chip).toBeVisible({ timeout: Timeouts.ELEMENT })
  await chip.click()
})

Then('the spoken language chip should be selected', async ({ page }) => {
  // A toggle chip must expose its state to assistive technology (aria-pressed);
  // the previous body accepted any `[data-state="checked"]` on the page, or else
  // just the page title.
  await expect(spokenLanguageChip(page, /Español/)).toHaveAttribute('aria-pressed', 'true', { timeout: Timeouts.ELEMENT })
})
