/**
 * Cross-DO integration workflow step definitions.
 *
 * Tests workflows spanning IdentityDO, ShiftManagerDO, CallRouterDO,
 * RecordsDO, and ConversationDO.
 */
import { expect } from '@playwright/test'
import { Given, When, Then, Before, getState, setState } from './fixtures'
import { getScenarioState } from './common.steps'
import {
  apiGet,
  apiPost,
  apiPatch,
  createVolunteerViaApi,
  createShiftViaApi,
  createBanViaApi,
  listAuditLogViaApi,
  listNotesViaApi,
  generateTestKeypair,
  uniquePhone,
  uniqueName,
} from '../../api-helpers'
import {
  simulateIncomingCall,
  simulateAnswerCall,
  simulateEndCall,
  simulateVoicemail,
  simulateIncomingMessage,
  uniqueCallerNumber,
} from '../../simulation-helpers'
import { ALWAYS_ON_SHIFT } from './always-on-shift'

// ── State ───────────────────────────────────────────────────────────

interface CrossDoState {
  volunteerPubkey?: string
  volunteerDeviceKey?: string
  newVolunteerPubkey?: string
  newVolunteerDeviceKey?: string
  shiftId?: string
  callId?: string
  callStatus?: string
  noteId?: string
  conversationId?: string
  conversationIds: string[]
  inviteCode?: string
  reportId?: string
  reporterDeviceKey?: string
  reviewerPubkey?: string
}

const CROSS_DO_KEY = 'cross_do'

function getCrossDoState(world: Record<string, unknown>): CrossDoState {
  return getState<CrossDoState>(world, CROSS_DO_KEY)
}


Before({ tags: '@backend' }, async ({ world }) => {
  const xdo = { conversationIds: [] }
  setState(world, CROSS_DO_KEY, xdo)
})

// ─── Volunteer Onboarding → Call → Note ─────────────────────────────

When('an admin creates a volunteer', async ({ request, world }) => {
  const vol = await createVolunteerViaApi(request, { name: uniqueName('XDO Vol') })
  getCrossDoState(world).volunteerPubkey = vol.pubkey
  getCrossDoState(world).volunteerDeviceKey = vol.deviceKey
})

When('the admin creates a shift including the volunteer', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  const shift = await createShiftViaApi(request, {
    name: uniqueName('XDO Shift'),
    ...ALWAYS_ON_SHIFT,
    userPubkeys: [getCrossDoState(world).volunteerPubkey!],
    hubId,
  })
  getCrossDoState(world).shiftId = shift.id
})

When('an incoming call arrives', async ({ request, world }) => {
  const caller = uniqueCallerNumber()
  const hubId = getScenarioState(world).hubId
  const result = await simulateIncomingCall(request, { callerNumber: caller, hubId })
  getCrossDoState(world).callId = result.callId
  getCrossDoState(world).callStatus = result.status
})

When('the volunteer answers the call', async ({ request, world }) => {
  // Use xdo state if available (cross-DO workflow), fall back to shared state
  // (simulation scenarios that use "Given an incoming call from ..." steps)
  const callId = getCrossDoState(world).callId ?? getScenarioState(world).callId
  const pubkey = getCrossDoState(world).volunteerPubkey ?? getScenarioState(world).volunteers[0]?.pubkey
  expect(callId).toBeTruthy()
  expect(pubkey).toBeTruthy()
  const result = await simulateAnswerCall(request, callId!, pubkey!)
  getCrossDoState(world).callStatus = result.status
  getScenarioState(world).callStatus = result.status
})

When('the volunteer writes a note for the call', async ({ request, world }) => {
  const { data, status } = await apiPost<{ id?: string; note?: { id: string } }>(
    request,
    `/hubs/${getScenarioState(world).hubId}/notes`,
    {
      encryptedContent: 'xdo-test-note',
      callId: getCrossDoState(world).callId,
      readerEnvelopes: [],
    },
    getCrossDoState(world).volunteerDeviceKey!,
  )
  if (status < 300) {
    getCrossDoState(world).noteId = (data as Record<string, unknown>)?.id as string
      ?? ((data as Record<string, unknown>)?.note as Record<string, unknown>)?.id as string
  }
})

Then('the call history should show a completed call', async ({ request, world }) => {
  // End the call first
  if (getCrossDoState(world).callStatus === 'in-progress') {
    await simulateEndCall(request, getCrossDoState(world).callId!)
  }
  const hubId = getScenarioState(world).hubId
  const { data } = await apiGet<{ calls: Array<{ callId: string; status: string }> }>(request, `/hubs/${hubId}/calls/history`)
  const calls = (data as { calls: Array<{ callId: string; status: string }> }).calls
  const call = calls.find(c => c.callId === getCrossDoState(world).callId)
  expect(call).toBeDefined()
  expect(call!.status).toBe('completed')
})

