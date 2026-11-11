/**
 * Backend step definitions for CMS assignment (EP06-A3).
 *
 * Tests the 4-component scoring formula fields in suggest-assignees responses
 * and the autoAssign/requiredSpecializations entity type fields.
 *
 * Reuses:
 *   - entity-schema.steps.ts: "case management is enabled", "an entity type {string} exists"
 *   - assertions.steps.ts: "the response status should be {int}"
 *   - cms.steps.ts: "a volunteer exists for assignment", "an unassigned arrest case exists"
 */
import { expect } from '@playwright/test'
import { Given, When, Then, Before, getState, setState } from './fixtures'
import { getScenarioState } from './common.steps'
import { getSharedState, setLastResponse } from './shared-state'
import {
  apiGet,
  apiPatch,
  apiPost,
  createUserViaApi,
  createRecordViaApi,
  createShiftViaApi,
  listEntityTypesViaApi,
  uniqueName,
} from '../../api-helpers'
import { ALWAYS_ON_SHIFT } from '@shared/always-on-shift'

// ── Local State ────────────────────────────────────────────────────

interface AssignmentState {
  recordId?: string
  entityTypeId?: string
  entityTypeDetails?: Record<string, unknown>
  volunteerAPubkey?: string
  volunteerBPubkey?: string
  /** Volunteers the "on-shift volunteers exist" Given put on shift in the scenario hub. */
  onShiftPubkeys?: string[]
  suggestions?: Array<Record<string, unknown>>
}

const ASSIGNMENT_KEY = 'assignment_ep06a3'

function getAssignmentState(world: Record<string, unknown>): AssignmentState {
  return getState<AssignmentState>(world, ASSIGNMENT_KEY)
}

/** Every volunteer the scenario put on shift was scored — so the per-suggestion checks have a subject. */
function expectScoredOnShiftVolunteers(world: Record<string, unknown>, suggestions: Array<Record<string, unknown>>): void {
  const expected = getAssignmentState(world).onShiftPubkeys ?? []
  expect(expected.length, 'no volunteer was put on shift: the scenario has no subject').toBeGreaterThan(0)
  expect(suggestions.map(s => s.pubkey)).toEqual(expect.arrayContaining(expected))
}

Before({ tags: '@backend' }, async ({ world }) => {
  setState(world, ASSIGNMENT_KEY, {} as AssignmentState)
})

// ── Entity Type with autoAssign ────────────────────────────────────

Given('an entity type with autoAssign enabled and threshold {int} exists', async ({ request, world }, threshold: number) => {
  const hubId = getScenarioState(world).hubId
  const name = uniqueName('auto_assign_scoring', '_')
  const label = 'Auto Assign Scoring'
  const { data, status } = await apiPost<Record<string, unknown>>(
    request,
    `/hubs/${hubId}/settings/cms/entity-types`,
    {
      name,
      label,
      labelPlural: `${label}s`,
      description: 'Entity type for autoAssign threshold testing',
      category: 'case',
      hubId,
      statuses: [
        { value: 'open', label: 'Open', order: 0 },
        { value: 'closed', label: 'Closed', order: 1 },
      ],
      defaultStatus: 'open',
      closedStatuses: ['closed'],
      fields: [],
      autoAssign: true,
      autoAssignThreshold: threshold,
    },
  )
  // The entity type is this scenario's subject: a refused create must fail here,
  // not leave a later step to assert against nothing (#2465).
  expect(status, `create entity type: ${JSON.stringify(data)}`).toBe(201)
  getAssignmentState(world).entityTypeId = (data as Record<string, unknown>).id as string
})

When('I fetch the entity type', async ({ request, world }) => {
  const state = getAssignmentState(world)
  const id = state.entityTypeId
  if (!id) return
  const hubId = getScenarioState(world).hubId
  const res = await apiGet<Record<string, unknown>>(request, `/hubs/${hubId}/settings/cms/entity-types/${id}`)
  setLastResponse(world, res)
  state.entityTypeDetails = res.data as Record<string, unknown>
})

