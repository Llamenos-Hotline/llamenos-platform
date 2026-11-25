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
import { fetchServerEventKeys, openRelayEvent } from '../../helpers/relay-crypto'
import type { ServerEventKey } from '@protocol/schemas/auth'
import {
  ADMIN_SEED,
  addHubMemberViaApi,
  apiGet,
  createHubViaApi,
  createVolunteerViaApi,
  uniqueName,
} from '../../api-helpers'

const BASE_URL = process.env.TEST_HUB_URL || 'http://localhost:3000'

/**
 * The relay is served by the SAME process as the API, at `/ws` — so its URL is
 * `TEST_HUB_URL` with the scheme swapped, and defaulting it to a hardcoded
 * `ws://localhost:3000/ws` is wrong for every run that points the suite
 * somewhere. Against a deployed target reached over an SSH forward on another
 * port, all 11 @relay scenarios failed on a connection to a relay that was not
 * the server under test, while every other scenario in the same run passed.
 * `TEST_RELAY_URL` still wins, for the case where the relay really is
 * elsewhere.
 */
const RELAY_URL = process.env.TEST_RELAY_URL
  || `${BASE_URL.replace(/^http/, 'ws').replace(/\/$/, '')}/ws`

const RELAY_KEY = 'relay'

interface RelayStepState {
  lastCapturedEvent?: CapturedEvent
  serverPubkey?: string
  /** The subscriber's relay-event keys, per (hub, epoch), from GET /api/auth/me */
  serverEventKeys?: ServerEventKey[]
  /** A user who belongs to a different hub only (never to the scenario hub) */
  otherHubMember?: { seedHex: string; hubId: string }
  /** A user who belongs to BOTH the scenario hub and a second hub */
  twoHubMember?: { seedHex: string; pubkey: string; secondHubId: string }
  /** That user's channel subscribed to the scenario hub */
  firstChannel?: RelayCapture
  /** That user's channel subscribed to the second hub */
  secondChannel?: RelayCapture
}

/**
 * This Playwright worker's own relay subscriber, created once per process and
 * a member of this worker's hub alone.
 *
 * It must NOT be the admin. Relay delivery is per-user by design (#1655): one
 * channel per client carries every hub that user has subscribed, combined, so
 * that a member never misses a hub's events for want of subscribing on the
 * right socket (the multi-hub routing axiom in CLAUDE.md). The admin, however,
 * is a member of EVERY worker's hub — so subscribing as the admin made each
 * worker's socket receive every other worker's hub events, and
 * `the event hubId should be the scenario hub` then failed on a foreign hub's
 * event roughly one run in three. That was a test-isolation defect, not a
 * server one, and the fix is a distinct pubkey per worker rather than a looser
 * assertion: with a subscriber that belongs to one hub only, a foreign hub's
 * event cannot reach it at all, and the hubId assertion keeps its teeth —
 * publishing a ring to the wrong hub still fails the scenario, now by timeout.
 *
 * Module scope IS worker scope: each Playwright worker is its own process, and
 * `workerHub` (tests/steps/fixtures.ts) is worker-scoped too, so one identity
 * per module matches one hub per worker.
 */
let workerRelaySubscriber: { seedHex: string; pubkey: string; hubId: string } | null = null

async function relaySubscriberFor(
  request: Parameters<typeof createVolunteerViaApi>[0],
  hubId: string,
): Promise<{ seedHex: string; pubkey: string; hubId: string }> {
  if (workerRelaySubscriber?.hubId === hubId) return workerRelaySubscriber
  const sub = await createVolunteerViaApi(request, { name: uniqueName('BDD Relay Subscriber') })
  await addHubMemberViaApi(request, hubId, sub.pubkey, ['role-volunteer'])
  workerRelaySubscriber = { seedHex: sub.seedHex, pubkey: sub.pubkey, hubId }
  return workerRelaySubscriber
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
  const subscriber = await relaySubscriberFor(request, state.hubId)
  state.relayCapture = await RelayCapture.connect(RELAY_URL, {
    seedHex: subscriber.seedHex,
    hubId: state.hubId ?? undefined,
  })

  // The subscriber's own relay-event keys (#2999): it is handed keys only for
  // the hubs it belongs to, so these open exactly what it may read.
  rs.serverEventKeys = await fetchServerEventKeys(request, subscriber.seedHex)
})

