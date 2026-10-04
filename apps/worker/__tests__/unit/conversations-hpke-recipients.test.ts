/**
 * The messaging paths must never seal a message to an Ed25519 *identity* key.
 *
 * DHKEM(X25519) accepts any 32 bytes as a recipient public key, so sealing to an
 * Ed25519 signing key produces a well-formed envelope that no secret key on
 * earth can open — silently. `apps/worker/lib/hpke-recipient.ts` exists to make
 * that a compile error; it stopped #1283 at the admin key but both messaging
 * sites still pushed a user's Ed25519 identity pubkey into the same list:
 *
 *   - `services/conversations.ts` handleIncoming — `readerPubkeys.push(conv.assignedTo)`
 *   - `routes/conversations.ts` POST /:id/messages — `readerPubkeys.push(pubkey)`
 *
 * `conversations.assignedTo` and `c.get('pubkey')` are both Ed25519 identity
 * keys (the ones that sign auth tokens). The server holds no X25519 key for any
 * user — `users` has only `pubkey`, and `devices.x25519_pubkey` is never
 * populated by any client today — so it cannot seal to a volunteer at all. The
 * honest behaviour is to omit the envelope, not to write one that claims a
 * reader who can never read.
 *
 * These tests use the real @noble crypto (see the FFI mock), so the
 * unopenability below is demonstrated, not asserted by comment.
 */
import { describe, it, expect } from 'vitest'
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { ConversationsService } from '@worker/services/conversations'
import { encryptMessageForStorage } from '@worker/lib/crypto'
import { hpkeOpen, symmetricDecrypt } from '@llamenos/crypto/ffi'
import { bytesToHex, hexToBytes, utf8ToBytes, bytesToUtf8 } from '@shared/encoding'
import { LABEL_DEVICE_ENCRYPTION_SEED, LABEL_MESSAGE } from '@shared/crypto-labels'
import { hpkeRecipientPubkey } from '@worker/lib/hpke-recipient'
import { createMockDb } from './mock-db'

/** A volunteer's two keys, derived the way a real device derives them. */
function volunteerKeys(seedHex: string) {
  const seed = hexToBytes(seedHex)
  const encSeed = hkdf(sha256, seed, undefined, utf8ToBytes(LABEL_DEVICE_ENCRYPTION_SEED), 32)
  return {
    /** signs auth tokens; stored in `conversations.assigned_to` */
    identityPubkey: bytesToHex(ed25519.getPublicKey(seed)),
    /** the only key an HPKE envelope can be opened with */
    encryptionPubkey: bytesToHex(x25519.getPublicKey(encSeed)),
    encryptionSecret: encSeed,
  }
}

const VOL = volunteerKeys('11'.repeat(32))
const ADMIN_X25519 = hpkeRecipientPubkey('ab'.repeat(32))!

const LABEL = utf8ToBytes(LABEL_MESSAGE)
const AAD = utf8ToBytes(`${LABEL_MESSAGE}:key-wrap`)

function openWith(secret: Uint8Array, encryptedContent: string, env: { enc: string; ct: string }): string {
  const sealed = new Uint8Array([...hexToBytes(env.enc), ...hexToBytes(env.ct)])
  const key = hpkeOpen(secret, sealed, LABEL, AAD)
  return bytesToUtf8(symmetricDecrypt(key, hexToBytes(encryptedContent), LABEL))
}

describe('Ed25519 identity keys are not HPKE recipients', () => {
  it('demonstration: an envelope sealed to an Ed25519 identity key cannot be opened', () => {
    const { encryptedContent, readerEnvelopes } = encryptMessageForStorage('secret', [VOL.identityPubkey])
    expect(readerEnvelopes).toHaveLength(1)
    // The envelope is well-formed and sealed to 32 valid bytes — and is garbage.
    expect(() => openWith(VOL.encryptionSecret, encryptedContent, readerEnvelopes[0])).toThrow()

    // The same plaintext sealed to the volunteer's X25519 key opens correctly,
    // so the failure above is the key type, not the harness.
    const good = encryptMessageForStorage('secret', [VOL.encryptionPubkey])
    expect(openWith(VOL.encryptionSecret, good.encryptedContent, good.readerEnvelopes[0])).toBe('secret')
  })

  it('handleIncoming does not seal an inbound message to the assignee Ed25519 identity key', async () => {
    const { db } = createMockDb(['conversations', 'messages', 'files', 'contactIdentifiers'])

    // Capture what actually reaches `insert(...).values(...)`.
    const insertedValues: Array<Record<string, unknown>> = []
    const realInsert = db.insert as unknown as (...a: unknown[]) => { values: (v: unknown) => unknown }
    ;(db as unknown as { insert: unknown }).insert = (...args: unknown[]) => {
      const chain = realInsert(...args)
      const realValues = chain.values.bind(chain)
      return {
        ...chain,
        values: (v: unknown) => {
          insertedValues.push(v as Record<string, unknown>)
          return realValues(v)
        },
      }
    }

    const service = new ConversationsService(db as any, 'hmac-secret', 'admin-pubkey')

    // An existing, already-claimed conversation: assignedTo holds the Ed25519
    // identity pubkey that `POST /conversations/:id/claim` stores.
    const conv = {
      id: 'conv-1', hubId: 'hub-1', channelType: 'sms',
      contactIdentifierHash: 'hash1', contactLast4: '4567',
      assignedTo: VOL.identityPubkey, status: 'active',
      metadata: null, messageCount: 1,
      lastMessageAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
    }
    // handleIncoming's conversation lookup, then addMessage's getById.
    db.$setSelectResults([[conv], [conv]])
    db.$setInsertResult([{ id: 'msg-1', conversationId: 'conv-1' }])

    await service.handleIncoming({
      channelType: 'sms',
      externalId: 'SM-1',
      senderIdentifier: '+15551110000',
      senderIdentifierHash: 'hash1',
      body: 'inbound body',
      timestamp: new Date().toISOString(),
    }, ADMIN_X25519, 'hub-1')

    const msg = insertedValues.find(v => v.direction === 'inbound')
    expect(msg).toBeDefined()
    const recipients = (msg!.readerEnvelopes as Array<{ pubkey: string }>).map(e => e.pubkey)

    // The admin, who does hold an X25519 secret, must still be a reader.
    expect(recipients).toContain(ADMIN_X25519)
    // The assignee's Ed25519 identity key must not be, because the resulting
    // envelope is unopenable by them or anyone.
    expect(recipients).not.toContain(VOL.identityPubkey)
  })
})