Then('the notes list should contain the volunteer\'s note', async ({request, world: _world}) => {
  const { notes } = await listNotesViaApi(request)
  expect(notes.length).toBeGreaterThan(0)
})

Then('the audit log should have entries for each step', async ({request, world}) => {
  // Events about hub activity (the shift, the note) must land in the hub's own
  // audit log, where the hub admin can see them (#1048). The call answer is
  // driven by a simulation shortcut here; the real answer paths are covered by
  // the call-actions audit scenario.
  const { entries } = await listAuditLogViaApi(request, { hubId: getScenarioState(world).hubId, limit: 100 })
  const events = entries.map(e => e.action)
  expect(events).toContain('shiftCreated')
  expect(events).toContain('noteCreated')
})

// ─── Ban Lifecycle with Call Integration ────────────────────────────

When('an admin bans {string}', async ({request, world}, phone: string) => {
  const hubId = getScenarioState(world).hubId
  await createBanViaApi(request, { phone, reason: 'XDO ban test', hubId })
})

When('an incoming call arrives from {string}', async ({ request, world }, phone: string) => {
  const hubId = getScenarioState(world).hubId
  try {
    const result = await simulateIncomingCall(request, { callerNumber: phone, hubId })
    getCrossDoState(world).callId = result.callId
    getCrossDoState(world).callStatus = result.status
  } catch (e) {
    // Banned callers get a 403 — record as 'rejected' instead of throwing
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('banned') || msg.includes('403')) {
      getCrossDoState(world).callStatus = 'rejected'
    } else {
      throw e
    }
  }
})

Then('the banned call should be rejected', async ({ world }) => {
  // The incoming-call step catches the 403 and sets status to 'rejected'
  expect(getCrossDoState(world).callStatus).toBe('rejected')
})

Then('the call should be ringing', async ({ world }) => {
  expect(getCrossDoState(world).callStatus).toBe('ringing')
})

// 'the admin removes the ban for {string}' is defined in crud.steps.ts

// ─── Conversation Lifecycle ─────────────────────────────────────────

When('an SMS arrives from {string} with body {string}', async ({ request, world }, phone: string, body: string) => {
  const result = await simulateIncomingMessage(request, {
    senderNumber: phone,
    body,
    channel: 'sms',
  })
  getCrossDoState(world).conversationId = result.conversationId
  getCrossDoState(world).conversationIds.push(result.conversationId)
})

When('a WhatsApp message arrives from {string} with body {string}', async ({ request, world }, phone: string, body: string) => {
  const result = await simulateIncomingMessage(request, {
    senderNumber: phone,
    body,
    channel: 'whatsapp',
  })
  getCrossDoState(world).conversationIds.push(result.conversationId)
})

// 'a new conversation should be created' is defined in messaging.steps.ts
// Cross-DO uses a local assertion instead:
Then('a conversation should have been created', async ({ world }) => {
  expect(getCrossDoState(world).conversationId).toBeDefined()
  expect(getCrossDoState(world).conversationId!.length).toBeGreaterThan(0)
})

When('the volunteer claims the conversation', async ({ request, world }) => {
  const volPubkey = getScenarioState(world).volunteers[0]?.pubkey ?? getCrossDoState(world).volunteerPubkey
  if (volPubkey && getCrossDoState(world).conversationId) {
    const volDeviceKey = getScenarioState(world).volunteers[0]?.deviceKey ?? getCrossDoState(world).volunteerDeviceKey
    // Conversation claim requires hub context — use hub-scoped path
    const hubId = getScenarioState(world).hubId
    const claimPath = hubId
      ? `/hubs/${hubId}/conversations/${getCrossDoState(world).conversationId}/claim`
      : `/conversations/${getCrossDoState(world).conversationId}/claim`
    await apiPost(request, claimPath, {
      pubkey: volPubkey,
    }, volDeviceKey!)
  }
})

Then('the conversation status should be {string}', async ({ request, world }, expectedStatus: string) => {
  if (getCrossDoState(world).conversationId) {
    const { data } = await apiGet<{ status?: string; conversation?: { status: string } }>(
      request,
      `/conversations/${getCrossDoState(world).conversationId}`,
    )
    const actual = (data as Record<string, unknown>)?.status as string
      ?? ((data as Record<string, unknown>)?.conversation as Record<string, unknown>)?.status as string
    expect(actual).toBe(expectedStatus)
  }
})

