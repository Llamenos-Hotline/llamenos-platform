/**
 * Backend step definitions for provider-held recordings (#2297): a voicemail is fetched and
 * then deleted AT THE PROVIDER, a refused deletion stays visible, and the hub's recording
 * posture reports what it read from the provider rather than what it assumes. #2309 adds
 * the write path (enforce) and the per-provider statement of what the provider retains.
 *
 * Drives the real voicemail processing path through the MockTelephonyAdapter, so these run
 * in the serial backend-bdd-simulated-telephony project alongside simulated-telephony.steps.ts.
 */
import { expect } from '@playwright/test'
import { When, Then } from './fixtures'
import { getScenarioState } from './common.steps'
import { setLastResponse } from './shared-state'
import { apiGet, apiPost } from '../../api-helpers'

interface SimulatedVoicemailResponse {
  ok?: boolean
  callId?: string
  recordingDeletion?: 'deleted' | 'failed'
  error?: string
}

interface PostureSetting {
  state: 'on' | 'off' | 'unknown'
  evidence?: string
  reason?: string
}

interface HeldRecording {
  callId: string
  kind: 'voicemail' | 'call' | 'call-log'
  deleteAttempts: number
  lastError: string | null
}

interface RecordingPostureResponse {
  provider: string
  recording: PostureSetting
  transcription: PostureSetting
  heldAtProvider: HeldRecording[]
  retention: {
    removed: Array<{ what: string; how: string }>
    retained: Array<{ what: string; reason: string }>
    source: string
  }
}

interface EnforcementAction {
  setting: 'recording' | 'transcription'
  target: string
  outcome: 'disabled' | 'already-off' | 'not-settable' | 'failed'
  evidence?: string
  reason?: string
}

interface EnforcementResponse {
  actions: EnforcementAction[]
  posture: RecordingPostureResponse
}

function lastVoicemail(world: Record<string, unknown>): SimulatedVoicemailResponse {
  const res = getScenarioState(world).lastApiResponse
  if (!res) throw new Error('no voicemail was simulated')
  return res.data as SimulatedVoicemailResponse
}

async function readPosture(
  request: Parameters<typeof apiGet>[0],
  hubId: string,
): Promise<RecordingPostureResponse> {
  const res = await apiGet<RecordingPostureResponse>(request, `/hubs/${hubId}/settings/telephony-provider/recording-posture`)
  expect(res.status, `reading the recording posture failed: ${JSON.stringify(res.data)}`).toBe(200)
  return res.data
}

When(
  'the simulated caller leaves a voicemail the provider holds as {string}',
  async ({ request, world }, recordingSid: string) => {
    const state = getScenarioState(world)
    const callId = state.callId
    if (!callId) throw new Error('no simulated call to leave a voicemail on')
    const res = await apiPost<SimulatedVoicemailResponse>(
      request,
      `/hubs/${state.hubId}/simulated-telephony/simulate/voicemail`,
      { callId, recordingSid },
    )
    state.lastApiResponse = res
    setLastResponse(world, res)
  },
)

Then('the provider should have confirmed deleting the voicemail recording', async ({ world }) => {
  expect(lastVoicemail(world).recordingDeletion).toBe('deleted')
})

Then('the provider deletion of the voicemail recording should be reported as failed', async ({ world }) => {
  const data = lastVoicemail(world)
  expect(data.recordingDeletion).toBe('failed')
  expect(data.error, 'a failed deletion must say why').toBeTruthy()
})

Then(
  "the hub's recording posture should show {int} recording(s) still held at the provider",
  async ({ request, world }, count: number) => {
    const { hubId } = getScenarioState(world)
    const posture = await readPosture(request, hubId)
    expect(posture.heldAtProvider).toHaveLength(count)
  },
)

Then("the recording still held at the provider should carry the provider's refusal", async ({ request, world }) => {
  const { hubId, callId } = getScenarioState(world)
  const posture = await readPosture(request, hubId)
  const held = posture.heldAtProvider.find(r => r.callId === callId)
  if (!held) throw new Error(`the refused recording for ${callId} is not tracked`)
  expect(held.kind).toBe('voicemail')
  expect(held.deleteAttempts).toBeGreaterThanOrEqual(1)
  expect(held.lastError, 'the refusal must be recorded, not swallowed').toBeTruthy()
})

