/**
 * Key import step definitions.
 * Matches steps from: packages/test-specs/features/auth/key-import.feature
 */
import { expect } from '@playwright/test'
import { When, Then } from '../fixtures'
import { TestIds, Timeouts } from '../../helpers'

Then('the hub URL should be stored as {string}', async ({ page }, expectedUrl: string) => {
  const hubUrl = await page.evaluate(() => {
    return (
      localStorage.getItem('llamenos-hub-url') ||
      localStorage.getItem('tauri-store:settings.json:hubUrl')
    )
  })
  expect(hubUrl).toContain(expectedUrl)
})

When('I see the error {string}', async ({ page }, errorText: string) => {
  const errorMessage = page.getByTestId(TestIds.ERROR_MESSAGE)
  await expect(errorMessage).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(errorMessage).toContainText(errorText)
})

When('I start typing in the device key field', async ({ page }) => {
  await page.getByTestId(TestIds.DEVICE_KEY_INPUT).fill('n')
})

Then('the error should disappear', async ({ page }) => {
  // The login page renders its validation error as login-error (role="alert").
  // The previous body sampled a different testid, discarded the result and
  // asserted only that the input was still editable.
  await expect(page.getByTestId(TestIds.DEVICE_KEY_INPUT)).toBeEditable()
  await expect(page.getByTestId(TestIds.LOGIN_ERROR).or(page.getByTestId(TestIds.ERROR_MESSAGE)))
    .toHaveCount(0, { timeout: Timeouts.ELEMENT })
})
