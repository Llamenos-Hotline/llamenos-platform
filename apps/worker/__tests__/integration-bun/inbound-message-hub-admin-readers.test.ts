/**
 * #1034 — an inbound message is sealed to the hub's admins, not to an env var.
 *
 * MUST run under `bun test` (see admin-definition.test.ts):
 *   bun test apps/worker/__tests__/integration-bun/inbound-message-hub-admin-readers.test.ts
 *
 * Requires postgres at DATABASE_URL with migrations applied and the Rust crypto
 * library (LLAMENOS_CRYPTO_LIB).
 *
 * The deployment under test is the one the in-app setup wizard produces: NO
 * `ADMIN_PUBKEY`, NO `ADMIN_DECRYPTION_PUBKEY`. The only thing that can read a
 * texter's first message is the X25519 device key the hub's admin registered.
 * Before #1034 the webhook sealed to `env.ADMIN_PUBKEY` (undefined here) and
 * answered 500, losing the message; with the Ed25519 key set it stored an
 * envelope that no secret could open. The assertion that matters is therefore
 * not "a message was stored" but "the admin's device secret OPENS it".
 */
import { describe, it, expect, afterAll } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { x25519 } from '@noble/curves/ed25519.js'
import '../../db/pg-array-patch'
import { createDatabase } from '../../db'
import { conversations, devices, hubs, messages, users } from '../../db/schema'
import { ConversationsService, InboundUnreadableError } from '../../services/conversations'
import { IdentityService } from '../../services/identity'
import { SettingsService } from '../../services/settings'
import { messagingContactHash } from '../../lib/messaging-contact-hash'
import { hpkeOpen, symmetricDecrypt } from '@llamenos/crypto/ffi'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@shared/encoding'
import { LABEL_MESSAGE } from '@shared/crypto-labels'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const db = createDatabase(DATABASE_URL)
const identity = new IdentityService(db)
const settings = new SettingsService(db)
const conversationsService = new ConversationsService(db, 'b'.repeat(64))

const suite = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('')
let counter = 0
const hexKey = (lead: string) => `${lead}${rand}${(counter++).toString(16).padStart(6, '0')}`.padEnd(64, '0')

const createdUsers: string[] = []
const createdHubs: string[] = []
const createdConversations: string[] = []

const PLAINTEXT = 'I need help tonight'

/** A hub whose founder is its admin and has registered a device with a REAL X25519 key. */
async function hubWithAdminDevice(withDevice: boolean) {
  const pubkey = hexKey('a0')
  await db.insert(users).values({ pubkey, displayName: 'founder' })
  createdUsers.push(pubkey)
  const secret = x25519.utils.randomSecretKey()
  const deviceKey = bytesToHex(x25519.getPublicKey(secret))
  if (withDevice) await db.insert(devices).values({ pubkey, platform: 'desktop', x25519Pubkey: deviceKey })
  const id = `hub-1034-${suite}-${counter++}`
  await settings.createHub(
    {
      id, name: id, slug: id, status: 'active', timezone: 'UTC', createdBy: pubkey,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    },
    { pubkey, roleIds: ['role-hub-admin'] },
  )
  createdHubs.push(id)
  return { hubId: id, deviceKey, secret }
}

async function receive(hubId: string) {
  // The reader set the webhook resolves: the hub's own admin readers — never an
  // env key, so a wizard-bootstrapped deployment (neither set) works.
  const adminRecipients = await identity.readersFor(hubId, 'admin')
  const sender = `+1555${Math.floor(1000000 + Math.random() * 8999999)}`
  const result = await conversationsService.handleIncoming(
    { channelType: 'sms', externalId: `ext-${suite}-${counter++}`, senderIdentifier: sender, body: PLAINTEXT, timestamp: new Date().toISOString() },
    messagingContactHash(sender, hubId, 'f'.repeat(64)),
    adminRecipients,
    hubId,
  )
  createdConversations.push(result.conversationId)
  const stored = await conversationsService.listMessages(result.conversationId)
  return stored.messages[0]!
}

afterAll(async () => {
  if (createdConversations.length > 0) {
    await db.delete(messages).where(inArray(messages.conversationId, createdConversations))
    await db.delete(conversations).where(inArray(conversations.id, createdConversations))
  }
  if (createdHubs.length > 0) await db.delete(hubs).where(inArray(hubs.id, createdHubs))
  await db.delete(users).where(inArray(users.pubkey, createdUsers))
})

describe('inbound message on a deployment with no admin env keys (#1034)', () => {
  it('is stored, and the hub admin device secret opens it', async () => {
    const { hubId, deviceKey, secret } = await hubWithAdminDevice(true)
    const message = await receive(hubId)

    const envelopes = message.readerEnvelopes as Array<{ pubkey: string; enc: string; ct: string }>
    expect(envelopes.map(e => e.pubkey)).toEqual([deviceKey])

    const sealed = new Uint8Array([...hexToBytes(envelopes[0]!.enc), ...hexToBytes(envelopes[0]!.ct)])
    const contentKey = hpkeOpen(secret, sealed, utf8ToBytes(LABEL_MESSAGE), new Uint8Array(0))
    const plaintext = new TextDecoder().decode(
      symmetricDecrypt(contentKey, hexToBytes(message.encryptedContent), new Uint8Array(0)),
    )
    expect(plaintext).toBe(PLAINTEXT)
  })

  it('is REFUSED, and nothing is stored, when the hub admin has registered no device', async () => {
    const { hubId } = await hubWithAdminDevice(false)
    await expect(receive(hubId)).rejects.toBeInstanceOf(InboundUnreadableError)
    const rows = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.hubId, hubId))
    expect(rows).toEqual([])
  })
})
