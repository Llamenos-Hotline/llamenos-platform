/**
 * #2461 — calls, records, events, evidence, shifts and ring groups are reachable
 * only under /hubs/:hubId.
 *
 * "Gloria" holds the global hub-admin role and no hub membership. On the old
 * unscoped mounts her role's permissions applied, the handlers fell back to hub
 * id '' and their `/:id` guards bound nothing, so she read, edited and deleted
 * hub A's rows by id. Assertions read response BODIES for hub A's ids and the
 * database for rows a refused write must not have stored, not only status codes.
 */
import { expect } from '@playwright/test'
import { Given, When, Then, Before, After, getState, setState } from './fixtures'
import { setLastResponse, getSharedState } from './shared-state'
import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
  createHubViaApi,
  deleteHubViaApi,
  createUserViaApi,
  createEntityTypeViaApi,
  createRecordViaApi,
  createEventViaApi,
  createShiftViaApi,
  uniqueName,
  ADMIN_SEED,
} from '../../api-helpers'
import { simulateCallForNote } from '../../simulation-helpers'
import { TestDB } from '../../db-helpers'

interface HubRowState {
  hubId?: string
  recordId?: string
  recordStatusHash?: string
  eventId?: string
  shiftId?: string
  ringGroupId?: string
  callId?: string
  hubAdminSeed?: string
  gloriaSeed?: string
  /** encryptedSummary of a record sent to the unscoped mount, to look for afterwards. */
  strayMarker?: string
}

const KEY = 'hub_row_binding_scope'
const s = (world: Record<string, unknown>) => getState<HubRowState>(world, KEY)

Before({ tags: '@hub-row-binding' }, async ({ world }) => {
  setState<HubRowState>(world, KEY, {})
})

After({ tags: '@hub-row-binding' }, async ({ request, world }) => {
  const hubId = s(world)?.hubId
  if (hubId) await deleteHubViaApi(request, hubId)
})

function resolve(state: HubRowState, path: string): string {
  return path
    .replace('{recordId}', state.recordId ?? 'missing')
    .replace('{eventId}', state.eventId ?? 'missing')
    .replace('{callId}', state.callId ?? 'missing')
    .replace('{ringGroupId}', state.ringGroupId ?? 'missing')
    .replace(/^\/api/, '')
}

async function send(request: Parameters<typeof apiGet>[0], method: string, path: string, seed: string) {
  switch (method) {
    case 'GET': return apiGet(request, path, seed)
    case 'PATCH': return apiPatch(request, path, { statusHash: 'tampered_by_unscoped_request' }, seed)
    case 'DELETE': return apiDelete(request, path, seed)
    default: throw new Error(`unsupported method ${method}`)
  }
}

Given('hub {string} holds a case record, an event, a shift, a ring group and a call', async ({ request, world }, _label: string) => {
  const state = s(world)
  const hubId = await createHubViaApi(request, uniqueName('hub-row-binding'))
  state.hubId = hubId

  const caseType = await createEntityTypeViaApi(request, { name: uniqueName('row_binding_case', '_'), category: 'case', hubId })
  const record = await createRecordViaApi(request, caseType.id as string, { hubId, statusHash: 'status_open_hash' })
  state.recordId = record.id as string
  state.recordStatusHash = 'status_open_hash'

  const eventType = await createEntityTypeViaApi(request, { name: uniqueName('row_binding_event', '_'), category: 'event', hubId })
  state.eventId = (await createEventViaApi(request, eventType.id as string, { hubId })).id as string

  state.shiftId = (await createShiftViaApi(request, { hubId })).id

  const ringGroupId = crypto.randomUUID()
  const ringGroup = await apiPost<{ id: string }>(request, `/hubs/${hubId}/ring-groups`, { id: ringGroupId, encryptedName: 'hub A ring group' })
  expect(ringGroup.status, 'create hub A ring group').toBe(200)
  state.ringGroupId = ringGroup.data.id

  state.callId = await simulateCallForNote(request, hubId)

  const admin = await createUserViaApi(request, { name: uniqueName('Row Binding Hub Admin'), roleIds: ['role-hub-admin'], hubId })
  state.hubAdminSeed = admin.seedHex
})

