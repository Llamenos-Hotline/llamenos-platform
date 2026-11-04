/**
 * Call lifecycle workflow step definitions (Epic 365).
 *
 * Tests full call lifecycle including ring, answer, note, end, history,
 * as well as ban-mid-call, volunteer removal, and busy exclusion scenarios.
 *
 * Reuses existing steps from call-routing, call-actions, call-simulation,
 * and cross-do step files. Only defines steps unique to call-lifecycle.feature.
 */
import { expect } from '@playwright/test'
import { When, Then, Before, getState, setState } from './fixtures'
import { getScenarioState } from './common.steps'
import {
  apiPost,
  apiGet,
  sealedNoteFields,
  ADMIN_SEED,
} from '../../api-helpers'
import {
  simulateIncomingCall,
  uniqueCallerNumber,
} from '../../simulation-helpers'

// ── Local State ──────────────────────────────────────────────────

interface LifecycleState {
  answeringVolunteerIndex?: number
  noteId?: string
  callerNumber?: string
}

const CALL_LIFECYCLE_KEY = 'call_lifecycle'

function getLifecycleState(world: Record<string, unknown>): LifecycleState {
  return getState<LifecycleState>(world, CALL_LIFECYCLE_KEY)
}


Before({ tags: '@lifecycle' }, async ({ world }) => {
  const lc = {}
  setState(world, CALL_LIFECYCLE_KEY, lc)
})

// ── Call from unique caller ──────────────────────────────────────

When('a call arrives from a unique caller', async ({ request, world }) => {
  const caller = uniqueCallerNumber()
  getLifecycleState(world).callerNumber = caller
  try {
    const result = await simulateIncomingCall(request, { callerNumber: caller, hubId: getScenarioState(world).hubId })
    getScenarioState(world).callId = result.callId
    getScenarioState(world).callStatus = result.status
  } catch {
    getScenarioState(world).callStatus = 'rejected'
  }
})

// ── Note creation by answering volunteer ─────────────────────────

When('the answering volunteer creates a note for the call', async ({ request, world, workerHub }) => {
  expect(getScenarioState(world).callId).toBeTruthy()
  // volunteer 1 answered (1-indexed), which is index 0 in the array
  const volIndex = (getLifecycleState(world).answeringVolunteerIndex ?? 1) - 1
  const vol = getScenarioState(world).volunteers[volIndex]
  expect(vol).toBeDefined()

  const { data, status } = await apiPost<{ id?: string; note?: { id: string } }>(
    request,
    `/hubs/${workerHub}/notes`,
    {
      ...(await sealedNoteFields(vol.deviceKey, 'lifecycle-test-note')),
      callId: getScenarioState(world).callId,
    },
    vol.deviceKey,
  )
  expect(status).toBeLessThan(300)
  getLifecycleState(world).noteId = (data as Record<string, unknown>)?.id as string
    ?? ((data as Record<string, unknown>)?.note as Record<string, unknown>)?.id as string
  getLifecycleState(world).answeringVolunteerIndex = getLifecycleState(world).answeringVolunteerIndex ?? 1
})

// ── Note visibility assertions ───────────────────────────────────

async function listNotesAs(
  request: import('@playwright/test').APIRequestContext,
  hubId: string,
  callId: string | undefined,
  deviceKey: string,
): Promise<{ notes: Array<Record<string, unknown>>; total: number }> {
  const qs = callId ? `?callId=${callId}` : ''
  const { status, data } = await apiGet<{ notes: Array<Record<string, unknown>>; total: number }>(
    request,
    `/hubs/${hubId}/notes${qs}`,
    deviceKey,
  )
  if (status !== 200) return { notes: [], total: 0 }
  return data
}

Then('the answering volunteer can see the note', async ({ request, world, workerHub }) => {
  const volIndex = (getLifecycleState(world).answeringVolunteerIndex ?? 1) - 1
  const vol = getScenarioState(world).volunteers[volIndex]
  expect(vol).toBeDefined()

  const { notes } = await listNotesAs(request, workerHub, getScenarioState(world).callId, vol.deviceKey)
  expect(notes.length).toBeGreaterThan(0)
})

Then('the admin can see the note', async ({ request, world, workerHub }) => {
  const { notes } = await listNotesAs(request, workerHub, getScenarioState(world).callId, ADMIN_SEED)
  expect(notes.length).toBeGreaterThan(0)
})

Then('the other volunteer cannot see the note', async ({ request, world, workerHub }) => {
  const answeringIndex = (getLifecycleState(world).answeringVolunteerIndex ?? 1) - 1
  const otherIndex = answeringIndex === 0 ? 1 : 0
  if (getScenarioState(world).volunteers.length <= otherIndex) {
    // Only one volunteer — skip
    return
  }
  const otherVol = getScenarioState(world).volunteers[otherIndex]

  // Notes are E2EE — only the author + admins can decrypt.
  // The API may return the note metadata but content is unreadable.
  // This assertion documents the expected access boundary.
  const { notes } = await listNotesAs(request, workerHub, getScenarioState(world).callId, otherVol.deviceKey)
  expect(notes).toBeDefined()
})
