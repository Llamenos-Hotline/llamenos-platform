/**
 * No provider identifier reaches a persisted or exported surface (#2333).
 *
 * A provider's id for a call, recording or message joins to the provider's CDR,
 * which holds the caller's number. Our own logs and audit rows must therefore
 * carry a keyed ref (lib/provider-ref.ts) — useful to an operator who holds the
 * id, useless to anyone who holds only our data.
 *
 * Real PostgreSQL and the production service registry. Each test drives a path
 * that logs, audits or records a failure about one call, then reads back EVERY
 * surface it could have landed on — all stderr/stdout, every audit_log row, the
 * provider ledger (`last_error`), the incident — and asserts the identifiers are
 * absent and the ref is present. The positive assertion is what keeps the
 * negative one from passing on a surface that was never written.
 *
 * What is deliberately NOT asserted absent: `provider_recordings.call_id` and
 * `recording_sid`, `active_calls.call_id`, `call_records.call_id` and
 * `call_tokens.call_sid`. Those are the working keys — the server must hand the
 * recording handle back to the provider to delete it, and a call's id IS the
 * provider's id for it (see the PR body for the follow-up).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import * as schema from '../../db/schema'
import type { AppEnv } from '../../types'

vi.mock('@llamenos/crypto/ffi', async () => await import('../mocks/llamenos-crypto-ffi'))
import { freshHubDb } from './hub-shred-helpers'
import { createServices, type Services } from '../../services'
import { processVoicemailRecording } from '../../services/voicemail'
import { processCallRecording } from '../../services/call-recordings'
import { audit } from '../../services/audit'
import { providerRef } from '../../lib/provider-ref'
import { requestLogger } from '../../middleware/request-logger'
import { insertHubFounder } from '../helpers/hub-founder'
import type { TelephonyAdapter } from '../../telephony/adapter'

const HMAC_SECRET = 'a'.repeat(64)
const fresh = freshHubDb('provider_id_surfaces')

/** Twilio-shaped call, recording and message SIDs, and a Vonage/Plivo-style UUID call id. */
const CALL_SID = 'CA0123456789abcdef0123456789abcdef'
const RECORDING_SID = 'RE89abcdef0123456789abcdef01234567'
const MESSAGE_SID = 'SMfedcba9876543210fedcba9876543210'
const UUID_CALL_ID = '3f1c0d52-8d2e-4f6b-9a41-7c1e2b5d9e10'
const ALL_IDS = [CALL_SID, RECORDING_SID, MESSAGE_SID, UUID_CALL_ID]

const ACCOUNT = { providerAccountId: () => 'twilio:AC-surfaces' }

/** A provider whose error text names the very call and recording it refused, as Twilio's does. */
function refusingProvider(): TelephonyAdapter {
  return {
    ...ACCOUNT,
    deleteRecording: async () => { throw new Error(`Recording ${RECORDING_SID} of call ${CALL_SID} could not be deleted: 500`) },
    getRecordingAudio: async () => new Uint8Array([1, 2, 3, 4]).buffer,
  } as unknown as TelephonyAdapter
}

let services: Services
let savedSecret: string | undefined
let written: string[] = []

