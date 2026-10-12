/**
 * Hub shred request lifecycle — the 48h window, cancellation, the co-approved
 * force override and retention-floor refusal, against real PostgreSQL.
 *
 * The window boundary is always moved by writing `execute_at` in SQL, so the
 * DATABASE clock decides — never setTimeout, never a faked Date on the app
 * side. `runExpiryOnce` drives the same exported per-request function the
 * expiry worker uses, so the test asserts the production path, not a copy.
 */
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519.js'
import { bytesToHex, utf8ToBytes } from '@shared/encoding'
import { LABEL_ERASURE_OVERRIDE_SIG } from '@shared/crypto-labels'
import * as schema from '../../db/schema'
import { RetentionService } from '../../services/retention'
import { encryptCallRecordForStorage } from '../../lib/crypto'
import { processExpiredRequest } from '../../lib/erasure-expiry-worker'

// The native FFI cannot load under vitest; the mock matches the Rust wire
// format (see hub-shred-execute.test.ts).
vi.mock('@llamenos/crypto/ffi', async () => await import('../mocks/llamenos-crypto-ffi'))

import { freshHubDb, openEnvelope, reader, seedReadableNote } from './hub-shred-helpers'

const fresh = freshHubDb('hub_shred_window')

beforeAll(fresh.setup, 180_000)
afterAll(fresh.teardown, 60_000)

const EXECUTOR = 'ab'.repeat(32)
const PLATFORM_ADMIN = 'ef'.repeat(32)

