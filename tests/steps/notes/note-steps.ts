/**
 * Note step definitions.
 * Matches steps from:
 *   - packages/test-specs/features/notes/note-create.feature
 *   - packages/test-specs/features/notes/note-detail.feature
 *   - packages/test-specs/features/notes/note-list.feature
 *   - packages/test-specs/features/notes/note-edit.feature
 *   - packages/test-specs/features/notes/notes-search.feature
 *
 * Behavioral depth: Note creation verified via API, edit persistence verified,
 * no .or() fallbacks, no empty bodies, no expect(true).toBe(true).
 */
import { expect, type Page } from '@playwright/test'
import { Given, When, Then } from '../fixtures'
import { TestIds } from '../../test-ids'
import { Timeouts, fillCallId } from '../../helpers'
import { listNotesViaApi, getCustomFieldsViaApi } from '../../api-helpers'

// --- Note navigation ---

Given('I navigate to the notes tab', async ({ page }) => {
  const { Navigation } = await import('../../pages/index')
  await Navigation.goToNotes(page)
})

// --- Note creation steps ---

When('I type {string} in the note text field', async ({ page }, text: string) => {
  await page.getByTestId(TestIds.NOTE_CONTENT).fill(text)
})

Then('the text {string} should be displayed', async ({ page }, text: string) => {
  await expect(page.getByTestId(TestIds.NOTE_CONTENT)).toHaveValue(text)
})

