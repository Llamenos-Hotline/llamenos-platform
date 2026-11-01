/**
 * #2330 — "the hotline can fail totally and silently" — against real
 * PostgreSQL, built the way production builds it: `createServices` registers
 * the routing checks, `IncidentService.runChecks` (the `incident-checks`
 * worker's body) evaluates them, and refused provider webhooks go through the
 * real `validateWebhook` in routes/telephony.ts into the real IncidentService.
 *
 * What is asserted is what was silent before:
 *  - a hub with a number, no shift and an empty fallback group is a STANDING
 *    `routing` incident, visible to a `shifts:manage-fallback` holder and
 *    invisible to a member without it;
 *  - three calls in and none answered is `no_answers`; one answered is not;
 *  - a forged-webhook flood is visible but wakes nobody; our provider, about
 *    our account, failing its signature does wake the responsible people; a
 *    correctly signed request from outside the allowlist names the stale
 *    allowlist — and is still refused;
 *  - no incident row holds a number-shaped value or a source address.
 *
 * Requires postgres at DATABASE_URL; creates and drops its own database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { DEFAULT_ROLES, type Role } from '@shared/permissions'
import type { AppEnv } from '../../types'
import { hubContext } from '../../middleware/hub'
import incidentsRoutes from '../../routes/incidents'
import * as schema from '../../db/schema'
import type { HubIncidentRow } from '../../db/schema/incidents'
import type { IncidentCategory, IncidentState } from '@protocol/schemas/incidents'
import type { TelephonyAdapter } from '../../telephony/adapter'
import { insertHubFounder } from '../helpers/hub-founder'

vi.mock('@llamenos/crypto/ffi', async () => await import('../mocks/llamenos-crypto-ffi'))
vi.mock('../../lib/service-factories')
// The route module imports the Bun SQL driver through `getDb`, which a Node
// test cannot load. Every path exercised here refuses before the replay check,
// the only `getDb` caller, so the module is replaced and getDb never runs.
vi.mock('../../db', () => ({ getDb: vi.fn(() => { throw new Error('getDb is not reached by a refused webhook') }) }))
import { freshHubDb } from './hub-shred-helpers'
import { createServices, type Services } from '../../services'
import { getHubTelephonyFromService, getTelephonyFromService } from '../../lib/service-factories'
import { providerAuthMonitor } from '../../services/provider-auth'
import { ROUTING_NO_ANSWER_MIN_INBOUND } from '../../services/routing-readiness'

const fresh = freshHubDb('routing_incidents')

let services: Services
interface Sent {
  channel: 'relay' | 'interrupt'
  incidentId: string
  hubId: string
  state: IncidentState
}
const sent: Sent[] = []

beforeAll(async () => {
  await fresh.setup()
  services = createServices(fresh.db, { hmacSecret: 'a'.repeat(64), serverKek: 'c'.repeat(64), env: { ENVIRONMENT: 'test' } })
  services.incidents.setNotifier({
    async relay(incident: HubIncidentRow, state: IncidentState) {
      sent.push({ channel: 'relay', incidentId: incident.id, hubId: incident.hubId, state })
    },
    async interrupt(incident: HubIncidentRow, state: IncidentState) {
      sent.push({ channel: 'interrupt', incidentId: incident.id, hubId: incident.hubId, state })
    },
  })
}, 180_000)
afterAll(fresh.teardown, 60_000)

beforeEach(async () => {
  sent.length = 0
  providerAuthMonitor.reset()
  await fresh.db.delete(schema.hubIncidents)
})

let hubCounter = 0
let numberCounter = 0
/** A hub; with a number unless `phone: false` (a hub without one receives no calls). */
async function createHub(opts: { phone?: boolean } = {}): Promise<{ id: string; phone: string | undefined }> {
  const id = `hub-rt-${++hubCounter}-${Math.random().toString(36).slice(2, 8)}`
  const phone = opts.phone === false ? undefined : `+1555${String(7000000 + ++numberCounter)}`
  await services.settings.createHub({
    id,
    name: `Hub ${id}`,
    slug: id,
    status: 'active',
    phoneNumber: phone,
    createdBy: 'integration-test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never, await insertHubFounder(fresh.db))
  return { id, phone }
}

let userCounter = 0
async function volunteerOf(hubId: string): Promise<string> {
  const pubkey = `${(++userCounter).toString(16).padStart(4, '0')}${'d'.repeat(60)}`
  await fresh.db.insert(schema.users).values({
    pubkey,
    displayName: 'Routing volunteer',
    hubRoles: [{ hubId, roleIds: ['role-volunteer'] }],
  })
  return pubkey
}

async function openIncident(hubId: string, category: IncidentCategory) {
  const rows = await fresh.db
    .select()
    .from(schema.hubIncidents)
    .where(and(
      eq(schema.hubIncidents.hubId, hubId),
      eq(schema.hubIncidents.category, category),
      isNull(schema.hubIncidents.closedAt),
    ))
  expect(rows.length).toBeLessThanOrEqual(1)
  return rows[0] ?? null
}

// ── Who sees it: the incidents router behind the real hubContext ───────────

const ROLES: Role[] = [
  ...DEFAULT_ROLES.map((r) => ({ ...r, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' })),
  ...([
    ['role-fallback-desk', 'shifts:manage-fallback'],
    ['role-provider-desk', 'telephony:manage-providers'],
  ] as const).map(([id, permission]) => ({
    id,
    name: id,
    slug: id,
    permissions: [permission],
    isDefault: false,
    isSystem: false,
    description: `Holds ${permission} and nothing else`,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  })),
]

async function listAs(roleId: string, hubId: string) {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('pubkey', 'f'.repeat(64))
    c.set('user', { pubkey: 'f'.repeat(64), roles: [], hubRoles: [{ hubId, roleIds: [roleId] }] } as unknown as AppEnv['Variables']['user'])
    c.set('allRoles', ROLES)
    c.set('permissions', [])
    c.set('services', services as unknown as AppEnv['Variables']['services'])
    await next()
  })
  const hubScoped = new Hono<AppEnv>()
  hubScoped.use('*', hubContext)
  hubScoped.route('/incidents', incidentsRoutes)
  app.route('/api/hubs/:hubId', hubScoped)
  const res = await app.request(`/api/hubs/${hubId}/incidents?open=true`, {}, { ENVIRONMENT: 'test' })
  expect(res.status).toBe(200)
  return ((await res.json()) as { incidents: { category: string; severity: string; counts: Record<string, number> }[] }).incidents
}

/** Nothing number-shaped (a phone number, a provider id's digits) and no IPv4/IPv6 address, anywhere but the row's own ids. */
function assertNoIdentifiers(row: HubIncidentRow, mustNotContain: string[]): void {
  const { id: _id, hubId: _hubId, ...rest } = row
  const text = JSON.stringify(rest)
  expect(text).not.toMatch(/\+?\d{7,}/)
  expect(text).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/)
  expect(text).not.toMatch(/[0-9a-f]{0,4}::[0-9a-f]{0,4}|([0-9a-f]{1,4}:){7}[0-9a-f]{1,4}/i)
  const whole = JSON.stringify(row)
  for (const s of mustNotContain) expect(whole).not.toContain(s)
}

// ── routing ────────────────────────────────────────────────────────────────

describe('routing/nobody_would_ring (#2330)', () => {
  it('is registered by the production service registry, with no_answers', () => {
    const names = services.incidents.getChecks().filter((c) => c.category === 'routing').map((c) => [c.name, c.kind])
    expect(names).toEqual([
      ['routing-nobody-would-ring', 'nobody_would_ring'],
      ['routing-no-answers', 'no_answers'],
    ])
  })

  it('a hub with a number, no shift and an empty fallback group is a standing incident, visible only to shifts:manage-fallback', async () => {
    const hub = await createHub()

    await services.incidents.runChecks()
    const row = await openIncident(hub.id, 'routing')
    expect(row, 'a hotline that can ring nobody must say so').not.toBeNull()
    expect(row!.severity).toBe('notify')
    expect(row!.counts).toEqual({ nobody_would_ring: 1 })
    expect(sent.filter((s) => s.hubId === hub.id).map((s) => [s.channel, s.state])).toEqual([
      ['relay', 'opened'],
      ['interrupt', 'opened'],
    ])

    // Standing, not a one-off: the next tick re-observes the same level.
    await services.incidents.runChecks()
    const again = await openIncident(hub.id, 'routing')
    expect(again!.id).toBe(row!.id)
    expect(again!.counts).toEqual({ nobody_would_ring: 1 })

    expect((await listAs('role-fallback-desk', hub.id)).map((i) => [i.category, i.counts])).toEqual([
      ['routing', { nobody_would_ring: 1 }],
    ])
    expect(await listAs('role-volunteer', hub.id)).toEqual([])
    expect(await listAs('role-provider-desk', hub.id)).toEqual([])

    assertNoIdentifiers(again!, [hub.phone!])
  })

  it('a hub without a number receives no calls, so expects no coverage', async () => {
    const hub = await createHub({ phone: false })
    await services.incidents.runChecks()
    expect(await openIncident(hub.id, 'routing')).toBeNull()
  })

  it('a hub that has switched voice off receives no calls, so expects no coverage — until it is switched back on', async () => {
    const hub = await createHub()
    await services.settings.updateHubSettings(hub.id, { channels: { voice: false, signal: true } })
    await services.incidents.runChecks()
    expect(await openIncident(hub.id, 'routing')).toBeNull()

    await services.settings.updateHubSettings(hub.id, { channels: { voice: true, signal: true } })
    await services.incidents.runChecks()
    expect((await openIncident(hub.id, 'routing'))!.counts).toEqual({ nobody_would_ring: 1 })
  })

  it('a fallback group naming an available volunteer would ring — no incident', async () => {
    const hub = await createHub()
    await services.settings.setFallbackGroup({ userPubkeys: [await volunteerOf(hub.id)] }, hub.id)
    await services.incidents.runChecks()
    expect(await openIncident(hub.id, 'routing')).toBeNull()
  })

  it('a fallback group whose only member is on break promises coverage it cannot give — incident', async () => {
    const hub = await createHub()
    const pubkey = await volunteerOf(hub.id)
    await fresh.db.update(schema.users).set({ onBreak: true }).where(eq(schema.users.pubkey, pubkey))
    await services.settings.setFallbackGroup({ userPubkeys: [pubkey] }, hub.id)
    await services.incidents.runChecks()
    expect((await openIncident(hub.id, 'routing'))!.counts).toEqual({ nobody_would_ring: 1 })
  })

  it('a shift on another day with no fallback group is the schedule working as written — no incident now', async () => {
    const hub = await createHub()
    const otherDay = (new Date().getUTCDay() + 3) % 7
    await services.shifts.create(hub.id, {
      encryptedName: 'shift',
      startTime: '09:00',
      endTime: '17:00',
      days: [otherDay],
      userPubkeys: [await volunteerOf(hub.id)],
    } as never)
    await services.incidents.runChecks()
    expect(await openIncident(hub.id, 'routing')).toBeNull()
  })
})

describe('routing/no_answers (#2330)', () => {
  /** A hub whose fallback group would ring, so only the answer outcomes can open anything. */
  async function staffedHub() {
    const hub = await createHub()
    await services.settings.setFallbackGroup({ userPubkeys: [await volunteerOf(hub.id)] }, hub.id)
    return hub
  }

  let callCounter = 0
  async function finishedCall(hubId: string, answered: boolean, minutesAgo = 5) {
    await services.calls.recordHistoricalCall(hubId, {
      callId: `CA-rt-${++callCounter}`,
      callerLast4: '0000',
      startedAt: new Date(Date.now() - minutesAgo * 60_000),
      durationSeconds: 30,
      answeredBy: answered ? 'a'.repeat(64) : null,
      status: answered ? 'completed' : 'unanswered',
      encryptedContent: 'sealed',
      adminEnvelopes: [],
    })
  }

  it(`${ROUTING_NO_ANSWER_MIN_INBOUND} inbound calls with none answered opens no_answers`, async () => {
    const hub = await staffedHub()
    for (let i = 0; i < 3; i++) await finishedCall(hub.id, false, 10 + i)

    await services.incidents.runChecks()
    const row = await openIncident(hub.id, 'routing')
    expect(row).not.toBeNull()
    expect(row!.counts).toEqual({ no_answers: 3 })
    expect(row!.severity).toBe('notify')
    expect(row!.oldestAgeSeconds).toBeGreaterThanOrEqual(12 * 60 - 5)
    expect((await listAs('role-fallback-desk', hub.id)).map((i) => i.counts)).toEqual([{ no_answers: 3 }])
    expect(await listAs('role-volunteer', hub.id)).toEqual([])
    assertNoIdentifiers(row!, ['CA-rt-'])
  })

  it('3 inbound with 1 answered opens nothing', async () => {
    const hub = await staffedHub()
    await finishedCall(hub.id, false)
    await finishedCall(hub.id, false)
    await finishedCall(hub.id, true)
    await services.incidents.runChecks()
    expect(await openIncident(hub.id, 'routing')).toBeNull()
  })

  it('a call answered and still in progress counts as answered', async () => {
    const hub = await staffedHub()
    for (let i = 0; i < 3; i++) await finishedCall(hub.id, false)
    await services.calls.addCall(hub.id, { callId: `CA-rt-live-${++callCounter}`, callerNumberSealed: null })
    await services.calls.answerCall(hub.id, `CA-rt-live-${callCounter}`, 'b'.repeat(64))
    expect(await services.calls.answerOutcomesSince(hub.id, new Date(Date.now() - 30 * 60_000))).toMatchObject({ inbound: 4, answered: 1 })
    await services.incidents.runChecks()
    expect(await openIncident(hub.id, 'routing')).toBeNull()
  })

  it('a call still ringing has no outcome yet; calls before the window do not count', async () => {
    const hub = await staffedHub()
    await finishedCall(hub.id, false)
    await finishedCall(hub.id, false)
    await finishedCall(hub.id, false, 45)
    await services.calls.addCall(hub.id, { callId: `CA-rt-ringing-${++callCounter}`, callerNumberSealed: null })
    await services.incidents.runChecks()
    expect(await openIncident(hub.id, 'routing')).toBeNull()
  })
})

// ── provider-auth: refused webhooks through the real route ─────────────────

const PROVIDER_EGRESS = '10.0.0.0/8'
const OUR_ACCOUNT = 'AC-our-account'
const GOOD_SIGNATURE = 'signed-with-our-secret'

/**
 * A provider adapter whose signature check is a header comparison and whose
 * account id is read the way Twilio's is (`AccountSid` in the form body). The
 * classification under test is the route's, not an adapter's crypto.
 */
function fakeProvider(): TelephonyAdapter {
  return {
    validateWebhook: vi.fn(async (request: Request) => request.headers.get('X-Test-Signature') === GOOD_SIGNATURE),
    webhookNamesOwnAccount: vi.fn(async (request: Request) =>
      new URLSearchParams(await request.clone().text()).get('AccountSid') === OUR_ACCOUNT),
    parseIncomingWebhook: vi.fn(async (request: Request) => {
      const form = new URLSearchParams(await request.clone().text())
      return { callSid: form.get('CallSid') ?? '', callerNumber: form.get('From') ?? '', calledNumber: form.get('To') ?? undefined }
    }),
    providerAccountId: () => `fake:${OUR_ACCOUNT}`,
  } as unknown as TelephonyAdapter
}

async function telephonyApp(adapter: TelephonyAdapter) {
  vi.mocked(getTelephonyFromService).mockResolvedValue(adapter)
  vi.mocked(getHubTelephonyFromService).mockResolvedValue(adapter)
  const { default: telephony } = await import('../../routes/telephony')
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('services', services as unknown as AppEnv['Variables']['services'])
    await next()
  })
  app.route('/api/telephony', telephony)
  return app
}

