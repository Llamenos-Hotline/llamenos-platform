/**
 * A volunteer who claims a conversation can read the message that created it
 * (#1512) — real PostgreSQL, real Rust crypto via bun:ffi.
 *
 * MUST run under `bun test`, NOT vitest:
 *   bun test apps/worker/__tests__/integration-bun/conversation-claim-rewrap.test.ts
 *
 * Why this tier: the assertion is DECRYPTABILITY, so the HPKE seal/open and the
 * AES-GCM content decrypt below are the production Rust implementation, not the
 * vitest @noble mock; and `messages.reader_envelopes` is a `bun-jsonb` column,
 * whose write path only matches production under Bun's native SQL driver.
 *
 * The defect: an inbound message that opens a `waiting` conversation has no
 * assignee, so `handleIncoming` wraps its content key for the platform admin
 * alone and discards it. `claim()` then sets `assigned_to` and writes nothing,
 * so the claiming volunteer holds a thread whose first message they can never
 * open. The server cannot fix that by itself — it holds no key that opens an
 * envelope — so the fix is a client-mediated re-wrap: the admin client opens
 * its own envelope, seals the content key to each of the assignee's device
 * keys, and the server appends those envelopes.
 *
 * `adminClientRewrap` below is that client step, done with the same crypto the
 * desktop links. Every assertion that matters is "the volunteer's secret key
 * opens the message to the original plaintext" — never an envelope count.
 *
 * Requires postgres at DATABASE_URL with migrations applied
 * (`bun scripts/worktree-db.ts use-isolated`). Rows created here are deleted on
 * teardown.
 */
import { describe, it, expect, afterAll, beforeEach } from 'bun:test'
import { inArray } from 'drizzle-orm'
import { x25519 } from '@noble/curves/ed25519.js'
import { hpkeOpen, hpkeSeal, symmetricDecrypt } from '@llamenos/crypto/ffi'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@shared/encoding'
import { LABEL_MESSAGE } from '@shared/crypto-labels'
import type { RecipientEnvelope } from '@shared/types'
import '../../db/pg-array-patch'
import { createDatabase } from '../../db'
import { conversations, devices, messages, users } from '../../db/schema'
import { ConversationsService } from '../../services/conversations'
import { ServiceError } from '../../services/settings'
import { hpkeRecipientPubkey, type HpkeRecipientPubkey } from '../../lib/hpke-recipient'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const db = createDatabase(DATABASE_URL)
const service = new ConversationsService(db, 'ab'.repeat(32))

const suite = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const NO_AAD = new Uint8Array(0)
const LABEL = utf8ToBytes(LABEL_MESSAGE)

/** An X25519 keypair held by a client — the server never sees `secret`. */
function makeKeypair() {
  const secret = x25519.utils.randomSecretKey()
  const recipient = hpkeRecipientPubkey(bytesToHex(x25519.getPublicKey(secret)))
  if (!recipient) throw new Error('fixture produced an invalid recipient key')
  return { secret, recipient }
}

const admin = makeKeypair()
const volunteer = {
  pubkey: bytesToHex(utf8ToBytes(`vol-${suite}`).slice(0, 32)).padEnd(64, '0'),
  devices: [makeKeypair(), makeKeypair()],
}
const bystander = {
  pubkey: bytesToHex(utf8ToBytes(`bys-${suite}`).slice(0, 32)).padEnd(64, '0'),
  device: makeKeypair(),
}

const createdConversations: string[] = []

function unwrapContentKey(envelope: RecipientEnvelope, secret: Uint8Array): Uint8Array {
  return hpkeOpen(secret, hexToBytes(envelope.enc + envelope.ct), LABEL, NO_AAD)
}

/**
 * What a reader's client does to read a stored message: find its envelope,
 * unwrap the content key, decrypt. Throws if there is no envelope for the key
 * or it does not open.
 */
async function readAs(messageId: string, keypair: { secret: Uint8Array; recipient: string }): Promise<string> {
  const [row] = await db
    .select({ encryptedContent: messages.encryptedContent, readerEnvelopes: messages.readerEnvelopes })
    .from(messages)
    .where(inArray(messages.id, [messageId]))
  const envelope = (row.readerEnvelopes as RecipientEnvelope[]).find((e) => e.pubkey === keypair.recipient)
  if (!envelope) throw new Error(`no envelope for ${keypair.recipient.slice(0, 8)}`)
  const contentKey = unwrapContentKey(envelope, keypair.secret)
  return new TextDecoder().decode(symmetricDecrypt(contentKey, hexToBytes(row.encryptedContent), NO_AAD))
}