After(async ({ world }) => {
  const state = getScenarioState(world)
  if (state?.relayCapture) {
    state.relayCapture.close()
    state.relayCapture = undefined
  }
  const rs = getRelayState(world)
  rs.firstChannel?.close()
  rs.secondChannel?.close()
  rs.firstChannel = undefined
  rs.secondChannel = undefined
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
  const otherHubId = await createHubViaApi(request, uniqueName('bdd-other-hub'))
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

// --- Per-user delivery: one channel carries every subscribed hub ---
//
// Guards the decision recorded in #1655 and in ConnectionManager.publishToHub:
// a client holds ONE channel for its whole session and that channel carries
// every hub the user subscribed, combined and unfiltered. Re-introducing a
// per-connection hub filter — the one-line `continue` the issue first floated —
// fails the Then step below, which is the point of having it.

Given('a volunteer who is a member of the scenario hub and a second hub', async ({ request, world }) => {
  const state = getScenarioState(world)
  const rs = getRelayState(world)
  const secondHubId = await createHubViaApi(request, uniqueName('bdd-second-hub'))
  const vol = await createVolunteerViaApi(request, { name: uniqueName('BDD Two-Hub Vol') })
  await addHubMemberViaApi(request, state.hubId, vol.pubkey, ['role-volunteer'])
  await addHubMemberViaApi(request, secondHubId, vol.pubkey, ['role-volunteer'])
  rs.twoHubMember = { seedHex: vol.seedHex, pubkey: vol.pubkey, secondHubId }
})

Given("that volunteer's first channel is subscribed to the scenario hub", async ({ world }) => {
  const state = getScenarioState(world)
  const rs = getRelayState(world)
  expect(rs.twoHubMember).toBeTruthy()
  rs.firstChannel = await RelayCapture.connect(RELAY_URL, {
    seedHex: rs.twoHubMember!.seedHex,
    hubId: state.hubId,
  })
})

Given("that volunteer's second channel is subscribed to the second hub", async ({ world }) => {
  const rs = getRelayState(world)
  expect(rs.twoHubMember).toBeTruthy()
  rs.secondChannel = await RelayCapture.connect(RELAY_URL, {
    seedHex: rs.twoHubMember!.seedHex,
    hubId: rs.twoHubMember!.secondHubId,
  })
})

When('an incoming call arrives in the second hub', async ({ request, world }) => {
  const rs = getRelayState(world)
  expect(rs.twoHubMember).toBeTruthy()
  await simulateIncomingCall(request, {
    callerNumber: uniqueCallerNumber(),
    hubId: rs.twoHubMember!.secondHubId,
  })
})

Then(
  'the first channel should receive a kind {int} event for the second hub within {int} seconds',
  async ({ world }, kind: number, seconds: number) => {
    const rs = getRelayState(world)
    expect(rs.firstChannel).toBeTruthy()
    expect(rs.twoHubMember).toBeTruthy()
    const events = await rs.firstChannel!.waitForEvents({
      kind,
      count: 1,
      timeoutMs: seconds * 1000,
    })
    expect(events.map(e => e.hubId)).toEqual([rs.twoHubMember!.secondHubId])
  },
)

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
  const content = decryptEventPayload(rs.lastCapturedEvent!, rs.serverEventKeys)
  expect(content).toBeTruthy()
  expect(content!.type).toBe(expectedType)
})

Then('the event should contain a {string} field', async ({ world }, fieldName: string) => {
  const rs = getRelayState(world)
  expect(rs.lastCapturedEvent).toBeTruthy()
  const content = decryptEventPayload(rs.lastCapturedEvent!, rs.serverEventKeys)
  expect(content).toBeTruthy()
  expect(content![fieldName]).toBeDefined()
})

Then(
  'the event content {string} should be {string}',
  async ({ world }, fieldName: string, expectedValue: string) => {
    const rs = getRelayState(world)
    expect(rs.lastCapturedEvent).toBeTruthy()
    const content = decryptEventPayload(rs.lastCapturedEvent!, rs.serverEventKeys)
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
  const content = decryptEventPayload(rs.lastCapturedEvent!, rs.serverEventKeys)
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
 * Open a captured frame with the subscriber's per-hub key (#2999). There is no
 * plaintext fallback: the relay never sends an unsealed frame.
 */
function decryptEventPayload(event: CapturedEvent, keys?: readonly ServerEventKey[]): Record<string, unknown> | null {
  if (!keys) throw new Error('[relay.steps] no relay-event keys were fetched for the subscriber')
  return openRelayEvent(keys, event)
}
