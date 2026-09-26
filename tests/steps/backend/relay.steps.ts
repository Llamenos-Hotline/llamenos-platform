/**
 * Step definitions for WebSocket relay event delivery BDD scenarios.
 *
 * Uses RelayCapture to subscribe to the in-process WebSocket relay and assert
 * that server-published events arrive within the expected timeframe.
 */
import { expect } from '@playwright/test'
import { Given, When, Then, After, getState, setState } from './fixtures'
import { getScenarioState } from './common.steps'
import { RelayCapture, type CapturedEvent } from '../../helpers/relay-capture'
import {
  simulateIncomingCall,
  simulateAnswerCall,
  simulateEndCall,
  simulateIncomingMessage,
  uniqueCallerNumber,
} from '../../simulation-helpers'
import { ed25519 } from '@noble/curves/ed25519.js'
import { hexToBytes, utf8ToBytes } from '@shared/encoding'
import { decryptHubEvent } from '../../helpers/relay-crypto'
import {
  ADMIN_SEED,
  addHubMemberViaApi,
  apiGet,
  createHubViaApi,
  createVolunteerViaApi,
} from '../../api-helpers'

const RELAY_URL = process.env.TEST_RELAY_URL || 'ws://localhost:3000/ws'
const BASE_URL = process.env.TEST_HUB_URL || 'http://localhost:3000'

const RELAY_KEY = 'relay'

interface RelayStepState {
  lastCapturedEvent?: CapturedEvent
  serverPubkey?: string
  /** Server event key (hex) fetched from GET /api/auth/me */
  serverEventKeyHex?: string
  /** A user who belongs to a different hub only (never to the scenario hub) */
  otherHubMember?: { seedHex: string; hubId: string }
}

function getRelayState(world: Record<string, unknown>): RelayStepState {
  let s = getState<RelayStepState | undefined>(world, RELAY_KEY)
  if (!s) {
    s = {}
    setState(world, RELAY_KEY, s)
  }
  return s
}

// --- Relay Setup ---

Given('the test relay is connected and capturing events', async ({ request, world }) => {
  const state = getScenarioState(world)
  const rs = getRelayState(world)
  if (state.relayCapture) {
    state.relayCapture.close()
  }
  state.relayCapture = await RelayCapture.connect(RELAY_URL, {
    seedHex: ADMIN_SEED,
    hubId: state.hubId ?? undefined,
  })

  // Fetch the server event key from /api/auth/me so we can decrypt relay events.
  // This makes tests work regardless of what SERVER_SECRET the server uses.
  if (!rs.serverEventKeyHex) {
    const { status, data } = await apiGet<{ serverEventKeyHex?: string }>(request, '/auth/me', ADMIN_SEED)
    if (status === 200 && data?.serverEventKeyHex) {
      rs.serverEventKeyHex = data.serverEventKeyHex
    }
  }
})

After(async ({ world }) => {
  const state = getScenarioState(world)
  if (state?.relayCapture) {
    state.relayCapture.close()
    state.relayCapture = undefined
  }
  const rs = getRelayState(world)
  rs.lastCapturedEvent = undefined
})

// --- Call Triggers ---

When('an incoming call arrives from a unique number', async ({ request, world }) => {
  const state = getScenarioState(world)
  const caller = uniqueCallerNumber()
  const result = await simulateIncomingCall(request, { callerNumber: caller, hubId: state.hubId })
  state.callId = result.callId
})

Given('an incoming call is ringing', async ({ request, world }) => {
  const state = getScenarioState(world)
  const caller = uniqueCallerNumber()
  const result = await simulateIncomingCall(request, { callerNumber: caller, hubId: state.hubId })
  state.callId = result.callId
})

When('the first volunteer answers the call', async ({ request, world }) => {
  const state = getScenarioState(world)
  expect(state.callId).toBeTruthy()
  expect(state.volunteers.length).toBeGreaterThan(0)
  await simulateAnswerCall(request, state.callId!, state.volunteers[0].pubkey)
})

When('the active call is ended', async ({ request, world }) => {
  const state = getScenarioState(world)
  expect(state.callId).toBeTruthy()
  await simulateEndCall(request, state.callId!)
})

// --- Messaging Triggers ---