beforeAll(async () => {
  savedSecret = process.env.HMAC_SECRET
  process.env.HMAC_SECRET = HMAC_SECRET
  await fresh.setup()
  const blobs = new Map<string, Uint8Array>()
  services = createServices(fresh.db, {
    hmacSecret: HMAC_SECRET,
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
}, 180_000)

afterAll(async () => {
  if (savedSecret === undefined) delete process.env.HMAC_SECRET
  else process.env.HMAC_SECRET = savedSecret
  await fresh.teardown()
}, 60_000)

beforeEach(async () => {
  written = []
  const capture = (chunk: string | Uint8Array) => {
    written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }
  vi.spyOn(process.stdout, 'write').mockImplementation(capture)
  vi.spyOn(process.stderr, 'write').mockImplementation(capture)
  await fresh.db.delete(schema.hubIncidents)
  await fresh.db.delete(schema.providerRecordings)
})

afterEach(() => {
  vi.restoreAllMocks()
})

let hubCounter = 0
async function createHub(): Promise<string> {
  const id = `hub-pis-${++hubCounter}-${Math.random().toString(36).slice(2, 8)}`
  await services.settings.createHub({
    id, name: `Hub ${id}`, slug: id, status: 'active', createdBy: 'integration-test',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } as never, await insertHubFounder(fresh.db))
  return id
}

/** Everything the server wrote to the log, and every audit / incident row and ledger error it persisted. */
async function surfaces(): Promise<{ logs: string; audit: string; ledgerErrors: string; incidents: string }> {
  return {
    logs: written.join(''),
    audit: JSON.stringify(await fresh.db.select().from(schema.auditLog)),
    ledgerErrors: JSON.stringify((await fresh.db.select().from(schema.providerRecordings)).map((r) => r.lastError)),
    incidents: JSON.stringify(await fresh.db.select().from(schema.hubIncidents)),
  }
}

function expectNoProviderIds(surface: string, label: string) {
  for (const id of ALL_IDS) expect(surface, `${label} must not contain ${id}`).not.toContain(id)
}

describe('a failed provider deletion leaves no provider identifier in a log line, an audit row or the ledger error', () => {
  it('voicemail', async () => {
    const hubId = await createHub()
    const outcome = await processVoicemailRecording({
      env: {} as never, services, adapter: refusingProvider(), hubId, callSid: CALL_SID, recordingSid: RECORDING_SID,
    })
    expect(outcome.recordingDeletion).toBe('failed')

    const s = await surfaces()
    // The failure was logged, audited and recorded — and the ref is how an operator finds it again.
    expect(s.logs).toContain(providerRef(CALL_SID))
    expect(s.audit).toContain(providerRef(CALL_SID))
    expect(s.audit).toContain('providerRecordingDeleteFailed')
    expect(s.ledgerErrors).toContain('could not be deleted: 500')
    for (const [label, surface] of Object.entries(s)) expectNoProviderIds(surface, label)
  })

  it('call recording', async () => {
    const hubId = await createHub()
    await processCallRecording({
      env: {} as never, services, adapter: refusingProvider(), hubId, callSid: CALL_SID, recordingSid: RECORDING_SID, answeredBy: '',
    })
    const s = await surfaces()
    expect(s.audit).toContain('providerRecordingDeleteFailed')
    expect(s.audit).toContain(providerRef(CALL_SID))
    for (const [label, surface] of Object.entries(s)) expectNoProviderIds(surface, label)
  })

  it('retention purge, hub shred and sweep (the eraser)', async () => {
    const hubId = await createHub()
    await services.providerRecordings.track({ hubId, callId: CALL_SID, recordingSid: RECORDING_SID, kind: 'voicemail', adapter: ACCOUNT })
    const eraser = services.providerRecordings.eraser(async () => refusingProvider())
    await eraser.deleteForCalls(hubId, [CALL_SID])
    await eraser.deleteForHub(hubId)
    await fresh.db.update(schema.providerRecordings).set({ createdAt: new Date(Date.now() - 3_600_000) })
    await eraser.retryPending(15 * 60_000)

    const s = await surfaces()
    expect(s.audit).toContain(providerRef(CALL_SID))
    for (const [label, surface] of Object.entries(s)) expectNoProviderIds(surface, label)
  })

  it('unaddressable residue', async () => {
    const hubId = await createHub()
    await services.providerRecordings.trackUnaddressable({ hubId, callId: UUID_CALL_ID, kind: 'voicemail', adapter: ACCOUNT })
    const s = await surfaces()
    expect(s.logs).toContain(providerRef(UUID_CALL_ID))
    expect(s.audit).toContain(providerRef(UUID_CALL_ID))
    for (const [label, surface] of Object.entries(s)) expectNoProviderIds(surface, label)
  })
})

describe('the audit service', () => {
  it('stores a keyed ref for every provider-identifier field, nested or not, and scrubs SIDs in free text', async () => {
    const hubId = await createHub()
    await services.audit.log('callMissed', 'system', { callSid: CALL_SID, hubNote: 'ok' }, hubId)
    await audit(services.audit, 'voicemailReceived', 'system', { callSid: UUID_CALL_ID }, undefined, hubId)
    await services.audit.log('providerRecordingDeleteFailed', 'system', {
      calls: [{ callId: CALL_SID, recordingSid: RECORDING_SID }],
      error: `Message ${MESSAGE_SID} on ${CALL_SID} failed`,
    }, hubId)

    const rows = await fresh.db.select().from(schema.auditLog)
    const stored = JSON.stringify(rows)
    expectNoProviderIds(stored, 'audit_log')
    expect(stored).toContain(providerRef(CALL_SID))
    expect(stored).toContain(providerRef(UUID_CALL_ID))
    expect(stored).toContain(providerRef(RECORDING_SID))
    expect(stored).toContain(providerRef(MESSAGE_SID))
    expect(stored).toContain('"hubNote":"ok"')

    // The chain still verifies: it commits to the stored (ref) details, not to what the caller passed.
    const check = await services.audit.verifyChain(hubId)
    expect(check.valid).toBe(true)
  })
})

describe('the request log', () => {
  it('names the route, never the URL: /api/calls/:callId/answer carries the provider call id', async () => {
    const app = new Hono<AppEnv>()
    app.use('*', requestLogger)
    app.post('/api/calls/:callId/answer', (c) => c.json({ ok: true }))

    for (const callId of [CALL_SID, UUID_CALL_ID, '1730000000.42']) {
      const res = await app.request(`/api/calls/${callId}/answer`, { method: 'POST' })
      expect(res.status).toBe(200)
    }
    const logs = written.join('')
    expect(logs).toContain('/api/calls/:callId/answer')
    for (const id of [CALL_SID, UUID_CALL_ID, '1730000000.42']) expect(logs).not.toContain(id)
  })
})
