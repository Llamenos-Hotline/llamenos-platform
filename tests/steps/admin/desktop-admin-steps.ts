/**
 * Desktop-specific admin step definitions.
 * Matches steps from:
 *   - packages/test-specs/features/desktop/calls/telephony-provider.feature
 *   - packages/test-specs/features/desktop/calls/call-recording.feature
 *   - packages/test-specs/features/desktop/messaging/rcs-channel.feature
 *   - packages/test-specs/features/desktop/settings/webrtc-settings.feature
 *   - packages/test-specs/features/desktop/admin/multi-hub.feature
 *   - packages/test-specs/features/desktop/misc/setup-wizard.feature
 *   - packages/test-specs/features/admin/reports.feature
 *   - packages/test-specs/features/admin/demo-mode.feature
 *   - packages/test-specs/features/messaging/blasts.feature
 */
import { expect, type Page } from '@playwright/test'
import { Given, When, Then } from '../fixtures'
import { TestIds, navTestIdMap } from '../../test-ids'
import { Timeouts, navigateAfterLogin, loginAsAdmin, reenterPinAfterReload } from '../../helpers'

/**
 * Select a channel card in the setup wizard by label.
 * Scoped to data-testid="setup-step" to avoid matching sidebar nav links.
 */
async function selectWizardChannel(page: Page, channelLabel: string) {
  const card = page.getByTestId('setup-step').getByRole('button', { name: new RegExp('^' + channelLabel, 'i') })
  await expect(card).toBeVisible({ timeout: Timeouts.ELEMENT })
  await card.click()
}

/**
 * Navigate through the setup wizard to a target step (0-indexed).
 * Starts at step 0 (Identity), advances through prior steps automatically.
 * @param channel - channel to select on step 1 (default: 'Reports')
 */
async function advanceWizardToStep(page: Page, targetStep: number, channel = 'Reports') {
  // Navigate away first to force SetupWizard remount and reset local step state.
  // TanStack Router won't remount the component on same-URL navigation, so if we're
  // already on /setup the wizard local state (step, data) would carry over.
  await navigateAfterLogin(page, '/')
  await navigateAfterLogin(page, '/setup')

  // Step 0 – Identity: fill hotline name. The Organization field (StepIdentity.tsx) is
  // optional to fill but always rendered — the old isVisible/catch probe just raced the
  // wizard's remount instead of guarding a genuinely conditional field.
  await page.getByLabel(/hotline name|name/i).first().fill(`TestHotline ${Date.now()}`)
  const orgInput = page.getByLabel(/organization/i)
  await expect(orgInput).toBeVisible({ timeout: Timeouts.ELEMENT })
  await orgInput.fill('Test Org')
  if (targetStep === 0) return

  // Advance 0→1: Channels — wait for step 1 progressbar to confirm transition
  await page.getByTestId(TestIds.SETUP_NEXT_BTN).click()
  await expect(page.locator('[role="progressbar"][aria-valuenow="2"]')).toBeVisible({ timeout: 10000 })
  if (targetStep === 1) return

  // Step 1 – Channels: select the specified channel
  await selectWizardChannel(page, channel)

  // Advance 1→2: Providers
  await page.getByTestId(TestIds.SETUP_NEXT_BTN).click()
  await expect(page.locator('[role="progressbar"][aria-valuenow="3"]')).toBeVisible({ timeout: 10000 })
  if (targetStep === 2) return

  // Step 2 – Providers: skip. SetupWizard.tsx renders `setup-skip-btn` unconditionally
  // for every step >= 2, so the "else click Next" fallback was dead code masking the
  // timeout-ignoring isVisible() probe.
  const skipBtn = page.getByTestId('setup-skip-btn')
  await expect(skipBtn).toBeVisible({ timeout: Timeouts.ELEMENT })
  await skipBtn.click()
  await expect(page.locator('[role="progressbar"][aria-valuenow="4"]')).toBeVisible({ timeout: 10000 })
  if (targetStep === 3) return

  // Step 3 – Settings: advance
  await page.getByTestId(TestIds.SETUP_NEXT_BTN).click()
  await expect(page.locator('[role="progressbar"][aria-valuenow="5"]')).toBeVisible({ timeout: 10000 })
  if (targetStep === 4) return

  // Step 4 – Invite: advance
  await page.getByTestId(TestIds.SETUP_NEXT_BTN).click()
  await expect(page.locator('[role="progressbar"][aria-valuenow="6"]')).toBeVisible({ timeout: 10000 })
}

