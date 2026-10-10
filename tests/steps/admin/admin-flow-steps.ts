/**
 * Admin flow step definitions.
 * Matches steps from: packages/test-specs/features/desktop/admin/admin-flow.feature
 * Covers admin navigation, volunteer CRUD, shift CRUD, ban management,
 * call history, settings, and language switching.
 *
 * Behavioral depth: All CRUD operations verify state changes via API.
 */
import { expect } from '@playwright/test'
import { When, Then } from '../fixtures'
import { TestIds, uniquePhone, Timeouts } from '../../helpers'
import {
  listVolunteersViaApi,
  listShiftsViaApi,
  listBansViaApi,
} from '../../api-helpers'

// --- Volunteer CRUD ---

When('I add a new volunteer with a unique name and phone', async ({ page, adminWorld }) => {
  const phone = uniquePhone()
  adminWorld.lastUserName = `Vol ${Date.now()}`
  adminWorld.lastPhone = phone
  await page.getByTestId(TestIds.VOLUNTEER_ADD_BTN).click()
  await page.getByLabel('Name').fill(adminWorld.lastUserName)
  await page.getByLabel('Phone Number').fill(phone)
  await page.getByLabel('Phone Number').blur()
  await page.getByTestId(TestIds.FORM_SAVE_BTN).click()
})

Then('I should see the generated device key', async ({ page }) => {
  const deviceKeyCode = page.getByTestId(TestIds.VOLUNTEER_DEVICE_KEY_CODE)
  await expect(deviceKeyCode).toBeVisible({ timeout: 15000 })
  // Verify the key looks valid: either bech32 nsec1 or hex seed (v3 API)
  const deviceKeyText = await deviceKeyCode.textContent()
  expect(deviceKeyText).toBeTruthy()
  const isNsec = deviceKeyText!.startsWith('nsec1')
  const isHexSeed = /^[0-9a-f]{64}$/i.test(deviceKeyText!.trim())
  expect(isNsec || isHexSeed).toBe(true)
})

When('I close the device key card', async ({ page }) => {
  await page.getByTestId(TestIds.DISMISS_DEVICE_KEY).click()
  await expect(page.getByTestId(TestIds.DISMISS_DEVICE_KEY)).not.toBeVisible({ timeout: 5000 })
})

Then('the volunteer should appear in the list', async ({ page, backendRequest, adminWorld }) => {
  // UI verification
  const row = page.getByTestId(TestIds.VOLUNTEER_ROW).filter({ hasText: adminWorld.lastUserName })
  await expect(row.first()).toBeVisible({ timeout: Timeouts.ELEMENT })

  // API verification: volunteer exists in backend.
  // listVolunteersViaApi takes no hub parameter (never has), so this checks the /users list by name.
  const volunteers = await listVolunteersViaApi(backendRequest)
  const found = volunteers.find(v => v.name === adminWorld.lastUserName)
  expect(found).toBeTruthy()
  adminWorld.lastUserPubkey = found!.pubkey
})

When('I delete the volunteer', async ({ page, adminWorld }) => {
  const volRow = page.getByTestId(TestIds.VOLUNTEER_ROW).filter({ hasText: adminWorld.lastUserName })
  await volRow.getByTestId(TestIds.VOLUNTEER_DELETE_BTN).click()
  await page.getByTestId(TestIds.CONFIRM_DIALOG_OK).click()
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 5000 })
})

Then('the volunteer should be removed from the list', async ({ page, backendRequest, adminWorld }) => {
  // UI verification
  const row = page.getByTestId(TestIds.VOLUNTEER_ROW).filter({ hasText: adminWorld.lastUserName })
  await expect(row).not.toBeVisible({ timeout: Timeouts.ELEMENT })

  // API verification: volunteer is gone (listVolunteersViaApi takes no hub parameter)
  const volunteers = await listVolunteersViaApi(backendRequest)
  const found = volunteers.find(v => v.name === adminWorld.lastUserName)
  expect(found).toBeUndefined()
})

// --- Shift CRUD ---