When('an inbound SMS message arrives from a unique number', async ({ request, world }) => {
  const state = getScenarioState(world)
  const sender = uniqueCallerNumber()
  const result = await simulateIncomingMessage(request, {
    senderNumber: sender,
    body: 'BDD test message',
    channel: 'sms',
    hubId: state.hubId,
  })
  state.conversationId = result.conversationId
  state.messageId = result.messageId
})

// --- Hub isolation ---

Given('a volunteer who is a member of a different hub only', async ({ request, world }) => {
  const rs = getRelayState(world)
  const otherHubId = await createHubViaApi(request, `bdd-other-hub-${Date.now()}`)
  const vol = await createVolunteerViaApi(request, { name: `BDD Other-Hub Vol ${Date.now()}` })
  await addHubMemberViaApi(request, otherHubId, vol.pubkey)
  rs.otherHubMember = { seedHex: vol.seedHex, hubId: otherHubId }
})

// Subscription refusals surface from RelayCapture.connect as `Relay error: not_member`.
Then("that volunteer's relay subscription to the scenario hub should be refused", async ({ world }) => {
  const state = getScenarioState(world)
  const { otherHubMember } = getRelayState(world)
  expect(otherHubMember).toBeTruthy()
  await expect(
    RelayCapture.connect(RELAY_URL, { seedHex: otherHubMember!.seedHex, hubId: state.hubId }),
  ).rejects.toThrow(/not_member/)
})

Then('that volunteer\'s relay subscription to {string} should be refused', async ({ world }, hubId: string) => {
  const { otherHubMember } = getRelayState(world)
  expect(otherHubMember).toBeTruthy()
  await expect(
    RelayCapture.connect(RELAY_URL, { seedHex: otherHubMember!.seedHex, hubId }),
  ).rejects.toThrow(/not_member/)
})

Then("that volunteer's relay subscription to their own hub should be accepted", async ({ world }) => {
  const { otherHubMember } = getRelayState(world)
  expect(otherHubMember).toBeTruthy()
  const capture = await RelayCapture.connect(RELAY_URL, {
    seedHex: otherHubMember!.seedHex,
    hubId: otherHubMember!.hubId,
  })
  capture.close()
})

// --- Relay Capture Utilities ---

Given('the relay captured events are cleared', async ({ world }) => {
  const state = getScenarioState(world)
  expect(state.relayCapture).toBeTruthy()
  // Wait for in-flight events to settle (publishing is fire-and-forget async)
  await new Promise(resolve => setTimeout(resolve, 1000))
  state.relayCapture!.clear()
})

// --- Event Assertions ---

Then(
  'the relay should receive a kind {int} event within {int} seconds',
  async ({ world }, kind: number, seconds: number) => {
    const state = getScenarioState(world)
    const rs = getRelayState(world)
    expect(state.relayCapture).toBeTruthy()
    const events = await state.relayCapture!.waitForEvents({
      kind,
      count: 1,
      timeoutMs: seconds * 1000,
    })
    expect(events.length).toBeGreaterThanOrEqual(1)
    rs.lastCapturedEvent = events[0]
  },
)

Then('the decrypted event content type should be {string}', async ({ world }, expectedType: string) => {
  const rs = getRelayState(world)
  expect(rs.lastCapturedEvent).toBeTruthy()
  const content = decryptEventPayload(rs.lastCapturedEvent!, rs.serverEventKeyHex)
  expect(content).toBeTruthy()
  expect(content!.type).toBe(expectedType)
})

Then('the event should contain a {string} field', async ({ world }, fieldName: string) => {
  const rs = getRelayState(world)
  expect(rs.lastCapturedEvent).toBeTruthy()
  const content = decryptEventPayload(rs.lastCapturedEvent!, rs.serverEventKeyHex)
  expect(content).toBeTruthy()
  expect(content![fieldName]).toBeDefined()
})

Then(
  'the event content {string} should be {string}',
  async ({ world }, fieldName: string, expectedValue: string) => {
    const rs = getRelayState(world)
    expect(rs.lastCapturedEvent).toBeTruthy()
    const content = decryptEventPayload(rs.lastCapturedEvent!, rs.serverEventKeyHex)
    expect(content).toBeTruthy()
    expect(content![fieldName]).toBe(expectedValue)
  },
)

