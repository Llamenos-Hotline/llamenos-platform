import { describe, it, expect } from 'vitest'
import {
  SimulatedMessagingAdapter,
  SimulatedMessagingRefusedError,
  isSimulatedMessagingAllowed,
  SIMULATED_MESSAGE_ID_PREFIX,
} from '@worker/messaging/simulated-adapter'

const DEV_ENV = { ENVIRONMENT: 'development', DEV_ROUTES_ENABLED: 'true' }

describe('SimulatedMessagingAdapter', () => {
  it('accepts and records a send on a dev-surface host, minting a sim- external id', async () => {
    const adapter = new SimulatedMessagingAdapter('sms', DEV_ENV)
    const result = await adapter.sendMessage({
      recipientIdentifier: '+15551234567',
      body: 'Hello',
      conversationId: 'conv-1',
    })
    expect(result.success).toBe(true)
    expect(result.externalId).toMatch(new RegExp(`^${SIMULATED_MESSAGE_ID_PREFIX}`))
  })

  it('reports connected as a simulated channel', async () => {
    const adapter = new SimulatedMessagingAdapter('signal', DEV_ENV)
    const status = await adapter.getChannelStatus()
    expect(status.connected).toBe(true)
    expect(status.details?.simulated).toBe(true)
  })

  it('never accepts an inbound webhook', async () => {
    const adapter = new SimulatedMessagingAdapter('sms', DEV_ENV)
    await expect(adapter.validateWebhook(new Request('http://localhost/'))).resolves.toBe(false)
    await expect(adapter.parseIncomingMessage(new Request('http://localhost/'))).rejects.toThrow()
  })

  it('is refused outright on production, before any flag is read', () => {
    expect(isSimulatedMessagingAllowed({ ENVIRONMENT: 'production', DEV_ROUTES_ENABLED: 'true' })).toBe(false)
    expect(() => new SimulatedMessagingAdapter('sms', { ENVIRONMENT: 'production', DEV_ROUTES_ENABLED: 'true' }))
      .toThrow(SimulatedMessagingRefusedError)
  })

  it('is refused without the explicit opt-in flag', () => {
    expect(isSimulatedMessagingAllowed({ ENVIRONMENT: 'development' })).toBe(false)
    expect(() => new SimulatedMessagingAdapter('sms', { ENVIRONMENT: 'development' }))
      .toThrow(SimulatedMessagingRefusedError)
  })

  it('demands a 32-character secret on a reachable (staging) host', () => {
    expect(isSimulatedMessagingAllowed({ ENVIRONMENT: 'staging', DEV_ROUTES_ENABLED: 'true' })).toBe(false)
    expect(isSimulatedMessagingAllowed({
      ENVIRONMENT: 'staging',
      DEV_ROUTES_ENABLED: 'true',
      DEV_RESET_SECRET: 'a'.repeat(32),
    })).toBe(true)
  })
})
