/**
 * Shift step definitions.
 * Matches steps from:
 *   - packages/test-specs/features/shifts/shift-list.feature
 *   - packages/test-specs/features/shifts/clock-in-out.feature
 */
import { expect } from '@playwright/test'
import { Then } from '../fixtures'
import { TestIds } from '../../test-ids'
import { Timeouts } from '../../helpers'
import { expectShiftScheduleSettled } from './shift-schedule-state'

Then('I should see the clock in\\/out card', async ({ page }) => {
  // The shifts page carries its clock control in the page header.
  await expect(page.getByTestId(TestIds.BREAK_TOGGLE_BTN)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the clock status text should be displayed', async ({ page }) => {
  await expect(page.getByTestId(TestIds.BREAK_TOGGLE_BTN)).toHaveText(/Clock (In|Out)/, { timeout: Timeouts.ELEMENT })
})

Then('I should see either the shifts list, empty state, or loading indicator', async ({ page, backendRequest, workerHub }) => {
  // A loading indicator is not a result: wait for the schedule to settle, then
  // check it shows what the server holds.
  await expectShiftScheduleSettled(page, backendRequest, workerHub)
})

// --- Clock in/out steps ---

Then('the clock status should update', async ({ page }) => {
  // The preceding step tapped "Clock In"; the control only flips once the
  // clock-in request has succeeded.
  await expect(page.getByTestId(TestIds.BREAK_TOGGLE_BTN)).toContainText('Clock Out', { timeout: Timeouts.ELEMENT })
})

Then('the button should change to {string}', async ({ page }, buttonText: string) => {
  const clockBtn = page.getByTestId(TestIds.BREAK_TOGGLE_BTN)
  await expect(clockBtn).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(clockBtn).toContainText(buttonText, { timeout: Timeouts.ELEMENT })
})

Then('the shift timer should appear', async ({ page }) => {
  // On the shifts page, verify the clock button changed to "Clock Out" (confirms on-shift)
  const clockBtn = page.getByTestId(TestIds.BREAK_TOGGLE_BTN)
  await expect(clockBtn).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(clockBtn).toContainText('Clock Out', { timeout: Timeouts.ELEMENT })
})

Then('the clock status should show {string}', async ({ page }, status: string) => {
  // On shifts page: verify via button text (no separate status card)
  // "Off Shift" → button should say "Clock In"
  if (status === 'Off Shift') {
    const clockBtn = page.getByTestId(TestIds.BREAK_TOGGLE_BTN)
    await expect(clockBtn).toContainText('Clock In', { timeout: Timeouts.ELEMENT })
  } else {
    // On dashboard: check the dashboard shift status card
    const shiftStatus = page.getByTestId(TestIds.DASHBOARD_SHIFT_STATUS)
    await expect(shiftStatus).toBeVisible({ timeout: Timeouts.ELEMENT })
    await expect(shiftStatus).toContainText(status)
  }
})
