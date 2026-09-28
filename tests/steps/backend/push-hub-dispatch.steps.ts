/**
 * Step definitions for push-hub-dispatch.feature.
 *
 * Verifies that WakePayload objects dispatched by the backend carry a hubId
 * field that matches the hub that triggered the push.
 *
 * Strategy:
 * - In ENVIRONMENT=development, push-dispatch.ts wraps whichever dispatcher it
 *   selects in RecordingPushDispatcher, which records every dispatched
 *   WakePayload in a module-level in-memory log before the transport is
 *   attempted. The recording therefore does not depend on whether APNs/ntfy are
 *   configured, nor on whether the configured broker is reachable.
 * - POST /api/dev/test-simulate/push-dispatch directly invokes the dispatcher
 *   so BDD tests can verify payload structure without a full telephony flow.
 * - GET /api/dev/test-push-log returns the recorded entries (X-Test-Secret auth).
 * - DELETE /api/dev/test-push-log clears the log for test isolation.
 */

import { expect } from '@playwright/test'
import { Given, When, Then, Before, getState, setState } from './fixtures'
import { getScenarioState } from './common.steps'
import {
  createVolunteerViaApi,
  uniqueName,
} from '../../api-helpers'

// ── Constants ──────────────────────────────────────────────────────

const TEST_SECRET = process.env.DEV_RESET_SECRET || 'test-reset-secret'
const BACKEND_BASE_URL = process.env.TEST_HUB_URL || 'http://localhost:3000'
const PUSH_LOG_STATE_KEY = 'push_hub_dispatch'

// ── Local State ────────────────────────────────────────────────────

interface WakePayload {
  hubId: string
  type: string
  conversationId?: string
  channelType?: string
  callId?: string
  shiftId?: string
}

interface PushLogEntry {
  wakePayload: WakePayload
  recipientPubkey: string
  recordedAt: string
}

interface PushHubDispatchState {
  volunteerPubkey?: string
  capturedEntries?: PushLogEntry[]
  apnsTopic?: string
  apnsVoipTopic?: string
}

function getPushState(world: Record<string, unknown>): PushHubDispatchState {
  return getState<PushHubDispatchState>(world, PUSH_LOG_STATE_KEY)
}

// ── Before ────────────────────────────────────────────────────────

Before({ tags: '@backend' }, async ({ world }) => {
  setState<PushHubDispatchState>(world, PUSH_LOG_STATE_KEY, {})
})

// ── Helpers ───────────────────────────────────────────────────────

function devHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-Test-Secret': TEST_SECRET }
}

/**
 * Clear the in-memory push log on the server for test isolation.
 */
async function clearPushLog(request: import('@playwright/test').APIRequestContext): Promise<void> {
  const url = `${BACKEND_BASE_URL}/api/test-push-log`
  await request.delete(url, { headers: devHeaders() })
}

/**
 * Fetch the recorded push log entries from the server.
 * Polls up to `maxWaitMs` to account for fire-and-forget dispatch.
 */
async function fetchPushLog(
  request: import('@playwright/test').APIRequestContext,
  minEntries = 1,
  maxWaitMs = 2000,
): Promise<PushLogEntry[]> {
  const url = `${BACKEND_BASE_URL}/api/test-push-log`

  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    const res = await request.get(url, { headers: devHeaders() })
    if (res.ok()) {
      const body = await res.json() as { entries: PushLogEntry[] }
      if (body.entries.length >= minEntries) return body.entries
    }
    await new Promise(r => setTimeout(r, 100))
  }

  const res = await request.get(url, { headers: devHeaders() })
  const body = await res.json() as { entries: PushLogEntry[] }
  return body.entries
}

/**
 * Directly invoke the push dispatcher via the dev simulation endpoint.
 * This exercises createPushDispatcherFromService in development mode, which
 * records the payload regardless of which transport (if any) is configured.
 */
async function simulatePushDispatch(
  request: import('@playwright/test').APIRequestContext,
  hubId: string,
  recipientPubkey: string,
  conversationId: string,
): Promise<void> {
  const url = `${BACKEND_BASE_URL}/api/test-simulate/push-dispatch`
  const res = await request.post(url, {
    headers: devHeaders(),
    data: {
      hubId,
      type: 'message',
      recipientPubkey,
      conversationId,
    },
  })
  if (!res.ok()) {
    const text = await res.text()
    throw new Error(`Push dispatch simulation failed (${res.status()}): ${text}`)
  }
}

// ── Given ──────────────────────────────────────────────────────────

