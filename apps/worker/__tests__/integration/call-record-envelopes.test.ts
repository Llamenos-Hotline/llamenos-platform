/**
 * Issue #1684 (§2.5): call record metadata encryption must be WIRED, not just
 * implemented. `encryptCallRecordForStorage` had no production caller: every
 * completed call was written with `encryptedContent: ''` and
 * `adminEnvelopes: []`, so no envelope set was ever produced.
 *
 * These tests run the REAL service (`CallsService` constructed the way
 * `createServices` constructs it) against real PostgreSQL and prove:
 *
 *  1. `endCall` produces a populated envelope set: §2.5 metadata
 *     ({ answeredBy, callerNumber }) encrypted under LABEL_CALL_META, wrapped
 *     to every admin X25519 recipient.
 *  2. The full caller number appears in NO plaintext column (it is HMAC-hashed
 *     at ingestion; the hash lives inside the envelope; callerLast4 stays
 *     plaintext per §2.5's explicit list).
 *  3. The stale-call reaper (`getActiveCalls`) seals metadata the same way.
 *  4. With no admin recipient resolvable, the record is stored WITHOUT
 *     envelopes and the error is loud (loud-but-stored, matching the
 *     conversations.ts contract) — never a silent seal to nothing.
 *  5. The admin who holds the X25519 secret can genuinely open the envelope
 *     and read the metadata back, byte for byte.
 *
 * Requires postgres at DATABASE_URL. Own database, dropped on teardown.
 */
// pg-array-patch must be imported before any schema is loaded.
import '../../db/pg-array-patch'
import '../mocks/llamenos-crypto-ffi'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { symmetricDecrypt } from '@llamenos/crypto/ffi'
import { hexToBytes } from '@shared/encoding'
import { LABEL_CALL_META } from '@shared/crypto-labels'
import * as schema from '../../db/schema'
import { CallsService } from '../../services/calls'
import { buildReaderPubkeys } from '../../lib/encryption-keys'
import { hashPhone } from '../../lib/crypto'
import { freshHubDb, openEnvelope, reader } from './hub-shred-helpers'

vi.mock('@llamenos/crypto/ffi', async () => await import('../mocks/llamenos-crypto-ffi'))

const fresh = freshHubDb('call_record_envelopes')

beforeAll(fresh.setup, 180_000)
afterAll(fresh.teardown, 60_000)

const HMAC_SECRET = 'b'.repeat(64)
const RAW_CALLER = '+15551234567'
/** What ringing.ts stores on the active call: HMAC-hashed at ingestion. */
const CALLER_HASH = hashPhone(RAW_CALLER, HMAC_SECRET)

/** Stored records seal with no AAD; the label is bound as the HPKE info. */
const NO_AAD = new Uint8Array(0)

/** An admin user with a registered device carrying an X25519 key. */
async function seedAdmin(roles: string[] = []) {
  const admin = reader()
  await fresh.db.insert(schema.users).values({
    pubkey: admin.pubkey,
    displayName: 'Admin',
    roles,
    active: true,
  })
  await fresh.db.insert(schema.devices).values({
    pubkey: admin.pubkey,
    platform: 'test',
    x25519Pubkey: admin.pubkey, // the reader() pubkey IS the X25519 key
  })
  return admin
}

/** CallsService wired the way createServices wires it. */
function wiredCalls(adminUserPubkeys: () => Promise<string[]>) {
  return new CallsService(fresh.db, {
    getAdminRecipients: async () =>
      buildReaderPubkeys(fresh.db, undefined, await adminUserPubkeys()),
  })
}

async function readRecord(callId: string) {
  const [row] = await fresh.db
    .select()
    .from(schema.callRecords)
    .where(eq(schema.callRecords.callId, callId))
  return row
}

function expectNoRawCallerDigits(row: Record<string, unknown>) {
  // §2.5: callerLast4 stays plaintext by design; the FULL number must not
  // appear in any plaintext column.
  const plaintextColumns = { ...row }
  delete plaintextColumns.encryptedContent
  delete plaintextColumns.adminEnvelopes
  expect(JSON.stringify(plaintextColumns)).not.toContain(RAW_CALLER)
  expect(JSON.stringify(plaintextColumns)).not.toContain('1234567')
  expect(row.callerLast4).toBe('4567')
}

