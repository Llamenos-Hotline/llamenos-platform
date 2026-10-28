/**
 * #2182 (D2): the messaging router hashes the sender exactly once.
 *
 * No adapter hashes any more. After `parseIncomingMessage`, the router computes
 * `messagingContactHash(senderIdentifier, hubId, MESSAGING_HASH_KEY)` and hands that
 * single value to every consumer: the conversation (`handleIncoming`), the blast
 * STOP / subscribe keywords, the firehose observer and the audit entry. These tests
 * drive the REAL webhook route and fail if a consumer is given a different value, a
 * value from the wrong hub, or the sender's identifier itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'
import type { Services } from '@worker/services'
import type { MessagingAdapter, IncomingMessage } from '@worker/messaging/adapter'
import { messagingContactHash } from '@worker/lib/messaging-contact-hash'
import '@worker/__tests__/mocks/llamenos-crypto-ffi'

vi.mock('@worker/lib/service-factories')
vi.mock('@worker/services/webhook-replay', () => ({
  checkWebhookReplay: vi.fn().mockResolvedValue(true),
}))
vi.mock('@worker/db', () => ({ getDb: vi.fn().mockReturnValue({}) }))
vi.mock('@worker/lib/ws-events', () => ({ publishEvent: vi.fn() }))
vi.mock('@worker/messaging/firehose-observer', () => ({
  observeFirehoseMessage: vi.fn().mockResolvedValue(true),
}))
import { getMessagingAdapterFromService } from '@worker/lib/service-factories'
import { observeFirehoseMessage } from '@worker/messaging/firehose-observer'

const KEY = '7'.repeat(64) // gitleaks:allow
const HUB = '9f2c1b64-0000-4000-8000-0000000000aa'
const OTHER_HUB = '9f2c1b64-0000-4000-8000-0000000000bb'
const SENDER = '+15551110000'

function incomingWith(overrides: Partial<IncomingMessage>): IncomingMessage {
  return {
    channelType: 'sms',
    externalId: 'SM-2182',
    senderIdentifier: SENDER,
    body: 'hello',
    timestamp: '2026-10-25T00:00:00.000Z',
    ...overrides,
  }
}

function adapterReturning(incoming: IncomingMessage): MessagingAdapter {
  return {
    validateWebhook: vi.fn().mockResolvedValue(true),
    parseIncomingMessage: vi.fn().mockResolvedValue(incoming),
  } as unknown as MessagingAdapter
}

function makeServices() {
  return {
    audit: { log: vi.fn().mockResolvedValue(undefined) },
    settings: { getMessagingConfig: vi.fn().mockResolvedValue(null) },
    blasts: {
      handleSubscriberKeyword: vi.fn().mockResolvedValue(undefined),
      getBlastSettings: vi.fn().mockResolvedValue({ subscribeKeyword: 'JOIN' }),
    },
    messagingSuppression: { clear: vi.fn().mockResolvedValue(true) },
    firehose: {},
    conversations: {
      handleIncoming: vi.fn().mockResolvedValue({
        conversationId: 'conv-2182',
        messageId: 'msg-2182',
        isNew: false,
        status: 'active',
      }),
      getById: vi.fn().mockResolvedValue({ id: 'conv-2182', assignedTo: null, channelType: 'sms' }),
    },
  } as unknown as Services
}

async function createApp(services: Services) {
  const { default: messaging } = await import('@worker/messaging/router')
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('services', services as unknown as AppEnv['Variables']['services'])
    c.env = {
      ADMIN_PUBKEY: 'a'.repeat(64),
      ADMIN_DECRYPTION_PUBKEY: 'c'.repeat(64),
      HMAC_SECRET: 'b'.repeat(64),
      MESSAGING_HASH_KEY: KEY,
    } as unknown as AppEnv['Bindings']
    await next()
  })
  app.route('/api/messaging', messaging)
  return app
}

const post = (app: Hono<AppEnv>, path: string) =>
  app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'SM-2182' }),
  })

describe('the messaging router hashes the sender once, per hub', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('files the message under the hub-keyed hash of senderIdentifier', async () => {
    vi.mocked(getMessagingAdapterFromService).mockResolvedValue(adapterReturning(incomingWith({})))
    const services = makeServices()

    const res = await post(await createApp(services), `/api/messaging/sms/webhook?hub=${HUB}`)

    expect(res.status).toBe(200)
    const [, hashArg, , hubArg] = vi.mocked(services.conversations.handleIncoming).mock.calls[0]
    expect(hubArg).toBe(HUB)
    expect(hashArg).toBe(messagingContactHash(SENDER, HUB, KEY))
    expect(hashArg).not.toContain(SENDER.slice(-4))
  })

  it('uses the "global" scope for a webhook without ?hub=, and a different hash than any hub', async () => {
    vi.mocked(getMessagingAdapterFromService).mockResolvedValue(adapterReturning(incomingWith({})))
    const services = makeServices()

    await post(await createApp(services), '/api/messaging/sms/webhook')

    const [, hashArg] = vi.mocked(services.conversations.handleIncoming).mock.calls[0]
    expect(hashArg).toBe(messagingContactHash(SENDER, undefined, KEY))
    expect(hashArg).not.toBe(messagingContactHash(SENDER, HUB, KEY))
  })

  it('gives the same contact a different thread hash in another hub', async () => {
    vi.mocked(getMessagingAdapterFromService).mockResolvedValue(adapterReturning(incomingWith({})))
    const services = makeServices()
    const app = await createApp(services)

    await post(app, `/api/messaging/sms/webhook?hub=${HUB}`)
    await post(app, `/api/messaging/sms/webhook?hub=${OTHER_HUB}`)

    const calls = vi.mocked(services.conversations.handleIncoming).mock.calls
    expect(calls[0][1]).not.toBe(calls[1][1])
  })

  it('hashes the identifier the reply address holds: the Signal UUID, not a phone number the message may not carry', async () => {
    const uuid = '5f1c6f0e-1c2b-4c1b-9b5e-2b6a0d7f3a11'
    vi.mocked(getMessagingAdapterFromService).mockResolvedValue(adapterReturning(incomingWith({
      channelType: 'signal',
      senderIdentifier: uuid,
      metadata: { sourceUuid: uuid },
    })))
    const services = makeServices()

    await post(await createApp(services), `/api/messaging/signal/webhook?hub=${HUB}`)

    const [, hashArg] = vi.mocked(services.conversations.handleIncoming).mock.calls[0]
    expect(hashArg).toBe(messagingContactHash(uuid, HUB, KEY))
  })

  it('feeds the audit entry the same hash, never the identifier', async () => {
    vi.mocked(getMessagingAdapterFromService).mockResolvedValue(adapterReturning(incomingWith({})))
    const services = makeServices()

    await post(await createApp(services), `/api/messaging/sms/webhook?hub=${HUB}`)

    const [event, , details] = vi.mocked(services.audit.log).mock.calls[0]
    expect(event).toBe('messageReceived')
    expect(details).toMatchObject({ channel: 'sms', senderHash: messagingContactHash(SENDER, HUB, KEY) })
    expect(JSON.stringify(details)).not.toContain(SENDER)
  })

  it('feeds the firehose observer the same hash for a Signal group message', async () => {
    vi.mocked(getMessagingAdapterFromService).mockResolvedValue(adapterReturning(incomingWith({
      channelType: 'signal',
      senderIdentifier: 'uuid-group-sender',
      metadata: { groupId: 'group-1' },
    })))
    const services = makeServices()

    await post(await createApp(services), `/api/messaging/signal/webhook?hub=${HUB}`)

    expect(observeFirehoseMessage).toHaveBeenCalledTimes(1)
    const [, message] = vi.mocked(observeFirehoseMessage).mock.calls[0]
    expect(message.senderIdentifierHash).toBe(messagingContactHash('uuid-group-sender', HUB, KEY))
    // Its fallback display name is no part of the number either.
    expect(message.senderUsername).not.toContain('uuid')
  })
})

describe('blast keywords are matched on the router hash (#2182)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('STOP reaches handleSubscriberKeyword with the hub-keyed hash and the sender identifier', async () => {
    vi.mocked(getMessagingAdapterFromService).mockResolvedValue(adapterReturning(incomingWith({ body: ' stop ' })))
    const services = makeServices()

    await post(await createApp(services), `/api/messaging/sms/webhook?hub=${HUB}`)

    expect(services.blasts.handleSubscriberKeyword).toHaveBeenCalledTimes(1)
    expect(services.blasts.handleSubscriberKeyword).toHaveBeenCalledWith(HUB, {
      identifier: SENDER,
      identifierHash: messagingContactHash(SENDER, HUB, KEY),
      lookupHashes: expect.arrayContaining([messagingContactHash(SENDER, HUB, KEY)]),
      // The suppression record is filed (STOP) or cleared (JOIN) under these, and
      // names the inbound message that caused it.
      identifiers: [SENDER],
      externalId: expect.any(String),
      keyword: 'STOP',
      channel: 'sms',
    })
  })

  it('the subscribe keyword reaches handleSubscriberKeyword with the same hash', async () => {
    vi.mocked(getMessagingAdapterFromService).mockResolvedValue(adapterReturning(incomingWith({ body: 'join' })))
    const services = makeServices()

    await post(await createApp(services), `/api/messaging/sms/webhook?hub=${HUB}`)

    expect(services.blasts.handleSubscriberKeyword).toHaveBeenCalledWith(HUB, {
      identifier: SENDER,
      identifierHash: messagingContactHash(SENDER, HUB, KEY),
      lookupHashes: expect.arrayContaining([messagingContactHash(SENDER, HUB, KEY)]),
      // The suppression record is filed (STOP) or cleared (JOIN) under these, and
      // names the inbound message that caused it.
      identifiers: [SENDER],
      externalId: expect.any(String),
      keyword: 'JOIN',
      channel: 'sms',
    })
  })

  it('an ordinary message triggers no keyword handling', async () => {
    vi.mocked(getMessagingAdapterFromService).mockResolvedValue(adapterReturning(incomingWith({ body: 'I need help' })))
    const services = makeServices()

    await post(await createApp(services), `/api/messaging/sms/webhook?hub=${HUB}`)

    expect(services.blasts.handleSubscriberKeyword).not.toHaveBeenCalled()
  })
})

// A person reaches the router under more than one identifier. The blast subscriber
// they were imported as is filed under ONE of them, so a STOP has to be looked up by
// every shape the webhook carried — otherwise the opt-out finds no row and the person
// stays reachable (consent failure).
describe('STOP is looked up by every identifier shape the sender carried', () => {
  const UUID = '0b6f2c1e-1111-4222-8333-444455556666'
  const NUMBER = '+15552220000'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  const stopData = (services: Services) =>
    vi.mocked(services.blasts.handleSubscriberKeyword).mock.calls[0][1] as unknown as {
      identifierHash: string
      lookupHashes: string[]
      identifiers: string[]
    }

  it('a Signal STOP with a UUID and a phone number looks up both', async () => {
    vi.mocked(getMessagingAdapterFromService).mockResolvedValue(adapterReturning(incomingWith({
      channelType: 'signal',
      senderIdentifier: UUID,
      aliases: [NUMBER],
      body: 'STOP',
    })))
    const services = makeServices()

    await post(await createApp(services), `/api/messaging/signal/webhook?hub=${HUB}`)

    const { lookupHashes } = stopData(services)
    expect(lookupHashes).toContain(messagingContactHash(UUID, HUB, KEY))
    expect(lookupHashes).toContain(messagingContactHash(NUMBER, HUB, KEY))
  })

  it('a Signal STOP whose envelope hides the number uses the number a previous message recorded for the UUID', async () => {
    const { SignalIdentityService } = await import('@worker/messaging/signal/identity')
    const lookup = vi.spyOn(SignalIdentityService.prototype, 'getIdentityByUuid').mockResolvedValue({ number: NUMBER, uuid: UUID } as never)
    vi.mocked(getMessagingAdapterFromService).mockResolvedValue(adapterReturning(incomingWith({
      channelType: 'signal',
      senderIdentifier: UUID,
      body: 'STOP',
    })))
    const services = makeServices()

    await post(await createApp(services), `/api/messaging/signal/webhook?hub=${HUB}`)

    expect(lookup).toHaveBeenCalledWith(HUB, UUID)
    expect(stopData(services).lookupHashes).toContain(messagingContactHash(NUMBER, HUB, KEY))
    // The opt-out is recorded against the recorded number too, so a later import of it is opted out.
    expect(stopData(services).identifiers).toEqual([UUID, NUMBER])
    lookup.mockRestore()
  })

  it('a Signal JOIN never widens through the recorded number', async () => {
    const { SignalIdentityService } = await import('@worker/messaging/signal/identity')
    const lookup = vi.spyOn(SignalIdentityService.prototype, 'getIdentityByUuid').mockResolvedValue({ number: NUMBER, uuid: UUID } as never)
    vi.mocked(getMessagingAdapterFromService).mockResolvedValue(adapterReturning(incomingWith({
      channelType: 'signal',
      senderIdentifier: UUID,
      body: 'join',
    })))
    const services = makeServices()

    await post(await createApp(services), `/api/messaging/signal/webhook?hub=${HUB}`)

    expect(lookup).not.toHaveBeenCalled()
    expect(stopData(services).lookupHashes).not.toContain(messagingContactHash(NUMBER, HUB, KEY))
    // Nor can it lift an opt-out through a number the message did not carry.
    expect(stopData(services).identifiers).toEqual([UUID])
    lookup.mockRestore()
  })

  it('START lifts the opt-out for the identifiers the message carried, never a recorded number (#2286)', async () => {
    const { SignalIdentityService } = await import('@worker/messaging/signal/identity')
    const lookup = vi.spyOn(SignalIdentityService.prototype, 'getIdentityByUuid').mockResolvedValue({ number: NUMBER, uuid: UUID } as never)
    vi.mocked(getMessagingAdapterFromService).mockResolvedValue(adapterReturning(incomingWith({
      channelType: 'signal',
      senderIdentifier: UUID,
      body: ' Start ',
    })))
    const services = makeServices()

    await post(await createApp(services), `/api/messaging/signal/webhook?hub=${HUB}`)

    expect(services.messagingSuppression.clear).toHaveBeenCalledWith('signal', [UUID])
    expect(lookup).not.toHaveBeenCalled()
    lookup.mockRestore()
  })

  it('an ordinary message and the hub subscribe keyword lift nothing', async () => {
    for (const body of ['I need help', 'join']) {
      vi.mocked(getMessagingAdapterFromService).mockResolvedValue(adapterReturning(incomingWith({ body })))
      const services = makeServices()
      await post(await createApp(services), `/api/messaging/sms/webhook?hub=${HUB}`)
      expect(services.messagingSuppression.clear, body).not.toHaveBeenCalled()
    }
  })

  it('a WhatsApp sender whose number arrives without "+" also matches the imported "+number"', async () => {
    vi.mocked(getMessagingAdapterFromService).mockResolvedValue(adapterReturning(incomingWith({
      channelType: 'whatsapp',
      senderIdentifier: NUMBER.slice(1),
      body: 'STOP',
    })))
    const services = makeServices()

    await post(await createApp(services), `/api/messaging/whatsapp/webhook?hub=${HUB}`)

    expect(stopData(services).lookupHashes).toContain(messagingContactHash(NUMBER, HUB, KEY))
  })

  it('lookup hashes stay per hub', async () => {
    vi.mocked(getMessagingAdapterFromService).mockResolvedValue(adapterReturning(incomingWith({ body: 'STOP' })))
    const services = makeServices()

    await post(await createApp(services), `/api/messaging/sms/webhook?hub=${HUB}`)

    expect(stopData(services).lookupHashes).not.toContain(messagingContactHash(SENDER, OTHER_HUB, KEY))
  })
})
