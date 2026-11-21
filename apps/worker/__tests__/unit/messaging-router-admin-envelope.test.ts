/**
 * The inbound messaging webhook seals every message to the HUB's admin readers
 * (#1034, #1283).
 *
 * The admin copy must be sealed to a key a hub admin actually holds: the X25519
 * key of their registered device (`readersFor(hub, 'admin')`). Not
 * `ADMIN_PUBKEY` (an Ed25519 signing key — 64 hex characters too, so a format
 * check passes either way, #1283), and not the instance-wide
 * `ADMIN_DECRYPTION_PUBKEY`, which a wizard-bootstrapped deployment does not
 * have and which D1 removes as a reader (#1034). The only assertion that
 * catches a wrong key is that the hub admin can OPEN the envelope with their
 * X25519 secret, so that is what these tests do, through the real router and
 * the real `ConversationsService.handleIncoming`.
 *
 * And when the hub has no admin reader at all, the message is REFUSED (503,
 * replay slot released) — never stored contentless behind a 200.
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
  releaseWebhookReplay: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@worker/db', () => ({
  getDb: vi.fn().mockReturnValue({}),
}))
vi.mock('@worker/lib/ws-events', () => ({
  publishEvent: vi.fn(),
}))
import { getMessagingAdapterFromService } from '@worker/lib/service-factories'
import { releaseWebhookReplay } from '@worker/services/webhook-replay'

const PLAINTEXT = 'I need help tonight'

const incoming: IncomingMessage = {
  channelType: 'sms',
  externalId: 'SM-1283',
  senderIdentifier: '+15551112283',
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

/** Open one envelope with the given X25519 secret, or `null` if it is not ours.
 *  Opens the stored-record format every reader uses (`open_record_for_reader`):
 *  HPKE info = label, no AAD on either the wrap or the content. */
function tryOpen(
  secret: Uint8Array,
  envelope: RecipientEnvelope,
  encryptedContent: string,
): string | null {
  const labelBytes = utf8ToBytes(LABEL_MESSAGE)
  const noAad = new Uint8Array(0)
  try {
    const sealed = new Uint8Array([...hexToBytes(envelope.enc), ...hexToBytes(envelope.ct)])
    const messageKey = hpkeOpen(secret, sealed, labelBytes, noAad)
    return new TextDecoder().decode(symmetricDecrypt(messageKey, hexToBytes(encryptedContent), noAad))
  } catch {
    return null
  }
}

/**
 * `hubAdminReaders` is what `readersFor(hub, 'admin')` resolves: the X25519
 * keys of the hub admins' registered devices (and its escrow key).
 */
function setup(hubAdminReaders: string[]) {
  const { db } = createMockDb(['conversations', 'messages'])
  // An existing, unassigned conversation from this sender — so the only
  // readers the server can seal to are the hub's admins.
  db.$setSelectResult([{
    id: 'conv-1283',
    hubId: 'hub-test',
    channelType: 'sms',
    contactIdentifierHash: 'thread-hash-1283',
    assignedTo: null,
    status: 'active',
  }])
  const conversations = new ConversationsService(db as never, 'b'.repeat(64))
  // Capture what would be persisted; everything upstream of the write is real.
  const addMessage = vi.spyOn(conversations, 'addMessage')
    .mockImplementation(async (input) => ({ id: 'msg-1283', ...input }) as never)
  const readersFor = vi.fn().mockResolvedValue(hubAdminReaders)

  const services = {
    audit: { log: vi.fn().mockResolvedValue(undefined) },
    settings: { getHub: vi.fn().mockResolvedValue({ hub: { id: 'hub-test' } }), getMessagingConfig: vi.fn().mockResolvedValue(null) },
    blasts: {
      handleSubscriberKeyword: vi.fn().mockResolvedValue(undefined),
      getBlastSettings: vi.fn().mockResolvedValue({ subscribeKeyword: 'JOIN' }),
    },
    identity: { readersFor },
    conversations,
  } as unknown as Services

  return { services, addMessage, readersFor }
}

/**
 * The deployment's env. By default it is a wizard-bootstrapped one: no
 * `ADMIN_DECRYPTION_PUBKEY`. `instanceKey` adds one, to show it is not a reader.
 */
