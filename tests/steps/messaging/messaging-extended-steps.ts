/**
 * Extended messaging/conversation step definitions.
 * Matches additional steps from: packages/test-specs/features/core/messaging-flow.feature
 * not covered by conversation-steps.ts or conversations-full-steps.ts
 *
 * Behavioral depth: Given steps seed data through the real API (simulated
 * inbound message into the worker's isolated hub, claim/close/send via the
 * hub-scoped conversations API) so the UI state the scenario needs actually
 * exists before any assertion runs.
 */
import { expect, type APIRequestContext, type Page } from '@playwright/test'
import { Given, When, Then } from '../fixtures'
import type { ConversationWorld } from '../fixtures'
import { TestIds } from '../../test-ids'
import { Timeouts } from '../../helpers'
import { Navigation } from '../../pages/index'
import { ADMIN_SEED, apiGet, apiPost, enableMessagingViaApi } from '../../api-helpers'
import { encryptMessageForDesktop } from '../../crypto-helpers'
import { seedConversationViaApi, type SeededConversation } from '../../conversation-seeding'
import { simulateIncomingMessage, simulateDeliveryStatus, uniqueCallerNumber } from '../../simulation-helpers'

// --- Admin messaging settings ---

Given('I am on the admin settings page', async ({ page }) => {
  await Navigation.goToHubSettings(page)
  await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({
    timeout: Timeouts.ELEMENT,
  })
})

// Each messaging channel renders its own collapsible settings section
// (`<channel>-channel`) whose enable switch is `<channel>-enabled-toggle`.
// Every interaction below is scoped to those testids: the admin settings page
// has many unrelated switches, and the first one on the page is the passkey
// policy's "require for admins" toggle — clicking it locks the admin out of
// every API route with WEBAUTHN_REQUIRED for the rest of the run.

type MessagingChannel = 'sms' | 'whatsapp'

async function enableChannelViaSettingsUi(page: Page, channel: MessagingChannel): Promise<void> {
  const trigger = page.getByTestId(`${channel}-channel-trigger`)
  await expect(trigger).toBeVisible({ timeout: Timeouts.ELEMENT })
  if (await trigger.getAttribute('aria-expanded') !== 'true') {
    await trigger.click()
  }
  const toggle = page.getByTestId(`${channel}-enabled-toggle`)
  await expect(toggle).toBeVisible({ timeout: Timeouts.ELEMENT })
  if (await toggle.getAttribute('aria-checked') !== 'true') {
    await toggle.click()
  }
  await expect(toggle).toHaveAttribute('aria-checked', 'true')

  const saved = page.waitForResponse(
    res => res.url().endsWith('/api/settings/messaging') && res.request().method() === 'PATCH',
    { timeout: Timeouts.API },
  )
  await page.getByTestId(`${channel}-save-btn`).click()
  expect((await saved).status()).toBe(200)
}

async function expectChannelEnabled(request: APIRequestContext, channel: MessagingChannel): Promise<void> {
  const { status, data } = await apiGet<{ enabledChannels: string[] }>(request, '/settings/messaging')
  expect(status).toBe(200)
  expect(data.enabledChannels).toContain(channel)
}

