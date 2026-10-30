/**
 * A failed provider-recording deletion raises a `provider-media` hub incident
 * (B-INCIDENT-PROVIDER-MEDIA), against real PostgreSQL and the production
 * service registry (`createServices`).
 *
 * Before this, `recordFailure` wrote a ledger row, a log line and an audit
 * entry — all pull-only — so caller audio could sit on a third party's
 * infrastructure while nothing anywhere said so. These tests drive each
 * production path that reaches a deletion (voicemail, call recording, the
 * retention purge's `deleteForCalls`, the hub shred's `deleteForHub`, the sweep's
 * `retryPending`) and assert, per path, that:
 *
 *  - an open `provider-media` incident exists, and the ledger row and audit
 *    entry are still written (the incident is in addition, never instead);
 *  - a member who lacks `telephony:manage-providers` sees nothing through the
 *    real `hubContext` + incidents route, a holder does;
 *  - the incident holds nothing number-shaped — no call id, recording handle,
 *    or phone number;
 *  - repeated failures update ONE incident rather than opening N.
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
import type { IncidentState } from '@protocol/schemas/incidents'
import { insertHubFounder } from '../helpers/hub-founder'

vi.mock('@llamenos/crypto/ffi', async () => await import('../mocks/llamenos-crypto-ffi'))
import { freshHubDb } from './hub-shred-helpers'
import { createServices, type Services } from '../../services'
import type { IncidentNotifier } from '../../services/incidents'
import { processVoicemailRecording } from '../../services/voicemail'
import { processCallRecording } from '../../services/call-recordings'
import type { TelephonyAdapter } from '../../telephony/adapter'

const fresh = freshHubDb('provider_media_incident')

let services: Services
const sent: { channel: 'relay' | 'interrupt'; incidentId: string; state: IncidentState }[] = []
const notifier: IncidentNotifier = {
  async relay(incident: HubIncidentRow, state: IncidentState) {
    sent.push({ channel: 'relay', incidentId: incident.id, state })
  },
  async interrupt(incident: HubIncidentRow, state: IncidentState) {
    sent.push({ channel: 'interrupt', incidentId: incident.id, state })
  },
}

beforeAll(async () => {
  await fresh.setup()
  const blobs = new Map<string, Uint8Array>()
  services = createServices(fresh.db, {
    hmacSecret: 'a'.repeat(64),
    serverKek: 'c'.repeat(64),
    env: { ENVIRONMENT: 'test' },
    blobStorage: {
      async put(key: string, body: Uint8Array) { blobs.set(key, body) },
      async get(key: string) {
        const bytes = blobs.get(key)
        if (!bytes) return null
        return { body: new Blob([new Uint8Array(bytes)]).stream(), size: bytes.byteLength, arrayBuffer: async () => new Uint8Array(bytes).buffer }
      },
      async delete(key: string) { blobs.delete(key) },
    } as never,
  })
  services.incidents.setNotifier(notifier)
}, 180_000)
afterAll(fresh.teardown, 60_000)

beforeEach(async () => {
  sent.length = 0
  await fresh.db.delete(schema.hubIncidents)
  await fresh.db.delete(schema.providerRecordings)
})

let hubCounter = 0
async function createHub(): Promise<string> {
  const id = `hub-pmi-${++hubCounter}-${Math.random().toString(36).slice(2, 8)}`
  await services.settings.createHub({
    id,
    name: `Hub ${id}`,
    slug: id,
    status: 'active',
    createdBy: 'integration-test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never, await insertHubFounder(fresh.db))
  return id
}

const ACCOUNT = { providerAccountId: () => 'twilio:AC-pmi' }

/** Number-shaped on purpose: a phone number in the call id, a provider-style recording handle. */
const CALL_ID = 'CA+15551234567'
const HANDLE = 'RE0123456789abcdef0123456789abcdef'

/** A provider that refuses every deletion (and serves audio, so a call recording's copy succeeds). */
function refusingProvider(): TelephonyAdapter {
  return {
    ...ACCOUNT,
    deleteRecording: async () => { throw new Error('provider returned 500') },
    getRecordingAudio: async () => new Uint8Array([1, 2, 3, 4]).buffer,
  } as unknown as TelephonyAdapter
}

async function openIncidents(hubId: string) {
  return fresh.db
    .select()
    .from(schema.hubIncidents)
    .where(and(
      eq(schema.hubIncidents.hubId, hubId),
      eq(schema.hubIncidents.category, 'provider-media'),
      isNull(schema.hubIncidents.closedAt),
    ))
}

/** The ledger row, the audit entry — the existing pull-only record that must survive. */
async function expectLedgerAndAudit(hubId: string, action: 'providerRecordingDeleteFailed' | 'providerCallLogDeleteFailed' = 'providerRecordingDeleteFailed') {
  const held = await services.providerRecordings.listHeld(hubId)
  expect(held.length).toBeGreaterThan(0)
  expect(held[0]!.deleteAttempts).toBeGreaterThanOrEqual(1)
  expect(held[0]!.lastError).toContain('provider returned 500')
  const { entries } = await fresh.audit.list(hubId)
  expect(entries.map((e) => e.action)).toContain(action)
}

