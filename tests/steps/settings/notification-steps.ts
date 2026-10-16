/**
 * Notification preferences step definitions.
 * Matches steps from: packages/test-specs/features/settings/notifications.feature
 *
 * Behavioral depth: Hard assertions on notification section elements.
 */
import { expect } from '@playwright/test'
import { Then } from '../fixtures'
import { Timeouts } from '../../helpers'
import { expandSettingsSection } from '../common/ui-helpers'

Then('I should see the notifications section', async ({ page }) => {
  await expect(page.getByTestId('notifications')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the notification toggles', async ({ page }) => {
  const section = await expandSettingsSection(page, 'notifications')
  // The previous version swallowed a failed expand click and, finding no
  // switches, passed on "the section rendered without them".
  await expect(section.getByRole('switch').first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})
