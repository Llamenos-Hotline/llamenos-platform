/**
 * Common backend step definitions — volunteer/shift/ban setup.
 * Hub isolation via workerHub fixture replaces server resets.
 */
import { Given, Before, getState, setState } from './fixtures'
import {
  createVolunteerViaApi,
  createShiftViaApi,
  createBanViaApi,
  type CreateVolunteerResult,
} from '../../api-helpers'
import type { RelayCapture } from '../../helpers/relay-capture'
import {
  simulateIncomingCall,
  simulateAnswerCall,
  simulateEndCall,
  uniqueCallerNumber,
} from '../../simulation-helpers'
import { ALWAYS_ON_SHIFT } from './always-on-shift'

const STATE_KEY = 'common'

/** Shared scenario state — reset before each scenario via Before hook. */
export interface ScenarioState {
  volunteers: Array<CreateVolunteerResult & { onShift?: boolean }>
  shiftIds: string[]
  callId?: string
  callStatus?: string
  conversationId?: string
  messageId?: string
  lastApiResponse?: { status: number; data: unknown }
  banPhones: string[]
  /** Maps plaintext phone → server-hashed phone (from ban API responses) */
  phoneHashMap: Record<string, string>
  relayCapture?: RelayCapture
  hubId: string
}

/** Get the common ScenarioState from the world fixture. */
export function getScenarioState(world: Record<string, unknown>): ScenarioState {
  return getState<ScenarioState>(world, STATE_KEY)
}

Before(async ({ world, workerHub }) => {
  const s: ScenarioState = {
    volunteers: [],
    shiftIds: [],
    banPhones: [],
    phoneHashMap: {},
    hubId: workerHub,
  }
  setState(world, STATE_KEY, s)
})

// ── Server Reset (no-op) ───────────────────────────────────────────
// Hub isolation via workerHub fixture replaces server resets.
// This step is kept as a no-op so any remaining references compile.

Given('the server is reset', async () => {
  // No-op: each Playwright worker uses an isolated hub (workerHub fixture).
  // Data created in one worker never affects another.
})

// No-op: admin authentication is handled by the workerHub fixture + ADMIN_SEED.
// This step exists so feature file backgrounds that document auth context compile.
Given('the admin is authenticated', async () => {})

// ── Volunteer Setup ────────────────────────────────────────────────

Given('{int} volunteers are on shift', async ({ request, world }, count: number) => {
  const state = getScenarioState(world)
  const volunteers: Array<CreateVolunteerResult & { onShift?: boolean }> = []

  for (let i = 0; i < count; i++) {
    const vol = await createVolunteerViaApi(request, {
      name: `BDD Vol ${Date.now()}-${i}`,
    })
    volunteers.push({ ...vol, onShift: true })
  }

  // Create a hub-scoped shift with all volunteers assigned and covering now
  const pubkeys = volunteers.map(v => v.pubkey)
  const shift = await createShiftViaApi(request, {
    name: `BDD Shift ${Date.now()}`,
    ...ALWAYS_ON_SHIFT,
    userPubkeys: pubkeys,
    hubId: state.hubId,
  })

  state.volunteers = volunteers
  state.shiftIds.push(shift.id)
})

// ── Ban Setup ──────────────────────────────────────────────────────

Given('{string} is on the ban list', async ({ request, world }, phone: string) => {
  const state = getScenarioState(world)
  await createBanViaApi(request, { phone, reason: 'BDD test ban', hubId: state.hubId })
  state.banPhones.push(phone)
})

// ── Call Completion Setup ──────────────────────────────────────────

Given('{int} calls were completed today', async ({ request, world }, count: number) => {
  const state = getScenarioState(world)
  for (let i = 0; i < count; i++) {
    const caller = uniqueCallerNumber()
    const { callId } = await simulateIncomingCall(request, { callerNumber: caller, hubId: state.hubId })
    if (state.volunteers.length > 0) {
      await simulateAnswerCall(request, callId, state.volunteers[0].pubkey)
      await simulateEndCall(request, callId)
    }
  }
})

Given('{int} call went to voicemail today', async ({ request, world }, count: number) => {
  const state = getScenarioState(world)
  const { simulateVoicemail } = await import('../../simulation-helpers')
  for (let i = 0; i < count; i++) {
    const caller = uniqueCallerNumber()
    const { callId } = await simulateIncomingCall(request, { callerNumber: caller, hubId: state.hubId })
    await simulateVoicemail(request, callId)
  }
})
