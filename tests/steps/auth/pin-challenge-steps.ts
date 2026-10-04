/**
 * PIN challenge step definitions.
 * Matches steps from: packages/test-specs/features/platform/desktop/auth/pin-challenge.feature
 * Covers phone unmask PIN re-verification, wrong PIN error display, and cancel dialog.
 */
import { expect, type Page } from '@playwright/test'
import { When, Then } from '../fixtures'
import { TestIds, Timeouts, enterPin, TEST_PIN } from '../../helpers'

/**
 * The volunteer row this feature acts on: the first one that actually has a phone
 * visibility toggle.
 *
 * NOT `VOLUNTEER_ROW.first()`. Since #1044 scoped the list to hub members, a global
 * super-admin counts as a member of every hub, so the bootstrap admin — inserted with
 * `phone: ''` — is row 0 of every hub's list. The row renders a phone and a toggle
 * only under `{user.phone && ...}`, so row 0 has neither, and asserting on it looks
 * for a `+` that can never appear there. The Background's volunteer is the row that
 * owns the toggle, and it is the row every step here must use.
 */
const phoneRow = (page: Page) =>
  page.getByTestId(TestIds.VOLUNTEER_ROW)
    .filter({ has: page.getByTestId(TestIds.TOGGLE_PHONE_VISIBILITY) })
    .first()

When('I click the phone visibility toggle', async ({ page }) => {
  const toggleBtn = phoneRow(page).getByTestId(TestIds.TOGGLE_PHONE_VISIBILITY)
  await expect(toggleBtn).toBeVisible({ timeout: Timeouts.ELEMENT })
  await toggleBtn.scrollIntoViewIfNeeded()
  await toggleBtn.click()
})

Then('I should see the PIN challenge dialog', async ({ page }) => {
  const pinDialog = page.getByTestId(TestIds.PIN_CHALLENGE_DIALOG)
  await expect(pinDialog).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I enter the correct PIN', async ({ page }) => {
  await enterPin(page, TEST_PIN)
})

Then('the PIN challenge dialog should close', async ({ page }) => {
  const pinDialog = page.getByTestId(TestIds.PIN_CHALLENGE_DIALOG)
  await expect(pinDialog).not.toBeVisible({ timeout: 5000 })
})

Then('the PIN challenge dialog should remain open', async ({ page }) => {
  const pinDialog = page.getByTestId(TestIds.PIN_CHALLENGE_DIALOG)
  await expect(pinDialog).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the unmasked phone number', async ({ page }) => {
  // After dialog closes, the phone should be visible in the row whose toggle was
  // clicked — see `phoneRow` above for why row 0 is the wrong row to ask.
  const phoneText = phoneRow(page).locator('text=/\\+/')
  await expect(phoneText).toBeVisible({ timeout: 5000 })
})

When('I enter a wrong PIN three times', async ({ page }) => {
  await enterPin(page, '99999999')
  const errorMsg = page.getByTestId(TestIds.PIN_CHALLENGE_ERROR)
  await expect(errorMsg).toBeVisible({ timeout: 5000 })

  await enterPin(page, '88888888')
  await expect(errorMsg).toBeVisible({ timeout: 5000 })

  await enterPin(page, '77777777')
  await expect(errorMsg).toBeVisible({ timeout: 5000 })
})

Then('I should see a wrong PIN error message', async ({ page }) => {
  const errorMsg = page.getByTestId(TestIds.PIN_CHALLENGE_ERROR)
  await expect(errorMsg).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should still be on the volunteers page', async ({ page }) => {
  const pageTitle = page.getByTestId(TestIds.PAGE_TITLE)
  await expect(pageTitle).toBeVisible()
  await expect(pageTitle).toContainText('Volunteers')
})