let hubCounter = 0
async function createHub(): Promise<string> {
  const id = `hub-${++hubCounter}-${Math.random().toString(36).slice(2, 8)}`
  await fresh.settings.createHub({
    id,
    name: `Hub ${id}`,
    slug: id,
    status: 'active',
    createdBy: 'integration-test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never)
  return id
}

async function getHub(hubId: string) {
  const [hub] = await fresh.db.select().from(schema.hubs).where(eq(schema.hubs.id, hubId))
  return hub!
}

/** A registered user with Ed25519 signing material and the given global roles. */
function adminDevice(opts: { roles?: string[] } = {}) {
  const secret = new Uint8Array(32)
  crypto.getRandomValues(secret)
  const pubkey = bytesToHex(ed25519.getPublicKey(secret))
  return {
    pubkey,
    roles: opts.roles ?? ['role-admin'],
    sign(message: string) {
      return bytesToHex(ed25519.sign(utf8ToBytes(message), secret))
    },
  }
}

async function registerDevice(device: ReturnType<typeof adminDevice>): Promise<void> {
  await fresh.db.insert(schema.users).values({
    pubkey: device.pubkey,
    roles: device.roles,
    displayName: 'Approver',
  })
}

/** Drive one expiry-worker pass over whatever is now expired. */
async function runExpiryOnce(): Promise<void> {
  const expired = await fresh.erasure.getExpiredPendingRequests()
  for (const request of expired) {
    try {
      await processExpiredRequest(request, {
        erasureService: fresh.erasure,
        auditService: fresh.audit,
        hubShred: fresh.shred,
      })
    } catch {
      await fresh.erasure.markFailed(request.id)
    }
  }
}

function overrideFor(subjectId: string, device: ReturnType<typeof adminDevice>, timestamp: string) {
  return {
    coApproverPubkey: device.pubkey,
    coApproverSignature: device.sign(`${LABEL_ERASURE_OVERRIDE_SIG}:${subjectId}:${timestamp}`),
    timestamp,
  }
}

describe('the 48-hour window', () => {
  it('restores full readability when cancelled inside the window', async () => {
    const hubId = await createHub()
    const { note, author } = await seedReadableNote(fresh.db, hubId)
    await fresh.erasure.createHubShredRequest(hubId, EXECUTOR)
    expect((await getHub(hubId)).status).toBe('shred_pending')

    await fresh.erasure.cancelHubShredRequest(hubId)

    expect((await getHub(hubId)).status).toBe('active')
    const [after] = await fresh.db.select().from(schema.notes).where(eq(schema.notes.id, note.id))
    expect(
      () => openEnvelope(author.secret, after!.authorEnvelope as { enc: string; ct: string }),
      'cancelling must restore readability — nothing was destroyed',
    ).not.toThrow()
  })

  it('is irreversible once the window has elapsed', async () => {
    const hubId = await createHub()
    await seedReadableNote(fresh.db, hubId)
    await fresh.erasure.createHubShredRequest(hubId, EXECUTOR)
    // The database clock decides, so move the deadline in SQL.
    await fresh.db.execute(sql`
      UPDATE erasure_requests SET execute_at = NOW() - INTERVAL '1 second'
      WHERE hub_id = ${hubId} AND status = 'pending'
    `)
    const expired = await fresh.erasure.getExpiredPendingRequests()
    expect(expired.map(r => r.hubId)).toContain(hubId)

    await runExpiryOnce()

    expect((await getHub(hubId)).status).toBe('shredded')
    await expect(fresh.erasure.cancelHubShredRequest(hubId)).rejects.toThrow(/404|No pending/)
    const [req] = await fresh.db
      .select()
      .from(schema.erasureRequests)
      .where(eq(schema.erasureRequests.hubId, hubId))
    expect(req!.status).toBe('completed')
  })

  it('does not expire one second before the deadline', async () => {
    const hubId = await createHub()
    await fresh.erasure.createHubShredRequest(hubId, EXECUTOR)
    await fresh.db.execute(sql`
      UPDATE erasure_requests SET execute_at = NOW() + INTERVAL '1 second'
      WHERE hub_id = ${hubId} AND status = 'pending'
    `)
    expect((await fresh.erasure.getExpiredPendingRequests()).map(r => r.hubId))
      .not.toContain(hubId)
  })

  it('refuses a second request while one is pending', async () => {
    const hubId = await createHub()
    await fresh.erasure.createHubShredRequest(hubId, EXECUTOR)
    await expect(
      fresh.erasure.createHubShredRequest(hubId, EXECUTOR),
    ).rejects.toMatchObject({ status: 409 })
  })

  it('waits the full configured window when no override is supplied', async () => {
    const hubId = await createHub()
    await fresh.erasure.createHubShredRequest(hubId, EXECUTOR)
    const [req] = await fresh.db
      .select()
      .from(schema.erasureRequests)
      .where(eq(schema.erasureRequests.hubId, hubId))
    expect(req!.emergencyOverride).toBe(false)
    const hours = (req!.executeAt.getTime() - req!.requestedAt.getTime()) / 3600_000
    expect(hours).toBeGreaterThan(47.5)
    expect(hours).toBeLessThan(48.5)
  })
})

describe('the co-approved force override', () => {
  it('executes immediately with a valid co-approver signature', async () => {
    const hubId = await createHub()
    await seedReadableNote(fresh.db, hubId)
    const approver = adminDevice()
    await registerDevice(approver)
    const ts = new Date().toISOString()

    await fresh.erasure.createHubShredRequest(hubId, EXECUTOR, 'closing the hub', {
      coApproverPubkey: approver.pubkey,
      coApproverSignature: approver.sign(`${LABEL_ERASURE_OVERRIDE_SIG}:${hubId}:${ts}`),
      timestamp: ts,
    })

    const [req] = await fresh.db
      .select()
      .from(schema.erasureRequests)
      .where(eq(schema.erasureRequests.hubId, hubId))
    expect(req!.emergencyOverride).toBe(true)
    // Force skips the WAIT, not the second pair of eyes (spec §14.1).
    expect(req!.executeAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000)

    await runExpiryOnce()
    expect((await getHub(hubId)).status).toBe('shredded')
  })

  it('refuses a force with no co-approval', async () => {
    const hubId = await createHub()
    const approver = adminDevice()
    await registerDevice(approver)
    const ts = new Date().toISOString()
    await expect(
      fresh.erasure.createHubShredRequest(hubId, EXECUTOR, undefined, {
        coApproverPubkey: approver.pubkey,
        coApproverSignature: '00'.repeat(64),
        timestamp: ts,
      }),
    ).rejects.toThrow(/signature verification failed/)
  })

  it('refuses a co-approver who is not an admin device', async () => {
    const hubId = await createHub()
    const volunteer = adminDevice({ roles: ['role-volunteer'] })
    await registerDevice(volunteer)
    await expect(
      fresh.erasure.createHubShredRequest(hubId, EXECUTOR, undefined,
        overrideFor(hubId, volunteer, new Date().toISOString())),
    ).rejects.toMatchObject({ status: 403, message: /registered admin device/ })
  })

  it('refuses a co-approver who is the requester', async () => {
    const hubId = await createHub()
    const requester = adminDevice()
    await registerDevice(requester)
    await expect(
      fresh.erasure.createHubShredRequest(hubId, requester.pubkey, undefined,
        overrideFor(hubId, requester, new Date().toISOString())),
    ).rejects.toMatchObject({ status: 400, message: /cannot be the same/ })
  })

  it('refuses a force when the hub disabled emergency override', async () => {
    const hubId = await createHub()
    const approver = adminDevice()
    await registerDevice(approver)
    await fresh.erasure.upsertConfig(
      hubId,
      { emergencyOverrideEnabled: false },
      EXECUTOR,
      24,
    )
    await expect(
      fresh.erasure.createHubShredRequest(hubId, EXECUTOR, undefined,
        overrideFor(hubId, approver, new Date().toISOString())),
    ).rejects.toMatchObject({ status: 403, message: /disabled for this hub/ })
  })
})

describe('platform retention floors', () => {
  it('refuses to shred inside a floor without an override', async () => {
    const retention = new RetentionService(fresh.db)
    await retention.upsertFloors(
      [{ category: 'call_records', minRetentionDays: 90 }],
      PLATFORM_ADMIN,
    )
    const hubId = await createHub()
    const admin = reader()
    const sealed = encryptCallRecordForStorage({ note: 'recent call' }, [admin.pubkey])
    await fresh.db.insert(schema.callRecords).values({
      callId: `call-${Math.random().toString(36).slice(2, 10)}`,
      hubId,
      startedAt: new Date(Date.now() - 10 * 24 * 3600_000),
      status: 'completed',
      encryptedContent: sealed.encryptedContent,
      adminEnvelopes: sealed.adminEnvelopes,
    })
    await fresh.erasure.createHubShredRequest(hubId, EXECUTOR)
    await fresh.db.execute(sql`
      UPDATE erasure_requests SET execute_at = NOW() - INTERVAL '1 second'
      WHERE hub_id = ${hubId}
    `)

    await runExpiryOnce()

    expect(
      (await getHub(hubId)).status,
      'a refused shred must not report success',
    ).toBe('shred_pending')
    const [req] = await fresh.db
      .select()
      .from(schema.erasureRequests)
      .where(eq(schema.erasureRequests.hubId, hubId))
    expect(req!.status).toBe('failed')
  })

  it('shreds inside a floor when the request carries a co-approved override', async () => {
    const retention = new RetentionService(fresh.db)
    await retention.upsertFloors(
      [{ category: 'call_records', minRetentionDays: 90 }],
      PLATFORM_ADMIN,
    )
    const hubId = await createHub()
    const admin = reader()
    const sealed = encryptCallRecordForStorage({ note: 'recent call' }, [admin.pubkey])
    await fresh.db.insert(schema.callRecords).values({
      callId: `call-${Math.random().toString(36).slice(2, 10)}`,
      hubId,
      startedAt: new Date(Date.now() - 10 * 24 * 3600_000),
      status: 'completed',
      encryptedContent: sealed.encryptedContent,
      adminEnvelopes: sealed.adminEnvelopes,
    })
    const approver = adminDevice()
    await registerDevice(approver)
    await fresh.erasure.createHubShredRequest(
      hubId,
      EXECUTOR,
      'legal hold released',
      overrideFor(hubId, approver, new Date().toISOString()),
    )
    await fresh.db.execute(sql`
      UPDATE erasure_requests SET execute_at = NOW() - INTERVAL '1 second'
      WHERE hub_id = ${hubId}
    `)

    await runExpiryOnce()

    expect((await getHub(hubId)).status).toBe('shredded')
  })
})