Then('the entity type should have autoAssign true', async ({ world }) => {
  const details = getAssignmentState(world).entityTypeDetails
  if (!details) return
  // Handle wrapped response
  const et = (details.entityType ?? details) as Record<string, unknown>
  expect(et.autoAssign).toBe(true)
})

Then('the entity type should have autoAssignThreshold {int}', async ({ world }, threshold: number) => {
  const details = getAssignmentState(world).entityTypeDetails
  if (!details) return
  const et = (details.entityType ?? details) as Record<string, unknown>
  expect(et.autoAssignThreshold).toBe(threshold)
})

// ── Case and volunteer setup for score breakdown scenario ──────────

Given('an unassigned arrest case exists', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  const types = await listEntityTypesViaApi(request, hubId)
  // jail-support template creates 'arrest_case'; fall back to first case type
  const entityType = types.find(t => t.name === 'arrest_case') ?? types.find(t => t.category === 'case')
  // The Background applies the jail-support template. Without its case type
  // there is no case to suggest assignees for, and this Given used to `return`
  // and leave the scenario subjectless (#2465).
  if (!entityType) throw new Error('the jail-support template defines no case type in this hub')
  const record = await createRecordViaApi(request, entityType.id as string, { hubId })
  getAssignmentState(world).recordId = (record as Record<string, unknown>).id as string
})

/**
 * A volunteer of the scenario hub, on an always-on shift there — i.e. a
 * candidate `suggest-assignees` must score. Optionally with specializations,
 * set through the real admin update route and checked.
 */
async function onShiftHubVolunteer(
  request: import('@playwright/test').APIRequestContext,
  hubId: string,
  name: string,
  specializations?: string[],
): Promise<string> {
  const vol = await createUserViaApi(request, { name: uniqueName(name), hubId })
  if (specializations) {
    const res = await apiPatch(request, `/users/${vol.pubkey}`, { specializations })
    expect(res.status, `set ${name}'s specializations: ${JSON.stringify(res.data)}`).toBe(200)
  }
  await createShiftViaApi(request, {
    name: uniqueName(`${name}Shift`),
    ...ALWAYS_ON_SHIFT,
    userPubkeys: [vol.pubkey],
    hubId,
  })
  return vol.pubkey
}

Given('on-shift volunteers exist', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  // Members of the scenario hub: these used to be created with global roles
  // only, so nothing tied them to the hub whose case is being scored.
  getAssignmentState(world).onShiftPubkeys = [
    await onShiftHubVolunteer(request, hubId, 'ScoreVol1'),
    await onShiftHubVolunteer(request, hubId, 'ScoreVol2'),
  ]
})

// ── Score breakdown assertions ─────────────────────────────────────

// Steps triggered after "When I request GET /records/:id/suggest-assignees"
// which is defined in cms.steps.ts and stores response in shared state.

Then('each suggestion should include {string}, {string}, {string}, {string}', async ({ world }, f1: string, f2: string, f3: string, f4: string) => {
  const res = getSharedState(world).lastResponse
  expect(res).toBeDefined()
  const body = res!.data as Record<string, unknown>
  const suggestions = (body.suggestions ?? []) as Array<Record<string, unknown>>
  // The Given put volunteers on shift in this hub; an empty list is a failure
  // to score them, not an empty environment. It used to `return` here (#2465).
  expectScoredOnShiftVolunteers(world, suggestions)
  for (const s of suggestions) {
    expect(s).toHaveProperty(f1)
    expect(s).toHaveProperty(f2)
    expect(s).toHaveProperty(f3)
    expect(s).toHaveProperty(f4)
  }
})

