/**
 * Step definitions for hub-incidents.feature (B-INCIDENTS, #2341).
 *
 * The core ships no real producer, so `POST /api/test-incidents/signal` (a
 * dev-surface route, routes/incidents-dev.ts) plays the defence. Everything
 * asserted is observed through what a real client sees: the permission-
 * filtered `GET /hubs/:hubId/incidents` as each member, the relay as a
 * member who holds none of the permissions, and the dev-surface push log.
 *
 * Each scenario gets its OWN hub: an incident is one open row per hub and
 * category, so sharing the worker hub would let one scenario's incident absorb
 * the next one's signals. Push-log entries are filtered to that hub, so
 * parallel workers never see each other's pushes.
 */
import { expect, type APIRequestContext } from '@playwright/test'
import { Given, When, Then, After, getState, setState } from './fixtures'
import { RelayCapture, type CapturedEvent } from '../../helpers/relay-capture'
import { decryptHubEvent } from '../../helpers/relay-crypto'
import { hexToBytes } from '@shared/encoding'
import { KIND_HUB_INCIDENT } from '@shared/event-kinds'
import {
  ADMIN_SEED,
  addHubMemberViaApi,
  apiGet,
  createHubViaApi,
  createRoleViaApi,
  createVolunteerViaApi,
  devGet,
  devPost,
  listAuditLogViaApi,
  uniqueName,
} from '../../api-helpers'

const BASE_URL = process.env.TEST_HUB_URL || 'http://localhost:3000'
const RELAY_URL = process.env.TEST_RELAY_URL
  || `${BASE_URL.replace(/^http/, 'ws').replace(/\/$/, '')}/ws`

/** Anything that looks like a phone number (spec §5.4 trap). */
const NUMBER_SHAPED = /\+?\d{7,}/

const KEY = 'hub_incidents'

interface Member {
  pubkey: string
  seedHex: string
}

interface HubIncident {
  id: string
  category: string
  counts: Record<string, number>
  closedAt: string | null
}

interface PushLogEntry {
  wakePayload: Record<string, unknown>
  recipientPubkey: string
}

interface IncidentState {
  hubId: string
  /** Members keyed by the one permission their role grants. */
  holders: Record<string, Member>
  volunteer?: Member
  relay?: RelayCapture
  serverEventKeyHex?: string
}

function st(world: Record<string, unknown>): IncidentState {
  const s = getState<IncidentState | undefined>(world, KEY)
  if (!s) throw new Error('Incident scenario state missing — run "Given an isolated hub for incident scenarios" first')
  return s
}

async function listIncidents(request: APIRequestContext, hubId: string, member: Member, open = true): Promise<HubIncident[]> {
  const { status, data } = await apiGet<{ incidents: HubIncident[] }>(
    request,
    `/hubs/${hubId}/incidents${open ? '?open=true' : ''}`,
    member.seedHex,
  )
  expect(status, 'GET /hubs/:hubId/incidents').toBe(200)
  return data.incidents
}

function holder(world: Record<string, unknown>, permission: string): Member {
  const m = st(world).holders[permission]
  if (!m) throw new Error(`No member holding "${permission}" in this scenario`)
  return m
}

async function incidentPushes(request: APIRequestContext, hubId: string): Promise<PushLogEntry[]> {
  const { status, data } = await devGet<{ entries: PushLogEntry[] }>(request, '/test-push-log')
  expect(status, 'GET /api/test-push-log').toBe(200)
  return data.entries.filter((e) => e.wakePayload.hubId === hubId && e.wakePayload.type === 'incident')
}

/** Poll until `count` incident pushes for the hub are logged (dispatch is not awaited by the route). */
async function waitForPushes(request: APIRequestContext, hubId: string, count: number): Promise<PushLogEntry[]> {
  const deadline = Date.now() + 5_000
  let entries = await incidentPushes(request, hubId)
  while (entries.length < count && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
    entries = await incidentPushes(request, hubId)
  }
  return entries
}

function decrypt(world: Record<string, unknown>, event: CapturedEvent): Record<string, unknown> {
  const keyHex = st(world).serverEventKeyHex
  if (keyHex) {
    return decryptHubEvent(event.payload, hexToBytes(keyHex), event.epoch) as Record<string, unknown>
  }
  // A server without SERVER_SECRET publishes plain JSON.
  return JSON.parse(event.payload) as Record<string, unknown>
}

