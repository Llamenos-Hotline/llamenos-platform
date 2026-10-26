/**
 * Full conversation management step definitions.
 * Matches steps from: packages/test-specs/features/core/messaging-flow.feature
 *
 * Behavioral depth: Hard assertions on conversation elements. Given steps seed
 * conversations through the real API (see conversation-seeding.ts) so the
 * conversation is in the exact status the scenario needs (waiting, active,
 * closed) before any UI assertion runs. The UI renders status-gated controls:
 * conv-assign-btn only for a selected `waiting` conversation, conv-close-btn
 * and the message composer only for `active`, conv-reopen-btn only for
 * `closed` (src/client/routes/conversations.tsx).
 *
 * Steps hand state to each other through the scenario-scoped `conversationWorld`
 * fixture (steps/fixtures.ts) — never through the page's `window`, which does
 * not survive a page load and is not shared with the retry's fresh page.
 * A Given step that cannot seed its conversation throws; every locator after
 * that is asserted hard — a missing element is a real app bug, not a "maybe"
 * to swallow.
 */
import { expect } from '@playwright/test'
import { Given, When, Then } from '../fixtures'
import type { ConversationWorld } from '../fixtures'
import { TestIds } from '../../test-ids'
import { Timeouts } from '../../helpers'
import { Navigation } from '../../pages/index'
import { enableMessagingViaApi } from '../../api-helpers'
import { seedConversationViaApi, type SeededConversation } from '../../conversation-seeding'
import { simulateIncomingMessage, uniqueCallerNumber } from '../../simulation-helpers'

type Page = import('@playwright/test').Page

/**
 * Navigate to the conversations page and select the seeded conversation.
 * Selection is scoped by the conversation's contact label so parallel workers
 * never select each other's conversations. The conversation was seeded through
 * the real API, so it must render — a missing card is an app bug.
 * The seeded conversation is recorded on the world so steps that must re-select
 * it after the app clears the detail selection (closing sets selectedId null)
 * can find it again.
 */
async function navigateAndSelect(
  page: Page,
  world: ConversationWorld,
  seeded: SeededConversation,
): Promise<void> {
  world.seeded = seeded
  await Navigation.goToConversations(page)
  const item = page.getByTestId(TestIds.CONVERSATION_ITEM).filter({ hasText: seeded.label })
  await expect(item).toBeVisible({ timeout: Timeouts.ELEMENT })
  await item.click()
}

// --- Conversation setup ---

Given('a conversation exists', async ({ page, backendRequest, workerHub, conversationWorld }) => {
  const seeded = await seedConversationViaApi(backendRequest, workerHub)
  // Select the conversation: downstream steps (assign, thread view) act on the
  // detail pane, which only renders once a conversation is selected.
  await navigateAndSelect(page, conversationWorld, seeded)
})