When('I create a new shift with a unique name', async ({ page, backendRequest, workerHub, adminWorld }) => {
  adminWorld.lastShiftName = `Shift ${Date.now()}`
  await page.getByTestId(TestIds.SHIFT_CREATE_BTN).click()
  await page.getByTestId(TestIds.SHIFT_NAME_INPUT).fill(adminWorld.lastShiftName)
  await page.getByTestId(TestIds.FORM_SAVE_BTN).click()

  // Wait for UI confirmation
  const card = page.getByTestId(TestIds.SHIFT_CARD).filter({ hasText: adminWorld.lastShiftName })
  await expect(card.first()).toBeVisible({ timeout: Timeouts.ELEMENT })

  // API verification: shift was created in backend
  const shifts = await listShiftsViaApi(backendRequest, workerHub)
  const found = shifts.find(s => s.encryptedName === adminWorld.lastShiftName)
  expect(found).toBeTruthy()
})

Then('the shift should appear in the list', async ({ page, adminWorld }) => {
  const card = page.getByTestId(TestIds.SHIFT_CARD).filter({ hasText: adminWorld.lastShiftName })
  await expect(card.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I edit the shift with a new name', async ({ page, adminWorld }) => {
  const updatedName = `Updated ${Date.now()}`
  const shiftCard = page.getByTestId(TestIds.SHIFT_CARD).filter({ hasText: adminWorld.lastShiftName })
  await shiftCard.getByTestId(TestIds.SHIFT_EDIT_BTN).click()
  await page.getByTestId(TestIds.SHIFT_NAME_INPUT).clear()
  await page.getByTestId(TestIds.SHIFT_NAME_INPUT).fill(updatedName)
  await page.getByTestId(TestIds.FORM_SAVE_BTN).click()
  adminWorld.lastShiftName = updatedName
})

Then('the updated shift name should appear', async ({ page, backendRequest, workerHub, adminWorld }) => {
  // UI verification
  const card = page.getByTestId(TestIds.SHIFT_CARD).filter({ hasText: adminWorld.lastShiftName })
  await expect(card.first()).toBeVisible({ timeout: Timeouts.ELEMENT })

  // API verification: updated name persisted
  const shifts = await listShiftsViaApi(backendRequest, workerHub)
  const found = shifts.find(s => s.encryptedName === adminWorld.lastShiftName)
  expect(found).toBeTruthy()
})

When('I delete the shift', async ({ page, adminWorld }) => {
  const shiftCard = page.getByTestId(TestIds.SHIFT_CARD).filter({ hasText: adminWorld.lastShiftName })
  await shiftCard.getByTestId(TestIds.SHIFT_DELETE_BTN).click()
})

Then('the shift should no longer appear', async ({ page, backendRequest, workerHub, adminWorld }) => {
  // UI verification
  const card = page.getByTestId(TestIds.SHIFT_CARD).filter({ hasText: adminWorld.lastShiftName })
  await expect(card).not.toBeVisible({ timeout: Timeouts.ELEMENT })

  // API verification: shift is gone
  const shifts = await listShiftsViaApi(backendRequest, workerHub)
  const found = shifts.find(s => s.encryptedName === adminWorld.lastShiftName)
  expect(found).toBeUndefined()
})

// --- Ban management ---

/** Convert a full E.164 phone to the server's masked format: `***` + last 4 digits */
function maskPhone(phone: string): string {
  return phone.length >= 4 ? `***${phone.slice(-4)}` : '***'
}

When('I ban a unique phone number with reason {string}', async ({ page, adminWorld }, reason: string) => {
  adminWorld.lastPhone = uniquePhone()
  await page.getByTestId(TestIds.BAN_ADD_BTN).click()
  await page.getByLabel('Phone Number').fill(adminWorld.lastPhone)
  await page.getByLabel('Phone Number').blur()
  await page.getByLabel('Reason').fill(reason)
  await page.getByTestId(TestIds.FORM_SAVE_BTN).click()
})

Then('the banned phone number should appear', async ({ page, backendRequest, workerHub, adminWorld }) => {
  const masked = maskPhone(adminWorld.lastPhone)

  // UI verification — phone is displayed in masked format (HIGH-W3)
  const row = page.getByTestId(TestIds.BAN_ROW).filter({ hasText: masked })
  await expect(row.first()).toBeVisible({ timeout: Timeouts.ELEMENT })

  // API verification (phone field is masked)
  const bans = await listBansViaApi(backendRequest, workerHub)
  const found = bans.find(b => b.phone === masked)
  expect(found).toBeTruthy()
})

When('I remove the ban for that phone number', async ({ page, adminWorld }) => {
  const masked = maskPhone(adminWorld.lastPhone)
  const banRow = page.getByTestId(TestIds.BAN_ROW).filter({ hasText: masked })
  await expect(banRow.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
  await banRow.getByTestId(TestIds.BAN_REMOVE_BTN).click()
  await page.getByTestId(TestIds.CONFIRM_DIALOG_OK).click()
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 5000 })
})