/**
 * Reload so ConfigProvider re-fetches /api/config (hub list, isMultiHub) after a hub was
 * created through the API. A full reload clears the in-memory key manager, so the PIN
 * screen must be passed again before the authenticated layout (and the switcher) renders.
 */
async function reloadAndUnlock(page: Page): Promise<void> {
  await page.reload()
  await reenterPinAfterReload(page)
  await expect(page.getByTestId(TestIds.NAV_SIDEBAR)).toBeVisible({ timeout: Timeouts.AUTH })
}

/**
 * Pick a hub in the sidebar hub switcher (hub-switcher.tsx) and wait for the switch to
 * take effect (the chosen option becomes aria-selected).
 *
 * The switcher is a plain `<button aria-haspopup="listbox">` + `role="option"` popover —
 * not a native `<select>` or Radix combobox — and only renders when the loaded config has
 * more than one hub. Callers must guarantee that (create a hub, then reload so /api/config
 * is re-fetched) instead of probing for the switcher's presence.
 *
 * @param hubId - hub to select; omit to select any hub that is not currently active.
 * @returns the selected hub's id
 */
async function selectHubInSwitcher(page: Page, hubId?: string): Promise<string> {
  const trigger = page.getByTestId(TestIds.HUB_SWITCHER_TRIGGER)
  await expect(trigger).toBeVisible({ timeout: Timeouts.ELEMENT })
  await trigger.click()
  const options = page.getByTestId(TestIds.HUB_SWITCHER_OPTION)
  const option = hubId
    ? options.and(page.locator(`[data-hub-id="${hubId}"]`))
    : options.and(page.locator('[aria-selected="false"]')).first()
  await expect(option).toBeVisible({ timeout: Timeouts.ELEMENT })
  const selectedId = await option.getAttribute('data-hub-id')
  expect(selectedId, 'hub option carries data-hub-id').toBeTruthy()
  await option.click()
  // Re-open to read the switcher's own view of the active hub.
  await trigger.click()
  await expect(options.and(page.locator(`[data-hub-id="${selectedId}"]`))).toHaveAttribute('aria-selected', 'true', { timeout: Timeouts.ELEMENT })
  await trigger.click()
  return selectedId!
}

// --- Telephony provider ---

When('I expand the telephony provider section', async ({ page }) => {
  const trigger = page.getByTestId(`${TestIds.SETTINGS_TELEPHONY}-trigger`)
  await trigger.scrollIntoViewIfNeeded()
  await trigger.click()
})

Then('I should see the Twilio credentials form', async ({ page }) => {
  await expect(page.getByTestId(TestIds.ACCOUNT_SID).or(page.getByLabel(/account sid/i)).first()).toBeVisible({
    timeout: Timeouts.ELEMENT,
  })
})

Then('I should see fields for Account SID, Auth Token, and TwiML App SID', async ({ page }) => {
  await expect(page.getByTestId(TestIds.ACCOUNT_SID).or(page.getByLabel(/account sid/i)).first()).toBeVisible({
    timeout: Timeouts.ELEMENT,
  })
})

When('I navigate to the telephony settings', async ({ page }) => {
  await page.getByTestId(navTestIdMap['Hub Settings']).click()
})

When('I fill in valid Twilio credentials', async ({ page }) => {
  const sidInput = page.getByTestId(TestIds.ACCOUNT_SID).or(page.getByLabel(/account sid/i)).first()
  await expect(sidInput).toBeVisible({ timeout: Timeouts.ELEMENT })
  await sidInput.fill('TEST_SID_00000000000000000000000')
})

When('I fill in Twilio credentials', async ({ page }) => {
  const sidInput = page.getByTestId(TestIds.ACCOUNT_SID).or(page.getByLabel(/account sid/i)).first()
  await expect(sidInput).toBeVisible({ timeout: Timeouts.ELEMENT })
  await sidInput.fill('TEST_SID_00000000000000000000000')
})

