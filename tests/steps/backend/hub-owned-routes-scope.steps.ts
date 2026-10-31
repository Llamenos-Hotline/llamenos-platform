/**
 * #2395 — hub-owned routers (notes, reports, contacts, audit) are reachable only
 * under /hubs/:hubId.
 *
 * "Gloria" holds the global hub-admin role and no hub membership: inside a hub
 * that role grants her nothing, but on the old unscoped mounts it granted
 * `notes:read-all`, `reports:read-all`, `contacts:view` and `audit:read` across
 * every hub, because the services add their hub filter only when given a hub.
 * Assertions read response BODIES for hub A's ids and its plaintext report
 * title, not only status codes.
 */
import { expect } from '@playwright/test'
import { Given, When, Then, Before, After, getState, setState } from './fixtures'
import { setLastResponse, getSharedState } from './shared-state'
import {
  apiGet,
  apiPost,
  createHubViaApi,
  deleteHubViaApi,
  createUserViaApi,
  createVolunteerViaApi,
  createReportViaApi,
  sealedNoteFields,
  uniqueName,
  ADMIN_SEED,
} from '../../api-helpers'
import { simulateCallForNote, simulateIncomingMessage } from '../../simulation-helpers'

interface HubOwnedState {
  hubId?: string
  noteId?: string
  reportId?: string
  reportTitle?: string
  contactHash?: string
  hubAdminSeed?: string
  gloriaSeed?: string
}

const KEY = 'hub_owned_routes_scope'
const s = (world: Record<string, unknown>) => getState<HubOwnedState>(world, KEY)

Before({ tags: '@hub-owned-scope' }, async ({ world }) => {
  setState<HubOwnedState>(world, KEY, {})
})

After({ tags: '@hub-owned-scope' }, async ({ request, world }) => {
  const hubId = s(world)?.hubId
  if (hubId) await deleteHubViaApi(request, hubId)
})

Given('hub {string} holds a note, a report, a contact and audit entries', async ({ request, world }, _label: string) => {
  const state = s(world)
  const hubId = await createHubViaApi(request, uniqueName('hub-owned-scope'))
  state.hubId = hubId

  // A volunteer of the hub files a note — and in doing so writes the hub's audit chain.
  const vol = await createVolunteerViaApi(request, { name: uniqueName('Scope Vol'), roleIds: ['role-volunteer'], hubId })
  const note = await apiPost<{ note?: { id?: string } }>(request, `/hubs/${hubId}/notes`, {
    ...(await sealedNoteFields(vol.deviceKey, 'hub A note')),
    callId: await simulateCallForNote(request, hubId),
  }, vol.deviceKey)
  expect(note.status).toBe(201)
  state.noteId = note.data.note?.id

  // A report, whose title the server stores in plaintext.
  state.reportTitle = uniqueName('Hub A report title')
  state.reportId = (await createReportViaApi(request, { title: state.reportTitle, hubId })).id

  // A contact: an inbound conversation in the hub.
  await simulateIncomingMessage(request, { senderNumber: `+1555${Date.now().toString().slice(-7)}`, body: 'help', channel: 'sms', hubId })
  const contacts = await apiGet<{ contacts: Array<{ contactHash: string }> }>(request, `/hubs/${hubId}/contacts`)
  expect(contacts.status).toBe(200)
  state.contactHash = contacts.data.contacts[0]?.contactHash
  expect(state.contactHash, 'hub A has a contact to leak').toBeTruthy()

  const admin = await createUserViaApi(request, { name: uniqueName('Scope Hub Admin'), roleIds: ['role-hub-admin'], hubId })
  state.hubAdminSeed = admin.seedHex
})

Given('{string} holds only a global hub-admin role and belongs to no hub', async ({ request, world }, _name: string) => {
  const gloria = await createUserViaApi(request, { name: uniqueName('Gloria'), roleIds: ['role-hub-admin'] })
  s(world).gloriaSeed = gloria.seedHex
})

When('{string} requests the unscoped {string}', async ({ request, world }, _name: string, path: string) => {
  const state = s(world)
  const resolved = path
    .replace('{reportId}', state.reportId ?? 'missing')
    .replace('{contactHash}', state.contactHash ?? 'missing')
  setLastResponse(world, await apiGet(request, resolved.replace(/^\/api/, ''), state.gloriaSeed!))
})

Then('the response names nothing of hub {string}', async ({ world }, _label: string) => {
  const state = s(world)
  const body = JSON.stringify(getSharedState(world).lastResponse?.data ?? null)
  for (const [what, value] of Object.entries({
    hubId: state.hubId, noteId: state.noteId, reportId: state.reportId,
    reportTitle: state.reportTitle, contactHash: state.contactHash,
  })) {
    expect(body, `the response carries hub A's ${what}`).not.toContain(value!)
  }
})

When('the admin of hub {string} lists the hub\'s notes', async ({ request, world }, _label: string) => {
  const state = s(world)
  setLastResponse(world, await apiGet(request, `/hubs/${state.hubId}/notes`, state.hubAdminSeed!))
})

Then('the volunteer\'s note of hub {string} is in the list', async ({ world }, _label: string) => {
  const data = getSharedState(world).lastResponse?.data as { notes: Array<{ id: string }> }
  expect(data.notes.map(n => n.id)).toContain(s(world).noteId)
})

When('the super-admin requests {string}', async ({ request, world }, path: string) => {
  setLastResponse(world, await apiGet(request, path.replace(/^\/api/, ''), ADMIN_SEED))
})

Then('no audit entry in the response belongs to hub {string}', async ({ world }, _label: string) => {
  const data = getSharedState(world).lastResponse?.data as { entries: Array<{ hubId?: string | null }> }
  expect(Array.isArray(data.entries)).toBe(true)
  expect(data.entries.filter(e => e.hubId === s(world).hubId)).toEqual([])
})