Then('the phone number should no longer appear', async ({ page, backendRequest, workerHub, adminWorld }) => {
  const masked = maskPhone(adminWorld.lastPhone)

  // UI verification
  const row = page.getByTestId(TestIds.BAN_ROW).filter({ hasText: masked })
  await expect(row).not.toBeVisible({ timeout: Timeouts.ELEMENT })

  // API verification
  const bans = await listBansViaApi(backendRequest, workerHub)
  const found = bans.find(b => b.phone === masked)
  expect(found).toBeUndefined()
})

// --- Phone validation ---

When('I try to add a volunteer with an invalid phone number', async ({ page }) => {
  await page.getByTestId(TestIds.VOLUNTEER_ADD_BTN).click()
  await page.getByLabel('Name').fill('Bad Phone')
  await page.getByLabel('Phone Number').fill('+12')
  await page.getByLabel('Phone Number').blur()
  await page.getByTestId(TestIds.FORM_SAVE_BTN).click()
})

Then('I should see an invalid phone error', async ({ page }) => {
  await expect(page.getByText(/invalid phone/i)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

// --- Call history ---

When('I search for a phone number in call history', async ({ page }) => {
  await page.getByTestId(TestIds.CALL_SEARCH).fill('+1234567890')
  await page.getByTestId(TestIds.CALL_SEARCH_BTN).click()
})

Then('I should see the clear filters button', async ({ page }) => {
  await expect(page.getByTestId(TestIds.CALL_CLEAR_FILTERS)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I click the clear filters button', async ({ page }) => {
  await page.getByTestId(TestIds.CALL_CLEAR_FILTERS).click()
})

Then('the clear filters button should not be visible', async ({ page }) => {
  await expect(page.getByTestId(TestIds.CALL_CLEAR_FILTERS)).not.toBeVisible({ timeout: 5000 })
})

// --- Settings toggles ---

Then('I should see at least one toggle switch', async ({ page }) => {
  // Hub settings sections are collapsible — expand any collapsed sections to reveal switches.
  // Use count() (DOM presence) rather than isVisible() to determine expansion state:
  // Radix collapsible animates from height:0, so the [data-state="open"] element exists in
  // the DOM immediately but has zero dimensions during animation — isVisible() would falsely
  // return false and trigger a collapse of an already-expanded section.
  const sections = page.locator('[data-testid][data-settings-section]')
  const sectionCount = await sections.count()
  for (let i = 0; i < sectionCount; i++) {
    const section = sections.nth(i)
    const openCount = await section.locator('[data-state="open"]').count()
    const isExpanded = openCount > 0
    if (!isExpanded) {
      // Click the trigger element using data-testid pattern "{id}-trigger"
      const sectionTestId = await section.getAttribute('data-testid')
      if (sectionTestId) {
        await section.getByTestId(`${sectionTestId}-trigger`).click().catch(() => {})
      }
    }
  }
  const switches = page.getByRole('switch')
  await expect(switches.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
  const count = await switches.count()
  expect(count).toBeGreaterThan(0)
})

// --- Language switching ---

When('I switch the language to Espanol', async ({ page }) => {
  await page.getByRole('combobox', { name: /switch to/i }).click()
  await page.getByRole('option', { name: /español/i }).click()
})

When('I switch the language back to English', async ({ page }) => {
  await page.getByRole('combobox', { name: /cambiar a/i }).click()
  await page.getByRole('option', { name: /english/i }).click()
})

// --- Settings summaries ---

Then('the telephony provider card should be visible', async ({ page }) => {
  await expect(page.getByTestId(TestIds.TELEPHONY_PROVIDER)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the transcription card should be visible', async ({ page }) => {
  await expect(page.getByTestId(TestIds.TRANSCRIPTION_SECTION)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('at least one status summary should be visible', async ({ page }) => {
  const statusCount = await page
    .getByText(
      /(Enabled|Disabled|Not configured|Not required|languages|fields|None|CAPTCHA|Default|Customized)/i,
    )
    .count()
  expect(statusCount).toBeGreaterThan(0)
})