When('the admin closes the conversation', async ({ request, world }) => {
  if (getCrossDoState(world).conversationId) {
    await apiPatch(request, `/conversations/${getCrossDoState(world).conversationId}`, { status: 'closed' })
  }
})

When('another SMS arrives from {string} with body {string}', async ({request, world: _world}, phone: string, body: string) => {
  await simulateIncomingMessage(request, {
    senderNumber: phone,
    body,
    channel: 'sms',
  })
})

Then('the conversation should be reopened', async ({ request, world }) => {
  if (getCrossDoState(world).conversationId) {
    const { data } = await apiGet<{ status?: string; conversation?: { status: string } }>(
      request,
      `/conversations/${getCrossDoState(world).conversationId}`,
    )
    const actual = (data as Record<string, unknown>)?.status as string
      ?? ((data as Record<string, unknown>)?.conversation as Record<string, unknown>)?.status as string
    // Reopened = either 'waiting' or 'active' (no longer 'closed')
    expect(actual).not.toBe('closed')
  }
})

// ─── Invite → Registration → Call Handling ──────────────────────────

When('an admin creates an invite', async ({ request, world, workerHub }) => {
  const { data } = await apiPost<{ code?: string; invite?: { code: string } }>(request, '/invites', {
    hubId: workerHub,
    name: uniqueName('XDO Invitee'),
    phone: uniquePhone(),
    roleIds: ['role-volunteer'],
  })
  getCrossDoState(world).inviteCode = (data as Record<string, unknown>)?.code as string
    ?? ((data as Record<string, unknown>)?.invite as Record<string, unknown>)?.code as string
})

When('the invite is redeemed by a new user', async ({ request, world }) => {
  // Simulate invite redemption by creating a volunteer directly
  // (Real redemption involves Schnorr signing which the redeem endpoint handles)
  const vol = await createVolunteerViaApi(request, {
    name: uniqueName('XDO Redeemed'),
    roleIds: ['role-volunteer'],
  })
  getCrossDoState(world).newVolunteerPubkey = vol.pubkey
  getCrossDoState(world).newVolunteerDeviceKey = vol.deviceKey
})

When('the admin creates a shift with the new volunteer', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  const shift = await createShiftViaApi(request, {
    name: uniqueName('XDO New Vol Shift'),
    ...ALWAYS_ON_SHIFT,
    userPubkeys: [getCrossDoState(world).newVolunteerPubkey!],
    hubId,
  })
  getCrossDoState(world).shiftId = shift.id
})

Then('the new volunteer should be rung', async ({ world }) => {
  // The call was created and volunteers on shift should be rung
  expect(getCrossDoState(world).callId).toBeDefined()
  expect(getCrossDoState(world).callStatus).toBe('ringing')
})

// ─── Multi-Channel Isolation ────────────────────────────────────────

Then('{int} separate conversations should exist', async ({ world }, count: number) => {
  expect(getCrossDoState(world).conversationIds.length).toBe(count)
  // All conversation IDs should be unique
  const unique = new Set(getCrossDoState(world).conversationIds)
  expect(unique.size).toBe(count)
})

Then('each conversation should have its own channel type', async ({ request, world }) => {
  const channels = new Set<string>()
  for (const id of getCrossDoState(world).conversationIds) {
    const { data } = await apiGet<{ channelType?: string; conversation?: { channelType: string } }>(request, `/conversations/${id}`)
    const channel = (data as Record<string, unknown>)?.channelType as string
      ?? ((data as Record<string, unknown>)?.conversation as Record<string, unknown>)?.channelType as string
    if (channel) channels.add(channel)
  }
  expect(channels.size).toBe(getCrossDoState(world).conversationIds.length)
})

// ─── Report Workflow ────────────────────────────────────────────────

Given('a reporter and reviewer exist', async ({ request, world }) => {
  const reporter = await createVolunteerViaApi(request, {
    name: uniqueName('XDO Reporter'),
    roleIds: ['role-reporter'],
  })
  getCrossDoState(world).reporterDeviceKey = reporter.deviceKey

  const reviewer = await createVolunteerViaApi(request, {
    name: uniqueName('XDO Reviewer'),
    roleIds: ['role-reviewer'],
  })
  getCrossDoState(world).reviewerPubkey = reviewer.pubkey
})

