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
 * keys (the ones that sign auth tokens). The key that *can* receive an envelope
 * is `devices.x25519_pubkey`, which clients now populate on unlock, and
 * `apps/worker/lib/device-recipients.ts` is the only path from a user id to it.
 * Where a user has no such device the honest behaviour is still to omit the
 * envelope, not to write one that claims a reader who can never read.
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
// Stored-record format (#1393): the label is HPKE info, and there is no AAD.
const NO_AAD = new Uint8Array(0)

function openWith(secret: Uint8Array, encryptedContent: string, env: { enc: string; ct: string }): string {
  const sealed = new Uint8Array([...hexToBytes(env.enc), ...hexToBytes(env.ct)])
  const key = hpkeOpen(secret, sealed, LABEL, NO_AAD)
  return bytesToUtf8(symmetricDecrypt(key, hexToBytes(encryptedContent), NO_AAD))
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
    // handleIncoming's conversation lookup, the assignee's device lookup, then
    // addMessage's getById.
    db.$setSelectResults([[conv], [{ x25519Pubkey: VOL.encryptionPubkey }], [conv]])
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
    const envelopes = msg!.readerEnvelopes as Array<{ pubkey: string; enc: string; ct: string }>
    const recipients = envelopes.map(e => e.pubkey)

    // The admin, who does hold an X25519 secret, must still be a reader.
    expect(recipients).toContain(ADMIN_X25519)
    // The assignee's Ed25519 identity key must not be, because the resulting
    // envelope is unopenable by them or anyone.
    expect(recipients).not.toContain(VOL.identityPubkey)
    // Their registered X25519 device key must be, and the envelope must really
    // open with the matching secret — the whole point of resolving it.
    expect(recipients).toContain(VOL.encryptionPubkey)
    const mine = envelopes.find(e => e.pubkey === VOL.encryptionPubkey)!
    expect(openWith(VOL.encryptionSecret, msg!.encryptedContent as string, mine)).toBe('inbound body')
  })

  it('omits the assignee envelope entirely when they have registered no device', async () => {
    const { db } = createMockDb(['conversations', 'messages', 'files', 'contactIdentifiers'])

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
    const conv = {
      id: 'conv-2', hubId: 'hub-1', channelType: 'sms',
      contactIdentifierHash: 'hash2', contactLast4: '4567',
      assignedTo: VOL.identityPubkey, status: 'active',
      metadata: null, messageCount: 1,
      lastMessageAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
    }
    // No device row for the assignee: the lookup returns nothing.
    db.$setSelectResults([[conv], [], [conv]])
    db.$setInsertResult([{ id: 'msg-2', conversationId: 'conv-2' }])

    await service.handleIncoming({
      channelType: 'sms',
      externalId: 'SM-2',
      senderIdentifier: '+15551110000',
      senderIdentifierHash: 'hash2',
      body: 'inbound body',
      timestamp: new Date().toISOString(),
    }, ADMIN_X25519, 'hub-1')

    const msg = insertedValues.find(v => v.direction === 'inbound')
    const recipients = (msg!.readerEnvelopes as Array<{ pubkey: string }>).map(e => e.pubkey)
    // One reader, and it is the admin. No substituted key, and no envelope
    // claiming a reader who cannot read — the message is still stored.
    expect(recipients).toEqual([ADMIN_X25519])
  })

  it('stores the inbound message even when NO reader exists anywhere — never drops it', async () => {
    const { db } = createMockDb(['conversations', 'messages', 'files', 'contactIdentifiers'])

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
    // An unassigned waiting conversation: no assignee device lookup runs, and
    // this test passes NO admin recipient — the reader list is empty.
    const conv = {
      id: 'conv-3', hubId: 'hub-1', channelType: 'sms',
      contactIdentifierHash: 'hash3', contactLast4: '4567',
      assignedTo: null, status: 'waiting',
      metadata: null, messageCount: 0,
      lastMessageAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
    }
    // handleIncoming's conversation lookup, then addMessage's getById.
    db.$setSelectResults([[conv], [conv]])
    db.$setInsertResult([{ id: 'msg-3', conversationId: 'conv-3' }])

    // The previous behaviour threw out of here (encryptMessageForStorage
    // refuses an empty reader list): the webhook answered 500, the provider
    // retried, and the replay guard answered the retry with an idempotent 200
    // — the crisis message silently dropped. The contract is loud-but-stored.
    const result = await service.handleIncoming({
      channelType: 'sms',
      externalId: 'SM-3',
      senderIdentifier: '+15551110000',
      senderIdentifierHash: 'hash3',
      body: 'crisis inbound body',
      timestamp: new Date().toISOString(),
    }, undefined, 'hub-1')

    expect(result.messageId).toBe('msg-3')
    const msg = insertedValues.find(v => v.direction === 'inbound')
    expect(msg).toBeDefined()
    // No plaintext anywhere in the row, no envelope claiming a phantom reader.
    expect(msg!.readerEnvelopes).toEqual([])
    expect(msg!.encryptedContent).toBe('')
    expect(JSON.stringify(msg)).not.toContain('crisis inbound body')
  })
})