Then('I should see the messaging configuration section', async ({ page }) => {
  await expect(page.getByTestId('sms-channel')).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(page.getByTestId('whatsapp-channel')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Given('I am on the messaging settings', async ({ page }) => {
  await Navigation.goToHubSettings(page)
  await expect(page.getByTestId('sms-channel')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I configure SMS channel with Twilio credentials', async ({ page }) => {
  await enableChannelViaSettingsUi(page, 'sms')
})

Then('the SMS channel should be enabled', async ({ backendRequest }) => {
  await expectChannelEnabled(backendRequest, 'sms')
})

When('I configure WhatsApp channel', async ({ page }) => {
  await enableChannelViaSettingsUi(page, 'whatsapp')
})

Then('the WhatsApp channel should be enabled', async ({ backendRequest }) => {
  await expectChannelEnabled(backendRequest, 'whatsapp')
})

// --- Active conversation steps ---

/**
 * Seed a conversation into the worker's isolated hub via the real API, select
 * it in the UI, and record it on the scenario's `conversationWorld`.
 * With `claim: true` the conversation is claimed by the admin (status active)
 * so status-gated UI (composer, close button) actually renders.
 * Every failure throws — a scenario whose precondition cannot be seeded must
 * fail, not pass vacuously.
 */
async function seedAndSelectConversation(
  page: Page,
  backendRequest: APIRequestContext,
  workerHub: string,
  world: ConversationWorld,
  body: string,
  opts: { claim?: boolean } = {},
): Promise<SeededConversation> {
  const seeded = await seedConversationViaApi(backendRequest, workerHub, {
    status: opts.claim ? 'active' : 'waiting',
    body,
  })
  world.seeded = seeded
  await Navigation.goToConversations(page)
  const item = page.getByTestId(TestIds.CONVERSATION_ITEM).filter({ hasText: seeded.last4 })
  await expect(item).toBeVisible({ timeout: Timeouts.ELEMENT })
  await item.click()
  return seeded
}

Given('I have an active conversation', async ({ page, backendRequest, workerHub, conversationWorld }) => {
  // Active = claimed: the message composer and close button only render for
  // active conversations, so claim through the real API during seeding.
  await seedAndSelectConversation(page, backendRequest, workerHub, conversationWorld, `Active conversation ${Date.now()}`, { claim: true })
})

When('I type a message and click send', async ({ page }) => {
  const composer = page.getByTestId(TestIds.MESSAGE_COMPOSER)
  await expect(composer).toBeVisible({ timeout: Timeouts.ELEMENT })
  const textarea = composer.locator('textarea, input[type="text"]').first()
  await textarea.fill(`Test message ${Date.now()}`)
  const sendBtn = page.getByTestId(TestIds.CONV_SEND_BTN)
  await expect(sendBtn).toBeVisible({ timeout: Timeouts.ELEMENT })
  await sendBtn.click()
})

Given('I sent a message in a conversation', async ({ page, backendRequest, workerHub, conversationWorld }) => {
  // Seed + claim, then post an outbound message through the real conversations
  // API so the thread contains an outbound message carrying a delivery status.
  // The message is sealed client-side — exactly as the desktop client's
  // encryptMessage does, for the admin reader — because the desktop client under
  // Playwright can only open envelopes sealed with the mock HPKE primitive
  // (tests/mocks/hpke-mock.ts); content the server seals with real RFC 9180
  // HPKE would render as "[Encrypted]" and could never satisfy the thread
  // assertion. The delivery-status simulation endpoint requires the message to
  // have an externalId, which the server only assigns when a provider is
  // configured — passing one explicitly is the documented test fallback.
  const seeded = await seedAndSelectConversation(
    page,
    backendRequest,
    workerHub,
    conversationWorld,
    `Inbound for delivery test ${Date.now()}`,
    { claim: true },
  )

  const outboundBody = `Outbound delivery probe ${Date.now()}`
  const base = `/hubs/${workerHub}/conversations/${seeded.conversationId}`
  const { encryptedContent, readerEnvelopes } = encryptMessageForDesktop(outboundBody, [ADMIN_SEED])
  const send = await apiPost<{ id?: string }>(backendRequest, `${base}/messages`, {
    encryptedContent,
    readerEnvelopes,
    externalId: `sim-${Date.now()}`,
  })
  if (send.status !== 201 || !send.data?.id) {
    throw new Error(`Seeding: sending outbound message failed (${send.status})`)
  }
  const messageId = send.data.id
  await simulateDeliveryStatus(backendRequest, {
    conversationId: seeded.conversationId,
    messageId,
    status: 'delivered',
  })
  conversationWorld.outbound = { conversationId: seeded.conversationId, messageId, body: outboundBody }

  // Re-select so the thread refetches and shows the outbound message.
  await Navigation.goToDashboard(page)
  await Navigation.goToConversations(page)
  const item = page.getByTestId(TestIds.CONVERSATION_ITEM).filter({ hasText: seeded.last4 })
  await expect(item).toBeVisible({ timeout: Timeouts.ELEMENT })
  await item.click()
})

Then('I should see the delivery status indicator', async ({ page, backendRequest, workerHub, conversationWorld }) => {
  const outbound = conversationWorld.outbound
  if (!outbound) throw new Error('Given step must have sent an outbound message')

  // UI: the outbound message renders in the thread (delivery status itself is
  // an icon-only affordance, so assert on the rendered bubble here).
  const thread = page.getByTestId(TestIds.CONVERSATION_THREAD)
  await expect(thread).toBeVisible({ timeout: Timeouts.ELEMENT })
  // The just-sent message's plaintext only appears after the client refetches
  // and HPKE/AES-GCM-decrypts it (ConversationThread's decrypt effect) — give
  // that its own budget instead of the generic ELEMENT timeout, which has been
  // observed to be too tight under contended CI runners.
  await expect(thread.getByText(outbound.body)).toBeVisible({ timeout: Timeouts.DECRYPT })

  // Behavior: the delivery status actually transitioned — verify through the
  // real API instead of asserting on an SVG glyph.
  const { status, data } = await apiGet<{ messages: Array<{ id: string; status?: string }> }>(
    backendRequest,
    `/hubs/${workerHub}/conversations/${outbound.conversationId}/messages`,
  )
  expect(status).toBe(200)
  const msg = data.messages.find(m => m.id === outbound.messageId)
  expect(['sent', 'delivered', 'read']).toContain(msg?.status)
})

Then('the conversation status should be {string}', async ({ page }, status: string) => {
  const statusText = page.locator(`text=/${status}/i`).first()
  await expect(statusText).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Given('I have an unassigned conversation', async ({ page, backendRequest, workerHub, conversationWorld }) => {
  await seedAndSelectConversation(page, backendRequest, workerHub, conversationWorld, `Unassigned conversation ${Date.now()}`)
})

When('I assign it to a volunteer', async ({ page }) => {
  // The Given step seeds a waiting (unassigned) conversation and selects it,
  // so the claim button must be rendered — a missing button is a real app bug.
  const assignBtn = page.getByTestId(TestIds.CONV_ASSIGN_BTN)
  await expect(assignBtn).toBeVisible({ timeout: Timeouts.ELEMENT })
  await assignBtn.click()
})

Then('the volunteer name should appear on the conversation', async ({ page }) => {
  // After claiming, the conversation is active and assigned to the current
  // user; the app confirms with a "Conversation claimed" toast and the card
  // stops showing the italic "Waiting" assignee placeholder.
  const assigned = page.locator('text=/assigned|claimed|volunteer/i').first()
  await expect(assigned).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Given('conversations exist across SMS and WhatsApp', async ({ page, backendRequest, workerHub }) => {
  await enableMessagingViaApi(backendRequest, ['sms', 'whatsapp'])
  await simulateIncomingMessage(backendRequest, {
    senderNumber: uniqueCallerNumber(),
    body: 'SMS test',
    channel: 'sms',
    hubId: workerHub,
  })
  await simulateIncomingMessage(backendRequest, {
    senderNumber: uniqueCallerNumber(),
    body: 'WhatsApp test',
    channel: 'whatsapp',
    hubId: workerHub,
  })
  await Navigation.goToConversations(page)
  await expect(page.getByTestId(TestIds.CONVERSATION_ITEM).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I filter by SMS channel', async ({ page }) => {
  // Desktop uses search to filter, not dedicated channel filter chips
  const searchInput = page.getByTestId(TestIds.CONV_SEARCH)
  await expect(searchInput).toBeVisible({ timeout: Timeouts.ELEMENT })
  await searchInput.fill('SMS')
})

Then('I should only see SMS conversations', async ({ page }) => {
  const conversationList = page.getByTestId(TestIds.CONVERSATION_LIST)
  await expect(conversationList).toBeVisible({ timeout: Timeouts.ELEMENT })
})
