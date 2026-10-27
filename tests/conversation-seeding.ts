/**
 * Conversation seeding for messaging step definitions.
 *
 * Seeds a conversation through the real API — an inbound message simulated into
 * the worker's isolated hub, then claim/close via the hub-scoped conversations
 * API — so the conversation is in the exact status a scenario needs (waiting,
 * active, closed) before any UI assertion runs.
 *
 * Every failure throws. A Given step that cannot seed its precondition must fail
 * the scenario: silently skipping the rest of the scenario turns it into a
 * vacuous pass that hides both app bugs and infrastructure faults.
 */
import type { APIRequestContext } from '@playwright/test'
import { apiGet, apiPatch, apiPost, enableMessagingViaApi } from './api-helpers'
import { contactLabel } from '../src/client/lib/contact-label'
import { simulateIncomingMessage, uniqueCallerNumber } from './simulation-helpers'

export type ConversationStatus = 'waiting' | 'active' | 'closed'

export interface SeededConversation {
  conversationId: string
  /** What the conversation card shows for this contact: a prefix of its thread hash. */
  label: string
}

/**
 * The label the conversation list renders for a conversation, derived the way the
 * client derives it, from the hash the server returns. The server keeps no part of
 * the sender's number (#2182), so a test finds the card by this, never by digits.
 */
export async function conversationLabel(
  backendRequest: APIRequestContext,
  workerHub: string,
  conversationId: string,
): Promise<string> {
  const { status, data } = await apiGet<{ channelType: string; contactIdentifierHash: string }>(
    backendRequest,
    `/hubs/${workerHub}/conversations/${conversationId}`,
  )
  if (status !== 200) throw new Error(`Reading conversation ${conversationId} failed (${status})`)
  const label = contactLabel(data)
  if (!label) throw new Error(`Conversation ${conversationId} has no contact hash to label it by`)
  return label
}

/**
 * Seed a conversation into the worker's isolated hub and put it in `status`:
 *   - waiting: fresh inbound message, unassigned (default)
 *   - active:  claimed by the admin via POST /conversations/:id/claim
 *   - closed:  claimed, then closed via PATCH /conversations/:id
 */
export async function seedConversationViaApi(
  backendRequest: APIRequestContext,
  workerHub: string,
  opts: { status?: ConversationStatus; body?: string } = {},
): Promise<SeededConversation> {
  const { status = 'waiting', body = `Test conversation ${Date.now()}` } = opts
  await enableMessagingViaApi(backendRequest, ['sms'])
  const senderNumber = uniqueCallerNumber()
  const result = await simulateIncomingMessage(backendRequest, {
    senderNumber,
    body,
    channel: 'sms',
    // Scope to the worker's hub: the UI lists conversations hub-scoped, so a
    // conversation seeded without a hubId would never render in the test app.
    hubId: workerHub,
  })
  if (!result.conversationId) {
    throw new Error('simulateIncomingMessage returned no conversationId')
  }

  const base = `/hubs/${workerHub}/conversations/${result.conversationId}`
  if (status !== 'waiting') {
    const claim = await apiPost(backendRequest, `${base}/claim`, {})
    if (claim.status !== 200) {
      throw new Error(`Seeding: claiming conversation ${result.conversationId} failed (${claim.status})`)
    }
  }
  if (status === 'closed') {
    const closed = await apiPatch(backendRequest, base, { status: 'closed' })
    if (closed.status !== 200) {
      throw new Error(`Seeding: closing conversation ${result.conversationId} failed (${closed.status})`)
    }
  }
  return { conversationId: result.conversationId, label: await conversationLabel(backendRequest, workerHub, result.conversationId) }
}