Then('the hub call history should contain {int} call with a voicemail', async ({ request, world }, count: number) => {
  const { hubId } = getScenarioState(world)
  const res = await apiGet<{ calls: Array<{ hasVoicemail?: boolean }> }>(request, `/hubs/${hubId}/calls/history?limit=100`)
  expect(res.status).toBe(200)
  expect(res.data.calls.filter(c => c.hasVoicemail === true)).toHaveLength(count)
})

When("the admin reads the hub's recording posture", async ({ request, world }) => {
  const state = getScenarioState(world)
  const res = await apiGet<RecordingPostureResponse>(request, `/hubs/${state.hubId}/settings/telephony-provider/recording-posture`)
  state.lastApiResponse = res
  setLastResponse(world, res)
})

When("volunteer {int} reads the hub's recording posture", async ({ request, world }, index: number) => {
  const state = getScenarioState(world)
  const vol = state.volunteers[index]
  expect(vol).toBeDefined()
  const res = await apiGet(request, `/hubs/${state.hubId}/settings/telephony-provider/recording-posture`, vol.deviceKey)
  state.lastApiResponse = res
  setLastResponse(world, res)
})

Then(
  'the posture should report provider-side {word} as {string} with the evidence it read',
  async ({ world }, setting: string, expected: string) => {
    expect(['recording', 'transcription']).toContain(setting)
    const data = getScenarioState(world).lastApiResponse?.data as RecordingPostureResponse
    const value = setting === 'recording' ? data.recording : data.transcription
    expect(value.state).toBe(expected)
    // "off" is a claim about what was read; with nothing read it would have to be "unknown".
    if (expected === 'unknown') expect(value.reason, 'unknown must say why').toBeTruthy()
    else expect(value.evidence, `${setting}=${expected} must name what it was read from`).toBeTruthy()
  },
)

When("the admin enforces the hub's recording posture", async ({ request, world }) => {
  const state = getScenarioState(world)
  const res = await apiPost<EnforcementResponse>(request, `/hubs/${state.hubId}/settings/telephony-provider/recording-posture/enforce`, {})
  state.lastApiResponse = res
  setLastResponse(world, res)
})

When("volunteer {int} enforces the hub's recording posture", async ({ request, world }, index: number) => {
  const state = getScenarioState(world)
  const vol = state.volunteers[index]
  expect(vol).toBeDefined()
  const res = await apiPost(request, `/hubs/${state.hubId}/settings/telephony-provider/recording-posture/enforce`, {}, vol.deviceKey)
  state.lastApiResponse = res
  setLastResponse(world, res)
})

Then('the posture should name at least one thing the provider retains, with the reason', async ({ world }) => {
  const data = getScenarioState(world).lastApiResponse?.data as RecordingPostureResponse
  // An empty "retained" list would read as "the provider keeps nothing" — the claim #2309
  // exists to stop anyone making without evidence.
  expect(data.retention.retained.length).toBeGreaterThan(0)
  for (const item of data.retention.retained) {
    expect(item.what).toBeTruthy()
    expect(item.reason).toBeTruthy()
  }
  expect(data.retention.source).toBeTruthy()
})

Then('every enforcement action should carry its evidence or its reason', async ({ world }) => {
  const data = getScenarioState(world).lastApiResponse?.data as EnforcementResponse
  expect(data.actions.length).toBeGreaterThan(0)
  for (const action of data.actions) {
    if (action.outcome === 'disabled' || action.outcome === 'already-off') expect(action.evidence).toBeTruthy()
    else expect(action.reason).toBeTruthy()
  }
})

Then(
  'the re-read posture should report provider-side recording as {string} with the evidence it read',
  async ({ world }, expected: string) => {
    const data = getScenarioState(world).lastApiResponse?.data as EnforcementResponse
    expect(data.posture.recording.state).toBe(expected)
    expect(data.posture.recording.evidence).toBeTruthy()
  },
)