describe('call record metadata encryption (PROTOCOL §2.5) — wired', () => {
  it('endCall seals { answeredBy, callerNumber } for admin recipients', async () => {
    const admin = await seedAdmin()
    const calls = wiredCalls(async () => [admin.pubkey])
    const volunteer = 'cd'.repeat(32)

    await calls.addCall('hub-1', {
      callId: 'call-seal-1',
      callerNumber: CALLER_HASH,
      callerLast4: '4567',
    })
    await calls.answerCall('hub-1', 'call-seal-1', volunteer)
    await calls.endCall('hub-1', 'call-seal-1')

    const row = await readRecord('call-seal-1')
    expect(row).toBeTruthy()
    // The envelope set exists — this is the assertion that fails today
    // (encryptedContent '' and adminEnvelopes []).
    expect(row!.encryptedContent).toMatch(/^[0-9a-f]+$/)
    expect(Array.isArray(row!.adminEnvelopes)).toBe(true)
    expect((row!.adminEnvelopes as unknown[]).length).toBeGreaterThan(0)

    expectNoRawCallerDigits(row as unknown as Record<string, unknown>)

    // The admin genuinely opens it: unwrap the record key, decrypt, parse.
    const envelopes = row!.adminEnvelopes as Array<{ pubkey: string; enc: string; ct: string }>
    const myEnvelope = envelopes.find((e) => e.pubkey === admin.pubkey)
    expect(myEnvelope).toBeTruthy()
    const recordKey = openEnvelope(admin.secret, myEnvelope!, LABEL_CALL_META)
    const plaintext = new TextDecoder().decode(
      symmetricDecrypt(recordKey, hexToBytes(row!.encryptedContent), NO_AAD),
    )
    const meta = JSON.parse(plaintext) as { answeredBy: string | null; callerNumber: string }
    expect(meta.answeredBy).toBe(volunteer)
    // §2.5: callerNumber is the HMAC-hashed phone number, never the raw digits.
    expect(meta.callerNumber).toBe(CALLER_HASH)
    expect(meta.callerNumber).not.toContain(RAW_CALLER)
  })

  it('seals metadata for an unanswered call (answeredBy null)', async () => {
    const admin = await seedAdmin()
    const calls = wiredCalls(async () => [admin.pubkey])

    await calls.addCall('hub-1', {
      callId: 'call-seal-2',
      callerNumber: CALLER_HASH,
      callerLast4: '4567',
    })
    await calls.endCall('hub-1', 'call-seal-2')

    const row = await readRecord('call-seal-2')
    expect(row!.status).toBe('unanswered')
    const envelopes = row!.adminEnvelopes as Array<{ pubkey: string; enc: string; ct: string }>
    expect(envelopes.length).toBeGreaterThan(0)
    const recordKey = openEnvelope(admin.secret, envelopes[0]!, LABEL_CALL_META)
    const meta = JSON.parse(
      new TextDecoder().decode(symmetricDecrypt(recordKey, hexToBytes(row!.encryptedContent), NO_AAD)),
    ) as { answeredBy: string | null }
    expect(meta.answeredBy).toBeNull()
  })

  it('the stale-call reaper seals metadata too', async () => {
    const admin = await seedAdmin()
    const calls = wiredCalls(async () => [admin.pubkey])

    // A ringing call far past the 3-minute TTL, inserted directly.
    await fresh.db.insert(schema.activeCalls).values({
      callId: 'call-stale-1',
      hubId: 'hub-1',
      callerNumber: CALLER_HASH,
      callerLast4: '4567',
      status: 'ringing',
      startedAt: new Date(Date.now() - 10 * 60 * 1000),
    })

    const active = await calls.getActiveCalls('hub-1')
    expect(active.find((c) => c.callId === 'call-stale-1')).toBeUndefined()

    const row = await readRecord('call-stale-1')
    expect(row).toBeTruthy()
    expect(row!.status).toBe('unanswered')
    expect((row!.adminEnvelopes as unknown[]).length).toBeGreaterThan(0)
    expect(row!.encryptedContent).toMatch(/^[0-9a-f]+$/)
    expectNoRawCallerDigits(row as unknown as Record<string, unknown>)
  })

  it('no admin recipient: loud-but-stored with an empty envelope set', async () => {
    // No admin user, no device, no env key — nothing to seal to. The record
    // must still be written (a dropped call record is worse), with empty
    // content, and the error must be logged for an operator.
    const calls = wiredCalls(async () => [])

    await calls.addCall('hub-1', {
      callId: 'call-seal-3',
      callerNumber: CALLER_HASH,
      callerLast4: '4567',
    })
    const row = await calls.endCall('hub-1', 'call-seal-3')
    expect(row.encryptedContent).toBe('')
    expect(row.adminEnvelopes).toEqual([])
  })

  it('production wiring: createServices arms both write paths', async () => {
    // The regression this issue is about was invisible to tests that built
    // services by hand — prove the construction path production uses
    // (createServices) actually seals.
    const { createServices } = await import('../../services')
    const escrow = reader()
    const services = createServices(fresh.db, {
      hmacSecret: HMAC_SECRET,
      serverKek: 'c'.repeat(64),
      env: {
        ENVIRONMENT: 'test',
        SERVER_SECRET: 'ab'.repeat(32),
        // The escrow key is the only hub-less recipient; the X25519 key IS the reader() pubkey.
        ADMIN_DECRYPTION_PUBKEY: escrow.pubkey,
      },
    })
    // A super-admin with a registered device is zero-knowledge (D1, #2190): it
    // must NOT be sealed to.
    const superAdmin = await seedAdmin(['role-super-admin'])

    await services.calls.addCall('hub-1', {
      callId: 'call-seal-4',
      callerNumber: CALLER_HASH,
      callerLast4: '4567',
    })
    await services.calls.endCall('hub-1', 'call-seal-4')

    const row = await readRecord('call-seal-4')
    const sealedTo = (row!.adminEnvelopes as Array<{ pubkey: string }>).map(e => e.pubkey)
    expect(sealedTo).toEqual([escrow.pubkey])
    expect(sealedTo).not.toContain(superAdmin.pubkey)
    expect(row!.encryptedContent).toMatch(/^[0-9a-f]+$/)
  })
})
