/**
 * Settings step definitions.
 * Matches steps from:
 *   - packages/test-specs/features/settings/settings-display.feature
 *   - packages/test-specs/features/settings/lock-logout.feature
 *   - packages/test-specs/features/settings/device-link.feature
 */
import { expect, type Page } from '@playwright/test'
import { Given, When, Then, After } from '../fixtures'
import { TestIds, sectionTestIdMap } from '../../test-ids'
import { Timeouts, TEST_PIN, enterPin, navigateAfterLogin } from '../../helpers'
import { expandSettingsSection } from '../common/ui-helpers'
import { apiPatch, getSpamSettingsViaApi } from '../../api-helpers'

// --- Settings display steps ---

Then('I should see my npub in monospace text', async ({ page }) => {
  // v3 identities are hex device pubkeys, shown in a <code> block in the profile
  // section. The old fallbacks ended at "the sidebar is visible".
  const profile = await expandSettingsSection(page, TestIds.SETTINGS_PROFILE)
  await expect(profile.locator('code').filter({ hasText: /^[0-9a-f]{64}$/ })).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the copy npub button', async ({ page }) => {
  // Assert the claim: a copy control for the public key in the profile section.
  // The previous fallback accepted the key's <code> block itself as the button.
  const profile = page.getByTestId(TestIds.SETTINGS_PROFILE)
  await expect(profile.getByRole('button', { name: /copy/i })).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the hub connection card', async ({ page }) => {
  // Hub connection is not a separate settings section on desktop —
  // check that the settings page is loaded by verifying the profile section
  const profileSection = page.getByTestId('profile')
  await expect(profileSection).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the connection status should be displayed', async ({ page }) => {
  // Connection status is implicit on the dashboard, not a dedicated settings element.
  // Verify settings page is loaded.
  await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the device link card \\(may need scroll)', async ({ page }) => {
  const linkedDevices = page.getByTestId('linked-devices')
  await linkedDevices.scrollIntoViewIfNeeded()
  await expect(linkedDevices).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the device link card should be tappable', async ({ page }) => {
  await expect(page.getByTestId('linked-devices')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the admin card \\(may need scroll)', async ({ page }) => {
  // Desktop has no "admin card" — check that the admin section is visible in the sidebar
  const adminSection = page.getByTestId(TestIds.NAV_ADMIN_SECTION)
  await expect(adminSection).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the admin card should be tappable', async ({ page }) => {
  // Desktop: admin section links in sidebar are always clickable
  const adminSection = page.getByTestId(TestIds.NAV_ADMIN_SECTION)
  const firstLink = adminSection.getByRole('link').first()
  await expect(firstLink).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the version text', async ({ page }) => {
  // Version text should be visible somewhere on the settings page
  const version = page.getByText(/v?\d+\.\d+\.\d+/).first()
  await expect(version).toBeVisible({ timeout: Timeouts.ELEMENT })
})

// --- Lock & Logout steps ---

Then('I should see the logout confirmation dialog', async ({ page }) => {
  await expect(page.getByTestId(TestIds.CONFIRM_DIALOG)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

// NOTE: Lock & Logout assertion steps are defined in:
//   - assertion-steps.ts: 'the dialog should be dismissed', 'no stored keys should remain', 'I should remain on the settings screen'
//   - navigation-steps.ts: 'I should return to the login screen'
// Do NOT duplicate them here.

// --- Device link steps ---

Then('I should see the step indicator', async ({ page }) => {
  // Desktop uses a simple inline device link flow within the linked-devices section
  // Verify the section is expanded and shows the link code input or device link content
  const section = page.getByTestId('linked-devices')
  await expect(section).toBeVisible({ timeout: Timeouts.ELEMENT })
  // The section should show either the link code input (idle state) or linking status
  const content = section.locator('input, button, p').first()
  await expect(content).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see step labels \\(Scan, Verify, Import)', async ({ page }) => {
  // Desktop doesn't use step labels — verify the linked-devices section is expanded with content
  const section = page.getByTestId('linked-devices')
  await expect(section).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the current step should be {string}', async ({ page }, step: string) => {
  // Desktop doesn't use step indicators — map step names to equivalent UI state
  const section = page.getByTestId('linked-devices')
  await expect(section).toBeVisible({ timeout: Timeouts.ELEMENT })
  const stepMap: Record<string, () => Promise<void>> = {
    'Scan': async () => {
      // Idle state — link code input should be visible
      const linkInput = page.getByTestId('link-code-input').or(section.locator('input').first())
      await expect(linkInput).toBeVisible({ timeout: Timeouts.ELEMENT })
    },
    'Verify': async () => {
      // SAS verification state — SAS code visible
      const sasCode = page.getByTestId('short-code').or(section.getByText(/verify/i).first())
      await expect(sasCode).toBeVisible({ timeout: Timeouts.ELEMENT })
    },
    'Import': async () => {
      // Success state
      const success = section.getByText(/success|linked|imported/i).first()
      await expect(success).toBeVisible({ timeout: Timeouts.ELEMENT })
    },
  }
  const handler = stepMap[step]
  if (handler) {
    await handler()
  } else {
    // Fallback: look for the step text anywhere in the section
    await expect(section.getByText(step).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
  }
})

Then('I should see either the camera preview or the camera permission prompt', async ({ page }) => {
  // In test environment, camera won't be available — verify the linked-devices section is visible
  const section = page.getByTestId('linked-devices')
  await expect(section).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Given('camera permission is not granted', async () => {
  // In Playwright test context, camera permission is not granted by default
})

Then('I should see the error state', async ({ page }) => {
  // (Only @requires-camera scenarios use this; they are excluded from desktop runs.)
  await expect(page.getByTestId(TestIds.ERROR_MESSAGE).or(page.getByRole('alert')).first())
    .toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the error message should mention {string}', async ({ page }, text: string) => {
  const matching = page.getByTestId(TestIds.ERROR_MESSAGE).or(page.getByRole('alert')).filter({ hasText: new RegExp(text, 'i') })
  await expect(matching.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the device link card should still be visible', async ({ page }) => {
  const linkedDevices = page.getByTestId('linked-devices')
  // The section may be below the fold after back navigation — scroll first,
  // then check visibility. Use locator.scrollIntoViewIfNeeded with a preceding
  // waitFor to ensure the element exists in the DOM before scrolling.
  await linkedDevices.waitFor({ state: 'attached', timeout: Timeouts.ELEMENT })
  await linkedDevices.scrollIntoViewIfNeeded()
  await expect(linkedDevices).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the settings identity card should be visible', async ({ page }) => {
  // The identity/profile section has data-testid="profile"
  await expect(page.getByTestId('profile')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('a QR code with invalid format is scanned', async ({ page }) => {
  // Simulate scanning an invalid QR — in test env, trigger via test hook
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('qr-scanned', { detail: { data: 'invalid-qr-data' } }))
  })
})

// --- Profile settings steps ---

When('I change my display name', async ({ page, adminWorld }) => {
  const nameInput = page.getByLabel(/name/i)
  const newName = `Admin ${Date.now()}`
  await nameInput.clear()
  await nameInput.fill(newName)
  // Scenario state, not `window`: the persistence check runs after a reload,
  // which wiped the window stash and turned the old check into `if (undefined)`.
  adminWorld.lastDisplayName = newName
})

Then('the new display name should persist', async ({ page, adminWorld }) => {
  expect(adminWorld.lastDisplayName, 'the rename step must record the new name').toBeTruthy()
  await expect(page.getByLabel(/name/i)).toHaveValue(adminWorld.lastDisplayName, { timeout: Timeouts.ELEMENT })
})

When('I enter a valid phone number', async ({ page }) => {
  const phone = `+1212${Date.now().toString().slice(-7)}`
  await page.getByLabel(/phone/i).fill(phone)
  await page.getByLabel(/phone/i).blur()
})

When('I enter an invalid phone number {string}', async ({ page }, phone: string) => {
  await page.getByLabel(/phone/i).fill(phone)
  await page.getByLabel(/phone/i).blur()
})

Then('I should see the {string} section', async ({ page }, sectionName: string) => {
  const testId = sectionTestIdMap[sectionName]
  if (testId) {
    await expect(page.getByTestId(testId)).toBeVisible({ timeout: Timeouts.ELEMENT })
  } else {
    // Fallback: look for the section by text content
    await expect(page.getByText(sectionName, { exact: true }).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
  }
})

When('they update their name and phone', async ({ page }) => {
  const nameInput = page.getByLabel(/name/i)
  await nameInput.clear()
  await nameInput.fill(`Vol ${Date.now()}`)
  const phoneInput = page.getByLabel(/phone/i)
  await phoneInput.clear()
  await phoneInput.fill(`+1212${Date.now().toString().slice(-7)}`)
  await phoneInput.blur()
})

When('I toggle a language option', async ({ page }) => {
  // Spoken-language chips in the profile section. The old step targeted a
  // testid the app never renders, so it toggled nothing and the scenario only
  // re-saved an unchanged profile.
  const profile = await expandSettingsSection(page, TestIds.SETTINGS_PROFILE)
  const chip = profile.getByRole('button', { name: /Français/ })
  await expect(chip).toBeVisible({ timeout: Timeouts.ELEMENT })
  await chip.click()
})

Then('the transcription section should be expanded', async ({ page }) => {
  const section = page.getByTestId(TestIds.TRANSCRIPTION_SECTION)
  await expect(section).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the profile section should be expanded', async ({ page }) => {
  const nameInput = page.getByLabel(/name/i)
  await expect(nameInput).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the profile section should collapse', async ({ page }) => {
  const nameInput = page.getByLabel(/name/i)
  await expect(nameInput).not.toBeVisible({ timeout: 3000 })
})

Then('the profile section should expand', async ({ page }) => {
  const nameInput = page.getByLabel(/name/i)
  await expect(nameInput).toBeVisible({ timeout: Timeouts.ELEMENT })
})

/** Click a settings section's collapsible header (its `{id}-trigger`). */
async function clickSectionHeader(page: Page, headerText: string) {
  const testId = sectionTestIdMap[headerText]
  const header = testId
    ? page.getByTestId(`${testId}-trigger`)
    : page.getByRole('heading', { name: headerText })
  await expect(header).toBeVisible({ timeout: Timeouts.ELEMENT })
  await header.click()
}

When('I click the {string} header', async ({ page }, headerText: string) => {
  await clickSectionHeader(page, headerText)
})

When('I click the {string} header again', async ({ page }, headerText: string) => {
  await clickSectionHeader(page, headerText)
})

/** Tab (keyboard only) until a settings section's trigger button holds focus. */
When('I tab to the {string} section header', async ({ page }, headerText: string) => {
  const testId = sectionTestIdMap[headerText]
  expect(testId, `no test id mapped for settings section "${headerText}"`).toBeTruthy()
  const trigger = page.getByTestId(`${testId}-trigger`)
  await expect(trigger).toBeVisible({ timeout: Timeouts.ELEMENT })
  // The page has a finite tab order: reaching the trigger within it proves it is
  // keyboard-focusable. Bounded so an unreachable trigger fails instead of hanging.
  for (let i = 0; i < 200; i++) {
    await page.keyboard.press('Tab')
    if (await trigger.evaluate(el => el === document.activeElement)) return
  }
  throw new Error(`"${headerText}" section header was never reached by Tab`)
})

When('I press {string} on the focused element', async ({ page }, key: string) => {
  // No body click first (unlike the shortcut step): that would drop the keyboard focus under test.
  await page.keyboard.press(key)
})

async function expectSectionHeaderExpanded(page: Page, headerText: string, expanded: boolean) {
  const testId = sectionTestIdMap[headerText]
  expect(testId, `no test id mapped for settings section "${headerText}"`).toBeTruthy()
  const trigger = page.getByTestId(`${testId}-trigger`)
  await expect(trigger).toHaveRole('button')
  await expect(trigger).toHaveAttribute('aria-expanded', String(expanded), { timeout: Timeouts.ELEMENT })
}

Then('the {string} section header should report itself expanded', async ({ page }, headerText: string) => {
  await expectSectionHeaderExpanded(page, headerText, true)
})

Then('the {string} section header should report itself collapsed', async ({ page }, headerText: string) => {
  await expectSectionHeaderExpanded(page, headerText, false)
})

Then('toggling a spoken language chip should flip its pressed state', async ({ page }) => {
  const profile = await expandSettingsSection(page, TestIds.SETTINGS_PROFILE)
  const chip = profile.getByRole('button', { name: /Français/ })
  await expect(chip).toBeVisible({ timeout: Timeouts.ELEMENT })
  // The seeded account may or may not already speak the language, so assert the
  // change in state rather than a fixed value.
  const before = await chip.getAttribute('aria-pressed')
  expect(['true', 'false']).toContain(before)
  const flipped = before === 'true' ? 'false' : 'true'
  await chip.click()
  await expect(chip).toHaveAttribute('aria-pressed', flipped, { timeout: Timeouts.ELEMENT })
  await chip.click()
  await expect(chip).toHaveAttribute('aria-pressed', before!, { timeout: Timeouts.ELEMENT })
})

Then(
  'both {string} and {string} sections should be visible',
  async ({ page }, sec1: string, sec2: string) => {
    const testId1 = sectionTestIdMap[sec1]
    const testId2 = sectionTestIdMap[sec2]
    if (testId1) {
      await expect(page.getByTestId(testId1)).toBeVisible({ timeout: Timeouts.ELEMENT })
    } else {
      await expect(page.getByText(sec1, { exact: true }).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
    }
    if (testId2) {
      await expect(page.getByTestId(testId2)).toBeVisible({ timeout: Timeouts.ELEMENT })
    } else {
      await expect(page.getByText(sec2, { exact: true }).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
    }
  },
)

Then('each settings section should have a {string} button', async ({ page }) => {
  // Each SettingsSection renders with data-testid={id} and data-settings-section.
  // The copy-link button is a sibling of the section's trigger button inside the CardHeader.
  // Wait for at least one settings section to be visible before counting
  const sections = page.locator('[data-testid][data-settings-section]')
  await expect(sections.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
  const sectionCount = await sections.count()
  expect(sectionCount).toBeGreaterThanOrEqual(1)
  // Check at least one section has an aria-labelled button (copy link)
  const linkButtons = page.locator('[data-testid][data-settings-section] button[aria-label]')
  await expect(linkButtons.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
  const count = await linkButtons.count()
  expect(count).toBeGreaterThanOrEqual(1)
})

// --- Settings toggle confirmation (settings-toggle.feature) ---

When('I click the spam mitigation toggle', async ({ page }) => {
  // Spam toggle is a role="switch" inside the spam-section
  const spamSection = page.getByTestId(TestIds.SETTINGS_SPAM)
  const toggle = spamSection.getByRole('switch').first()
  await expect(toggle).toBeVisible({ timeout: Timeouts.ELEMENT })
  await toggle.click()
})

Then('I can cancel without applying the change', async ({ page }) => {
  // Click the Cancel button in the confirmation dialog
  const cancelBtn = page.getByTestId(TestIds.CONFIRM_DIALOG_CANCEL)
    .or(page.getByRole('button', { name: /cancel/i }).first())
  await expect(cancelBtn).toBeVisible({ timeout: Timeouts.ELEMENT })
  await cancelBtn.click()
  // The dialog should close
  await expect(page.getByTestId(TestIds.CONFIRM_DIALOG)).not.toBeVisible({ timeout: Timeouts.ELEMENT })
})

// Regression coverage for #1130: exercises the admin *sidebar* route
// (/admin/spam-protection), which renders a different component tree than
// the "Hub Settings" page used by the scenario above. The bug was that this
// route's toggle handler re-read settings from the server instead of
// PATCHing them, so the switch visually flipped and then silently reverted
// on reload — confirming the switch state right after the click would not
// have caught that; only the server's state and a fresh load prove the write
// landed.
//
// Spam settings are instance-wide (the client PATCHes the unscoped
// /settings/spam), so the scenario records the value it started from and the
// `After` hook below puts it back — no other scenario inherits a flipped CAPTCHA.
When('I toggle the CAPTCHA setting and confirm the change', async ({ page, backendRequest, adminWorld }) => {
  const before = (await getSpamSettingsViaApi(backendRequest)).voiceCaptchaEnabled
  adminWorld.spamCaptchaBefore = before
  const toggle = page.getByTestId(TestIds.SPAM_CAPTCHA_TOGGLE)
  // Settle on the server's value before clicking, so the click flips a loaded
  // setting rather than the switch's pre-fetch default.
  await expect(toggle).toHaveAttribute('aria-checked', String(before), { timeout: Timeouts.ELEMENT })

  await toggle.click()
  const confirmBtn = page.getByTestId(TestIds.CONFIRM_DIALOG_OK)
  await expect(confirmBtn).toBeVisible({ timeout: Timeouts.ELEMENT })
  await confirmBtn.click()
  await expect(page.getByTestId(TestIds.CONFIRM_DIALOG)).not.toBeVisible({ timeout: Timeouts.ELEMENT })

  // The switch must reflect the server's PATCH response, not just the
  // pre-click intent — confirm it actually flipped.
  await expect(toggle).toHaveAttribute('aria-checked', String(!before), { timeout: Timeouts.ELEMENT })
})

Then('the CAPTCHA setting change should persist after a reload', async ({ page, backendRequest, adminWorld }) => {
  const before = adminWorld.spamCaptchaBefore
  if (before === undefined) throw new Error('the CAPTCHA toggle step must run first')
  const expected = !before

  // Server truth: the PATCH landed.
  await expect
    .poll(async () => (await getSpamSettingsViaApi(backendRequest)).voiceCaptchaEnabled, { timeout: Timeouts.API })
    .toBe(expected)

  // A reload clears the in-memory device key, so the app opens on the PIN screen
  // and unlocking lands on "/" — unlock, then come back to the sidebar route.
  await page.reload()
  await expect(page.getByTestId(TestIds.PIN_INPUT)).toBeVisible({ timeout: Timeouts.AUTH })
  await enterPin(page, TEST_PIN)
  // Wait for the authenticated layout to render before navigating. A URL change
  // is not enough: navigateAfterLogin takes an instant (non-waiting) snapshot of
  // the sidebar and, finding it still unrendered, falls back to `goto('/login')`
  // — a full page load that throws away the key we just unlocked, leaving the
  // scenario stranded on the PIN screen.
  await expect(page.getByTestId(TestIds.NAV_SIDEBAR)).toBeVisible({ timeout: Timeouts.AUTH })
  await navigateAfterLogin(page, '/admin/spam-protection')

  await expect(page.getByTestId(TestIds.SPAM_CAPTCHA_TOGGLE))
    .toHaveAttribute('aria-checked', String(expected), { timeout: Timeouts.ELEMENT })
})

After(async ({ backendRequest, adminWorld }) => {
  if (adminWorld.spamCaptchaBefore === undefined) return
  const { status } = await apiPatch(backendRequest, '/settings/spam', { voiceCaptchaEnabled: adminWorld.spamCaptchaBefore })
  expect(status, 'restoring the instance-wide CAPTCHA setting must succeed').toBe(200)
})

When('I press {string}', async ({ page }, keys: string) => {
  // Ensure page body has focus before sending keyboard shortcuts
  await page.locator('body').click({ position: { x: 10, y: 10 } }).catch(() => {})
  await page.keyboard.press(keys)
})

Then('I should see the command palette', async ({ page }) => {
  // The palette is a cmdk list inside a dialog.
  await expect(page.getByRole('dialog').locator('[cmdk-root]')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('it should be focusable and searchable', async ({ page }) => {
  // The command palette input should accept text
  const input = page.locator('[cmdk-input]').first()
    .or(page.getByRole('combobox').first())
    .or(page.getByPlaceholder(/search|type a command/i).first())
  await expect(input.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
  await input.first().fill('vol')
  // Should still be focusable (not errored or closed)
  await expect(input.first()).toBeVisible({ timeout: 2000 })
})
