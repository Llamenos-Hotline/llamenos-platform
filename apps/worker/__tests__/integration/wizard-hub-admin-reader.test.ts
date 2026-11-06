/**
 * #1034 / #1035 — on a wizard-bootstrapped deployment, the setup admin is the
 * hub's READER from the first message, and nobody else's key is involved.
 *
 * The deployment here has NO `ADMIN_PUBKEY` and NO `ADMIN_DECRYPTION_PUBKEY`:
 * the state the in-app setup wizard leaves. Before the fix, every inbound
 * message on such a deployment was sealed to the unset env key — stored with
 * no content and no envelope behind a 200, readable by nobody, while the
 * provider believed it delivered.
 *
 * Real PostgreSQL, the real `/api/setup/complete` and `/api/messaging/:channel/
 * webhook` handlers, the real services; only the provider adapter and the
 * replay ledger are stand-ins. Every "can read" below is a real HPKE open with
 * the reader's own X25519 secret.
 *
 * Requires postgres at DATABASE_URL; creates and drops its own database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { x25519 } from '@noble/curves/ed25519.js'
import type { AppEnv } from '../../types'
import * as schema from '../../db/schema'
import type { MessagingAdapter, IncomingMessage } from '../../messaging/adapter'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@shared/encoding'
import { LABEL_MESSAGE } from '@shared/crypto-labels'
import { insertHubFounder } from '../helpers/hub-founder'

vi.mock('@llamenos/crypto/ffi', async () => await import('../mocks/llamenos-crypto-ffi'))
vi.mock('../../lib/service-factories')
vi.mock('../../services/webhook-replay', () => ({
  checkWebhookReplay: vi.fn(async () => true),
  releaseWebhookReplay: vi.fn(async () => undefined),
}))
vi.mock('../../db', () => ({ getDb: vi.fn(() => ({})) }))
vi.mock('../../lib/ws-events', () => ({ publishEvent: vi.fn() }))
import { hpkeOpen, symmetricDecrypt } from '@llamenos/crypto/ffi'
import { freshHubDb } from './hub-shred-helpers'
import { createServices, type Services } from '../../services'
import { getMessagingAdapterFromService } from '../../lib/service-factories'
import { releaseWebhookReplay } from '../../services/webhook-replay'

const fresh = freshHubDb('wizard_hub_admin_reader')
// A wizard deployment: no ADMIN_PUBKEY, no ADMIN_DECRYPTION_PUBKEY.
const ENV = {
  ENVIRONMENT: 'test',
  HMAC_SECRET: 'a'.repeat(64),
  SERVER_KEK: 'c'.repeat(64),
  MESSAGING_HASH_KEY: 'f'.repeat(64),
  HOTLINE_NAME: 'Day One',
}

let services: Services

/** A person with a device: an Ed25519 identity and the device's X25519 keypair. */
function person() {
  const secret = x25519.utils.randomSecretKey()
  return {
    pubkey: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
    deviceSecret: secret,
    devicePubkey: bytesToHex(x25519.getPublicKey(secret)),
  }
}

async function registerDevice(p: ReturnType<typeof person>) {
  await fresh.db.insert(schema.devices).values({ pubkey: p.pubkey, platform: 'desktop', x25519Pubkey: p.devicePubkey })
}

/** Open a stored message with a reader's device secret; `null` if no envelope opens. */
function open(secret: Uint8Array, row: { encryptedContent: string; readerEnvelopes: unknown }): string | null {
  const noAad = new Uint8Array(0)
  for (const env of row.readerEnvelopes as Array<{ enc: string; ct: string }>) {
    try {
      const key = hpkeOpen(secret, hexToBytes(env.enc + env.ct), utf8ToBytes(LABEL_MESSAGE), noAad)
      return new TextDecoder().decode(symmetricDecrypt(key, hexToBytes(row.encryptedContent), noAad))
    } catch { /* not this reader's envelope */ }
  }
  return null
}

beforeAll(async () => {
  await fresh.setup()
  services = createServices(fresh.db, { hmacSecret: ENV.HMAC_SECRET, serverKek: ENV.SERVER_KEK, env: { ENVIRONMENT: 'test' } })
  services.incidents.setNotifier({ async relay() {}, async interrupt() {} })
}, 180_000)
afterAll(fresh.teardown, 60_000)

beforeEach(() => vi.clearAllMocks())

async function completeSetup(admin: ReturnType<typeof person>) {
  const { default: setup } = await import('../../routes/setup')
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('pubkey', admin.pubkey)
    c.set('permissions', ['settings:manage-setup'])
    c.set('services', services as unknown as AppEnv['Variables']['services'])
    await next()
  })
  app.route('/api/setup', setup)
  return app.request('/api/setup/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }, ENV)
}