/**
 * The admin client's half of the re-wrap: open its own envelope on each
 * message the server reports as a gap, seal the content key to every missing
 * assignee device under the same label, submit. Runs until no gap remains.
 */
async function adminClientRewrap(conversationId: string): Promise<number> {
  let total = 0
  // Bounded: if submissions stop closing the gap, fail with that, not a timeout.
  for (let round = 0; ; round++) {
    const gaps = await service.listAssigneeEnvelopeGaps(conversationId)
    if (gaps.messages.length === 0) return total
    if (round === 5) throw new Error('re-wrap submitted but the assignee envelope gap did not close')
    const entries = gaps.messages.flatMap((m) => {
      const own = m.readerEnvelopes.find((e) => e.pubkey === admin.recipient)
      if (!own) throw new Error(`admin cannot open message ${m.id}`)
      const contentKey = unwrapContentKey(own, admin.secret)
      return m.missingRecipients.map((recipient) => {
        const sealed = hpkeSeal(hexToBytes(recipient), contentKey, LABEL, NO_AAD)
        return {
          messageId: m.id,
          envelope: { pubkey: recipient, enc: bytesToHex(sealed.subarray(0, 32)), ct: bytesToHex(sealed.subarray(32)) },
        }
      })
    })
    total += (await service.addAssigneeEnvelopes(conversationId, entries)).added
  }
}

async function inbound(body: string, sender: string): Promise<{ conversationId: string; messageId: string }> {
  const r = await service.handleIncoming(
    {
      channelType: 'sms',
      externalId: `ext-${suite}-${crypto.randomUUID()}`,
      senderIdentifier: '+15550001234',
      senderIdentifierHash: `hash-${suite}-${sender}`,
      body,
      timestamp: new Date().toISOString(),
    },
    admin.recipient as HpkeRecipientPubkey,
  )
  if (!createdConversations.includes(r.conversationId)) createdConversations.push(r.conversationId)
  return { conversationId: r.conversationId, messageId: r.messageId }
}

async function expectServiceError(p: Promise<unknown>, status: number): Promise<void> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(ServiceError)
    expect((err as ServiceError).status).toBe(status)
    return
  }
  throw new Error(`expected ServiceError ${status}, call resolved`)
}

beforeEach(async () => {
  await db.delete(users).where(inArray(users.pubkey, [volunteer.pubkey, bystander.pubkey]))
  await db.insert(users).values([
    { pubkey: volunteer.pubkey, displayName: 'Volunteer' },
    { pubkey: bystander.pubkey, displayName: 'Bystander' },
  ])
  await db.insert(devices).values([
    ...volunteer.devices.map((d) => ({ pubkey: volunteer.pubkey, platform: 'desktop', x25519Pubkey: d.recipient })),
    { pubkey: bystander.pubkey, platform: 'desktop', x25519Pubkey: bystander.device.recipient },
  ])
})

afterAll(async () => {
  if (createdConversations.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversations))
  }
  await db.delete(users).where(inArray(users.pubkey, [volunteer.pubkey, bystander.pubkey]))
})

