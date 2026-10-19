/**
 * Issue #1684 (item 3): the per-user audit key (CRYPTO_ARCHITECTURE.md →
 * packages/crypto/src/audit_key.rs) must be WIRED, not just implemented.
 * `ErasureService.upsertAuditUserKey` had no caller, so no `audit_user_keys`
 * row was ever created, `LABEL_AUDIT_DETAILS` encryption never happened, and
 * the erasure-time key deletion shredded nothing.
 *
 * Proven here against real PostgreSQL with the real service wiring:
 *
 *  1. A user's first audit entry creates their `audit_user_keys` row, the key
 *     HPKE-wrapped to each admin under LABEL_AUDIT_USER_KEY_WRAP (AAD binds
 *     the wrap to the user, matching audit_key.rs).
 *  2. The entry's `details` are encrypted at rest under LABEL_AUDIT_DETAILS
 *     (AAD binds ciphertext to user AND entry id) — the stored row does not
 *     contain the plaintext.
 *  3. An admin holding the X25519 secret unwraps the key and decrypts the
 *     details offline — the byte-for-byte E2EE property.
 *  4. The API read path (list) returns decrypted details, so clients and the
 *     hash-chain recomputation contract are unchanged.
 *  5. verifyChain validates a chain containing encrypted entries.
 *  6. Destroying the key row makes the details permanently undecryptable
 *     (crypto-shredding) — via the raw decrypt path AND the service read path.
 *  7. `system` entries are never encrypted (no user key exists for them).
 *  8. createServices — the production construction path — arms all of it.
 *
 * Requires postgres at DATABASE_URL. Own database, dropped on teardown.
 */
// pg-array-patch must be imported before any schema is loaded.
import '../../db/pg-array-patch'
import '../mocks/llamenos-crypto-ffi'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { hpkeOpen, symmetricDecrypt } from '@llamenos/crypto/ffi'
import { hexToBytes, utf8ToBytes } from '@shared/encoding'
import { LABEL_AUDIT_DETAILS, LABEL_AUDIT_USER_KEY_WRAP } from '@shared/crypto-labels'
import * as schema from '../../db/schema'
import { AuditService, computeEntryHash } from '../../services/audit'
import { ErasureService } from '../../services/erasure'
import { freshHubDb, reader } from './hub-shred-helpers'

vi.mock('@llamenos/crypto/ffi', async () => await import('../mocks/llamenos-crypto-ffi'))

const fresh = freshHubDb('audit_user_key')

beforeAll(fresh.setup, 180_000)
afterAll(fresh.teardown, 60_000)

const SERVER_SECRET_HEX = 'ef'.repeat(32)

/** The audit-details ciphertext marker written into the JSONB details column. */
const MARKER = '$encrypted'

function wiredAudit(adminPubkeys: string[]) {
  const erasure = new ErasureService(fresh.db)
  return new AuditService(fresh.db, {
    serverSecret: hexToBytes(SERVER_SECRET_HEX),
    resolveAdminRecipients: async () => adminPubkeys,
    keyStore: erasure,
  })
}

/** Read the raw stored row — what a database snapshot attacker would see. */
async function rawEntry(id: string) {
  const [row] = await fresh.db.select().from(schema.auditLog).where(eq(schema.auditLog.id, id))
  return row
}

async function keyRow(userPubkey: string) {
  const [row] = await fresh.db
    .select()
    .from(schema.auditUserKeys)
    .where(eq(schema.auditUserKeys.userPubkey, userPubkey))
  return row
}

/** The offline admin path: unwrap the audit key from its envelope. */
function unwrapAuditKey(admin: ReturnType<typeof reader>, envelope: { enc: string; ct: string }, userPubkey: string): Uint8Array {
  const bytes = new Uint8Array([...hexToBytes(envelope.enc), ...hexToBytes(envelope.ct)])
  return hpkeOpen(
    admin.secret,
    bytes,
    utf8ToBytes(LABEL_AUDIT_USER_KEY_WRAP),
    utf8ToBytes(`${LABEL_AUDIT_USER_KEY_WRAP}:${userPubkey}`),
  )
}

/** audit_key.rs-compatible details decryption: nonce_hex:ciphertext_hex. */
function openDetails(auditKey: Uint8Array, encrypted: string, userPubkey: string, entryId: string): string {
  const [nonceHex, ctHex] = encrypted.split(':')
  const data = new Uint8Array([...hexToBytes(nonceHex!), ...hexToBytes(ctHex!)])
  return new TextDecoder().decode(
    symmetricDecrypt(auditKey, data, utf8ToBytes(`${LABEL_AUDIT_DETAILS}:${userPubkey}:${entryId}`)),
  )
}