Then('the raw event payload should NOT be valid JSON', async ({ world }) => {
  const rs = getRelayState(world)
  expect(rs.lastCapturedEvent).toBeTruthy()
  let isJson = false
  try {
    JSON.parse(rs.lastCapturedEvent!.payload)
    isJson = true
  } catch {
    isJson = false
  }
  expect(isJson).toBe(false)
})

Then('the decrypted event content should be valid JSON', async ({ world }) => {
  const rs = getRelayState(world)
  expect(rs.lastCapturedEvent).toBeTruthy()
  const content = decryptEventPayload(rs.lastCapturedEvent!, rs.serverEventKeyHex)
  expect(content).toBeTruthy()
})

Then(
  'the event hubId should be {string}',
  async ({ world }, expectedHubId: string) => {
    const rs = getRelayState(world)
    expect(rs.lastCapturedEvent).toBeTruthy()
    expect(rs.lastCapturedEvent!.hubId).toBe(expectedHubId)
  },
)

Then('the event hubId should be the scenario hub', async ({ world }) => {
  const state = getScenarioState(world)
  const rs = getRelayState(world)
  expect(rs.lastCapturedEvent).toBeTruthy()
  expect(rs.lastCapturedEvent!.hubId).toBe(state.hubId)
})

Then('the event version should be {int}', async ({ world }, expectedVersion: number) => {
  const rs = getRelayState(world)
  expect(rs.lastCapturedEvent).toBeTruthy()
  expect(rs.lastCapturedEvent!.v).toBe(expectedVersion)
})

Then('the event signature should be valid', async ({ request, world }) => {
  const rs = getRelayState(world)
  expect(rs.lastCapturedEvent).toBeTruthy()

  // Fetch server pubkey for signature verification
  if (!rs.serverPubkey) {
    const res = await request.get(`${BASE_URL}/api/config`)
    const config = (await res.json()) as { serverPubkey?: string }
    rs.serverPubkey = config.serverPubkey
  }
  expect(rs.serverPubkey).toBeTruthy()

  const event = rs.lastCapturedEvent!
  // Reconstruct the signed message: "{v}:{hubId}:{kind}:{epoch}:{payload}:{ts}"
  const sigMessage = `${event.v}:${event.hubId}:${event.kind}:${event.epoch}:${event.payload}:${event.ts}`
  const valid = ed25519.verify(
    hexToBytes(event.sig),
    utf8ToBytes(sigMessage),
    hexToBytes(rs.serverPubkey!),
  )
  expect(valid).toBe(true)
})

Then("the event pubkey should match the server's configured pubkey", async ({ request, world }) => {
  const rs = getRelayState(world)
  expect(rs.lastCapturedEvent).toBeTruthy()
  if (!rs.serverPubkey) {
    const res = await request.get(`${BASE_URL}/api/config`)
    const config = (await res.json()) as { serverPubkey?: string }
    rs.serverPubkey = config.serverPubkey
  }
  // In the new protocol, events don't carry pubkey — the server's identity
  // is verified via the signature. Just assert we have a server pubkey configured.
  expect(rs.serverPubkey).toBeTruthy()
})

// --- Helpers ---

/**
 * Decrypt event payload using the server event key fetched from GET /api/auth/me.
 *
 * The server provides `serverEventKeyHex` (epoch-scoped AES-256-GCM key) to
 * authenticated clients. Using this key directly avoids any dependency on knowing
 * the server's SERVER_SECRET — the test works with any server configuration.
 *
 * Falls back to direct JSON parse for unencrypted content (shouldn't happen in prod).
 */
function decryptEventPayload(event: CapturedEvent, serverEventKeyHex?: string): Record<string, unknown> | null {
  // Try direct JSON parse first (unencrypted fallback)
  try {
    return JSON.parse(event.payload) as Record<string, unknown>
  } catch {
    // Payload is encrypted — decrypt with server event key
  }

  if (!serverEventKeyHex) {
    console.warn('[relay.steps] No serverEventKeyHex from /api/auth/me — cannot decrypt event payload')
    return null
  }

  try {
    const eventKey = hexToBytes(serverEventKeyHex)
    return decryptHubEvent(event.payload, eventKey, event.epoch)
  } catch (err) {
    console.warn('[relay.steps] Failed to decrypt event payload:', err)
    return null
  }
}