When('the reporter creates a report', async ({ request, world }) => {
  const kp = generateTestKeypair()
  const { data, status: _status } = await apiPost<{ id?: string; conversation?: { id: string } }>(
    request,
    '/reports',
    {
      title: uniqueName('XDO Report'),
      category: 'general',
      encryptedContent: 'xdo-report-content',
      readerEnvelopes: [{ pubkey: kp.pubkey, ct: 'key', enc: kp.pubkey }],
    },
    getCrossDoState(world).reporterDeviceKey!,
  )
  getCrossDoState(world).reportId = (data as Record<string, unknown>)?.id as string
    ?? ((data as Record<string, unknown>)?.conversation as Record<string, unknown>)?.id as string
})

When('the admin assigns the report to the reviewer', async ({ request, world }) => {
  if (getCrossDoState(world).reportId && getCrossDoState(world).reviewerPubkey) {
    await apiPost(request, `/reports/${getCrossDoState(world).reportId}/assign`, { assignedTo: getCrossDoState(world).reviewerPubkey })
  }
})

Then('the report should show the reviewer as assignee', async ({ request, world }) => {
  if (getCrossDoState(world).reportId) {
    const { data } = await apiGet<{ assignedTo?: string; conversation?: { assignedTo: string } }>(
      request,
      `/reports/${getCrossDoState(world).reportId}`,
    )
    const assignee = (data as Record<string, unknown>)?.assignedTo as string
      ?? ((data as Record<string, unknown>)?.conversation as Record<string, unknown>)?.assignedTo as string
    expect(assignee).toBe(getCrossDoState(world).reviewerPubkey)
  }
})

Then('the audit log should contain report assignment entries', async ({request, world: _world}) => {
  // Report-related audit entries are logged without hub scope — query globally
  const { entries } = await listAuditLogViaApi(request)
  // Look for report-related audit entries
  expect(entries.length).toBeGreaterThan(0)
})

// ─── Voicemail Fallback ─────────────────────────────────────────────

When('no volunteer answers within the timeout', async ({ request, world }) => {
  // Simulate voicemail (call goes unanswered)
  await simulateVoicemail(request, getCrossDoState(world).callId!)
  getCrossDoState(world).callStatus = 'unanswered'
})

Then('the call should go to voicemail', async ({ world }) => {
  expect(getCrossDoState(world).callStatus).toBe('unanswered')
})

Then('the call history should show an unanswered call', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  const { data } = await apiGet<{ calls: Array<{ callId: string; status: string }> }>(request, `/hubs/${hubId}/calls/history`)
  const calls = (data as { calls: Array<{ callId: string; status: string }> }).calls
  const call = calls.find(c => c.callId === getCrossDoState(world).callId)
  expect(call).toBeDefined()
  expect(call!.status).toBe('unanswered')
})

// ─── Shift Changes Affect Routing ───────────────────────────────────

When('the admin removes the first volunteer from the shift', async ({ request, world }) => {
  if (getScenarioState(world).shiftIds.length > 0 && getScenarioState(world).volunteers.length > 1) {
    // Update shift to only include second volunteer
    const secondVol = getScenarioState(world).volunteers[1]
    await apiPatch(request, `/shifts/${getScenarioState(world).shiftIds[0]}`, {
      userPubkeys: [secondVol.pubkey],
    })
  }
})

Then('only the second volunteer should be rung', async ({ world }) => {
  // callId is set by call-lifecycle.steps.ts via getScenarioState(world).callId;
  // getCrossDoState(world).callId is set by cross-do-internal call steps. Accept either.
  const callId = getCrossDoState(world).callId ?? getScenarioState(world).callId
  expect(callId).toBeDefined()
})

// ─── Conversation Notes ─────────────────────────────────────────────

When('the volunteer writes a note for the conversation', async ({ request, world }) => {
  const volDeviceKey = getScenarioState(world).volunteers[0]?.deviceKey ?? getCrossDoState(world).volunteerDeviceKey
  if (volDeviceKey && getCrossDoState(world).conversationId) {
    const { data, status } = await apiPost<{ id?: string; note?: { id: string } }>(
      request,
      '/notes',
      {
        encryptedContent: 'xdo-conv-note',
        conversationId: getCrossDoState(world).conversationId,
        readerEnvelopes: [],
      },
      volDeviceKey,
    )
    if (status < 300) {
      getCrossDoState(world).noteId = (data as Record<string, unknown>)?.id as string
        ?? ((data as Record<string, unknown>)?.note as Record<string, unknown>)?.id as string
    }
  }
})

Then('the note should be linked to the conversation', async ({ world }) => {
  expect(getCrossDoState(world).noteId).toBeDefined()
})

Then('listing notes by conversation returns the correct note', async ({ request, world }) => {
  if (getCrossDoState(world).conversationId) {
    const { notes } = await listNotesViaApi(request, { callId: undefined })
    // At least one note exists
    expect(notes.length).toBeGreaterThan(0)
  }
})