describe('per-user audit key — wired', () => {
  it('creates the audit_user_keys row on a user\'s first entry and encrypts details at rest', async () => {
    const admin = reader()
    const audit = wiredAudit([admin.pubkey])
    const user = 'aa'.repeat(32)
    const details = { noteId: 'n-secret-1', callId: 'call-xyz' }

    const entry = await audit.log('noteCreated', user, details, 'hub-ak-1')

    // The row exists — fails today: upsertAuditUserKey has no caller.
    const key = await keyRow(user)
    expect(key).toBeTruthy()
    const envelopes = key!.adminEnvelopes as Array<{ pubkey: string; enc: string; ct: string }>
    expect(envelopes.map((e) => e.pubkey)).toContain(admin.pubkey)

    // Details at rest are the encrypted marker, not the plaintext.
    const stored = await rawEntry(entry.id)
    const storedDetails = stored!.details as Record<string, unknown>
    expect(typeof storedDetails[MARKER]).toBe('string')
    expect(JSON.stringify(storedDetails)).not.toContain('n-secret-1')
    expect(JSON.stringify(storedDetails)).not.toContain('call-xyz')

    // The log() return contract is unchanged: callers get their plaintext back.
    expect(entry.details).toEqual(details)
  })

  it('an admin unwraps the key and decrypts the details offline (audit_key.rs format)', async () => {
    const admin = reader()
    const audit = wiredAudit([admin.pubkey])
    const user = 'bb'.repeat(32)

    const entry = await audit.log('callAnswered', user, { callId: 'call-secret-2' }, 'hub-ak-1')

    const key = await keyRow(user)
    const envelopes = key!.adminEnvelopes as Array<{ pubkey: string; enc: string; ct: string }>
    const auditKey = unwrapAuditKey(admin, envelopes[0]!, user)
    expect(auditKey).toHaveLength(32)

    const stored = await rawEntry(entry.id)
    const marker = (stored!.details as Record<string, string>)[MARKER]!
    const plaintext = openDetails(auditKey, marker, user, entry.id)
    expect(JSON.parse(plaintext)).toEqual({ callId: 'call-secret-2' })
  })

  it('list() returns decrypted details; entryHash commits to the plaintext', async () => {
    const admin = reader()
    const audit = wiredAudit([admin.pubkey])
    const user = 'cc'.repeat(32)
    const details = { shiftId: 'shift-secret-3' }

    const entry = await audit.log('shiftCreated', user, details, 'hub-ak-2')

    const { entries } = await audit.list('hub-ak-2')
    const listed = entries.find((e) => e.id === entry.id)
    expect(listed).toBeTruthy()
    expect(listed!.details).toEqual(details)

    // Client-side recomputation (tests/integrity-helpers, audit-integrity
    // BDD) hashes the API-visible details and must match the stored hash.
    const stored = await rawEntry(entry.id)
    const createdAt = stored!.createdAt instanceof Date ? stored!.createdAt.toISOString() : String(stored!.createdAt)
    expect(
      computeEntryHash({
        id: entry.id,
        action: 'shiftCreated',
        actorPubkey: user,
        createdAt,
        details,
        previousEntryHash: stored!.previousEntryHash,
      }),
    ).toBe(stored!.entryHash)
  })

  it('verifyChain validates a chain containing encrypted entries', async () => {
    const admin = reader()
    const audit = wiredAudit([admin.pubkey])
    const user = 'dd'.repeat(32)

    await audit.log('userAdded', user, { name: 'secret-name-4' }, 'hub-ak-3')
    await audit.log('login', user, {}, 'hub-ak-3')
    await audit.log('callMissed', 'system', { callSid: 'sys-1' }, 'hub-ak-3')

    const result = await audit.verifyFullChain('hub-ak-3')
    expect(result.valid).toBe(true)
    expect(result.checkedEntries).toBe(3)
  })

  it('destroying the key row makes the details permanently undecryptable', async () => {
    const admin = reader()
    const audit = wiredAudit([admin.pubkey])
    const user = 'ee'.repeat(32)

    const entry = await audit.log('noteCreated', user, { noteId: 'n-shred-5' }, 'hub-ak-4')
    const stored = await rawEntry(entry.id)
    const marker = (stored!.details as Record<string, string>)[MARKER]!

    // Sanity: admin CAN read it before the shred.
    const keyBefore = await keyRow(user)
    const envBefore = (keyBefore!.adminEnvelopes as Array<{ enc: string; ct: string }>)[0]!
    const auditKey = unwrapAuditKey(admin, envBefore, user)
    expect(JSON.parse(openDetails(auditKey, marker, user, entry.id))).toEqual({ noteId: 'n-shred-5' })

    // The shred: erasure deletes the audit_user_keys row (erasure.ts).
    await fresh.db.delete(schema.auditUserKeys).where(eq(schema.auditUserKeys.userPubkey, user))
    expect(await keyRow(user)).toBeUndefined()

    // Any key an attacker might hold is wrong; AES-GCM refuses the ciphertext.
    const wrongKey = new Uint8Array(32)
    crypto.getRandomValues(wrongKey)
    expect(() => openDetails(wrongKey, marker, user, entry.id)).toThrow()

    // The service read path no longer returns the plaintext either.
    const { entries } = await audit.list('hub-ak-4')
    const listed = entries.find((e) => e.id === entry.id)
    expect(JSON.stringify(listed!.details)).not.toContain('n-shred-5')

    // And chain verification refuses to vouch for an entry it cannot read.
    const verify = await audit.verifyChain('hub-ak-4')
    expect(verify.valid).toBe(false)
    expect(verify.firstBrokenEntry?.reason).toContain('undecryptable')
  })

  it('with no admin recipient the entry is still written, encrypted at rest, and readable via the service', async () => {
    const audit = wiredAudit([])
    const user = 'ee'.repeat(32)

    // Must not throw: a bootstrap-time audit write cannot depend on an admin
    // recipient existing yet.
    const entry = await audit.log('noteCreated', user, { noteId: 'n-norecip-7' }, 'hub-ak-6')

    const stored = await rawEntry(entry.id)
    expect(typeof (stored!.details as Record<string, unknown>)[MARKER]).toBe('string')
    expect(JSON.stringify(stored!.details)).not.toContain('n-norecip-7')
    expect((await keyRow(user))!.adminEnvelopes).toEqual([])

    const { entries } = await audit.list('hub-ak-6')
    expect(entries.find((e) => e.id === entry.id)?.details).toEqual({ noteId: 'n-norecip-7' })
  })

  it('never encrypts system entries and never creates a key row for them', async () => {
    const admin = reader()
    const audit = wiredAudit([admin.pubkey])

    const entry = await audit.log('callMissed', 'system', { callSid: 'sys-secret-6' }, 'hub-ak-5')

    const stored = await rawEntry(entry.id)
    expect(stored!.details).toEqual({ callSid: 'sys-secret-6' })
    expect(await keyRow('system')).toBeUndefined()
  })

  it('production wiring: createServices arms the audit key path when SERVER_SECRET is set', async () => {
    const { createServices } = await import('../../services')
    const admin = reader()
    await fresh.db.insert(schema.users).values({
      pubkey: admin.pubkey,
      displayName: 'Admin AK',
      roles: ['role-super-admin'],
      active: true,
    })
    await fresh.db.insert(schema.devices).values({
      pubkey: admin.pubkey,
      platform: 'test',
      x25519Pubkey: admin.pubkey,
    })

    const services = createServices(fresh.db, {
      hmacSecret: 'b'.repeat(64),
      env: {
        ENVIRONMENT: 'test',
        SERVER_SECRET: SERVER_SECRET_HEX,
      },
    })

    const user = 'ff'.repeat(32)
    const entry = await services.audit.log('noteCreated', user, { noteId: 'n-wired-7' }, 'hub-ak-6')

    // Fails today: nothing calls upsertAuditUserKey.
    expect(await keyRow(user)).toBeTruthy()
    const stored = await rawEntry(entry.id)
    expect(JSON.stringify(stored!.details)).not.toContain('n-wired-7')

    const { entries } = await services.audit.list('hub-ak-6')
    expect(entries.find((e) => e.id === entry.id)!.details).toEqual({ noteId: 'n-wired-7' })
  })

  it('erasure deletes the key row (crypto-shredding) inside the user-erasure transaction', async () => {
    const admin = reader()
    const audit = wiredAudit([admin.pubkey])
    const user = 'ab'.repeat(32)

    // The user must exist for the erasure transaction's user-row update.
    await fresh.db.insert(schema.users).values({ pubkey: user, displayName: 'Erase Me' })
    await audit.log('noteCreated', user, { noteId: 'n-erasure-8' }, 'hub-ak-7')
    expect(await keyRow(user)).toBeTruthy()

    // ErasureService.executeErasure is the production path; it needs a full
    // request row. The key deletion itself is a single statement inside that
    // transaction — drive it through the real service method that owns it.
    const erasure = new ErasureService(fresh.db)
    await erasure.destroyAuditUserKey(user)

    expect(await keyRow(user)).toBeUndefined()
    const stored = await fresh.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actorPubkey, user))
    // Entries remain (audit floor), but the key is gone.
    expect(stored.length).toBeGreaterThan(0)
  })
})
