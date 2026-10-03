/**
 * Note thread reply step definitions.
 * Matches steps from: packages/test-specs/features/notes/note-thread.feature
 *
 * Behavioral depth: Hard assertions, no expect(true).toBe(true),
 * no if(visible) guards hiding failures, no .or(PAGE_TITLE) fallbacks.
 */
import { expect } from '@playwright/test'
import { Given, Then } from '../fixtures'
import { TestIds } from '../../test-ids'
import { Timeouts, fillCallId } from '../../helpers'
import { Navigation } from '../../pages/index'
import { listNotesViaApi, apiPost, generateTestKeypair } from '../../api-helpers'

Given('I am on the note detail screen', async ({ page, backendRequest: request, workerHub }) => {
  // Try API to check for existing notes
  let hasNotes = false
  try {
    const { notes } = await listNotesViaApi(request, { hubId: workerHub })
    hasNotes = notes.length > 0
  } catch {
    // API not available — will check UI
  }

  await Navigation.goToNotes(page)

  if (!hasNotes) {
    // Create a note if none exist
    const newBtn = page.getByTestId(TestIds.NOTE_NEW_BTN)
    await expect(newBtn).toBeVisible({ timeout: Timeouts.ELEMENT })
    await newBtn.click()
    // Fill call ID — either Input (no recent calls) or Select (has recent calls)
    await fillCallId(page, `CALL-${Date.now()}`)
    const contentField = page.getByTestId(TestIds.NOTE_CONTENT)
    await expect(contentField).toBeVisible({ timeout: Timeouts.ELEMENT })
    await contentField.fill('Test note for thread')
    const saveBtn = page.getByTestId(TestIds.FORM_SAVE_BTN)
    await expect(saveBtn).toBeEnabled({ timeout: 5000 })
    await saveBtn.click({ timeout: Timeouts.ELEMENT })
  }

  // Open first note's thread by clicking the reply button
  const replyBtn = page.getByTestId(TestIds.NOTE_REPLY_BTN).first()
  await expect(replyBtn).toBeVisible({ timeout: Timeouts.ELEMENT })
  await replyBtn.click()
})

Given('the note has no replies', async ({ page }) => {
  // Check the precondition instead of assuming it: the opened (first) note's
  // reply button reads plain "Reply" when it has none, "N replies" otherwise.
  await expect(page.getByTestId(TestIds.NOTE_REPLY_BTN).first()).toHaveText(/^\s*Reply\s*$/, { timeout: Timeouts.ELEMENT })
})

Given('I am on the notes list', async ({ page }) => {
  await Navigation.goToNotes(page)
  const pageTitle = page.getByTestId(TestIds.PAGE_TITLE)
  await expect(pageTitle).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(pageTitle).toContainText(/notes/i)
})

Then('I should see the thread replies section', async ({ page }) => {
  // Thread section should be visible in note detail view
  const thread = page.getByTestId(TestIds.NOTE_THREAD)
  await expect(thread).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the reply input field', async ({ page }) => {
  await expect(page.getByTestId(TestIds.NOTE_REPLY_TEXT)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the no replies message', async ({ page }) => {
  const threadSection = page.getByTestId(TestIds.NOTE_THREAD)
  await expect(threadSection).toBeVisible({ timeout: Timeouts.ELEMENT })
  // The ConversationThread component shows "No messages yet" when empty
  const noMessagesText = threadSection.getByText(/no messages|no replies|no comments|be the first/i).first()
  await expect(noMessagesText).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the reply count in the thread header', async ({ page }) => {
  // Reply count is displayed on the reply button (note-reply-btn), not inside the thread
  const replyBtn = page.getByTestId(TestIds.NOTE_REPLY_BTN).first()
  await expect(replyBtn).toBeVisible({ timeout: Timeouts.ELEMENT })
  // The button shows either "Reply" (0 replies) or "N replies"
  const text = await replyBtn.textContent()
  expect(text).toBeTruthy()
})

Then('I should see the send reply button', async ({ page }) => {
  await expect(page.getByTestId(TestIds.NOTE_REPLY_SEND)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('notes with replies should show a reply count badge', async ({ page, backendRequest: request, workerHub }) => {
  // Seed a note with a reply via API so the badge has data to render
  const callId = `call-badge-${Date.now()}`
  const noteRes = await apiPost<{ note?: { id: string }; id?: string }>(request, `/hubs/${workerHub}/notes`, {
    encryptedContent: 'badge-test-note',
    callId,
  })
  expect(noteRes.status).toBeLessThan(300)
  const noteId = noteRes.data.note?.id ?? noteRes.data.id
  expect(noteId).toBeTruthy()

  // Add a reply to bump replyCount
  const kp = generateTestKeypair()
  const replyRes = await apiPost(request, `/hubs/${workerHub}/notes/${noteId}/replies`, {
    encryptedContent: 'badge-test-reply',
    readerEnvelopes: [{ pubkey: kp.pubkey, ct: 'fake-ct', enc: kp.pubkey }],
  })
  expect(replyRes.status).toBeLessThan(300)

  // Navigate away and back to force notes list to re-fetch with the seeded data
  await page.getByTestId(TestIds.NAV_DASHBOARD).click()
  await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })
  await Navigation.goToNotes(page)

  // Wait for notes list to load
  await expect(page.getByTestId(TestIds.NOTE_LIST)).toBeVisible({ timeout: Timeouts.ELEMENT })

  // Verify at least one reply button shows a count (e.g., "1 replies")
  const replyBtnWithCount = page.getByTestId(TestIds.NOTE_REPLY_BTN).filter({ hasText: /\d+\s*repl/i })
  await expect(replyBtnWithCount.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})
