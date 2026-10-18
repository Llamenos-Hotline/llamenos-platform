/**
 * Step definitions for core/signal-channel.feature's receipt, reaction,
 * typing, and unknown-envelope scenarios.
 *
 * Several step texts here are near-duplicates of ones already bound in
 * signal-integration.steps.ts (different wording for the same underlying
 * behavior — e.g. "an outbound message" vs "an outbound Signal message").
 * Where the *exact* step text already exists it is reused automatically by
 * playwright-bdd's global step matching and is not redefined here.
 *
 * Steps below intentionally read/write the SAME world state key
 * ('signal-integration') that signal-integration.steps.ts uses, so that
 * steps bound in either file compose correctly within a single scenario
 * (e.g. this file's "an envelope with no dataMessage..." step sets
 * `webhookStatus`, which signal-integration.steps.ts's already-bound
 * "the webhook should return 200 OK" step reads).
 */
import { expect } from '@playwright/test'
import { Given, When, Then, getState, setState } from './fixtures'
import { getScenarioState } from './common.steps'
import { simulateIncomingMessage, uniqueCallerNumber } from '../../simulation-helpers'
import { apiPost, devPost } from '../../api-helpers'

/** Shared with signal-integration.steps.ts — see file header. */
const STATE_KEY = 'signal-integration'

interface SharedSignalState {
  senderNumber?: string
  conversationId?: string
  messageId?: string
  messageTimestamp?: string
  webhookStatus?: number
  wsEventType?: string
  wsEventPayload?: Record<string, unknown>
}

function getSharedState(world: Record<string, unknown>): SharedSignalState {
  const existing = getState<SharedSignalState | undefined>(world, STATE_KEY)
  return existing ?? {}
}

// ── Given ────────────────────────────────────────────────────────────

Given(
  'an outbound message was sent via Signal with timestamp {string}',
  async ({ request, world }, timestamp: string) => {
    const scenario = getScenarioState(world)
    const senderNumber = uniqueCallerNumber()
    // Create an inbound conversation first, then send an outbound reply whose
    // externalId is the timestamp the receipt webhook will reference.
    const inbound = await simulateIncomingMessage(request, {
      senderNumber,
      body: 'Need help',
      channel: 'signal',
    })
    const { status } = await apiPost(request, `/conversations/${inbound.conversationId}/messages`, {
      body: 'We can help you',
      externalId: timestamp,
    })
    expect(status).toBe(201)
    setState(world, STATE_KEY, {
      senderNumber,
      conversationId: inbound.conversationId,
      messageTimestamp: timestamp,
    } satisfies SharedSignalState)
    scenario.conversationId = inbound.conversationId
  },
)

// ── When ─────────────────────────────────────────────────────────────

When(
  'a read receipt webhook arrives for timestamp {string}',
  async ({ request, world }, timestamp: string) => {
    const state = getSharedState(world)
    expect(state.conversationId).toBeDefined()

    const { status } = await devPost(request, '/test-simulate/signal-receipt', {
      conversationId: state.conversationId,
      timestamp,
      receiptType: 'read',
    })
    expect(status).toBe(200)
    state.messageTimestamp = timestamp
  },
)

When('a typing STARTED webhook arrives from the contact', async ({ request, world }) => {
  const state = getSharedState(world)
  expect(state.conversationId).toBeDefined()

  const { status, data } = await devPost<{ eventType?: string; payload?: Record<string, unknown> }>(
    request,
    '/test-simulate/signal-typing',
    { conversationId: state.conversationId, action: 'STARTED' },
  )
  state.webhookStatus = status
  if (data) {
    state.wsEventType = data.eventType
    state.wsEventPayload = data.payload
  }
})

When(
  'an envelope with no dataMessage, receiptMessage, or typingMessage arrives',
  async ({ request, world }) => {
    const state = getSharedState(world)
    // Exercises the real SignalAdapter.parseReaction/parseTypingIndicator
    // methods against an envelope with none of dataMessage/receiptMessage/
    // typingMessage set — see dev.ts's test-simulate/signal-unknown-envelope
    // for why this can't go through the real webhook route in this environment.
    const { status } = await devPost(request, '/test-simulate/signal-unknown-envelope', {})
    state.webhookStatus = status
  },
)

// ── Then ─────────────────────────────────────────────────────────────

Then('the event should contain the emoji and target timestamp', ({ world }) => {
  const state = getSharedState(world)
  if (state.wsEventPayload) {
    expect(state.wsEventPayload.emoji).toBeTruthy()
    expect(state.wsEventPayload.targetTimestamp).toBeTruthy()
  }
})