async function relayEvents(world: Record<string, unknown>, settleMs = 1_500): Promise<Record<string, unknown>[]> {
  const relay = st(world).relay
  if (!relay) throw new Error('The volunteer is not connected to the relay')
  await relay.waitForEvents({ kind: KIND_HUB_INCIDENT, count: 1, timeoutMs: 5_000 })
  // Give any (wrongly) extra events time to arrive before counting.
  await new Promise((r) => setTimeout(r, settleMs))
  return relay.getEvents(KIND_HUB_INCIDENT).map((e) => decrypt(world, e))
}

// ── Setup ──────────────────────────────────────────────────────────

Given('an isolated hub for incident scenarios', async ({ request, world }) => {
  const hubId = await createHubViaApi(request, uniqueName('bdd-incidents'))
  setState<IncidentState>(world, KEY, { hubId, holders: {} })
})

Given('a hub member whose role grants only {string}', async ({ request, world }, permission: string) => {
  const s = st(world)
  if (s.holders[permission]) return
  const unique = uniqueName('inc', '-').toLowerCase()
  const role = await createRoleViaApi(request, {
    name: `incident ${permission} ${unique}`,
    slug: `incident-${permission.replace(/[^a-z0-9]+/gi, '-')}-${unique}`.toLowerCase(),
    permissions: [permission],
  })
  const member = await createVolunteerViaApi(request, { name: uniqueName('IncidentHolder') })
  await addHubMemberViaApi(request, s.hubId, member.pubkey, [role.id])
  s.holders[permission] = { pubkey: member.pubkey, seedHex: member.seedHex }
})

Given('a hub volunteer with no incident permission', async ({ request, world }) => {
  const s = st(world)
  const vol = await createVolunteerViaApi(request, { name: uniqueName('IncidentVolunteer') })
  await addHubMemberViaApi(request, s.hubId, vol.pubkey, ['role-volunteer'])
  s.volunteer = { pubkey: vol.pubkey, seedHex: vol.seedHex }
})

Given('the volunteer is connected to the relay for the incident hub', async ({ request, world }) => {
  const s = st(world)
  if (!s.volunteer) throw new Error('No volunteer in this scenario')
  s.relay = await RelayCapture.connect(RELAY_URL, {
    seedHex: s.volunteer.seedHex,
    hubId: s.hubId,
    kinds: [KIND_HUB_INCIDENT],
  })
  const { status, data } = await apiGet<{ serverEventKeyHex?: string }>(request, '/auth/me', ADMIN_SEED)
  if (status === 200) s.serverEventKeyHex = data?.serverEventKeyHex
})

After(async ({ world }) => {
  const s = getState<IncidentState | undefined>(world, KEY)
  s?.relay?.close()
})

// ── Producer ───────────────────────────────────────────────────────

When('the test producer signals {int} {string} {string} event(s)', async ({ request, world }, count: number, category: string, kind: string) => {
  const { status, data } = await devPost(request, '/test-incidents/signal', {
    hubId: st(world).hubId,
    category,
    kind,
    repeat: count,
  })
  expect(status, `test producer: ${JSON.stringify(data)}`).toBe(200)
})

When('the incident closer runs {int} minutes later', async ({ request, world }, minutes: number) => {
  const { status, data } = await devPost<{ closed: number }>(request, '/test-incidents/sweep', {
    hubId: st(world).hubId,
    advanceMs: minutes * 60_000,
  })
  expect(status).toBe(200)
  expect(data.closed).toBeGreaterThan(0)
})

// ── Permission-filtered GET ────────────────────────────────────────

Then('the {string} holder sees one open {string} incident counting {int} {string}', async ({ request, world }, permission: string, category: string, count: number, kind: string) => {
  const incidents = await listIncidents(request, st(world).hubId, holder(world, permission))
  expect(incidents).toHaveLength(1)
  expect(incidents[0]!.category).toBe(category)
  expect(incidents[0]!.counts[kind]).toBe(count)
  expect(incidents[0]!.closedAt).toBeNull()
})

Then('the {string} holder sees only {string} incidents', async ({ request, world }, permission: string, category: string) => {
  const incidents = await listIncidents(request, st(world).hubId, holder(world, permission))
  expect(incidents.length).toBeGreaterThan(0)
  expect(new Set(incidents.map((i) => i.category))).toEqual(new Set([category]))
})

Then('the {string} holder sees no incidents', async ({ request, world }, permission: string) => {
  expect(await listIncidents(request, st(world).hubId, holder(world, permission), false)).toEqual([])
})

Then('the {string} holder sees no open incidents', async ({ request, world }, permission: string) => {
  expect(await listIncidents(request, st(world).hubId, holder(world, permission))).toEqual([])
})

Then('the volunteer sees no incidents', async ({ request, world }) => {
  const s = st(world)
  if (!s.volunteer) throw new Error('No volunteer in this scenario')
  // The negative case is the one that matters: same hub, an incident open,
  // and a member without the permission gets nothing.
  expect(await listIncidents(request, s.hubId, s.volunteer, false)).toEqual([])
})