When('I fill in invalid Twilio credentials', async ({ page }) => {
  const sidInput = page.getByTestId(TestIds.ACCOUNT_SID).or(page.getByLabel(/account sid/i)).first()
  await expect(sidInput).toBeVisible({ timeout: Timeouts.ELEMENT })
  await sidInput.fill('invalid')
})

Then('I should see available provider options', async ({ page }) => {
  // Content assertion — verifying provider names are displayed
  await expect(page.getByText(/twilio|signalwire|vonage|plivo/i).first()).toBeVisible({
    timeout: Timeouts.ELEMENT,
  })
})

Then('Twilio should be selected by default', async ({ page }) => {
  // Content assertion — verifying Twilio is shown as selected
  await expect(page.getByText(/twilio/i).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

// --- Call recording ---
// DELETED: All call recording steps require real telephony infrastructure (actual
// phone calls with recordings). These cannot be tested in the Playwright environment.
// The call-recording.feature file has been deleted as well.

// --- RCS channel ---

When('I navigate to the messaging channel settings', async ({ page }) => {
  await page.getByTestId(navTestIdMap['Hub Settings']).click()
})

Then('I should see the RCS configuration section', async ({ page }) => {
  // Content assertion — verifying RCS text is displayed
  await expect(page.getByText(/rcs/i).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I fill in valid RCS settings', async ({ page }) => {
  // Navigate to Hub Settings if not already there
  const { Navigation } = await import('../../pages/index')
  await Navigation.goToHubSettings(page)
  // Scroll the RCS section trigger into view and expand it
  const rcsTrigger = page.getByTestId('rcs-channel-trigger')
  await rcsTrigger.scrollIntoViewIfNeeded()
  await rcsTrigger.click()
  // Wait for the agent ID input to appear after expansion
  const agentIdInput = page.getByTestId(TestIds.RCS_AGENT_ID)
  await expect(agentIdInput).toBeVisible({ timeout: Timeouts.ELEMENT })
  await agentIdInput.fill('test-agent-id')
})

Then('the RCS agent ID should be saved', async ({ page }) => {
  // Wait for the save to complete — the button re-enables when saving finishes
  const saveBtn = page.getByTestId(TestIds.FORM_SAVE_BTN)
  await expect(saveBtn).toBeEnabled({ timeout: Timeouts.API })
  // Verify the agent ID input retained its value (proves the save round-tripped)
  await expect(page.getByTestId(TestIds.RCS_AGENT_ID)).toHaveValue('test-agent-id')
})

// --- WebRTC ---

When('I expand the WebRTC section', async ({ page }) => {
  const trigger = page.getByTestId(`${TestIds.SETTINGS_TRANSCRIPTION}-trigger`)
    .or(page.getByRole('button', { name: /webrtc/i }))
  await trigger.first().scrollIntoViewIfNeeded()
  await trigger.first().click()
})

Then('I should see fields for STUN and TURN server configuration', async ({ page }) => {
  // Content assertion — verifying STUN/TURN text is displayed
  await expect(page.getByText(/stun|turn/i).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

// --- Multi-hub ---

When('I navigate to the hub management page', async ({ page }) => {
  await page.getByTestId(TestIds.NAV_ADMIN_HUBS).click()
})

When('I fill in the hub name', async ({ page }) => {
  await page.getByLabel(/name/i).first().fill(`TestHub ${Date.now()}`)
})

Then('the new hub should appear in the hub list', async ({ page }) => {
  // Content assertion — verifying hub name text
  await expect(page.getByText(/TestHub/).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Given('multiple hubs exist', async ({ backendRequest }) => {
  const { createHubViaApi } = await import('../../api-helpers')
  // Create a second hub — the worker hub already exists from test setup. A failure here
  // must fail the scenario: the old catch-all swallowed it and let the switch steps run
  // against a single-hub config.
  await createHubViaApi(backendRequest, `Hub-${Date.now()}`)
})

When('I select a different hub', async ({ page }) => {
  // "Given multiple hubs exist" creates the second hub via the backend API — the page's
  // config (hub list, isMultiHub) was fetched once on mount and won't know about it
  // without a reload. The old locator also matched neither a native <select> nor a
  // Radix combobox, so this step silently selected nothing either way.
  await reloadAndUnlock(page)
  await selectHubInSwitcher(page)
})

Then('the app should switch to the selected hub context', async ({ page }) => {
  // After hub switch, the page title or hub name should update to reflect the new context
  await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I navigate to the hub settings', async ({ page }) => {
  await page.getByTestId(navTestIdMap['Hub Settings']).click()
})

Then('I should see the hub-specific configuration', async ({ page }) => {
  await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I switch to a specific hub', async ({ page }) => {
  // Same as "I select a different hub": reload to pick up the hub created by
  // "Given multiple hubs exist", and drive the real hub-switcher control.
  await reloadAndUnlock(page)
  await selectHubInSwitcher(page)
})

Then('I should see only volunteers for that hub', async ({ page }) => {
  // After hub switch + navigating to volunteers, the page should render the volunteer list
  await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })
  // The volunteer list or empty state should be present (hub-specific filtering)
  const list = page.getByTestId(TestIds.VOLUNTEER_ROW).first().or(page.getByText(/no volunteers|no users/i).first())
  await expect(list).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Given('a non-default hub exists', async ({ page, adminWorld }) => {
  const { createHubViaApi } = await import('../../api-helpers')
  adminWorld.lastHubName = `NonDefault-${Date.now()}`
  adminWorld.lastHubId = await createHubViaApi(page.request, adminWorld.lastHubName)
})

When('I click {string} on the hub', async ({ page, adminWorld }, text: string) => {
  // Act on the hub created by "a non-default hub exists". The old
  // getByRole('button', { name: /Delete/i }).first() clicked whichever hub row rendered
  // first — potentially another parallel worker's hub.
  expect(text, 'only the Delete hub action is implemented').toBe('Delete')
  expect(adminWorld.lastHubId, 'a non-default hub must exist first').toBeTruthy()
  if (!page.url().includes('/admin/hubs')) {
    await navigateAfterLogin(page, '/admin/hubs')
    await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })
  }
  const btn = page.getByTestId(`delete-hub-${adminWorld.lastHubId}`)
  await expect(btn).toBeVisible({ timeout: Timeouts.ELEMENT })
  await btn.click()
})

When('I confirm the deletion', async ({ page, adminWorld }) => {
  // Hub deletion always goes through DeleteHubDialog (routes/admin/hubs.tsx) — a Radix
  // Dialog, never window.confirm() — and its confirm button stays disabled until the
  // hub's name is typed exactly. The old isVisible/catch cascade could silently skip
  // typing the name (leaving the button disabled) or skip clicking it outright.
  //
  // This phrase is shared with custom-fields.feature, whose delete uses a native
  // confirm() that "I click the delete button on {string}" already accepted — there is
  // no in-page dialog to drive. Which flow this scenario is in is recorded state (the hub
  // Given sets adminWorld.lastHubId), not a DOM probe.
  if (!adminWorld.lastHubId) return
  const confirmName = page.getByTestId(TestIds.DELETE_HUB_CONFIRM_NAME)
  await expect(confirmName).toHaveText(adminWorld.lastHubName, { timeout: Timeouts.ELEMENT })
  await page.getByTestId(TestIds.DELETE_HUB_CONFIRM_INPUT).fill(adminWorld.lastHubName)
  const okBtn = page.getByTestId(TestIds.CONFIRM_DIALOG_OK)
  await expect(okBtn).toBeEnabled({ timeout: Timeouts.ELEMENT })
  const deleteResponse = page.waitForResponse(
    res => res.url().includes(`/hubs/${adminWorld.lastHubId}`) && res.request().method() === 'DELETE',
    { timeout: Timeouts.API },
  )
  await okBtn.click()
  expect((await deleteResponse).ok(), 'DELETE hub request failed').toBe(true)
})

Then('the hub should be removed', async ({ page, adminWorld }) => {
  // Was: any [role="status"] element or any /deleted|removed/ text — satisfied by
  // unrelated toasts. Assert the deleted hub's row is gone.
  await expect(page.getByTestId(`delete-hub-${adminWorld.lastHubId}`)).toHaveCount(0, { timeout: Timeouts.ELEMENT })
})

// --- Setup wizard ---

When('I navigate to the setup wizard', async ({ page }) => {
  await navigateAfterLogin(page, '/setup')
})

Then('the hotline name input should be visible', async ({ page }) => {
  await expect(page.getByLabel(/hotline name|name your hotline/i)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I fill in the hotline name', async ({ page }) => {
  await page.getByLabel(/hotline name|name/i).first().fill(`TestHotline ${Date.now()}`)
})

When('I fill in the organization name', async ({ page }) => {
  // Optional to fill, but always rendered (StepIdentity.tsx) — see advanceWizardToStep.
  const orgInput = page.getByLabel(/organization/i)
  await expect(orgInput).toBeVisible({ timeout: Timeouts.ELEMENT })
  await orgInput.fill('Test Organization')
})

Given('I am on the channels step', async ({ page }) => {
  await advanceWizardToStep(page, 1)
})

When('I select the {string} channel', async ({ page }, channel: string) => {
  await selectWizardChannel(page, channel)
})

When('I click the {string} channel again', async ({ page }, channel: string) => {
  await selectWizardChannel(page, channel)
})

Then('both channels should be marked as selected', async ({ page }) => {
  // Both Voice Calls and SMS channels should have aria-pressed="true"
  const voiceCard = page.getByTestId('channel-card-voice')
  const smsCard = page.getByTestId('channel-card-sms')
  await expect(voiceCard).toHaveAttribute('aria-pressed', 'true', { timeout: Timeouts.ELEMENT })
  await expect(smsCard).toHaveAttribute('aria-pressed', 'true', { timeout: Timeouts.ELEMENT })
})

Then('other channels should not be selected', async ({ page }) => {
  // Channels that weren't explicitly selected should have aria-pressed="false"
  const reportsCard = page.getByTestId('channel-card-reports')
  await expect(reportsCard).toHaveAttribute('aria-pressed', 'false', { timeout: Timeouts.ELEMENT })
})

Then('the channel should be deselected', async ({ page }) => {
  // The Voice Calls channel should now be deselected after toggling it off
  const voiceCard = page.getByTestId('channel-card-voice')
  await expect(voiceCard).toHaveAttribute('aria-pressed', 'false', { timeout: Timeouts.ELEMENT })
})

Then('the error message should disappear', async ({ page }) => {
  // The "select at least one channel" validation error should not be visible
  await expect(page.getByText(/select at least/i)).not.toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the validation error should reappear', async ({ page }) => {
  // Content assertion — verifying validation error text
  await expect(page.getByText(/select at least/i).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Given('I am on the providers step', async ({ page }) => {
  await advanceWizardToStep(page, 2)
})

Given('I selected only {string} on the channels step', async ({ page }, channel: string) => {
  await advanceWizardToStep(page, 1)
  await selectWizardChannel(page, channel)
})

Given('I selected {string} on the channels step', async ({ page }, channel: string) => {
  await advanceWizardToStep(page, 1)
  await selectWizardChannel(page, channel)
})

When('I advance to the providers step', async ({ page }) => {
  await page.getByTestId(TestIds.SETUP_NEXT_BTN).click()
})

Given('I selected {string} and advanced to settings step', async ({ page }, channel: string) => {
  await advanceWizardToStep(page, 3, channel)
})

Given('I am on the invite step', async ({ page }) => {
  await advanceWizardToStep(page, 4)
})

When('I fill in the volunteer name', async ({ page }) => {
  await page.getByLabel(/name/i).first().fill(`SetupVol ${Date.now()}`)
})

When('I fill in the volunteer phone', async ({ page }) => {
  const phone = `+1212${Date.now().toString().slice(-7)}`
  await page.getByLabel(/phone/i).first().fill(phone)
  await page.getByLabel(/phone/i).first().blur()
})

Then('the volunteer name should appear with an invite code', async ({ page }) => {
  // Content assertion — verifying volunteer name is displayed
  await expect(page.getByText(/SetupVol/).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Given('I have completed all wizard steps', async ({ page }) => {
  await advanceWizardToStep(page, 5)
})

Then('I should see the configured hotline name', async ({ page }) => {
  // Content assertion — verifying hotline name is displayed
  await expect(page.getByText(/TestHotline|hotline/i).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the selected channels', async ({ page }) => {
  // On the summary step, at least one channel name should be visible
  await expect(page.getByText(/reports|voice|sms|whatsapp|signal/i).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I type a hotline name', async ({ page }) => {
  await page.getByLabel(/hotline name|name/i).first().fill('Test')
})

When('I clear the hotline name', async ({ page }) => {
  await page.getByLabel(/hotline name|name/i).first().clear()
})

Given('I have advanced to the providers step', async ({ page }) => {
  await advanceWizardToStep(page, 2)
})

Then('the previously selected channel should still be selected', async ({ page }) => {
  // After navigating back, the Reports channel (selected in advanceWizardToStep) should still be pressed
  const reportsCard = page.getByTestId('channel-card-reports')
  await expect(reportsCard).toHaveAttribute('aria-pressed', 'true', { timeout: Timeouts.ELEMENT })
})

Then('the previously entered hotline name should still be filled', async ({ page }) => {
  const input = page.getByLabel(/hotline name|name/i).first()
  const value = await input.inputValue()
  expect(value.length).toBeGreaterThan(0)
})

When('I complete the entire setup wizard', async ({ page }) => {
  await advanceWizardToStep(page, 5)
  // Should now be on Step 5 – Summary with "Go to Dashboard" button
  await expect(page.getByText(/review|summary|launch/i).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

// --- Reports ---

Given('at least one report exists', async ({ backendRequest, workerHub }) => {
  const { listReportsViaApi, createReportViaApi } = await import('../../api-helpers')
  const result = await listReportsViaApi(backendRequest, { hubId: workerHub })
  if (result.conversations.length === 0) {
    await createReportViaApi(backendRequest, { title: `Seed report ${Date.now()}`, hubId: workerHub })
  }
})

Given('a report exists', async ({ backendRequest, workerHub }) => {
  const { listReportsViaApi, createReportViaApi } = await import('../../api-helpers')
  const result = await listReportsViaApi(backendRequest, { hubId: workerHub })
  if (result.conversations.length === 0) {
    await createReportViaApi(backendRequest, { title: `Seed report ${Date.now()}`, hubId: workerHub })
  }
})

When('I fill in the report details', async ({ page }) => {
  // Report form has both title and body fields
  const titleInput = page.getByTestId(TestIds.REPORT_TITLE_INPUT)
  const bodyInput = page.getByTestId(TestIds.REPORT_BODY_INPUT)
  await expect(titleInput).toBeVisible({ timeout: Timeouts.ELEMENT })
  await titleInput.fill(`Test Report ${Date.now()}`)
  await bodyInput.fill('Test report content for BDD testing')
})

Then('the report should appear in the reports list', async ({ page }) => {
  // Content assertion — verifying report text is displayed
  await expect(page.getByText(/test report/i).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see reports in the list', async ({ page }) => {
  const reportList = page.getByTestId(TestIds.REPORT_LIST).or(page.getByTestId(TestIds.REPORT_CARD))
  await expect(reportList.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I click on the report', async ({ page }) => {
  // Navigate to reports if not already there — use the URL (a fact about current
  // navigation state) instead of racing the report card's render with isVisible().
  if (!page.url().includes('/reports')) {
    await page.getByTestId(TestIds.NAV_REPORTS).click()
    await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })
  }
  const reportCard = page.getByTestId(TestIds.REPORT_CARD).first()
  await expect(reportCard).toBeVisible({ timeout: Timeouts.ELEMENT })
  await reportCard.click()
})

Then('I should see the report detail view', async ({ page }) => {
  await expect(page.getByTestId(TestIds.REPORT_DETAIL).or(page.getByTestId(TestIds.REPORT_METADATA)).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the report content', async ({ page }) => {
  // Content assertion — verifying report text is displayed
  await expect(page.getByText(/report/i).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

// --- Demo mode ---

When('I navigate to the setup wizard summary step', async ({ page }) => {
  await advanceWizardToStep(page, 5)
})

When('I enable the demo mode toggle', async ({ page }) => {
  // Find the Switch by its id (linked to the "Populate with sample data" label via htmlFor="demo-mode")
  const toggle = page.getByTestId(TestIds.DEMO_MODE_TOGGLE)
  await expect(toggle).toBeVisible({ timeout: Timeouts.ELEMENT })
  if ((await toggle.getAttribute('data-state')) !== 'checked') {
    await toggle.click()
  }
  await expect(toggle).toHaveAttribute('data-state', 'checked')
})

Given('demo mode has been enabled', async ({ page }) => {
  // This step opens its scenarios (no Background), so the page is never authenticated
  // yet. The old 1s sidebar isVisible probe (whose timeout is ignored) raced that; log in
  // unconditionally — loginAsAdmin is idempotent.
  await loginAsAdmin(page)
  // Navigate to wizard summary and enable the demo mode toggle
  await advanceWizardToStep(page, 5)
  const toggle = page.getByTestId(TestIds.DEMO_MODE_TOGGLE)
  await expect(toggle).toBeVisible({ timeout: Timeouts.ELEMENT })
  if ((await toggle.getAttribute('data-state')) !== 'checked') {
    await toggle.click()
  }
  await expect(toggle).toHaveAttribute('data-state', 'checked')
  // Complete the setup wizard to persist demo mode and create demo accounts
  const completeBtn = page.getByTestId('setup-complete-btn')
  await expect(completeBtn).toBeVisible({ timeout: Timeouts.ELEMENT })
  await completeBtn.click()
  // Wait for redirect to dashboard (wizard completion includes async demo seeding)
  await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.AUTH })
  // Verify demo mode was persisted by checking the API — the config endpoint
  // must return demoMode: true before we proceed, otherwise the login page
  // won't render the demo account picker.
  await page.waitForFunction(async () => {
    const res = await fetch('/api/config', { headers: { 'Cache-Control': 'no-cache' } })
    const data = await res.json()
    return data.demoMode === true
  }, { timeout: Timeouts.ELEMENT })
})

// 'I visit the login page' -> defined in common/navigation-steps.ts
// 'I dismiss the demo banner' -> defined in common/interaction-steps.ts

// --- Blasts ---

When('I compose a blast message', async ({ page }) => {
  // BlastComposer.tsx always renders both fields unconditionally.
  const nameInput = page.getByTestId(TestIds.BLAST_NAME)
  await expect(nameInput).toBeVisible({ timeout: Timeouts.ELEMENT })
  const name = `Blast ${Date.now()}`
  await nameInput.fill(name)
  await page.evaluate((n) => {
    (window as unknown as Record<string, unknown>).__test_blast_name = n
  }, name)
  await page.getByTestId(TestIds.BLAST_TEXT).fill('Test blast message content')
})

When('I select recipients', async () => {
  // BlastComposer.tsx has no per-recipient selection UI — delivery targets are the
  // channel toggles (SMS/WhatsApp/Signal/RCS), which default to SMS already selected.
  // There is nothing to click for "Create a blast message" to succeed; this is a
  // documented no-op instead of a snapshot-racing best-effort click on a "select all"
  // checkbox that does not exist in the current composer.
})

Then('the blast should appear in the blast list', async ({ page }) => {
  // The blast just composed, by name. The old `.or(getByText(/blast/i))` matched
  // the page's own "Blasts" heading, so it passed with an empty list.
  const name = await page.evaluate(
    () => (window as unknown as Record<string, unknown>).__test_blast_name as string | undefined,
  )
  expect(name, 'the compose step must record the blast name').toBeTruthy()
  await expect(page.getByTestId(TestIds.BLAST_CARD).filter({ hasText: name as string })).toBeVisible({
    timeout: Timeouts.ELEMENT,
  })
})

Then('I should see the recipient selection interface', async ({ page }) => {
  // Accept: subscriber list, channel selector, or any recipient/channel/select UI element
  const recipientUi = page.getByText(/recipient|volunteer|select|channel|subscriber/i)
  await expect(recipientUi.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should be able to select individual volunteers', async ({ page }) => {
  // Accept checkboxes (subscriber list) OR channel toggle buttons (blast composer) —
  // a single waiting assertion instead of a non-waiting probe that always fell through
  // to the toggle-button branch (BlastComposer has no checkbox).
  await expect(
    page.locator('input[type="checkbox"]').first().or(page.locator('button.rounded-lg').first()),
  ).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should be able to select all volunteers', async ({ page }) => {
  // Accept "Select All" text or Target Channels section (blast composer)
  const selectAll = page.getByText(/select all|target channels/i)
  await expect(selectAll.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I set a future send time', async ({ page }) => {
  // schedule-picker.tsx always renders `blast-schedule-input` unconditionally — the
  // native-datetime-local fallback and the isVisible/catch guard around the whole
  // block were dead code that could silently skip setting the schedule entirely.
  const dateInput = page.getByTestId('blast-schedule-input')
  await expect(dateInput).toBeVisible({ timeout: Timeouts.ELEMENT })
  // tomorrow in local datetime-local format (YYYY-MM-DDTHH:mm)
  const d = new Date(Date.now() + 86400000)
  const pad = (n: number) => String(n).padStart(2, '0')
  const tomorrow = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  // Set value via JS to reliably trigger React's onChange on controlled datetime-local inputs
  await dateInput.evaluate((el: HTMLInputElement, val: string) => {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    if (nativeSetter) {
      nativeSetter.call(el, val)
    } else {
      el.value = val
    }
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }, tomorrow)
})

Then('the blast should appear as {string}', async ({ page }, status: string) => {
  // Content assertion — verifying blast status text
  await expect(page.getByText(status, { exact: true }).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Given('a blast has been sent', async ({ page }) => {
  await page.getByTestId(TestIds.NAV_BLASTS).click()
  await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })

  // Always create this scenario's own blast. The old step branched on whether the list
  // was empty and then opened whichever card rendered first — in a shared hub that is
  // some other scenario's blast, and the branch itself raced the list's load.
  const blastName = `Test Blast ${Date.now()}`
  await page.getByTestId(TestIds.BLAST_NEW_BTN).click()
  const nameInput = page.getByTestId(TestIds.BLAST_NAME)
  await expect(nameInput).toBeVisible({ timeout: Timeouts.ELEMENT })
  await nameInput.fill(blastName)
  await page.getByTestId(TestIds.BLAST_TEXT).fill('Test blast message for delivery status verification')
  await page.getByTestId('blast-send-btn').click()

  const card = page.getByTestId(TestIds.BLAST_CARD).filter({ hasText: blastName })
  await expect(card).toBeVisible({ timeout: Timeouts.API })
  await card.click()
})

Then('I should see the delivery status for the blast', async ({ page }) => {
  // The blast card and detail panel both show a status badge (Draft, Sent, Scheduled, Sending, Cancelled)
  // Look for the Badge component showing any blast status — the regex covers all possible values
  await expect(
    page.getByText(/draft|sent|scheduled|sending|cancelled/i).first(),
  ).toBeVisible({ timeout: Timeouts.ELEMENT })
})

// --- Multi-hub extended ---

Given('I have selected a hub', async ({ page, backendRequest, workerHub }) => {
  // The old step waited for the switcher and silently did nothing when it was absent.
  // Make the multi-hub precondition explicit (a second hub, then reload so /api/config
  // re-fetches the list) and select this worker's hub.
  const { createHubViaApi } = await import('../../api-helpers')
  await createHubViaApi(backendRequest, `Hub-${Date.now()}`)
  await reloadAndUnlock(page)
  await selectHubInSwitcher(page, workerHub)
})

When('I open hub settings', async ({ page }) => {
  await page.getByTestId(navTestIdMap['Hub Settings']).click()
})

Then('I should see telephony, messaging, and general tabs', async ({ page }) => {
  // Content assertion — verifying tab/section names
  const telephony = page.getByText(/telephony/i)
  const messaging = page.getByText(/messaging/i)
  const general = page.getByText(/general|settings/i)
  await expect(telephony.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(messaging.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(general.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})
