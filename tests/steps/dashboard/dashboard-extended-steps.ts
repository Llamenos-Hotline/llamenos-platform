/**
 * Extended dashboard step definitions.
 * Matches steps from:
 *   - packages/test-specs/features/dashboard/dashboard-blasts-nav.feature
 *   - packages/test-specs/features/dashboard/dashboard-break.feature
 *   - packages/test-specs/features/dashboard/dashboard-errors.feature
 *
 * Behavioral depth: Hard assertions on dashboard-specific elements.
 * No .or(PAGE_TITLE) fallbacks masking missing elements.
 */
import { expect } from '@playwright/test'
import { Given, When, Then } from '../fixtures'
import { TestIds } from '../../test-ids'
import { Timeouts } from '../../helpers'

// --- Blasts navigation ---

Then('I should see the blasts card on the dashboard', async ({ page }) => {
  await expect(page.getByTestId(TestIds.NAV_BLASTS)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I tap the view blasts button', async ({ page }) => {
  await page.getByTestId(TestIds.NAV_BLASTS).click()
})

Then('I should see the blasts screen', async ({ page }) => {
  await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(page.getByTestId(TestIds.PAGE_TITLE)).toContainText(/blasts/i)
})

When('I tap the back button on blasts', async ({ page }) => {
  // The desktop blasts route has no in-page back control; back is history
  // navigation (the window's back button / Alt+Left).
  await expect(page.getByTestId(TestIds.PAGE_TITLE)).toContainText(/blasts/i, { timeout: Timeouts.ELEMENT })
  await page.goBack()
})

// --- Break toggle ---

Given('the volunteer is on shift', async ({ page }) => {
  await expect(page.getByTestId(TestIds.DASHBOARD_SHIFT_STATUS)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Given('the volunteer is on break', async ({ page }) => {
  // The dashboard toggle offers "Clock In" while on break. Toggle only when not
  // already on break: an unconditional click would take a volunteer who was on
  // break OFF it.
  const breakBtn = page.getByTestId(TestIds.BREAK_TOGGLE_BTN)
  await expect(breakBtn).toHaveText(/Clock (In|Out)/, { timeout: Timeouts.ELEMENT })
  if ((await breakBtn.textContent())?.includes('Clock Out')) {
    await breakBtn.click()
  }
  await expect(breakBtn).toContainText('Clock In', { timeout: Timeouts.ELEMENT })
})

Then('I should see the break toggle button', async ({ page }) => {
  await expect(page.getByTestId(TestIds.BREAK_TOGGLE_BTN)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the on-break banner', async ({ page }) => {
  // The status card always has text ("Current Shift" heading), so non-empty text
  // proves nothing: it must name the break state.
  const breakBanner = page.getByTestId(TestIds.DASHBOARD_SHIFT_STATUS)
  await expect(breakBanner).toContainText('On Break', { timeout: Timeouts.ELEMENT })
})

// --- Dashboard help navigation ---

Then('I should see the help card', async ({ page }) => {
  await expect(page.getByTestId(TestIds.NAV_HELP)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I tap the help card', async ({ page }) => {
  await page.getByTestId(TestIds.NAV_HELP).click()
})

Then('I should see the help screen', async ({ page }) => {
  await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(page.getByTestId(TestIds.PAGE_TITLE)).toContainText(/help/i)
})

Then('I should see the help card on the dashboard', async ({ page }) => {
  await expect(page.getByTestId(TestIds.NAV_HELP)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

// --- Dashboard quick actions ---

Then('I should see the quick actions grid', async ({ page }) => {
  // Desktop dashboard shows nav cards (active calls, shift status, calls today) rather than a dedicated quick actions grid
  const dashboardContent = page.locator(
    `[data-testid="${TestIds.DASHBOARD_ACTIVE_CALLS}"], [data-testid="${TestIds.DASHBOARD_SHIFT_STATUS}"], [data-testid="${TestIds.DASHBOARD_CALLS_TODAY}"]`,
  )
  await expect(dashboardContent.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

// --- Dashboard errors ---

Given('a dashboard error is displayed', async ({ page }) => {
  // A precondition, so it must hold: the old body returned early when no error
  // was on screen, and the scenario then "dismissed" nothing and passed.
  await expect(page.getByTestId(TestIds.ERROR_MESSAGE)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I dismiss the dashboard error', async ({ page }) => {
  const errorEl = page.getByTestId(TestIds.ERROR_MESSAGE)
  await expect(errorEl).toBeVisible({ timeout: Timeouts.ELEMENT })
  await errorEl.click()
})

Then('the dashboard error card should not be visible', async ({ page }) => {
  await expect(page.getByTestId(TestIds.ERROR_MESSAGE)).not.toBeVisible({ timeout: 3000 })
})