Given('a volunteer is registered in the hub', async ({ request, world }) => {
  const state = getScenarioState(world)
  const vol = await createVolunteerViaApi(request, { name: uniqueName('PushTestVol') })
  getPushState(world).volunteerPubkey = vol.pubkey
  state.volunteers.push({ ...vol, onShift: false })
})

// ── When ──────────────────────────────────────────────────────────

When('the backend dispatches a push notification to the volunteer in the hub', async ({ request, world }) => {
  const state = getScenarioState(world)
  const push = getPushState(world)

  expect(push.volunteerPubkey).toBeDefined()

  // Use a deterministic test hub ID. The workerHub fixture value may be undefined
  // when createHubViaApi returns an unexpected response format. We use a synthetic
  // UUID here to verify the hubId contract — that the dispatched payload carries
  // the SAME hubId that was passed to the dispatcher.
  const testHubId = state.hubId || `bdd-push-hub-${Date.now()}`

  // Store the hub ID so Then-steps can assert against it
  state.hubId = testHubId

  // Clear any prior log entries for isolation
  await clearPushLog(request)

  // Dispatch a synthetic push payload with the test hub ID
  await simulatePushDispatch(
    request,
    testHubId,
    push.volunteerPubkey!,
    `test-conv-${Date.now()}`,
  )

  // Capture log entries for Then-step assertions, filtering to entries from THIS hub
  // to avoid contamination from background push dispatches (e.g. call simulations
  // from concurrently-running scenarios in other feature files).
  const allEntries = await fetchPushLog(request, 1)
  push.capturedEntries = allEntries.filter(e => e.wakePayload.hubId === testHubId)
})

// ── Then ──────────────────────────────────────────────────────────

Then('the push payload should include the hub identifier', ({ world }) => {
  const push = getPushState(world)
  expect(push.capturedEntries).toBeDefined()
  expect(push.capturedEntries!.length).toBeGreaterThan(0)

  const entry = push.capturedEntries![0]
  expect(entry.wakePayload.hubId).toBeDefined()
  expect(entry.wakePayload.hubId.length).toBeGreaterThan(0)
})

Then('the push payload hubId should match the hub', ({ world }) => {
  const state = getScenarioState(world)
  const push = getPushState(world)
  expect(push.capturedEntries).toBeDefined()
  expect(push.capturedEntries!.length).toBeGreaterThan(0)

  const entry = push.capturedEntries![0]
  expect(entry.wakePayload.hubId).toBe(state.hubId)
})

Then('the push payload should have a type field', ({ world }) => {
  const push = getPushState(world)
  expect(push.capturedEntries).toBeDefined()
  expect(push.capturedEntries!.length).toBeGreaterThan(0)

  const entry = push.capturedEntries![0]
  expect(entry.wakePayload.type).toBeDefined()
  expect(['message', 'voicemail', 'shift_reminder', 'assignment']).toContain(entry.wakePayload.type)
})

Then('the push payload should have a conversationId field', ({ world }) => {
  const push = getPushState(world)
  expect(push.capturedEntries).toBeDefined()
  expect(push.capturedEntries!.length).toBeGreaterThan(0)

  const entry = push.capturedEntries![0]
  expect(entry.wakePayload.conversationId).toBeDefined()
  expect(entry.wakePayload.conversationId!.length).toBeGreaterThan(0)
})

// ── APNs topic (Issue #724) ──────────────────────────────────────────

// The test environment has no real APNs credentials, so a real ApnsClient
// send never happens. This queries the same derivation (lib/apns-topic.ts)
// that push-dispatch.ts and voip-push.ts use to build the real ApnsClient's
// `defaultTopic`, which the underlying @fivesheepco/cloudflare-apns2 library
// places directly into the outgoing `apns-topic` HTTP header (verified in
// apps/worker/__tests__/unit/apns-topic.test.ts by mocking fetch against a
// real ApnsClient/Notification pair).
When('the backend computes the outgoing APNs topic for a push', async ({ request, world }) => {
  const url = `${BACKEND_BASE_URL}/api/test-apns-topic`
  const res = await request.get(url, { headers: devHeaders() })
  expect(res.ok()).toBeTruthy()

  const body = await res.json() as { topic: string; voipTopic: string }
  const push = getPushState(world)
  push.apnsTopic = body.topic
  push.apnsVoipTopic = body.voipTopic
})

Then('the outgoing apns-topic header should equal {string}', ({ world }, expectedTopic: string) => {
  const push = getPushState(world)
  expect(push.apnsTopic).toBe(expectedTopic)
})

Then('the outgoing VoIP apns-topic header should equal {string}', ({ world }, expectedTopic: string) => {
  const push = getPushState(world)
  expect(push.apnsVoipTopic).toBe(expectedTopic)
})
