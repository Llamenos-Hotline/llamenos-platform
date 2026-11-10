import { describe, it, expect, vi, beforeEach } from 'vitest'
import { routeOutboundMessage } from '@worker/messaging/delivery-router'
import type { MessagingConfig } from '@shared/types'
import type { SettingsService } from '@worker/services/settings'

vi.mock('@worker/lib/service-factories', () => ({
  getMessagingAdapterFromService: vi.fn(),
}))

import { getMessagingAdapterFromService } from '@worker/lib/service-factories'

describe('delivery-router', () => {
  const mockSendMessage = vi.fn()
  const mockSendMediaMessage = vi.fn()
  const mockSignalSendMessage = vi.fn()
  const mockSignalSendMediaMessage = vi.fn()

  function createMockAdapter(channelType: string) {
    return {
      channelType,
      sendMessage: channelType === 'signal' ? mockSignalSendMessage : mockSendMessage,
      sendMediaMessage: channelType === 'signal' ? mockSignalSendMediaMessage : mockSendMediaMessage,
      parseIncomingMessage: vi.fn(),
      validateWebhook: vi.fn(),
      getChannelStatus: vi.fn(),
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockSendMessage.mockResolvedValue({ success: true, externalId: 'ext-123' })
    mockSendMediaMessage.mockResolvedValue({ success: true, externalId: 'ext-456' })
    mockSignalSendMessage.mockResolvedValue({ success: true, externalId: 'sig-123' })
    mockSignalSendMediaMessage.mockResolvedValue({ success: true, externalId: 'sig-456' })

    const mockedGetAdapter = vi.mocked(getMessagingAdapterFromService)
    mockedGetAdapter.mockImplementation(async (channel) => {
      return createMockAdapter(channel) as any
    })
  })

  function createDeps(config: Partial<MessagingConfig> & { signalRegistered?: boolean }) {
    const { signalRegistered, ...messagingConfig } = config
    return {
      settingsService: {
        getMessagingConfig: vi.fn().mockResolvedValue({
          enabledChannels: ['sms', 'whatsapp', 'signal'],
          sms: { enabled: true },
          whatsapp: { integrationMode: 'twilio' as const },
          signal: { bridgeUrl: 'http://signal-bridge', bridgeApiKey: 'key', webhookSecret: 'secret', registeredNumber: '+15550000000' },
          rcs: null,
          telegram: null,
          autoAssign: true,
          inactivityTimeout: 60,
          maxConcurrentPerUser: 3,
          preferSignalDelivery: messagingConfig.preferSignalDelivery ?? true,
          smsContentMode: messagingConfig.smsContentMode ?? 'notification-only',
        } satisfies MessagingConfig),
      } as unknown as SettingsService,
      suppression: { blocksOutbound: vi.fn().mockResolvedValue(false) },
      notifierUrl: signalRegistered ? 'http://notifier:3100' : undefined,
      notifierApiKey: signalRegistered ? 'api-key' : undefined,
    }
  }

  it('routes via Signal when recipient is registered and preferSignalDelivery is true', async () => {
    const deps = createDeps({ signalRegistered: true, preferSignalDelivery: true })

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ registered: true }),
    } as unknown as Response) as unknown as typeof fetch

    const { result, actualChannel } = await routeOutboundMessage(deps, {
      channelType: 'sms',
      recipientIdentifier: '+15551234567',
      identifierHash: 'hash123',
      body: 'Hello world',
      conversationId: 'conv-1',
    })

    expect(actualChannel).toBe('signal')
    expect(result.success).toBe(true)
    expect(result.externalId).toBe('sig-123')
  })

  it('falls back to SMS when Signal is not available', async () => {
    const deps = createDeps({ signalRegistered: true, preferSignalDelivery: true })

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ registered: false }),
    } as unknown as Response) as unknown as typeof fetch

    const { result, actualChannel } = await routeOutboundMessage(deps, {
      channelType: 'sms',
      recipientIdentifier: '+15551234567',
      identifierHash: 'hash123',
      body: 'Hello world',
      conversationId: 'conv-1',
    })

    expect(actualChannel).toBe('sms')
    expect(result.success).toBe(true)
    expect(result.externalId).toBe('ext-123')
  })

  it('falls back to original channel when preferSignalDelivery is false', async () => {
    const deps = createDeps({ signalRegistered: true, preferSignalDelivery: false })

    const { result, actualChannel } = await routeOutboundMessage(deps, {
      channelType: 'sms',
      recipientIdentifier: '+15551234567',
      identifierHash: 'hash123',
      body: 'Hello world',
      conversationId: 'conv-1',
    })

    expect(actualChannel).toBe('sms')
    expect(result.success).toBe(true)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('sanitizes SMS body in notification-only mode', async () => {
    const deps = createDeps({ smsContentMode: 'notification-only' })

    const { result, actualChannel } = await routeOutboundMessage(deps, {
      channelType: 'sms',
      recipientIdentifier: '+15551234567',
      identifierHash: 'hash123',
      body: 'Sensitive content here',
      conversationId: 'conv-1',
    })

    expect(actualChannel).toBe('sms')
    expect(result.success).toBe(true)
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        body: 'You have a new secure message. Open Llamenos to view it.',
      })
    )
  })

  it('preserves SMS body in full mode', async () => {
    const deps = createDeps({ smsContentMode: 'full' })

    const { result, actualChannel } = await routeOutboundMessage(deps, {
      channelType: 'sms',
      recipientIdentifier: '+15551234567',
      identifierHash: 'hash123',
      body: 'Sensitive content here',
      conversationId: 'conv-1',
    })

    expect(actualChannel).toBe('sms')
    expect(result.success).toBe(true)
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        body: 'Sensitive content here',
      })
    )
  })

  it('does not sanitize non-SMS channels', async () => {
    const deps = createDeps({ smsContentMode: 'notification-only' })

    const { result, actualChannel } = await routeOutboundMessage(deps, {
      channelType: 'whatsapp',
      recipientIdentifier: '+15551234567',
      identifierHash: 'hash123',
      body: 'WhatsApp content',
      conversationId: 'conv-1',
    })

    expect(actualChannel).toBe('whatsapp')
    expect(result.success).toBe(true)
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        body: 'WhatsApp content',
      })
    )
  })

  it('handles Signal-first routing failure gracefully', async () => {
    const deps = createDeps({ signalRegistered: true, preferSignalDelivery: true })

    global.fetch = vi.fn().mockRejectedValue(new Error('Network error')) as unknown as typeof fetch

    const { result, actualChannel } = await routeOutboundMessage(deps, {
      channelType: 'sms',
      recipientIdentifier: '+15551234567',
      identifierHash: 'hash123',
      body: 'Hello world',
      conversationId: 'conv-1',
    })

    expect(actualChannel).toBe('sms')
    expect(result.success).toBe(true)
    expect(result.externalId).toBe('ext-123')
  })

  it('falls back to the simulated provider on a dev-surface host when the channel is not configured (#2551)', async () => {
    const deps = {
      ...createDeps({ preferSignalDelivery: false }),
      env: { ENVIRONMENT: 'development', DEV_ROUTES_ENABLED: 'true' },
    }
    vi.mocked(getMessagingAdapterFromService).mockRejectedValue(new Error('SMS is not enabled'))

    const { result, actualChannel } = await routeOutboundMessage(deps, {
      channelType: 'sms',
      recipientIdentifier: '+15551234567',
      identifierHash: 'hash123',
      body: 'Hello world',
      conversationId: 'conv-1',
    })

    // The simulator accepted and recorded the send, minting its own provider id.
    expect(actualChannel).toBe('sms')
    expect(result.success).toBe(true)
    expect(result.externalId).toMatch(/^sim-/)
  })

  it('rethrows the unconfigured-channel error when the dev surface is closed (#2551)', async () => {
    const deps = {
      ...createDeps({ preferSignalDelivery: false }),
      env: { ENVIRONMENT: 'production' },
    }
    vi.mocked(getMessagingAdapterFromService).mockRejectedValue(new Error('SMS is not enabled'))

    await expect(routeOutboundMessage(deps, {
      channelType: 'sms',
      recipientIdentifier: '+15551234567',
      identifierHash: 'hash123',
      body: 'Hello world',
      conversationId: 'conv-1',
    })).rejects.toThrow('SMS is not enabled')
  })

  it('never falls back to the simulator for a transient provider failure (#2551)', async () => {
    const deps = {
      ...createDeps({ preferSignalDelivery: false }),
      env: { ENVIRONMENT: 'development', DEV_ROUTES_ENABLED: 'true' },
    }
    vi.mocked(getMessagingAdapterFromService).mockRejectedValue(new Error('fetch failed'))

    await expect(routeOutboundMessage(deps, {
      channelType: 'sms',
      recipientIdentifier: '+15551234567',
      identifierHash: 'hash123',
      body: 'Hello world',
      conversationId: 'conv-1',
    })).rejects.toThrow('fetch failed')
  })
})