let messageCounter = 0
async function inboundSms(hubId: string, body: string) {
  const incoming: IncomingMessage = {
    channelType: 'sms',
    externalId: `SM-wizard-${++messageCounter}`,
    senderIdentifier: '+15550170000',
    body,
    timestamp: new Date().toISOString(),
  }
  vi.mocked(getMessagingAdapterFromService).mockResolvedValue({
    validateWebhook: vi.fn(async () => true),
    parseIncomingMessage: vi.fn(async () => incoming),
  } as unknown as MessagingAdapter)
  const { default: messaging } = await import('../../messaging/router')
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('services', services as unknown as AppEnv['Variables']['services'])
    await next()
  })
  app.route('/api/messaging', messaging)
  return app.request(`/api/messaging/sms/webhook?hub=${hubId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: incoming.externalId }),
  }, ENV)
}

async function inboundRows(hubId: string) {
  const convs = await fresh.db.select({ id: schema.conversations.id }).from(schema.conversations)
    .where(eq(schema.conversations.hubId, hubId))
  if (convs.length === 0) return []
  return fresh.db.select().from(schema.messages).where(and(
    inArray(schema.messages.conversationId, convs.map(c => c.id)),
    eq(schema.messages.direction, 'inbound'),
  ))
}

describe('the setup wizard provisions a hub admin who reads inbound messages (#1034)', () => {
  const admin = person()
  let adminInserted = false
  let adminRegistered = false

  async function insertAdmin() {
    if (adminInserted) return
    await fresh.db.delete(schema.hubs)
    await fresh.db.insert(schema.users).values({ pubkey: admin.pubkey, displayName: 'Setup admin', roles: ['role-super-admin'] })
    adminInserted = true
  }

  /** The wizard's hub: device registered, then setup completed. Independent of the refusal test. */
  async function wizardHub(): Promise<string> {
    await insertAdmin()
    if (!adminRegistered) {
      await registerDevice(admin)
      adminRegistered = true
    }
    const { hubs } = await services.settings.getHubs()
    if (hubs.length > 0) return hubs[0].id
    expect((await completeSetup(admin)).status).toBe(200)
    return (await services.settings.getHubs()).hubs[0].id
  }

  it('refuses to found the hub until the setup admin has registered a device key', async () => {
    await insertAdmin()

    const refused = await completeSetup(admin)
    expect(refused.status).toBe(409)
    expect((await services.settings.getHubs()).hubs).toEqual([])

    // What the desktop wizard does before it completes setup.
    const hubId = await wizardHub()
    // The founder is the hub's admin reader through their own device key.
    expect(await services.identity.readersFor(hubId, 'admin')).toEqual([admin.devicePubkey])
  })

  it('a texter\'s first message is stored and the hub admin opens it — with no admin key in the env', async () => {
    const hubId = await wizardHub()
    const res = await inboundSms(hubId, 'I need help tonight')

    expect(res.status).toBe(200)
    const rows = await inboundRows(hubId)
    expect(rows).toHaveLength(1)
    expect(open(admin.deviceSecret, rows[0])).toBe('I need help tonight')
  })

  it('a second admin added later reads what arrives after they join, and not what arrived before', async () => {
    const hubId = await wizardHub()
    const second = person()
    await fresh.db.insert(schema.users).values({
      pubkey: second.pubkey, displayName: 'Second admin', hubRoles: [{ hubId, roleIds: ['role-hub-admin'] }],
    })
    await registerDevice(second)

    const res = await inboundSms(hubId, 'are you still there')
    expect(res.status).toBe(200)

    const rows = await inboundRows(hubId)
    const before = rows.find(r => open(admin.deviceSecret, r) === 'I need help tonight')
    const after = rows.find(r => open(admin.deviceSecret, r) === 'are you still there')
    expect(before).toBeDefined()
    expect(after).toBeDefined()
    if (!before || !after) return
    expect(open(second.deviceSecret, after)).toBe('are you still there')
    // Content is sealed to the readers of the moment it arrived; nothing
    // re-wraps history for a later admin (the first admin can still relay it).
    expect(open(second.deviceSecret, before)).toBeNull()
  })
})

describe('an inbound message no hub admin can read is refused, never dropped (#1034)', () => {
  it('answers 503, writes nothing, and hands back the replay slot so a redelivery is processed', async () => {
    // A hub whose only admin has never registered a device, and no escrow key.
    const id = `hub-no-reader-${Math.random().toString(36).slice(2, 8)}`
    await services.settings.createHub({
      id, name: id, slug: id, status: 'active', phoneNumber: '',
      createdBy: 'integration-test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as never, await insertHubFounder(fresh.db))
    expect(await services.identity.readersFor(id, 'admin')).toEqual([])

    const res = await inboundSms(id, 'please answer')

    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('60')
    // Not a contentless record behind a 200: no conversation stub, no row.
    expect(await fresh.db.select().from(schema.conversations).where(eq(schema.conversations.hubId, id))).toEqual([])
    expect(releaseWebhookReplay).toHaveBeenCalledTimes(1)
  })
})