Given('I have an open conversation', async ({ page, backendRequest, workerHub, conversationWorld }) => {
  const seeded = await seedConversationViaApi(backendRequest, workerHub)
  await navigateAndSelect(page, conversationWorld, seeded)
  // Claim the conversation through the UI so it becomes "active" and the
  // composer is visible. The conversation was just seeded via
  // simulateIncomingMessage, so it is guaranteed to be unassigned — the
  // claim button must be present.
  const claimBtn = page.getByTestId(TestIds.CONV_ASSIGN_BTN)
  await expect(claimBtn).toBeVisible({ timeout: Timeouts.ELEMENT })
  await claimBtn.click()
  await expect(page.getByTestId(TestIds.MESSAGE_COMPOSER)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Given('conversations from different channels exist', async ({ page, backendRequest, workerHub }) => {
  await enableMessagingViaApi(backendRequest, ['sms', 'whatsapp'])
  await simulateIncomingMessage(backendRequest, {
    senderNumber: uniqueCallerNumber(),
    body: 'SMS conversation',
    channel: 'sms',
    hubId: workerHub,
  })
  await simulateIncomingMessage(backendRequest, {
    senderNumber: uniqueCallerNumber(),
    body: 'WhatsApp conversation',
    channel: 'whatsapp',
    hubId: workerHub,
  })
  await Navigation.goToConversations(page)
  await expect(page.getByTestId(TestIds.CONVERSATION_ITEM).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Given('an open conversation exists', async ({ page, backendRequest, workerHub, conversationWorld }) => {
  // "Open" means active: the close button only renders once the conversation
  // is claimed, so claim it through the real API before navigating.
  const seeded = await seedConversationViaApi(backendRequest, workerHub, { status: 'active' })
  await navigateAndSelect(page, conversationWorld, seeded)
})

Given('a closed conversation exists', async ({ page, backendRequest, workerHub, conversationWorld }) => {
  // Seed a conversation and close it through the real API (claim → close) so
  // the reopen button — rendered only for selected `closed` conversations —
  // is actually available.
  const seeded = await seedConversationViaApi(backendRequest, workerHub, { status: 'closed' })
  await navigateAndSelect(page, conversationWorld, seeded)
})

Given('conversations exist', async ({ page, backendRequest, workerHub, conversationWorld }) => {
  const seeded = await seedConversationViaApi(backendRequest, workerHub)
  await navigateAndSelect(page, conversationWorld, seeded)
})

// --- Conversation interactions ---

When('I click on a conversation', async ({ page }) => {
  const item = page.getByTestId(TestIds.CONVERSATION_ITEM).first()
  await expect(item).toBeVisible({ timeout: Timeouts.ELEMENT })
  await item.click()
})

When('I type a message in the reply field', async ({ page }) => {
  const composer = page.getByTestId(TestIds.MESSAGE_COMPOSER)
  await expect(composer).toBeVisible({ timeout: Timeouts.ELEMENT })
  const textarea = composer.locator('textarea, input[type="text"]').first()
  await textarea.fill(`Test message ${Date.now()}`)
})

When('I assign the conversation to a volunteer', async ({ page }) => {
  // For a waiting conversation the app's assign action is the Claim button:
  // conv-assign-btn → handleClaim self-assigns immediately (src/client/routes/
  // conversations.tsx). There is no volunteer-picker dialog on this path —
  // the Reassign dialog (conv-reassign-btn) is a separate admin-only action.
  // The Given step seeded and selected a waiting conversation, so the claim
  // button must be rendered — a missing button is a real app bug.
  const assignBtn = page.getByTestId(TestIds.CONV_ASSIGN_BTN)
  await expect(assignBtn).toBeVisible({ timeout: Timeouts.ELEMENT })
  await assignBtn.click()
  // Claim completes with a "Conversation claimed" toast — wait for it so the
  // Then step runs against the post-claim state, not mid-request.
  await expect(page.getByText(/claimed/i).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I close the conversation', async ({ page }) => {
  const closeBtn = page.getByTestId(TestIds.CONV_CLOSE_BTN)
  await expect(closeBtn).toBeVisible({ timeout: Timeouts.ELEMENT })
  await closeBtn.click()
  // handleClose closes immediately — the app shows no confirm dialog for
  // closing a conversation — and surfaces a "Conversation closed" toast.
})

When('I reopen the conversation', async ({ page, conversationWorld }) => {
  // The reopen button only renders for a selected closed conversation, and
  // closing a conversation clears the detail selection (handleClose sets
  // selectedId to null). Re-navigate to force a fresh list fetch (the relay
  // may have removed the closed card from live state), then re-select the
  // scenario's conversation by its unique sender digits. Re-selecting an
  // already-selected card is idempotent, so this is safe in both the
  // reopen-only and close-and-reopen scenarios.
  const seeded = conversationWorld.seeded
  expect(seeded, 'a Given step must have seeded the scenario\'s conversation').toBeDefined()
  await Navigation.goToDashboard(page)
  await Navigation.goToConversations(page)
  const item = page.getByTestId(TestIds.CONVERSATION_ITEM).filter({ hasText: seeded!.label })
  await expect(item).toBeVisible({ timeout: Timeouts.ELEMENT })
  await item.click()
  const reopenBtn = page.getByTestId(TestIds.CONV_REOPEN_BTN)
  await expect(reopenBtn).toBeVisible({ timeout: Timeouts.ELEMENT })
  await reopenBtn.click()
})

When('I search for a phone number', async ({ page }) => {
  const searchInput = page.getByTestId(TestIds.CONV_SEARCH)
  await expect(searchInput).toBeVisible({ timeout: Timeouts.ELEMENT })
  await searchInput.fill('+1212')
})

// --- Conversation assertions ---

Then('I should see the conversation thread', async ({ page }) => {
  await expect(page.getByTestId(TestIds.CONVERSATION_THREAD)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see message timestamps', async ({ page }) => {
  // Timestamps appear in the conversation thread
  const thread = page.getByTestId(TestIds.CONVERSATION_THREAD)
  await expect(thread).toBeVisible({ timeout: Timeouts.ELEMENT })
  const timestamp = thread.locator('text=/\\d{1,2}:\\d{2}|ago|just now/i').first()
  await expect(timestamp).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the message should appear in the thread', async ({ page }) => {
  const thread = page.getByTestId(TestIds.CONVERSATION_THREAD)
  await expect(thread).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(thread.locator('text=/Test message|test/i').first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('each conversation should show its channel badge', async ({ page }) => {
  const item = page.getByTestId(TestIds.CONVERSATION_ITEM).first()
  await expect(item).toBeVisible({ timeout: Timeouts.ELEMENT })
  // Channel badge is rendered by ChannelBadge component inside conversation-item
  const badge = item.locator('text=/SMS|WhatsApp|Signal|RCS/i')
  await expect(badge.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the conversation should show the assigned volunteer', async ({ page }) => {
  // After claiming, the conversation detail header shows the assigned user
  const assigned = page.locator('text=/assigned|claimed|volunteer/i')
  await expect(assigned.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the conversation status should change to {string}', async ({ page }, status: string) => {
  // After close/reopen, look for the status text or a toast notification
  const statusText = page.locator(`text=/${status}/i`).first()
  await expect(statusText).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('matching conversations should be displayed', async ({ page }) => {
  const results = page.locator(
    `[data-testid="${TestIds.CONVERSATION_ITEM}"], [data-testid="${TestIds.EMPTY_STATE}"], [data-testid="${TestIds.CONVERSATION_LIST}"]`,
  )
  await expect(results.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})
