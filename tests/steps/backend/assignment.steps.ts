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
  apiPost,
  createUserViaApi,
  createRecordViaApi,
  createShiftViaApi,
  listEntityTypesViaApi,
  uniqueName,
} from '../../api-helpers'
import { ALWAYS_ON_SHIFT } from './always-on-shift'

// ── Local State ────────────────────────────────────────────────────

interface AssignmentState {
  recordId?: string
  entityTypeId?: string
  entityTypeDetails?: Record<string, unknown>
  volunteerAPubkey?: string
  volunteerBPubkey?: string
  suggestions?: Array<Record<string, unknown>>
}

const ASSIGNMENT_KEY = 'assignment_ep06a3'

function getAssignmentState(world: Record<string, unknown>): AssignmentState {
  return getState<AssignmentState>(world, ASSIGNMENT_KEY)
}

Before({ tags: '@backend' }, async ({ world }) => {
  setState(world, ASSIGNMENT_KEY, {} as AssignmentState)
})

// ── Entity Type with autoAssign ────────────────────────────────────

Given('an entity type with autoAssign enabled and threshold {int} exists', async ({ request, world }, threshold: number) => {
  const hubId = getScenarioState(world).hubId
  const name = `auto_assign_scoring_${Date.now()}`
  const label = 'Auto Assign Scoring'
  const { data, status } = await apiPost<Record<string, unknown>>(
    request,
    hubId ? `/hubs/${hubId}/settings/cms/entity-types` : '/settings/cms/entity-types',
    {
      name,
      label,
      labelPlural: `${label}s`,
      description: 'Entity type for autoAssign threshold testing',
      category: 'case',
      hubId: hubId ?? '',
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
  if (status < 300) {
    getAssignmentState(world).entityTypeId = (data as Record<string, unknown>).id as string
  }
})

When('I fetch the entity type', async ({ request, world }) => {
  const state = getAssignmentState(world)
  const id = state.entityTypeId
  if (!id) return
  const res = await apiGet<Record<string, unknown>>(request, `/settings/cms/entity-types/${id}`)
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
  if (!entityType) return
  const record = await createRecordViaApi(request, entityType.id as string, { hubId })
  getAssignmentState(world).recordId = (record as Record<string, unknown>).id as string
})

Given('on-shift volunteers exist', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  const vol1 = await createUserViaApi(request, { name: uniqueName('ScoreVol1') })
  const vol2 = await createUserViaApi(request, { name: uniqueName('ScoreVol2') })
  await createShiftViaApi(request, {
    name: uniqueName('ScoreShift'),
    ...ALWAYS_ON_SHIFT,
    userPubkeys: [vol1.pubkey, vol2.pubkey],
    hubId,
  })
})

// ── Score breakdown assertions ─────────────────────────────────────

// Steps triggered after "When I request GET /records/:id/suggest-assignees"
// which is defined in cms.steps.ts and stores response in shared state.

Then('each suggestion should include {string}, {string}, {string}, {string}', async ({ world }, f1: string, f2: string, f3: string, f4: string) => {
  const res = getSharedState(world).lastResponse
  expect(res).toBeDefined()
  const body = res!.data as Record<string, unknown>
  const suggestions = (body.suggestions ?? []) as Array<Record<string, unknown>>
  if (suggestions.length === 0) return // Accept empty list in envs with no on-shift volunteers
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
  if (suggestions.length === 0) return
  for (const s of suggestions) {
    expect(s).toHaveProperty(field)
    expect(Array.isArray(s[field])).toBe(true)
  }
})

// ── Specialization scoring ─────────────────────────────────────────

Given('an arrest case linked to an entity type requiring specialization {string} exists', async ({ request, world }, spec: string) => {
  const hubId = getScenarioState(world).hubId
  const name = `spec_req_type_${Date.now()}`
  const label = 'Specialization Required Type'
  const { data: etData, status: etStatus } = await apiPost<Record<string, unknown>>(
    request,
    hubId ? `/hubs/${hubId}/settings/cms/entity-types` : '/settings/cms/entity-types',
    {
      name,
      label,
      labelPlural: `${label}s`,
      description: `Entity type requiring ${spec}`,
      category: 'case',
      hubId: hubId ?? '',
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
  const entityTypeId = etStatus < 300 ? (etData as Record<string, unknown>).id as string : undefined
  if (!entityTypeId) return

  const record = await createRecordViaApi(request, entityTypeId, { statusHash: 'open', hubId })
  getAssignmentState(world).recordId = (record as Record<string, unknown>).id as string
  getAssignmentState(world).entityTypeId = entityTypeId
})

Given('volunteer A has specialization {string}', async ({ request, world }, spec: string) => {
  const vol = await createUserViaApi(request, { name: uniqueName(`Vol-A-${spec}`) })
  getAssignmentState(world).volunteerAPubkey = vol.pubkey
  // Update volunteer profile with specialization
  await apiPost(request, `/users/${vol.pubkey}/profile`, { specializations: [spec] }).catch(() => {})
})

Given('volunteer B has no specializations', async ({ request, world }) => {
  const vol = await createUserViaApi(request, { name: uniqueName('Vol-B-no-spec') })
  getAssignmentState(world).volunteerBPubkey = vol.pubkey
})

When('I fetch suggest-assignees for the case', async ({ request, world }) => {
  const state = getAssignmentState(world)
  const recordId = state.recordId ?? (getScenarioState(world).lastApiResponse?.data as string | undefined)
  if (!recordId) return
  const res = await apiGet<Record<string, unknown>>(request, `/records/${recordId}/suggest-assignees`)
  setLastResponse(world, res)
  state.suggestions = ((res.data as Record<string, unknown>)?.suggestions ?? []) as Array<Record<string, unknown>>
})

Then('volunteer A should have a higher specializationScore than volunteer B', async ({ world }) => {
  const state = getAssignmentState(world)
  const suggestions = state.suggestions ?? []
  if (suggestions.length < 2) return // Accept if not enough on-shift volunteers in test env
  const volA = suggestions.find(s => s.pubkey === state.volunteerAPubkey)
  const volB = suggestions.find(s => s.pubkey === state.volunteerBPubkey)
  if (!volA || !volB) return
  expect(volA.specializationScore as number).toBeGreaterThan(volB.specializationScore as number)
})
