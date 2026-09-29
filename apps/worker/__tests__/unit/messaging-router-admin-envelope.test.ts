/**
 * Regression test for #1283 on the inbound messaging webhook.
 *
 * The admin copy of every inbound SMS/WhatsApp/RCS message must be sealed to
 * `ADMIN_DECRYPTION_PUBKEY` (X25519), never to `ADMIN_PUBKEY` (Ed25519 signing
 * key). Both are 64 hex characters, so a format check passes either way — the
 * only assertion that catches the mix-up is that the admin can actually OPEN
 * the envelope with their X25519 secret. This test does exactly that, through
 * the real router and the real `ConversationsService.handleIncoming`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { hpkeOpen, symmetricDecrypt } from '@llamenos/crypto/ffi'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@shared/encoding'
import { LABEL_MESSAGE } from '@shared/crypto-labels'
import type { RecipientEnvelope } from '@shared/types'
import type { AppEnv } from '@worker/types'
import type { Services } from '@worker/services'
import type { MessagingAdapter, IncomingMessage } from '@worker/messaging/adapter'
import { ConversationsService } from '@worker/services/conversations'
import { createMockDb } from './mock-db'
// The real ffi.ts uses bun:ffi to load a native .so — unavailable in the Vitest environment.
import '@worker/__tests__/mocks/llamenos-crypto-ffi'

vi.mock('@worker/lib/service-factories')
vi.mock('@worker/services/webhook-replay', () => ({
  checkWebhookReplay: vi.fn().mockResolvedValue(true),
}))
vi.mock('@worker/db', () => ({
  getDb: vi.fn().mockReturnValue({}),
}))
vi.mock('@worker/lib/ws-events', () => ({
  publishEvent: vi.fn(),
}))
import { getMessagingAdapterFromService } from '@worker/lib/service-factories'

const PLAINTEXT = 'I need help tonight'

const incoming: IncomingMessage = {
  channelType: 'sms',
  externalId: 'SM-1283',
  senderIdentifier: '+15551112283',
  senderIdentifierHash: 'hash-1283',
  body: PLAINTEXT,
  timestamp: '2026-09-29T00:00:00.000Z',
}

/**
 * The admin holds two INDEPENDENT random secrets (PROTOCOL.md 2.11): an Ed25519
 * signing key and an X25519 decryption key. Neither is derived from the other.
 */
function makeAdmin() {
  const signingSecret = ed25519.utils.randomSecretKey()
  const decryptionSecret = x25519.utils.randomSecretKey()
  return {
    signingPubkey: bytesToHex(ed25519.getPublicKey(signingSecret)),
    decryptionPubkey: bytesToHex(x25519.getPublicKey(decryptionSecret)),
    decryptionSecret,
  }
}

/** Open one envelope with the given X25519 secret, or `null` if it is not ours. */
function tryOpen(
  secret: Uint8Array,
  envelope: RecipientEnvelope,
  encryptedContent: string,
): string | null {
  const labelBytes = utf8ToBytes(LABEL_MESSAGE)
  const aadKeyWrap = utf8ToBytes(`${LABEL_MESSAGE}:key-wrap`)
  try {
    const sealed = new Uint8Array([...hexToBytes(envelope.enc), ...hexToBytes(envelope.ct)])
    const messageKey = hpkeOpen(secret, sealed, labelBytes, aadKeyWrap)
    return new TextDecoder().decode(symmetricDecrypt(messageKey, hexToBytes(encryptedContent), labelBytes))
  } catch {
    return null
  }
}

function setup() {
  const { db } = createMockDb(['conversations', 'messages'])
  // An existing, unassigned conversation from this sender — so the only reader
  // the server can seal to is the admin.
  db.$setSelectResult([{
    id: 'conv-1283',
    hubId: null,
    channelType: 'sms',
    contactIdentifierHash: incoming.senderIdentifierHash,
    contactLast4: '2283',
    assignedTo: null,
    status: 'active',
  }])
  const conversations = new ConversationsService(db as never, 'b'.repeat(64))
  // Capture what would be persisted; everything upstream of the write is real.
  const addMessage = vi.spyOn(conversations, 'addMessage')
    .mockImplementation(async (input) => ({ id: 'msg-1283', ...input }) as never)

  const services = {
    audit: { log: vi.fn().mockResolvedValue(undefined) },
    settings: { getMessagingConfig: vi.fn().mockResolvedValue(null) },
    blasts: {
      handleSubscriberKeyword: vi.fn().mockResolvedValue(undefined),
      getBlastSettings: vi.fn().mockResolvedValue({ subscribeKeyword: 'JOIN' }),
    },
    conversations,
  } as unknown as Services

  return { services, addMessage }
}

async function createApp(services: Services, admin: ReturnType<typeof makeAdmin>) {
  const { default: messaging } = await import('@worker/messaging/router')
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('services', services as unknown as AppEnv['Variables']['services'])
    c.env = {
      ADMIN_PUBKEY: admin.signingPubkey,
      ADMIN_DECRYPTION_PUBKEY: admin.decryptionPubkey,
      HMAC_SECRET: 'b'.repeat(64),
    } as unknown as AppEnv['Bindings']
    await next()
  })
  app.route('/api/messaging', messaging)
  return app
}

describe('inbound messaging webhook — admin envelope is decryptable (#1283)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getMessagingAdapterFromService).mockResolvedValue({
      validateWebhook: vi.fn().mockResolvedValue(true),
      parseIncomingMessage: vi.fn().mockResolvedValue(incoming),
    } as unknown as MessagingAdapter)
  })

  it('the admin can open the stored message with their X25519 decryption secret', async () => {
    const admin = makeAdmin()
    const { services, addMessage } = setup()
    const app = await createApp(services, admin)

    const res = await app.request('/api/messaging/sms/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: incoming.externalId }),
    })

    expect(res.status).toBe(200)
    expect(addMessage).toHaveBeenCalledTimes(1)
    const stored = addMessage.mock.calls[0][0]
    expect(stored.readerEnvelopes?.length).toBeGreaterThan(0)

    const opened = (stored.readerEnvelopes ?? [])
      .map(env => tryOpen(admin.decryptionSecret, env, stored.encryptedContent ?? ''))
      .filter((p): p is string => p !== null)
    expect(opened).toEqual([PLAINTEXT])
  })

  it('never lists the Ed25519 signing key as a recipient', async () => {
    const admin = makeAdmin()
    const { services, addMessage } = setup()
    const app = await createApp(services, admin)

    await app.request('/api/messaging/sms/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: incoming.externalId }),
    })

    const recipients = (addMessage.mock.calls[0][0].readerEnvelopes ?? []).map(e => e.pubkey)
    expect(recipients).not.toContain(admin.signingPubkey)
  })
})