async function incoming(
  app: Hono<AppEnv>,
  opts: { to: string; from: string; sourceIp: string; accountSid?: string; signature?: string },
) {
  const form = new URLSearchParams({ CallSid: 'CA9876543210', From: opts.from, To: opts.to })
  if (opts.accountSid) form.set('AccountSid', opts.accountSid)
  const res = await app.request('/api/telephony/incoming', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Forwarded-For': opts.sourceIp,
      'X-Test-Signature': opts.signature ?? 'forged',
    },
    body: form.toString(),
  }, { ENVIRONMENT: 'test', TELEPHONY_WEBHOOK_IPS: PROVIDER_EGRESS })
  return res.status
}

describe('provider-auth: refused webhooks (#2330)', () => {
  const prevTrust = process.env.TRUST_PROXY_HEADERS
  beforeAll(() => {
    process.env.TRUST_PROXY_HEADERS = 'true'
  })
  afterAll(() => {
    if (prevTrust === undefined) delete process.env.TRUST_PROXY_HEADERS
    else process.env.TRUST_PROXY_HEADERS = prevTrust
  })

  const CALLER = '+15559998877'
  const interruptsFor = (hubId: string) => sent.filter((s) => s.hubId === hubId && s.channel === 'interrupt')

  it('500 forged webhooks without our account id: a record-level incident, visible, and nobody is woken', async () => {
    const hub = await createHub()
    const app = await telephonyApp(fakeProvider())
    const sources: string[] = []
    for (let i = 0; i < 500; i++) {
      // Half through the provider's own egress (an attacker with their own
      // account there), half from anywhere; none carries our account id.
      const ip = i % 2 === 0 ? `10.${(i >> 8) & 0xff}.${i & 0xff}.7` : `198.${(i >> 8) & 0xff}.${i & 0xff}.9`
      sources.push(ip)
      const status = await incoming(app, { to: hub.phone!, from: CALLER, sourceIp: ip, accountSid: i % 3 === 0 ? 'AC-their-account' : undefined })
      expect(status).toBe(403)
    }

    const row = await openIncident(hub.id, 'provider-auth')
    expect(row, 'the flood must be visible (rule V)').not.toBeNull()
    expect(row!.severity).toBe('record')
    expect(Object.keys(row!.counts).sort()).toEqual(['ip_rejected', 'signature_invalid'])
    expect(interruptsFor(hub.id), 'a forged flood must never interrupt anybody').toEqual([])
    expect(sent.filter((s) => s.hubId === hub.id && s.channel === 'relay').map((s) => s.state)).toContain('opened')

    expect((await listAs('role-provider-desk', hub.id)).map((i) => [i.category, i.severity])).toEqual([['provider-auth', 'record']])
    expect(await listAs('role-volunteer', hub.id)).toEqual([])
    expect(await listAs('role-fallback-desk', hub.id)).toEqual([])

    assertNoIdentifiers(row!, [hub.phone!, CALLER, 'CA9876543210', ...sources.slice(0, 20)])
  })

  it('our account id + provider egress IP + a wrong signature → notify', async () => {
    const hub = await createHub()
    const app = await telephonyApp(fakeProvider())
    expect(await incoming(app, { to: hub.phone!, from: CALLER, sourceIp: '10.1.2.3', accountSid: OUR_ACCOUNT })).toBe(403)

    const row = await openIncident(hub.id, 'provider-auth')
    expect(row!.counts).toEqual({ own_account_signature_invalid: 1 })
    expect(row!.severity).toBe('notify')
    expect(interruptsFor(hub.id).map((s) => s.state)).toEqual(['opened'])
    assertNoIdentifiers(row!, [hub.phone!, CALLER, OUR_ACCOUNT, '10.1.2.3'])
  })

  it('our account id from a NON-provider IP is a forgery wearing our name → record', async () => {
    const hub = await createHub()
    const app = await telephonyApp(fakeProvider())
    expect(await incoming(app, { to: hub.phone!, from: CALLER, sourceIp: '192.0.2.44', accountSid: OUR_ACCOUNT })).toBe(403)

    const row = await openIncident(hub.id, 'provider-auth')
    expect(row!.counts).toEqual({ ip_rejected: 1 })
    expect(row!.severity).toBe('record')
    expect(interruptsFor(hub.id)).toEqual([])
  })

  it('a provider IP with a foreign account id (an attacker with their own provider account) → record', async () => {
    const hub = await createHub()
    const app = await telephonyApp(fakeProvider())
    expect(await incoming(app, { to: hub.phone!, from: CALLER, sourceIp: '10.9.9.9', accountSid: 'AC-their-account' })).toBe(403)

    const row = await openIncident(hub.id, 'provider-auth')
    expect(row!.counts).toEqual({ signature_invalid: 1 })
    expect(row!.severity).toBe('record')
    expect(interruptsFor(hub.id)).toEqual([])
  })

  it('a correctly signed request from outside the allowlist → provider_allowlist_stale, notify, and still 403', async () => {
    const hub = await createHub()
    const adapter = fakeProvider()
    const app = await telephonyApp(adapter)
    expect(await incoming(app, { to: hub.phone!, from: CALLER, sourceIp: '192.0.2.10', signature: GOOD_SIGNATURE })).toBe(403)

    expect(adapter.validateWebhook).toHaveBeenCalledTimes(1)
    const row = await openIncident(hub.id, 'provider-auth')
    expect(row!.counts).toEqual({ provider_allowlist_stale: 1 })
    expect(row!.severity).toBe('notify')
    expect(interruptsFor(hub.id).map((s) => s.state)).toEqual(['opened'])
    assertNoIdentifiers(row!, [hub.phone!, CALLER, '192.0.2.10'])
  })

  it('a refusal whose hub cannot be determined opens nothing — no hub is invented', async () => {
    const before = await fresh.db.select().from(schema.hubIncidents)
    const app = await telephonyApp(fakeProvider())
    expect(await incoming(app, { to: '+15550000001', from: CALLER, sourceIp: '10.4.4.4', accountSid: OUR_ACCOUNT })).toBe(403)
    expect(await fresh.db.select().from(schema.hubIncidents)).toEqual(before)
  })
})