async function createApp(services: Services, admin: ReturnType<typeof makeAdmin>, instanceKey?: string) {
  const { default: messaging } = await import('@worker/messaging/router')
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('services', services as unknown as AppEnv['Variables']['services'])
    c.env = {
      ADMIN_PUBKEY: admin.signingPubkey,
      ...(instanceKey ? { ADMIN_DECRYPTION_PUBKEY: instanceKey } : {}),
      HMAC_SECRET: 'b'.repeat(64),
      MESSAGING_HASH_KEY: 'f'.repeat(64),
    } as unknown as AppEnv['Bindings']
    await next()
  })
  app.route('/api/messaging', messaging)
  return app
}

function post(app: Hono<AppEnv>) {
  return app.request('/api/messaging/sms/webhook?hub=hub-test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: incoming.externalId }),
  })
}

function openAll(secret: Uint8Array, stored: { readerEnvelopes?: RecipientEnvelope[]; encryptedContent?: string }): string[] {
  return (stored.readerEnvelopes ?? [])
    .map(env => tryOpen(secret, env, stored.encryptedContent ?? ''))
    .filter((p): p is string => p !== null)
}

describe('inbound messaging webhook — sealed to the hub admin readers (#1034, #1283)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getMessagingAdapterFromService).mockResolvedValue({
      validateWebhook: vi.fn().mockResolvedValue(true),
      parseIncomingMessage: vi.fn().mockResolvedValue(incoming),
    } as unknown as MessagingAdapter)
  })

  it('on a deployment with NO ADMIN_DECRYPTION_PUBKEY, the hub admin opens the stored message with their device secret', async () => {
    // The wizard-bootstrapped deployment of #1034: before the fix the message
    // was sealed to the unset env key — stored with no content, read by no one.
    const hubAdmin = makeAdmin()
    const { services, addMessage, readersFor } = setup([hubAdmin.decryptionPubkey])
    const app = await createApp(services, hubAdmin)

    const res = await post(app)

    expect(res.status).toBe(200)
    expect(readersFor).toHaveBeenCalledWith('hub-test', 'admin')
    expect(addMessage).toHaveBeenCalledTimes(1)
    expect(openAll(hubAdmin.decryptionSecret, addMessage.mock.calls[0][0])).toEqual([PLAINTEXT])
  })

  it('a second hub admin reads it too — every admin reader gets an envelope', async () => {
    const first = makeAdmin()
    const second = makeAdmin()
    const { services, addMessage } = setup([first.decryptionPubkey, second.decryptionPubkey])
    const app = await createApp(services, first)

    await post(app)

    const stored = addMessage.mock.calls[0][0]
    expect(openAll(first.decryptionSecret, stored)).toEqual([PLAINTEXT])
    expect(openAll(second.decryptionSecret, stored)).toEqual([PLAINTEXT])
  })

  it('never seals to the instance-wide ADMIN_DECRYPTION_PUBKEY: the platform operator is not a hub reader (D1)', async () => {
    const hubAdmin = makeAdmin()
    const operator = makeAdmin()
    const { services, addMessage } = setup([hubAdmin.decryptionPubkey])
    const app = await createApp(services, hubAdmin, operator.decryptionPubkey)

    await post(app)

    const stored = addMessage.mock.calls[0][0]
    expect((stored.readerEnvelopes ?? []).map(e => e.pubkey)).toEqual([hubAdmin.decryptionPubkey])
    expect(openAll(operator.decryptionSecret, stored)).toEqual([])
  })

  it('never lists the Ed25519 signing key as a recipient', async () => {
    const hubAdmin = makeAdmin()
    const { services, addMessage } = setup([hubAdmin.decryptionPubkey])
    const app = await createApp(services, hubAdmin)

    await post(app)

    const recipients = (addMessage.mock.calls[0][0].readerEnvelopes ?? []).map(e => e.pubkey)
    expect(recipients).not.toContain(hubAdmin.signingPubkey)
  })

  it('REFUSES with 503 — never a contentless record behind a 200 — when the hub has no admin reader', async () => {
    // Before #1034's fix this answered 200 and stored the message with empty
    // content and no envelope: the provider believed it delivered and the text
    // was gone. Now nothing is stored, the provider is told to retry, and the
    // replay slot is handed back so that retry is processed, not deduplicated.
    const operator = makeAdmin()
    const { services, addMessage } = setup([])
    const app = await createApp(services, makeAdmin(), operator.decryptionPubkey)

    const res = await post(app)

    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('60')
    expect(addMessage).not.toHaveBeenCalled()
    expect(releaseWebhookReplay).toHaveBeenCalledTimes(1)
    expect(vi.mocked(releaseWebhookReplay).mock.calls[0][1]).toBe('sms')
  })
})
