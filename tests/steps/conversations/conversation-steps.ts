/**
 * Conversation step definitions.
 * Matches steps from:
 *   - packages/test-specs/features/conversations/conversation-list.feature
 *   - packages/test-specs/features/conversations/conversation-filters.feature
 *
 * Behavioral depth: Hard assertions on conversation-specific elements.
 * Steps seed conversations via simulateIncomingMessage when needed.
 */
import { expect, type Page } from '@playwright/test'
import { Given, When, Then } from '../fixtures'
import { TestIds } from '../../test-ids'
import { Timeouts } from '../../helpers'
import { seedConversationViaApi } from '../../conversation-seeding'

Given('I navigate to the conversations tab', async ({ page }) => {
  const { Navigation } = await import('../../pages/index')
  await Navigation.goToConversations(page)
})

Given('I open a conversation', async ({ page, backendRequest, workerHub, conversationWorld }) => {
  // Seed into the worker's hub — the UI lists conversations hub-scoped. The
  // previous version seeded without a hubId and swallowed every error, so no
  // conversation ever rendered, nothing was opened, and each following step fell
  // back to "the page title is visible".
  const seeded = await seedConversationViaApi(backendRequest, workerHub, { body: 'Auto-seeded test message' })
  conversationWorld.seeded = seeded

  // Reload so the client picks up the messaging config, then re-enter the PIN.
  const { reenterPinAfterReload } = await import('../../helpers')
  await page.reload()
  await reenterPinAfterReload(page)

  const { Navigation } = await import('../../pages/index')
  await Navigation.goToConversations(page)

  const item = page.getByTestId(TestIds.CONVERSATION_ITEM).filter({ hasText: seeded.last4 })
  await expect(item).toBeVisible({ timeout: Timeouts.API })
  await item.click()
  await expect(page.getByTestId(TestIds.CONVERSATION_THREAD)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

// --- Filter chips ---
//
// The desktop conversation list has no filter chips: it groups conversations
// into Waiting / Active / Closed section headers, each rendered only when it has
// conversations, and none of them is "selected". These steps assert the desktop
// analog where one exists. They used to fall back to "the list container is
// visible", which holds for an empty list too, so every filter scenario passed
// without a single chip or header on screen.

function sectionHeader(page: Page, name?: string) {
  const headers = page.getByTestId(TestIds.CONV_SECTION_HEADER)
  return name ? headers.filter({ hasText: new RegExp(name, 'i') }) : headers
}

Then('the filter chips should be visible', async ({ page }) => {
  await expect(sectionHeader(page).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the {string} filter chip', async ({ page }, filterName: string) => {
  await expect(sectionHeader(page, filterName)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the {string} filter should be selected', async ({}, filterName: string) => {
  throw new Error(`The desktop conversation list has no selectable filters (asked for "${filterName}")`)
})

When('I tap the {string} filter chip', async ({ page }, filterName: string) => {
  const header = sectionHeader(page, filterName)
  await expect(header).toBeVisible({ timeout: Timeouts.ELEMENT })
  await header.click()
})

Then('the conversation list should update', async ({ page }) => {
  await expect(page.getByTestId(TestIds.CONVERSATION_LIST)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Given('I have selected the {string} filter', async ({ page }, filterName: string) => {
  const header = sectionHeader(page, filterName)
  await expect(header).toBeVisible({ timeout: Timeouts.ELEMENT })
  await header.click()
})

Then(
  'I should see either the conversations list, empty state, or loading indicator',
  async ({ page }) => {
    // conversation-list renders for both the empty and the populated list, never
    // during loading — so its visibility is the settled state.
    await expect(page.getByTestId(TestIds.CONVERSATION_LIST)).toBeVisible({ timeout: Timeouts.ELEMENT })
  },
)

Then('I should see the conversation filters', async ({ page }) => {
  await expect(sectionHeader(page).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the create note FAB', async ({ page }) => {
  await expect(page.getByTestId(TestIds.NOTE_NEW_BTN)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

// --- Conversation detail steps (assign, notes, e2ee) ---

Then('I should see the assign conversation button', async ({ page }) => {
  // Claim (conv-assign-btn) shows on waiting conversations; admins also get
  // Reassign on waiting/active ones. The seeded conversation is waiting.
  const assign = page.getByTestId(TestIds.CONV_ASSIGN_BTN).or(page.getByTestId('conv-reassign-btn'))
  await expect(assign.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I tap the assign conversation button', async ({ page }) => {
  // The control that opens the assign dialog (with its volunteer list) is
  // Reassign; Claim assigns to yourself without a dialog.
  const reassignBtn = page.getByTestId('conv-reassign-btn')
  await expect(reassignBtn).toBeVisible({ timeout: Timeouts.ELEMENT })
  await reassignBtn.click()
})

Then('I should see the assign dialog', async ({ page }) => {
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the add note button', async ({ page }) => {
  await expect(page.getByTestId(TestIds.CONV_ADD_NOTE_BTN)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I tap the add note button', async ({ page }) => {
  // The conversation's own add-note button. Falling back to the notes page (as
  // the old step did when no conversation was open) tests a different feature.
  const convNoteBtn = page.getByTestId(TestIds.CONV_ADD_NOTE_BTN)
  await expect(convNoteBtn).toBeVisible({ timeout: Timeouts.ELEMENT })
  await convNoteBtn.click()
})

Then('I should see the E2EE encryption indicator', async ({ page }) => {
  // The open conversation's header renders a lock icon with "End-to-end encrypted".
  await expect(page.getByTestId(TestIds.CONVERSATION_THREAD)).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(page.getByText(/end-to-end encrypted/i).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the indicator should display {string}', async ({ page }, text: string) => {
  await expect(page.getByText(new RegExp(text, 'i')).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})