describe('claim re-wrap: the claiming volunteer can read pre-claim messages (#1512)', () => {
  it('pre-claim message is unreadable to the claimer until an admin client re-wraps it, then readable on every device', async () => {
    const plaintext = `I need help — ${suite}`
    const { conversationId, messageId } = await inbound(plaintext, 'a')
    await service.claim(conversationId, volunteer.pubkey)

    // The gap the issue describes, observed as a failed read — not a count.
    for (const device of volunteer.devices) {
      await expect(readAs(messageId, device)).rejects.toThrow('no envelope')
    }

    expect(await adminClientRewrap(conversationId)).toBe(volunteer.devices.length)

    for (const device of volunteer.devices) {
      expect(await readAs(messageId, device)).toBe(plaintext)
    }
    // The admin keeps its envelope: re-wrapping added a reader, dropped none.
    expect(await readAs(messageId, admin)).toBe(plaintext)
    // And it is the claimer who was added — nobody else.
    await expect(readAs(messageId, bystander.device)).rejects.toThrow('no envelope')
  })

  it('covers every pre-claim message, and post-claim messages need no re-wrap', async () => {
    const { conversationId, messageId: first } = await inbound(`first ${suite}`, 'b')
    const { messageId: second } = await inbound(`second ${suite}`, 'b')
    await service.claim(conversationId, volunteer.pubkey)
    const { messageId: after } = await inbound(`after claim ${suite}`, 'b')

    // Sealed to the assignee at arrival — readable with no re-wrap.
    expect(await readAs(after, volunteer.devices[0])).toBe(`after claim ${suite}`)
    const gaps = await service.listAssigneeEnvelopeGaps(conversationId)
    expect(gaps.messages.map((m) => m.id).sort()).toEqual([first, second].sort())

    await adminClientRewrap(conversationId)
    expect(await readAs(first, volunteer.devices[1])).toBe(`first ${suite}`)
    expect(await readAs(second, volunteer.devices[1])).toBe(`second ${suite}`)
    expect((await service.listAssigneeEnvelopeGaps(conversationId)).messages).toEqual([])
  })

  it('refuses an envelope addressed to anyone but the current assignee, and writes nothing', async () => {
    const plaintext = `refuse ${suite}`
    const { conversationId, messageId } = await inbound(plaintext, 'c')
    await service.claim(conversationId, volunteer.pubkey)

    const [row] = await db.select().from(messages).where(inArray(messages.id, [messageId]))
    const contentKey = unwrapContentKey((row.readerEnvelopes as RecipientEnvelope[])[0], admin.secret)
    const sealFor = (recipient: string) => {
      const sealed = hpkeSeal(hexToBytes(recipient), contentKey, LABEL, NO_AAD)
      return { pubkey: recipient, enc: bytesToHex(sealed.subarray(0, 32)), ct: bytesToHex(sealed.subarray(32)) }
    }

    // A valid assignee entry alongside a bystander entry: the whole batch fails.
    await expectServiceError(
      service.addAssigneeEnvelopes(conversationId, [
        { messageId, envelope: sealFor(volunteer.devices[0].recipient) },
        { messageId, envelope: sealFor(bystander.device.recipient) },
      ]),
      400,
    )
    await expect(readAs(messageId, bystander.device)).rejects.toThrow('no envelope')
    await expect(readAs(messageId, volunteer.devices[0])).rejects.toThrow('no envelope')
  })

  it('is append-only: a later submission cannot replace a working envelope', async () => {
    const plaintext = `append-only ${suite}`
    const { conversationId, messageId } = await inbound(plaintext, 'd')
    await service.claim(conversationId, volunteer.pubkey)
    await adminClientRewrap(conversationId)

    // A wrap of a DIFFERENT key for the same device must not displace the real one.
    const bogus = hpkeSeal(hexToBytes(volunteer.devices[0].recipient), new Uint8Array(32).fill(7), LABEL, NO_AAD)
    const result = await service.addAssigneeEnvelopes(conversationId, [{
      messageId,
      envelope: { pubkey: volunteer.devices[0].recipient, enc: bytesToHex(bogus.subarray(0, 32)), ct: bytesToHex(bogus.subarray(32)) },
    }])
    expect(result.added).toBe(0)
    expect(await readAs(messageId, volunteer.devices[0])).toBe(plaintext)
    expect(await readAs(messageId, admin)).toBe(plaintext)
  })

  it('rejects a re-wrap on an unclaimed conversation, and a message from another conversation', async () => {
    const { conversationId: waiting, messageId: waitingMsg } = await inbound(`waiting ${suite}`, 'e')
    const envelope = { pubkey: volunteer.devices[0].recipient, enc: '00'.repeat(32), ct: '00'.repeat(48) }
    await expectServiceError(service.addAssigneeEnvelopes(waiting, [{ messageId: waitingMsg, envelope }]), 409)

    const { conversationId: claimed } = await inbound(`claimed ${suite}`, 'f')
    await service.claim(claimed, volunteer.pubkey)
    await expectServiceError(service.addAssigneeEnvelopes(claimed, [{ messageId: waitingMsg, envelope }]), 404)
  })
})
