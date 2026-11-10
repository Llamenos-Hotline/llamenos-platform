/**
 * Admin settings step definitions.
 * Matches steps from: packages/test-specs/features/admin/admin-settings.feature
 *
 * Behavioral depth: Hard assertions on settings elements.
 * No .or(PAGE_TITLE) fallbacks.
 */
import { expect } from '@playwright/test'
import { Given, When, Then } from '../fixtures'
import { TestIds } from '../../test-ids'
import { Timeouts, Navigation, navigateAfterLogin } from '../../helpers'

Given('I navigate to the admin settings tab', async ({ page }) => {
  await Navigation.goToHubSettings(page)
})

Given('I navigate to the admin {string} section', async ({ page }, section: string) => {
  await navigateAfterLogin(page, `/admin/${section}`)
})

Then('I should see the transcription settings card', async ({ page }) => {
  await expect(page.getByTestId(TestIds.TRANSCRIPTION_SECTION)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the transcription enabled toggle', async ({ page }) => {
  const section = page.getByTestId(TestIds.TRANSCRIPTION_SECTION)
  await expect(section).toBeVisible({ timeout: Timeouts.ELEMENT })
  // Expand the section if collapsed (CollapsibleContent hides children when closed)
  // Use count() instead of isVisible() — Radix Collapsible sets data-state="open" immediately
  // but element has height:0 during animation, so isVisible() returns false and re-clicks
  // the trigger, collapsing an already-expanding section.
  const contentSelector = '[data-slot="collapsible-content"][data-state="open"]'
  const isExpanded = await section.locator(contentSelector).count() > 0
  if (!isExpanded) {
    await section.getByTestId('transcription-trigger').click()
  }
  const toggle = section.locator('[role="switch"], input[type="checkbox"]').first()
  await expect(toggle).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the transcription opt-out toggle', async ({ page }) => {
  const section = page.getByTestId(TestIds.TRANSCRIPTION_SECTION)
  await expect(section).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I toggle transcription on', async ({ page }) => {
  const section = page.getByTestId(TestIds.TRANSCRIPTION_SECTION)
  await expect(section).toBeVisible({ timeout: Timeouts.ELEMENT })
  // Expand the section if collapsed — use count() not isVisible() (see comment above)
  const contentSelector = '[data-slot="collapsible-content"][data-state="open"]'
  const isExpanded = await section.locator(contentSelector).count() > 0
  if (!isExpanded) {
    await section.getByTestId('transcription-trigger').click()
  }
  const toggle = section.locator('[role="switch"], input[type="checkbox"]').first()
  await expect(toggle).toBeVisible({ timeout: Timeouts.ELEMENT })
  await toggle.click()
})

Then('transcription should be enabled', async ({ page }) => {
  const section = page.getByTestId(TestIds.TRANSCRIPTION_SECTION)
  await expect(section).toBeVisible({ timeout: Timeouts.ELEMENT })
  // Verify toggle state
  const toggle = section.locator('[role="switch"], input[type="checkbox"]').first()
  await expect(toggle).toBeChecked()
})

Then('they should receive a {int} forbidden response', async ({ rolesWorld }, statusCode: number) => {
  // The preceding When step ("...attempts to access an unauthorized endpoint") is a
  // pure API call — it never navigates the UI, so there is no admin nav / "access
  // denied" text to probe for. Read the real signal it recorded instead of racing
  // the page with a non-waiting isVisible() guess.
  expect(rolesWorld.endpointStatus).toBe(statusCode)
})