/** The incident holds only declared kinds and integers: nothing number-shaped from the call. */
function expectNoIdentifiers(row: HubIncidentRow) {
  expect(row.counts).toEqual({ delete_failed: expect.any(Number) })
  const stored = JSON.stringify(row)
  expect(stored).not.toContain(CALL_ID)
  expect(stored).not.toContain('15551234567')
  expect(stored).not.toContain(HANDLE)
  expect(stored).not.toContain('twilio')
}

describe('a failed provider deletion raises a provider-media incident', () => {
  it('voicemail: processVoicemailRecording', async () => {
    const hubId = await createHub()
    const outcome = await processVoicemailRecording({
      env: {} as never, services, adapter: refusingProvider(), hubId, callSid: CALL_ID, recordingSid: HANDLE,
    })
    expect(outcome.recordingDeletion).toBe('failed')

    const [row, ...rest] = await openIncidents(hubId)
    expect(rest).toEqual([])
    expect(row, 'the failed voicemail deletion must open an incident').toBeDefined()
    expect(row!.severity).toBe('notify')
    expect(row!.counts).toEqual({ delete_failed: 1 })
    expectNoIdentifiers(row!)
    expect(sent).toEqual([
      { channel: 'relay', incidentId: row!.id, state: 'opened' },
      { channel: 'interrupt', incidentId: row!.id, state: 'opened' },
    ])
    await expectLedgerAndAudit(hubId)
  })

  it('call recording: processCallRecording', async () => {
    const hubId = await createHub()
    const outcome = await processCallRecording({
      env: {} as never, services, adapter: refusingProvider(), hubId, callSid: CALL_ID, recordingSid: HANDLE, answeredBy: '',
    })
    expect(outcome.providerCopy).toBe('kept')

    const [row] = await openIncidents(hubId)
    expect(row, 'the failed call-recording deletion must open an incident').toBeDefined()
    expect(row!.counts).toEqual({ delete_failed: 1 })
    expectNoIdentifiers(row!)
    await expectLedgerAndAudit(hubId)
  })

  it('retention purge: eraser.deleteForCalls', async () => {
    const hubId = await createHub()
    await services.providerRecordings.track({ hubId, callId: CALL_ID, recordingSid: HANDLE, kind: 'voicemail', adapter: ACCOUNT })
    const result = await services.providerRecordings.eraser(async () => refusingProvider()).deleteForCalls(hubId, [CALL_ID])
    expect(result.failed).toHaveLength(1)

    const [row] = await openIncidents(hubId)
    expect(row).toBeDefined()
    expectNoIdentifiers(row!)
    await expectLedgerAndAudit(hubId)
  })

  it('hub shred: eraser.deleteForHub', async () => {
    const hubId = await createHub()
    await services.providerRecordings.track({ hubId, callId: CALL_ID, recordingSid: HANDLE, kind: 'call', adapter: ACCOUNT })
    const result = await services.providerRecordings.eraser(async () => refusingProvider()).deleteForHub(hubId)
    expect(result.failed.some((f) => f.callId === CALL_ID)).toBe(true)

    const [row] = await openIncidents(hubId)
    expect(row).toBeDefined()
    expectNoIdentifiers(row!)
    await expectLedgerAndAudit(hubId)
  })

  it('sweep: eraser.retryPending, including a hub with no provider configured', async () => {
    const hubId = await createHub()
    await services.providerRecordings.track({ hubId, callId: CALL_ID, recordingSid: HANDLE, kind: 'voicemail', adapter: ACCOUNT })
    await fresh.db.update(schema.providerRecordings).set({ createdAt: new Date(Date.now() - 3_600_000) })
    const result = await services.providerRecordings.eraser(async () => null).retryPending(15 * 60_000)
    expect(result.failed).toHaveLength(1)

    const [row] = await openIncidents(hubId)
    expect(row, 'no provider configured is still caller audio held at a provider').toBeDefined()
    expectNoIdentifiers(row!)
  })

  it('residue with no handle (unaddressable) raises it too', async () => {
    const hubId = await createHub()
    await services.providerRecordings.trackUnaddressable({ hubId, callId: CALL_ID, kind: 'voicemail', adapter: ACCOUNT })
    await services.providerRecordings.eraser(async () => refusingProvider()).deleteForHub(hubId)
    const [row] = await openIncidents(hubId)
    expect(row).toBeDefined()
    expectNoIdentifiers(row!)
  })

  it('a successful deletion raises nothing', async () => {
    const hubId = await createHub()
    await services.providerRecordings.track({ hubId, callId: CALL_ID, recordingSid: HANDLE, kind: 'voicemail', adapter: ACCOUNT })
    const adapter = { ...ACCOUNT, deleteRecording: async () => {} } as unknown as TelephonyAdapter
    const result = await services.providerRecordings.deleteHeld(async () => adapter, { hubId })
    expect(result.deleted).toBe(1)
    expect(await openIncidents(hubId)).toEqual([])
    expect(sent).toEqual([])
  })

  it('repeated failures update one incident; the core throttles instead of opening N', async () => {
    const hubId = await createHub()
    await services.providerRecordings.track({ hubId, callId: CALL_ID, recordingSid: HANDLE, kind: 'voicemail', adapter: ACCOUNT })
    const eraser = services.providerRecordings.eraser(async () => refusingProvider())
    await fresh.db.update(schema.providerRecordings).set({ createdAt: new Date(Date.now() - 3_600_000) })
    for (let i = 0; i < 5; i++) await eraser.retryPending(15 * 60_000)

    const rows = await openIncidents(hubId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.counts).toEqual({ delete_failed: 5 })
    // One announcement on open — five failures inside the 60-minute window do not page five times.
    expect(sent).toEqual([
      { channel: 'relay', incidentId: rows[0]!.id, state: 'opened' },
      { channel: 'interrupt', incidentId: rows[0]!.id, state: 'opened' },
    ])
    const held = await services.providerRecordings.listHeld(hubId)
    expect(held[0]!.deleteAttempts, 'the ledger still counts every attempt').toBe(5)
  })

  it('is scoped to the failing hub', async () => {
    const hubA = await createHub()
    const hubB = await createHub()
    await services.providerRecordings.track({ hubId: hubA, callId: CALL_ID, recordingSid: HANDLE, kind: 'voicemail', adapter: ACCOUNT })
    await services.providerRecordings.eraser(async () => refusingProvider()).deleteForHub(hubA)
    expect(await openIncidents(hubA)).toHaveLength(1)
    expect(await openIncidents(hubB)).toEqual([])
  })

  it('a failure to raise the incident never undoes the ledger row or the audit entry, nor throws', async () => {
    const hubId = await createHub()
    await services.providerRecordings.track({ hubId, callId: CALL_ID, recordingSid: HANDLE, kind: 'voicemail', adapter: ACCOUNT })
    const spy = vi.spyOn(services.incidents, 'signal').mockRejectedValueOnce(new Error('incident store down'))
    try {
      const result = await services.providerRecordings.deleteHeld(async () => refusingProvider(), { hubId })
      expect(result.failed).toHaveLength(1)
      expect(spy).toHaveBeenCalledWith(hubId, 'provider-media', 'delete_failed')
    } finally {
      spy.mockRestore()
    }
    await expectLedgerAndAudit(hubId)
  })
})