Given('{string} holds the global hub-admin role but no hub membership', async ({ request, world }, _name: string) => {
  const gloria = await createUserViaApi(request, { name: uniqueName('Gloria'), roleIds: ['role-hub-admin'] })
  s(world).gloriaSeed = gloria.seedHex
})

When('{string} sends {string} to the unscoped {string}', async ({ request, world }, _name: string, method: string, path: string) => {
  const state = s(world)
  setLastResponse(world, await send(request, method, resolve(state, path), state.gloriaSeed!))
})

When('the super-admin sends {string} to the unscoped {string}', async ({ request, world }, method: string, path: string) => {
  setLastResponse(world, await send(request, method, resolve(s(world), path), ADMIN_SEED))
})

Then('the response names no row of hub {string}', async ({ world }, _label: string) => {
  const state = s(world)
  const body = JSON.stringify(getSharedState(world).lastResponse?.data ?? null)
  for (const [what, value] of Object.entries({
    hubId: state.hubId, recordId: state.recordId, eventId: state.eventId,
    shiftId: state.shiftId, ringGroupId: state.ringGroupId, callId: state.callId,
  })) {
    expect(value, `hub A's ${what} was set up`).toBeTruthy()
    expect(body, `the response carries hub A's ${what}`).not.toContain(value!)
  }
})

Then('the admin of hub {string} still reads the record unchanged', async ({ request, world }, _label: string) => {
  const state = s(world)
  const res = await apiGet<{ id: string; statusHash: string }>(request, `/hubs/${state.hubId}/records/${state.recordId}`, state.hubAdminSeed!)
  expect(res.status, 'the record still exists in hub A').toBe(200)
  expect(res.data.statusHash).toBe(state.recordStatusHash)
})

When('the super-admin creates a record at the unscoped {string}', async ({ request, world }, path: string) => {
  const state = s(world)
  state.strayMarker = uniqueName('stray-unscoped-record')
  setLastResponse(world, await apiPost(request, path.replace(/^\/api/, ''), {
    entityTypeId: crypto.randomUUID(),
    statusHash: 'status_open_hash',
    encryptedSummary: state.strayMarker,
    summaryEnvelopes: [{ pubkey: 'a'.repeat(64), enc: 'b'.repeat(64), ct: 'c' }],
  }, ADMIN_SEED))
})

Then('no record was created outside hub {string}', async ({ world }, _label: string) => {
  expect(await TestDB.countRows('case_records', 'encrypted_summary', s(world).strayMarker!)).toBe(0)
})

When('the admin of hub {string} updates the record', async ({ request, world }, _label: string) => {
  const state = s(world)
  state.recordStatusHash = 'status_updated_by_hub_admin'
  setLastResponse(world, await apiPatch(request, `/hubs/${state.hubId}/records/${state.recordId}`, { statusHash: state.recordStatusHash }, state.hubAdminSeed!))
})

type AuditPage = { entries: Array<{ action: string; hubId?: string | null; details?: Record<string, unknown> }> }
const updatesOf = (page: AuditPage, recordId: string) =>
  page.entries.filter(e => e.action === 'recordUpdated' && e.details?.recordId === recordId)

Then('hub {string}\'s audit log records the update of the record', async ({ request, world }, _label: string) => {
  const state = s(world)
  const res = await apiGet<AuditPage>(request, `/hubs/${state.hubId}/audit?limit=100`, state.hubAdminSeed!)
  expect(res.status).toBe(200)
  expect(updatesOf(res.data, state.recordId!).length, 'recordUpdated in hub A\'s chain').toBe(1)
})

Then('the platform audit chain does not record the update of the record', async ({ request, world }) => {
  const res = await apiGet<AuditPage>(request, '/admin/audit?limit=100', ADMIN_SEED)
  expect(res.status).toBe(200)
  expect(updatesOf(res.data, s(world).recordId!)).toEqual([])
})