Then('each suggestion should include {string} array', async ({ world }, field: string) => {
  const res = getSharedState(world).lastResponse
  expect(res).toBeDefined()
  const body = res!.data as Record<string, unknown>
  const suggestions = (body.suggestions ?? []) as Array<Record<string, unknown>>
  // The Given put volunteers on shift in this hub; an empty list is a failure
  // to score them, not an empty environment. It used to `return` here (#2465).
  expectScoredOnShiftVolunteers(world, suggestions)
  for (const s of suggestions) {
    expect(s).toHaveProperty(field)
    expect(Array.isArray(s[field])).toBe(true)
  }
})

// ── Specialization scoring ─────────────────────────────────────────

Given('an arrest case linked to an entity type requiring specialization {string} exists', async ({ request, world }, spec: string) => {
  const hubId = getScenarioState(world).hubId
  const name = uniqueName('spec_req_type', '_')
  const label = 'Specialization Required Type'
  const { data: etData, status: etStatus } = await apiPost<Record<string, unknown>>(
    request,
    `/hubs/${hubId}/settings/cms/entity-types`,
    {
      name,
      label,
      labelPlural: `${label}s`,
      description: `Entity type requiring ${spec}`,
      category: 'case',
      hubId,
      statuses: [
        { value: 'open', label: 'Open', order: 0 },
        { value: 'closed', label: 'Closed', order: 1 },
      ],
      defaultStatus: 'open',
      closedStatuses: ['closed'],
      fields: [],
      requiredSpecializations: [spec],
    },
  )
  // This Given used to `return` silently when the create failed, so the
  // scenario ran on with no record and no entity type (#2465).
  expect(etStatus, `create entity type: ${JSON.stringify(etData)}`).toBe(201)
  const entityTypeId = (etData as Record<string, unknown>).id as string

  const record = await createRecordViaApi(request, entityTypeId, { statusHash: 'open', hubId })
  getAssignmentState(world).recordId = (record as Record<string, unknown>).id as string
  getAssignmentState(world).entityTypeId = entityTypeId
})

// Both volunteers are on shift in the case's hub, so both MUST be scored. These
// used to be hubless and off shift, and A's specialization was written to
// `/users/:pubkey/profile` — a route that does not exist — with the 404
// swallowed by `.catch(() => {})`. The Then step then returned early when
// either volunteer was missing, so the scenario asserted nothing (#2465).
Given('volunteer A has specialization {string}', async ({ request, world }, spec: string) => {
  getAssignmentState(world).volunteerAPubkey = await onShiftHubVolunteer(
    request, getScenarioState(world).hubId, `Vol-A-${spec}`, [spec],
  )
})

Given('volunteer B has no specializations', async ({ request, world }) => {
  getAssignmentState(world).volunteerBPubkey = await onShiftHubVolunteer(
    request, getScenarioState(world).hubId, 'Vol-B-no-spec',
  )
})

When('I fetch suggest-assignees for the case', async ({ request, world }) => {
  const state = getAssignmentState(world)
  const recordId = state.recordId
  expect(recordId, 'no case was created to suggest assignees for').toBeTruthy()
  const res = await apiGet<Record<string, unknown>>(request, `/hubs/${getScenarioState(world).hubId}/records/${recordId}/suggest-assignees`)
  setLastResponse(world, res)
  state.suggestions = ((res.data as Record<string, unknown>)?.suggestions ?? []) as Array<Record<string, unknown>>
})

Then('volunteer A should have a higher specializationScore than volunteer B', async ({ world }) => {
  const state = getAssignmentState(world)
  expect(getSharedState(world).lastResponse?.status, 'suggest-assignees').toBe(200)
  const suggestions = state.suggestions ?? []
  const volA = suggestions.find(s => s.pubkey === state.volunteerAPubkey)
  const volB = suggestions.find(s => s.pubkey === state.volunteerBPubkey)
  if (!volA) throw new Error('volunteer A (on shift in this hub) was not scored')
  if (!volB) throw new Error('volunteer B (on shift in this hub) was not scored')
  expect(volA.specializationScore as number).toBeGreaterThan(volB.specializationScore as number)
})