// ── Relay ──────────────────────────────────────────────────────────

Then('the volunteer receives exactly one incident relay event', async ({ world }) => {
  expect(await relayEvents(world)).toHaveLength(1)
})

Then('that relay event carries only an incident id and the state {string}', async ({ world }, state: string) => {
  const [content] = await relayEvents(world, 0)
  // Try to read detail out of it: there is none to read.
  expect(Object.keys(content!).sort()).toEqual(['incidentId', 'state'])
  expect(content!.state).toBe(state)
  const text = JSON.stringify(content)
  expect(text).not.toContain('spam')
  expect(text).not.toContain('fail')
  expect(text).not.toMatch(/"(category|counts|severity|totalCount|peakPerMinute)"/)
})

Then('the volunteer receives an incident relay event with the state {string}', async ({ world }, state: string) => {
  const deadline = Date.now() + 5_000
  let states: unknown[] = []
  while (Date.now() < deadline) {
    states = (await relayEvents(world, 0)).map((c) => c.state)
    if (states.includes(state)) break
    await new Promise((r) => setTimeout(r, 100))
  }
  expect(states).toContain(state)
})

// ── Push ───────────────────────────────────────────────────────────

async function settledPushes(request: APIRequestContext, hubId: string, atLeast: number): Promise<PushLogEntry[]> {
  await waitForPushes(request, hubId, atLeast)
  // Settle, then count: an over-notification must show up as a failure.
  await new Promise((r) => setTimeout(r, 1_000))
  return incidentPushes(request, hubId)
}

Then('the {string} holder received exactly {int} incident push(es)', async ({ request, world }, permission: string, count: number) => {
  const pk = holder(world, permission).pubkey
  const entries = await settledPushes(request, st(world).hubId, count)
  expect(entries.filter((e) => e.recipientPubkey === pk)).toHaveLength(count)
})

Then('the {string} holder received no incident push', async ({ request, world }, permission: string) => {
  const pk = holder(world, permission).pubkey
  const entries = await settledPushes(request, st(world).hubId, 1)
  // Someone was pushed (the spam holder), so the hub's pushes really were logged…
  expect(entries.length).toBeGreaterThan(0)
  // …and this member was not among the recipients.
  expect(entries.filter((e) => e.recipientPubkey === pk)).toEqual([])
})

Then('the volunteer received no incident push', async ({ request, world }) => {
  const s = st(world)
  if (!s.volunteer) throw new Error('No volunteer in this scenario')
  const entries = await settledPushes(request, s.hubId, 1)
  expect(entries.length).toBeGreaterThan(0)
  expect(entries.filter((e) => e.recipientPubkey === s.volunteer!.pubkey)).toEqual([])
})

Then('no incident push went out for the incident hub', async ({ request, world }) => {
  const s = st(world)
  // The incident must exist first, or "no push" would pass vacuously.
  expect(await listIncidents(request, s.hubId, holder(world, 'settings:manage-spam'))).toHaveLength(1)
  await new Promise((r) => setTimeout(r, 1_000))
  expect(await incidentPushes(request, s.hubId)).toEqual([])
})

Then('every incident push carries only the hub and the incident type', async ({ request, world }) => {
  const hubId = st(world).hubId
  const entries = await waitForPushes(request, hubId, 1)
  expect(entries.length).toBeGreaterThan(0)
  for (const e of entries) {
    expect(e.wakePayload).toEqual({ hubId, type: 'incident' })
  }
})

Then('no incident push carries a number-shaped string', async ({ request, world }) => {
  const hubId = st(world).hubId
  const entries = await waitForPushes(request, hubId, 1)
  expect(entries.length).toBeGreaterThan(0)
  for (const e of entries) {
    // The hub id is routing, not content; every other value must be free of anything number-shaped.
    const { hubId: _hub, ...rest } = e.wakePayload
    expect(JSON.stringify(rest)).not.toMatch(NUMBER_SHAPED)
    expect(JSON.stringify(rest)).not.toMatch(/spam|fail|count/i)
  }
})

// ── Audit ──────────────────────────────────────────────────────────

Then('the incident hub\'s audit log records {string} and {string} by the system', async ({ request, world }, opened: string, closed: string) => {
  const { entries } = await listAuditLogViaApi(request, { hubId: st(world).hubId, limit: 100 })
  for (const action of [opened, closed]) {
    const entry = entries.find((e) => e.action === action)
    expect(entry, `audit entry ${action}`).toBeDefined()
    expect(entry!.actorPubkey).toBe('system')
  }
})
