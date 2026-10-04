/**
 * Admin erasure management step definitions.
 * Matches steps from: packages/test-specs/features/platform/desktop/admin/erasure-management.feature
 */
import { expect } from '@playwright/test'
import { When, Then } from '../fixtures'
import { Timeouts } from '../../helpers'

Then('I should see the erasure queue or empty state', async ({ page }) => {
  // The queue settles into exactly one of: the request list, or the empty
  // message (erasure-loading renders until then). The old version also accepted
  // any `erasure-*` testid — erasure-loading included — so it passed mid-load.
  const requestList = page.getByTestId('erasure-request-list')
  const empty = page.getByTestId('erasure-empty')
  await expect(requestList.or(empty)).toBeVisible({ timeout: Timeouts.API })
})

Then('I should see the erasure config form', async ({ page }) => {
  // The config form's delay input. The old version also accepted the admin
  // shell's `admin-section` wrapper, which is on screen for every section.
  await expect(page.getByTestId('erasure-delay-input')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the admin erase button', async ({ page }) => {
  const btn = page.getByTestId('erasure-admin-erase-btn')
  await expect(btn).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the admin wipe button', async ({ page }) => {
  const btn = page.getByTestId('erasure-admin-wipe-btn')
  await expect(btn).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I click the admin erase button', async ({ page }) => {
  await page.getByTestId('erasure-admin-erase-btn').click()
})

When('I click the admin wipe button', async ({ page }) => {
  await page.getByTestId('erasure-admin-wipe-btn').click()
})

Then('I should see a dialog for entering user ID and justification', async ({ page }) => {
  const userIdInput = page.getByTestId('erase-user-id-input')
  const justificationInput = page.getByTestId('erase-justification-input')
  await expect(userIdInput).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(justificationInput).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see a dialog for entering user ID and device pubkey', async ({ page }) => {
  const userIdInput = page.getByTestId('wipe-user-id-input')
  const pubkeyInput = page.getByTestId('wipe-device-pubkey-input')
  await expect(userIdInput).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(pubkeyInput).toBeVisible({ timeout: Timeouts.ELEMENT })
})
