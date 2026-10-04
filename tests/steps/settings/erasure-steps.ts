/**
 * Account erasure self-service step definitions.
 * Matches steps from: packages/test-specs/features/platform/desktop/settings/account-erasure.feature
 */
import { expect } from '@playwright/test'
import { Then } from '../fixtures'
import { Timeouts } from '../../helpers'

// The three erasure states render INSIDE the `account-erasure` card. The old
// steps also accepted the card itself, which is on screen before the erasure
// status has loaded and whether or not any state renders — so they could not
// fail. Only the states themselves count, and they are mutually exclusive.

Then('I should see the erasure request button or pending state', async ({ page }) => {
  const available = page.getByTestId('erasure-available')
  const pending = page.getByTestId('erasure-pending')
  const completed = page.getByTestId('erasure-completed')
  await expect(available.or(pending).or(completed)).toBeVisible({ timeout: Timeouts.API })
})

Then('I should see the erasure available state or pending state', async ({ page }) => {
  const available = page.getByTestId('erasure-available')
  const pending = page.getByTestId('erasure-pending')
  await expect(available.or(pending)).toBeVisible({ timeout: Timeouts.API })
})

Then('the account erasure section should be visible', async ({ page }) => {
  // Wait for the outer account-erasure Card — it is always rendered after the settings page
  // finishes loading (loading=false). Use waitFor so we retry until visible rather than
  // checking a one-shot snapshot that may catch the page mid-render.
  const section = page.getByTestId('account-erasure')
  await section.waitFor({ state: 'visible', timeout: Timeouts.ELEMENT })
})
