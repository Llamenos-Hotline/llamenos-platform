/**
 * Transcription preferences step definitions.
 * Matches steps from: packages/test-specs/features/settings/transcription-preferences.feature
 *
 * Behavioral depth: Hard assertions on transcription section.
 */
import { expect } from '@playwright/test'
import { Given, Then } from '../fixtures'
import { TestIds } from '../../test-ids'
import { Timeouts } from '../../helpers'
import { getTranscriptionSettingsViaApi } from '../../api-helpers'

Given('I expand the transcription section', async ({ page }) => {
  const section = page.getByTestId(TestIds.TRANSCRIPTION_SECTION)
  await expect(section).toBeVisible({ timeout: Timeouts.ELEMENT })
  await section.click()
})

Given('transcription opt-out is not allowed', async ({ backendRequest, $test }) => {
  // allowUserOptOut is a GLOBAL setting (/settings/transcription), so a parallel
  // run cannot flip it without poisoning other workers' scenarios. Read it: when
  // opt-out is allowed the premise does not hold and the scenario is SKIPPED,
  // reported as such. (The old body was empty, and the managed-message check
  // then matched unrelated "admin" text in the section.)
  const settings = await getTranscriptionSettingsViaApi(backendRequest)
  $test.skip(settings.allowUserOptOut, 'transcription opt-out is allowed on this server; the scenario needs it disallowed')
})

Then('I should see the transcription settings section', async ({ page }) => {
  await expect(page.getByTestId(TestIds.TRANSCRIPTION_SECTION)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the transcription toggle', async ({ page }) => {
  const section = page.getByTestId(TestIds.TRANSCRIPTION_SECTION)
  await expect(section).toBeVisible({ timeout: Timeouts.ELEMENT })
  const toggle = section.locator('[role="switch"], input[type="checkbox"]').first()
  await expect(toggle).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the transcription managed message', async ({ page }) => {
  const section = page.getByTestId(TestIds.TRANSCRIPTION_SECTION)
  await expect(section).toBeVisible({ timeout: Timeouts.ELEMENT })
  // When opt-out is not allowed, section should show a "managed by admin" message
  const managedText = section.getByText(/managed|disabled|admin/i)
  await expect(managedText.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})
