/**
 * Inbound message step definitions.
 * Matches steps from: packages/test-specs/features/platform/desktop/messaging/inbound-messages.feature
 *
 * Messages are simulated into the worker's isolated hub — the path a provider
 * webhook carrying `?hub=` takes — and the conversation list, which is scoped to
 * the user's member hubs, must show them. The sender number is unique per
 * scenario, so every assertion targets this scenario's conversation by its last
 * four digits rather than whatever conversation happens to render first.
 */
import { expect } from '@playwright/test'
import { When, Then } from '../fixtures'
import { TestIds } from '../../test-ids'
import { Timeouts } from '../../helpers'
import { Navigation } from '../../pages/index'
import { enableMessagingViaApi } from '../../api-helpers'
import {
  simulateIncomingMessage,
  uniqueCallerNumber,
  type SimulateIncomingMessageOptions,
} from '../../simulation-helpers'

type Channel = NonNullable<SimulateIncomingMessageOptions['channel']>

When(
  'an inbound {string} message arrives at my hub from a new number',
  async ({ backendRequest, workerHub, conversationWorld }, channel: string) => {
    await sendInbound(backendRequest, workerHub, conversationWorld, channel as Channel, 1)
  },
)

When(
  '{int} inbound {string} messages arrive at my hub from the same new number',
  async ({ backendRequest, workerHub, conversationWorld }, count: number, channel: string) => {
    await sendInbound(backendRequest, workerHub, conversationWorld, channel as Channel, count)
  },
)

async function sendInbound(
  backendRequest: import('@playwright/test').APIRequestContext,
  workerHub: string,
  world: import('../fixtures').ConversationWorld,
  channel: Channel,
  count: number,
): Promise<void> {
  await enableMessagingViaApi(backendRequest, [channel])
  const senderNumber = uniqueCallerNumber()
  const inbound = { last4: senderNumber.slice(-4), conversationIds: [] as string[], bodies: [] as string[] }
  for (let i = 0; i < count; i++) {
    const body = `Inbound ${channel} ${i + 1} ${Date.now()}`
    const { conversationId, messageId } = await simulateIncomingMessage(backendRequest, {
      senderNumber,
      body,
      channel,
      hubId: workerHub,
    })
    expect(conversationId, 'the inbound message must open or extend a conversation').toBeTruthy()
    expect(messageId, 'the inbound message must be stored').toBeTruthy()
    inbound.conversationIds.push(conversationId)
    inbound.bodies.push(body)
  }
  world.inbound = inbound
}

function requireInbound(world: import('../fixtures').ConversationWorld) {
  if (!world.inbound) throw new Error('an inbound message step must run first')
  return world.inbound
}

function senderConversation(page: import('@playwright/test').Page, last4: string) {
  return page.getByTestId(TestIds.CONVERSATION_ITEM).filter({ hasText: last4 })
}

Then("that sender's conversation should appear in the conversation list", async ({ page, conversationWorld }) => {
  const inbound = requireInbound(conversationWorld)
  await Navigation.goToConversations(page)
  await expect(page.getByTestId(TestIds.CONVERSATION_LIST)).toBeVisible({ timeout: Timeouts.API })
  await expect(senderConversation(page, inbound.last4)).toBeVisible({ timeout: Timeouts.API })
})

Then('those messages should belong to one conversation', async ({ conversationWorld }) => {
  const ids = requireInbound(conversationWorld).conversationIds
  expect(ids.length).toBeGreaterThan(1)
  expect(new Set(ids).size).toBe(1)
})

Then(
  "opening that sender's conversation should show every message in its thread",
  async ({ page, conversationWorld }) => {
    const inbound = requireInbound(conversationWorld)
    await Navigation.goToConversations(page)
    const item = senderConversation(page, inbound.last4)
    await expect(item).toHaveCount(1, { timeout: Timeouts.API })
    await item.click()
    const thread = page.getByTestId(TestIds.CONVERSATION_THREAD)
    await expect(thread).toBeVisible({ timeout: Timeouts.API })
    await expect(thread.getByTestId(TestIds.CONVERSATION_MESSAGE)).toHaveCount(inbound.bodies.length, {
      timeout: Timeouts.API,
    })
  },
)