describe('who sees the provider-media incident', () => {
  const ROLES: Role[] = [
    ...DEFAULT_ROLES.map((r) => ({ ...r, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' })),
    {
      id: 'role-provider-desk',
      name: 'Provider desk',
      slug: 'provider-desk',
      permissions: ['telephony:manage-providers'],
      isDefault: false,
      isSystem: false,
      description: 'Holds telephony:manage-providers and nothing else',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ]

  /** The incidents router mounted as app.ts mounts it, behind the real hubContext. */
  async function listAs(hubRoles: { hubId: string; roleIds: string[] }[], hubId: string) {
    const app = new Hono<AppEnv>()
    app.use('*', async (c, next) => {
      c.set('pubkey', 'f'.repeat(64))
      c.set('user', { pubkey: 'f'.repeat(64), roles: [], hubRoles } as unknown as AppEnv['Variables']['user'])
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
    return { status: res.status, text: await res.text() }
  }

  it('a telephony:manage-providers holder sees it through GET; a member of the same hub without it sees nothing', async () => {
    const hubId = await createHub()
    await services.providerRecordings.track({ hubId, callId: CALL_ID, recordingSid: HANDLE, kind: 'voicemail', adapter: ACCOUNT })
    await services.providerRecordings.eraser(async () => refusingProvider()).deleteForHub(hubId)

    for (const roleId of ['role-provider-desk', 'role-hub-admin']) {
      const holder = await listAs([{ hubId, roleIds: [roleId] }], hubId)
      expect(holder.status).toBe(200)
      const body = JSON.parse(holder.text) as { incidents: { category: string; counts: Record<string, number>; totalCount: number }[] }
      expect(body.incidents.map((i) => [i.category, i.counts, i.totalCount])).toEqual([['provider-media', { delete_failed: 1 }, 1]])
      // What the client is given carries no identifier either.
      expect(holder.text).not.toContain(CALL_ID)
      expect(holder.text).not.toContain(HANDLE)
    }

    const volunteer = await listAs([{ hubId, roleIds: ['role-volunteer'] }], hubId)
    expect(volunteer.status).toBe(200)
    expect(JSON.parse(volunteer.text)).toEqual({ incidents: [] })
  })
})