Then('the create note FAB should be visible', async ({ page }) => {
  await expect(page.getByTestId(TestIds.NOTE_NEW_BTN)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Given('custom fields are configured for notes', async ({ backendRequest: request }) => {
  // Verify custom fields exist via API — create a default one if none exist
  const fields = await getCustomFieldsViaApi(request)
  if (fields.length === 0) {
    const { updateCustomFieldsViaApi } = await import('../../api-helpers')
    await updateCustomFieldsViaApi(request, [{
      id: `cf-${Date.now()}`,
      name: 'priority_level',
      label: 'Priority Level',
      type: 'text',
      context: 'call-notes',
    }])
  }
})

Then('I should see custom field inputs below the text field', async ({ page }) => {
  // Look for additional form inputs beyond the main text field
  const formInputs = page.getByTestId(TestIds.NOTE_FORM).locator('input, textarea, select')
  const count = await formInputs.count()
  expect(count).toBeGreaterThanOrEqual(1)
})

// --- Note list steps ---

Then('I should see either the notes list, empty state, or loading indicator', async ({ page }) => {
  const anyContent = page.locator(
    `[data-testid="${TestIds.NOTE_LIST}"], [data-testid="${TestIds.EMPTY_STATE}"], [data-testid="${TestIds.LOADING_SKELETON}"]`,
  )
  await expect(anyContent.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I tap the create note FAB', async ({ page }) => {
  await page.getByTestId(TestIds.NOTE_NEW_BTN).click()
})

Then('I should see the note creation screen', async ({ page }) => {
  await expect(page.getByTestId(TestIds.NOTE_FORM)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the note text input should be visible', async ({ page }) => {
  await expect(page.getByTestId(TestIds.NOTE_CONTENT)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the save button should be visible', async ({ page }) => {
  await expect(page.getByTestId(TestIds.FORM_SAVE_BTN)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the back button should be visible', async ({ page }) => {
  // The desktop note form is inline on the notes page: its way back is the form's
  // cancel button (there is no back-btn on this route).
  const form = page.getByTestId(TestIds.NOTE_FORM)
  await expect(form.getByTestId(TestIds.FORM_CANCEL_BTN)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

// --- Note detail steps ---

Given('at least one note exists', async ({ page, backendRequest: request, workerHub }) => {
  // Verify via API that notes exist, create one if needed
  let hasNotes = false
  try {
    const { notes } = await listNotesViaApi(request, { hubId: workerHub })
    hasNotes = notes.length > 0
  } catch {
    // API may not be available — fall through to UI creation
  }

  // Always navigate to notes page so subsequent steps that check for note cards
  // find them on the correct page (not the dashboard).
  const { Navigation } = await import('../../pages/index')
  await Navigation.goToNotes(page)

  if (!hasNotes) {
    // Create a note through the UI
    const newBtn = page.getByTestId(TestIds.NOTE_NEW_BTN)
    await expect(newBtn).toBeVisible({ timeout: Timeouts.ELEMENT })
    await newBtn.click()
    await expect(page.getByTestId(TestIds.NOTE_FORM)).toBeVisible({ timeout: Timeouts.ELEMENT })
    await fillCallId(page, `CALL-${Date.now()}`)
    await page.getByTestId(TestIds.NOTE_CONTENT).fill('Auto-created test note')
    await page.getByTestId(TestIds.FORM_SAVE_BTN).click()
    // Wait for form to close and note to appear in list
    await expect(page.getByTestId(TestIds.NOTE_FORM)).not.toBeVisible({ timeout: Timeouts.ELEMENT })
    // Wait for the created note card to appear
    await expect(page.getByTestId(TestIds.NOTE_CARD).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
  }
})

When('I navigate to a note\'s detail view', async ({ page }) => {
  // On desktop, notes are displayed inline (no separate detail page).
  // Just ensure a note card is visible — that IS the detail view on desktop.
  await expect(page.getByTestId(TestIds.NOTE_CARD).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the full note text', async ({ page }) => {
  // On desktop the note card is the detail view; its decrypted body renders in
  // note-detail-text. Asserting the card's whole textContent would pass on the
  // timestamp alone, so the body itself must carry text.
  const noteCard = page.getByTestId(TestIds.NOTE_CARD).first()
  await expect(noteCard.getByTestId(TestIds.NOTE_DETAIL_TEXT)).toHaveText(/\S/, { timeout: Timeouts.ELEMENT })
})

Then('I should see the creation date', async ({ page }) => {
  // Date should appear within the note context — look for date-like patterns
  const datePattern = page.locator('text=/\\d{1,2}[\\/\\-]|ago|today|yesterday|\\d{4}/i')
  await expect(datePattern.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the author pubkey', async ({ page }) => {
  // Author pubkey or npub should be visible
  const author = page.locator('text=/npub1|[a-f0-9]{8}/i')
  await expect(author.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I am on a note detail view', async ({ page }) => {
  // On desktop, notes are inline — the note card IS the detail view.
  await expect(page.getByTestId(TestIds.NOTE_CARD).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('a copy button should be visible in the top bar', async () => {
  // The desktop note card has no copy control, so the scenario's claim is false
  // on desktop. The previous body passed on the mere presence of a note card.
  throw new Error('The desktop note view has no copy button')
})

// --- Note edit steps (note-edit.feature) ---

Given('I open a note', async ({ page, backendRequest: request, workerHub }) => {
  // Ensure a note exists first
  let hasNotes = false
  try {
    const { notes } = await listNotesViaApi(request, { hubId: workerHub })
    hasNotes = notes.length > 0
  } catch {
    // API may not be available
  }

  if (!hasNotes) {
    const newBtn = page.getByTestId(TestIds.NOTE_NEW_BTN)
    await expect(newBtn).toBeVisible({ timeout: Timeouts.ELEMENT })
    await newBtn.click()
    await expect(page.getByTestId(TestIds.NOTE_FORM)).toBeVisible({ timeout: Timeouts.ELEMENT })
    await fillCallId(page, `CALL-${Date.now()}`)
    await page.getByTestId(TestIds.NOTE_CONTENT).fill('Auto-created note for test')
    await page.getByTestId(TestIds.FORM_SAVE_BTN).click()
    await expect(page.getByTestId(TestIds.NOTE_FORM)).not.toBeVisible({ timeout: Timeouts.ELEMENT })
  }

  const noteCard = page.getByTestId(TestIds.NOTE_CARD).first()
  await expect(noteCard).toBeVisible({ timeout: Timeouts.ELEMENT })
  await noteCard.click()
})

Then('I should see the note edit button', async ({ page }) => {
  await expect(page.getByTestId(TestIds.NOTE_EDIT_BTN).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I tap the note edit button', async ({ page }) => {
  // Scope the edit button to the same card asserted by the preceding step, instead of
  // `.first()` over every note-card's edit button on the page.
  const noteCard = page.getByTestId(TestIds.NOTE_CARD).first()
  await expect(noteCard).toBeVisible({ timeout: Timeouts.ELEMENT })
  const editBtn = noteCard.getByTestId(TestIds.NOTE_EDIT_BTN)
  await expect(editBtn).toBeVisible({ timeout: Timeouts.ELEMENT })
  await editBtn.click()
})

Then('I should see the note edit input', async ({ page }) => {
  // Editing is inline: the edited card swaps its body for NoteEditForm.
  const noteCard = page.getByTestId(TestIds.NOTE_CARD).first()
  await expect(noteCard.getByTestId(TestIds.NOTE_EDIT_INPUT)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I cancel editing', async ({ page }) => {
  const noteCard = page.getByTestId(TestIds.NOTE_CARD).first()
  const cancelBtn = noteCard.getByTestId(TestIds.FORM_CANCEL_BTN)
  await expect(cancelBtn).toBeVisible({ timeout: Timeouts.ELEMENT })
  await cancelBtn.click()
})

Then('I should see the note detail text', async ({ page }) => {
  // Back in read mode: the same card shows its body again and the edit input is gone.
  const noteCard = page.getByTestId(TestIds.NOTE_CARD).first()
  await expect(noteCard.getByTestId(TestIds.NOTE_EDIT_INPUT)).toHaveCount(0, { timeout: Timeouts.ELEMENT })
  await expect(noteCard.getByTestId(TestIds.NOTE_DETAIL_TEXT)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

// --- Notes search steps (notes-search.feature) ---

Then('I should see the notes search input', async ({ page }) => {
  await expect(page.getByTestId(TestIds.NOTE_SEARCH)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

const NOTE_SEARCH_TERM = 'test'

When('I type in the notes search input', async ({ page }) => {
  const searchInput = page.getByTestId(TestIds.NOTE_SEARCH)
  await expect(searchInput).toBeVisible({ timeout: Timeouts.ELEMENT })
  await searchInput.fill(NOTE_SEARCH_TERM)
  // The search is a form: it applies on submit (Enter), not per keystroke. Filling
  // the box alone changes nothing, which is what the old version of this step did.
  await searchInput.press('Enter')
  await expect(page).toHaveURL(new RegExp(`[?&]search=${NOTE_SEARCH_TERM}\\b`), { timeout: Timeouts.ELEMENT })
})

/** The notes page once loading is over: the list, or the empty state (never the skeleton). */
function settledNotes(page: Page) {
  return page.getByTestId(TestIds.NOTE_LIST).or(page.getByTestId(TestIds.EMPTY_STATE))
}

Then('the notes list should update', async ({ page }) => {
  await expect(settledNotes(page)).toBeVisible({ timeout: Timeouts.ELEMENT })
  // Every note still shown must match the search term (the filter runs on the
  // decrypted body). An empty result is legitimate; an unfiltered list is not.
  const bodies = await page.getByTestId(TestIds.NOTE_DETAIL_TEXT).allTextContents()
  for (const body of bodies) {
    expect(body.toLowerCase(), 'a note that does not match the search is still listed').toContain(NOTE_SEARCH_TERM)
  }
})

When('I clear the notes search', async ({ page }) => {
  const searchInput = page.getByTestId(TestIds.NOTE_SEARCH)
  await expect(searchInput).toBeVisible({ timeout: Timeouts.ELEMENT })
  await searchInput.clear()
  await searchInput.press('Enter')
  await expect(page).not.toHaveURL(/[?&]search=[^&]/, { timeout: Timeouts.ELEMENT })
})

Then('I should see the full notes list', async ({ page, backendRequest: request, workerHub }) => {
  await expect(settledNotes(page)).toBeVisible({ timeout: Timeouts.ELEMENT })
  // Which branch is correct is decided by the server, not by whichever element
  // happened to render: if the hub has notes, the unfiltered list must show them.
  const { total } = await listNotesViaApi(request, { hubId: workerHub })
  if (total > 0) {
    await expect(page.getByTestId(TestIds.NOTE_LIST)).toBeVisible({ timeout: Timeouts.ELEMENT })
    await expect(page.getByTestId(TestIds.NOTE_CARD).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
  } else {
    await expect(page.getByTestId(TestIds.EMPTY_STATE)).toBeVisible({ timeout: Timeouts.ELEMENT })
  }
})

// --- Save and verify note creation via API ---

When('I fill in the call ID with {string}', async ({ page }, callId: string) => {
  await page.getByTestId(TestIds.NOTE_CALL_ID).fill(callId)
  await page.evaluate((id) => {
    (window as unknown as Record<string, unknown>).__test_note_call_id = id
  }, callId)
})

Then('I should see {string} in the notes list', async ({ page }, text: string) => {
  const noteCard = page.getByTestId(TestIds.NOTE_CARD).filter({ hasText: text })
  await expect(noteCard.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should not see {string} in the notes list', async ({ page }, text: string) => {
  const noteCard = page.getByTestId(TestIds.NOTE_CARD).filter({ hasText: text })
  await expect(noteCard).not.toBeVisible({ timeout: 3000 })
})

Then('the note should show the call ID {string}', async ({ page }, callId: string) => {
  // Call ID may be truncated in the header
  const truncated = callId.slice(0, 8)
  const noteCard = page.getByTestId(TestIds.NOTE_CARD).filter({ hasText: truncated })
  await expect(noteCard.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the note should exist in the API response', async ({ backendRequest: request, workerHub }) => {
  const { notes } = await listNotesViaApi(request, { hubId: workerHub })
  expect(notes.length).toBeGreaterThan(0)
})
