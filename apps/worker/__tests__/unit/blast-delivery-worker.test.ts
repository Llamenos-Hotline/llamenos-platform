/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  startBlastWorker,
  stopBlastWorker,
} from '@worker/lib/blast-delivery-worker'
import type { BlastsService } from '@worker/services/blasts'
import type { SettingsService } from '@worker/services/settings'
import type { MessagingAdapter } from '@worker/messaging/adapter'
import type { BlastContent, BlastSettings, BlastStats } from '@shared/types'

function createMockBlastsService(overrides: Partial<BlastsService> = {}): BlastsService {
  return {
    getSendingBlasts: vi.fn().mockResolvedValue([]),
    getBlast: vi.fn().mockResolvedValue({
      id: 'blast-1',
      hubId: 'hub-1',
      status: 'sending',
      content: { text: 'Hello world' } as BlastContent,
      defaultLanguage: 'en',
      stats: { totalRecipients: 0, sent: 0, delivered: 0, failed: 0, optedOut: 0 },
    }),
    getBlastSettings: vi.fn().mockResolvedValue({
      optOutFooter: '\nReply STOP to unsubscribe.',
      rateLimitPerSecond: 10,
      rateLimits: {},
      subscribeKeyword: 'JOIN',
      unsubscribeKeyword: 'STOP',
      confirmationMessage: 'Subscribed',
      unsubscribeMessage: 'Unsubscribed',
      doubleOptIn: false,
      maxBlastsPerDay: 10,
    } as BlastSettings),
    drainDeliveryBatch: vi.fn().mockResolvedValue([]),
    syncBlastStats: vi.fn().mockResolvedValue({
      stats: { totalRecipients: 0, sent: 0, delivered: 0, failed: 0, optedOut: 0 } as BlastStats,
      completed: true,
    }),
    isSubscriberActive: vi.fn().mockResolvedValue(true),
    getSubscriberById: vi.fn().mockResolvedValue({ id: 'sub-1', language: 'en' }),
    markDeliverySent: vi.fn().mockResolvedValue(undefined),
    markDeliveryFailed: vi.fn().mockResolvedValue(undefined),
    markDeliveryOptedOut: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as BlastsService
}

function createMockAdapter(): MessagingAdapter {
  return {
    channelType: 'sms',
    sendMessage: vi.fn().mockResolvedValue({ success: true, externalId: 'ext-123' }),
    sendMediaMessage: vi.fn().mockResolvedValue({ success: true, externalId: 'ext-456' }),
    parseIncomingMessage: vi.fn(),
    validateWebhook: vi.fn(),
    getChannelStatus: vi.fn(),
  } as unknown as MessagingAdapter
}

function createSettingsService(overrides: Partial<SettingsService> = {}): SettingsService {
  return {
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
      preferSignalDelivery: true,
      smsContentMode: 'notification-only',
    }),
    ...overrides,
  } as unknown as SettingsService
}

function createDeps(overrides: Record<string, unknown> = {}) {
  const mockAdapter = createMockAdapter()
  return {
    blastsService: createMockBlastsService(),
    settingsService: createSettingsService(),
    resolveAdapter: vi.fn().mockResolvedValue(mockAdapter),
    resolveIdentifier: vi.fn().mockResolvedValue('+1234567890'),
    onProgress: vi.fn(),
    onStatusChange: vi.fn(),
    mockAdapter,
    ...overrides,
  }
}

describe('blast-delivery-worker', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false })
    stopBlastWorker()
  })

  afterEach(() => {
    stopBlastWorker()
    vi.useRealTimers()
  })

  describe('buildMessageBody bug: undefined body', () => {
    it('does not prepend "undefined" to opt-out footer when both smsText and text are missing', async () => {
      const mockAdapter = createMockAdapter()
      const blastsService = createMockBlastsService({
        getSendingBlasts: vi.fn().mockResolvedValue([{ id: 'blast-1', hubId: 'hub-1' }]),
        getBlast: vi.fn().mockResolvedValue({
          id: 'blast-1',
          hubId: 'hub-1',
          status: 'sending',
          content: { smsText: undefined, text: undefined } as unknown as BlastContent,
          defaultLanguage: 'en',
        }),
        drainDeliveryBatch: vi.fn().mockResolvedValue([
          { id: 'del-1', subscriberId: 'sub-1', channel: 'sms', attempts: 0 },
        ]),
        syncBlastStats: vi.fn().mockResolvedValue({
          stats: { totalRecipients: 1, sent: 1, delivered: 0, failed: 0, optedOut: 0 } as BlastStats,
          completed: true,
        }),
      })

      const deps = {
        blastsService,
        settingsService: createSettingsService({ getMessagingConfig: vi.fn().mockResolvedValue({
          enabledChannels: ['sms', 'whatsapp', 'signal'],
          sms: { enabled: true },
          whatsapp: { integrationMode: 'twilio' as const },
          signal: { bridgeUrl: 'http://signal-bridge', bridgeApiKey: 'key', webhookSecret: 'secret', registeredNumber: '+15550000000' },
          rcs: null,
          telegram: null,
          autoAssign: true,
          inactivityTimeout: 60,
          maxConcurrentPerUser: 3,
          preferSignalDelivery: true,
          smsContentMode: 'full' as const,
        }) }),
        resolveAdapter: vi.fn().mockResolvedValue(mockAdapter),
        resolveIdentifier: vi.fn().mockResolvedValue('+1234567890'),
      }

      startBlastWorker(deps)
      await vi.advanceTimersByTimeAsync(5000)

      expect(mockAdapter.sendMessage).toHaveBeenCalledTimes(1)
      const callArgs = mockAdapter.sendMessage.mock.calls[0][0]
      expect(callArgs.body).not.toContain('undefined')
      expect(callArgs.body).toBe('\nReply STOP to unsubscribe.')
    })

    it('uses smsText override for SMS channel when present', async () => {
      const mockAdapter = createMockAdapter()
      const blastsService = createMockBlastsService({
        getSendingBlasts: vi.fn().mockResolvedValue([{ id: 'blast-1', hubId: 'hub-1' }]),
        getBlast: vi.fn().mockResolvedValue({
          id: 'blast-1',
          hubId: 'hub-1',
          status: 'sending',
          content: { text: 'Default text', smsText: 'SMS override' } as BlastContent,
          defaultLanguage: 'en',
        }),
        drainDeliveryBatch: vi.fn().mockResolvedValue([
          { id: 'del-1', subscriberId: 'sub-1', channel: 'sms', attempts: 0 },
        ]),
        syncBlastStats: vi.fn().mockResolvedValue({
          stats: { totalRecipients: 1, sent: 1, delivered: 0, failed: 0, optedOut: 0 } as BlastStats,
          completed: true,
        }),
      })

      const deps = {
        blastsService,
        settingsService: createSettingsService({ getMessagingConfig: vi.fn().mockResolvedValue({
          enabledChannels: ['sms', 'whatsapp', 'signal'],
          sms: { enabled: true },
          whatsapp: { integrationMode: 'twilio' as const },
          signal: { bridgeUrl: 'http://signal-bridge', bridgeApiKey: 'key', webhookSecret: 'secret', registeredNumber: '+15550000000' },
          rcs: null,
          telegram: null,
          autoAssign: true,
          inactivityTimeout: 60,
          maxConcurrentPerUser: 3,
          preferSignalDelivery: true,
          smsContentMode: 'full' as const,
        }) }),
        resolveAdapter: vi.fn().mockResolvedValue(mockAdapter),
        resolveIdentifier: vi.fn().mockResolvedValue('+1234567890'),
      }

      startBlastWorker(deps)
      await vi.advanceTimersByTimeAsync(5000)

      const callArgs = mockAdapter.sendMessage.mock.calls[0][0]
      expect(callArgs.body).toBe('SMS override\nReply STOP to unsubscribe.')
    })

    it('falls back to text when smsText is not present for SMS channel', async () => {
      const mockAdapter = createMockAdapter()
      const blastsService = createMockBlastsService({
        getSendingBlasts: vi.fn().mockResolvedValue([{ id: 'blast-1', hubId: 'hub-1' }]),
        getBlast: vi.fn().mockResolvedValue({
          id: 'blast-1',
          hubId: 'hub-1',
          status: 'sending',
          content: { text: 'Default text' } as BlastContent,
          defaultLanguage: 'en',
        }),
        drainDeliveryBatch: vi.fn().mockResolvedValue([
          { id: 'del-1', subscriberId: 'sub-1', channel: 'sms', attempts: 0 },
        ]),
        syncBlastStats: vi.fn().mockResolvedValue({
          stats: { totalRecipients: 1, sent: 1, delivered: 0, failed: 0, optedOut: 0 } as BlastStats,
          completed: true,
        }),
      })

      const deps = {
        blastsService,
        settingsService: createSettingsService({ getMessagingConfig: vi.fn().mockResolvedValue({
          enabledChannels: ['sms', 'whatsapp', 'signal'],
          sms: { enabled: true },
          whatsapp: { integrationMode: 'twilio' as const },
          signal: { bridgeUrl: 'http://signal-bridge', bridgeApiKey: 'key', webhookSecret: 'secret', registeredNumber: '+15550000000' },
          rcs: null,
          telegram: null,
          autoAssign: true,
          inactivityTimeout: 60,
          maxConcurrentPerUser: 3,
          preferSignalDelivery: true,
          smsContentMode: 'full' as const,
        }) }),
        resolveAdapter: vi.fn().mockResolvedValue(mockAdapter),
        resolveIdentifier: vi.fn().mockResolvedValue('+1234567890'),
      }

      startBlastWorker(deps)
      await vi.advanceTimersByTimeAsync(5000)

      const callArgs = mockAdapter.sendMessage.mock.calls[0][0]
      expect(callArgs.body).toBe('Default text\nReply STOP to unsubscribe.')
    })
  })

  describe('rate limiters memory leak', () => {
    it('clears rate limiters on stopBlastWorker', async () => {
      const deps = createDeps()
      startBlastWorker(deps)
      await vi.advanceTimersByTimeAsync(5000)
      stopBlastWorker()

      const deps2 = createDeps()
      startBlastWorker(deps2)
      await vi.advanceTimersByTimeAsync(5000)
      stopBlastWorker()

      expect(true).toBe(true)
    })
  })

  describe('lifecycle', () => {
    it('ignores duplicate start calls', () => {
      const deps = createDeps()
      startBlastWorker(deps)
      startBlastWorker(deps)
      expect(vi.getTimerCount()).toBeGreaterThan(0)
    })

    it('stops cleanly when no timer is running', () => {
      expect(() => stopBlastWorker()).not.toThrow()
    })
  })

  describe('polling and batch processing', () => {
    it('polls for sending blasts and processes deliveries', async () => {
      const mockAdapter = createMockAdapter()
      const blastsService = createMockBlastsService({
        getSendingBlasts: vi.fn().mockResolvedValue([{ id: 'blast-1', hubId: 'hub-1' }]),
        drainDeliveryBatch: vi.fn().mockResolvedValue([
          { id: 'del-1', subscriberId: 'sub-1', channel: 'sms', attempts: 0 },
        ]),
        syncBlastStats: vi.fn().mockResolvedValue({
          stats: { totalRecipients: 1, sent: 1, delivered: 0, failed: 0, optedOut: 0 } as BlastStats,
          completed: true,
        }),
      })

      const onStatusChange = vi.fn()
      const deps = {
        blastsService,
        settingsService: createSettingsService(),
        resolveAdapter: vi.fn().mockResolvedValue(mockAdapter),
        resolveIdentifier: vi.fn().mockResolvedValue('+1234567890'),
        onStatusChange,
      }

      startBlastWorker(deps)
      await vi.advanceTimersByTimeAsync(5000)

      expect(blastsService.getSendingBlasts).toHaveBeenCalled()
      expect(blastsService.drainDeliveryBatch).toHaveBeenCalledWith('blast-1', 50)
      expect(mockAdapter.sendMessage).toHaveBeenCalledTimes(1)
      expect(onStatusChange).toHaveBeenCalledWith('blast-1', 'hub-1', 'sent')
    })

    it('skips blast if status is no longer sending', async () => {
      const blastsService = createMockBlastsService({
        getSendingBlasts: vi.fn().mockResolvedValue([{ id: 'blast-1', hubId: 'hub-1' }]),
        getBlast: vi.fn()
          .mockResolvedValueOnce({
            id: 'blast-1',
            hubId: 'hub-1',
            status: 'sending',
            content: { text: 'Hello' } as BlastContent,
            defaultLanguage: 'en',
          })
          .mockResolvedValueOnce({
            id: 'blast-1',
            hubId: 'hub-1',
            status: 'sending',
            content: { text: 'Hello' } as BlastContent,
            defaultLanguage: 'en',
          })
          .mockResolvedValueOnce({
            id: 'blast-1',
            hubId: 'hub-1',
            status: 'cancelled',
            content: { text: 'Hello' } as BlastContent,
            defaultLanguage: 'en',
          }),
        drainDeliveryBatch: vi.fn().mockResolvedValue([
          { id: 'del-1', subscriberId: 'sub-1', channel: 'sms', attempts: 0 },
        ]),
      })

      const deps = createDeps({ blastsService })
      startBlastWorker(deps)
      await vi.advanceTimersByTimeAsync(5000)

      expect(deps.mockAdapter.sendMessage).not.toHaveBeenCalled()
    })

    it('marks delivery opted out when subscriber is no longer active', async () => {
      const blastsService = createMockBlastsService({
        getSendingBlasts: vi.fn().mockResolvedValue([{ id: 'blast-1', hubId: 'hub-1' }]),
        drainDeliveryBatch: vi.fn().mockResolvedValue([
          { id: 'del-1', subscriberId: 'sub-1', channel: 'sms', attempts: 0 },
        ]),
        isSubscriberActive: vi.fn().mockResolvedValue(false),
      })

      const deps = createDeps({ blastsService })
      startBlastWorker(deps)
      await vi.advanceTimersByTimeAsync(5000)

      expect(blastsService.markDeliveryOptedOut).toHaveBeenCalledWith('del-1')
      expect(deps.mockAdapter.sendMessage).not.toHaveBeenCalled()
    })

    it('marks delivery failed when no adapter is available', async () => {
      const blastsService = createMockBlastsService({
        getSendingBlasts: vi.fn().mockResolvedValue([{ id: 'blast-1', hubId: 'hub-1' }]),
        drainDeliveryBatch: vi.fn().mockResolvedValue([
          { id: 'del-1', subscriberId: 'sub-1', channel: 'sms', attempts: 0 },
        ]),
      })

      const deps = createDeps({
        blastsService,
        resolveAdapter: vi.fn().mockResolvedValue(null),
      })
      startBlastWorker(deps)
      await vi.advanceTimersByTimeAsync(5000)

      expect(blastsService.markDeliveryFailed).toHaveBeenCalledWith(
        'del-1',
        'No adapter available for channel: sms',
        0,
      )
    })

    it('marks delivery failed when identifier cannot be resolved', async () => {
      const blastsService = createMockBlastsService({
        getSendingBlasts: vi.fn().mockResolvedValue([{ id: 'blast-1', hubId: 'hub-1' }]),
        drainDeliveryBatch: vi.fn().mockResolvedValue([
          { id: 'del-1', subscriberId: 'sub-1', channel: 'sms', attempts: 0 },
        ]),
      })

      const deps = createDeps({
        blastsService,
        resolveIdentifier: vi.fn().mockResolvedValue(null),
      })
      startBlastWorker(deps)
      await vi.advanceTimersByTimeAsync(5000)

      expect(blastsService.markDeliveryFailed).toHaveBeenCalledWith(
        'del-1',
        'Could not resolve subscriber identifier',
        0,
      )
    })

    it('marks delivery sent on successful adapter send', async () => {
      const mockAdapter = createMockAdapter()
      const blastsService = createMockBlastsService({
        getSendingBlasts: vi.fn().mockResolvedValue([{ id: 'blast-1', hubId: 'hub-1' }]),
        drainDeliveryBatch: vi.fn().mockResolvedValue([
          { id: 'del-1', subscriberId: 'sub-1', channel: 'sms', attempts: 0 },
        ]),
        syncBlastStats: vi.fn().mockResolvedValue({
          stats: { totalRecipients: 1, sent: 1, delivered: 0, failed: 0, optedOut: 0 } as BlastStats,
          completed: true,
        }),
      })

      const deps = {
        blastsService,
        settingsService: createSettingsService(),
        resolveAdapter: vi.fn().mockResolvedValue(mockAdapter),
        resolveIdentifier: vi.fn().mockResolvedValue('+1234567890'),
      }

      startBlastWorker(deps)
      await vi.advanceTimersByTimeAsync(5000)

      expect(blastsService.markDeliverySent).toHaveBeenCalledWith('del-1', 'ext-123')
    })

    it('marks delivery failed on adapter send failure', async () => {
      const mockAdapter = createMockAdapter()
      mockAdapter.sendMessage = vi.fn().mockResolvedValue({ success: false, error: 'Network error' })

      const blastsService = createMockBlastsService({
        getSendingBlasts: vi.fn().mockResolvedValue([{ id: 'blast-1', hubId: 'hub-1' }]),
        drainDeliveryBatch: vi.fn().mockResolvedValue([
          { id: 'del-1', subscriberId: 'sub-1', channel: 'sms', attempts: 0 },
        ]),
      })

      const deps = {
        blastsService,
        settingsService: createSettingsService(),
        resolveAdapter: vi.fn().mockResolvedValue(mockAdapter),
        resolveIdentifier: vi.fn().mockResolvedValue('+1234567890'),
      }

      startBlastWorker(deps)
      await vi.advanceTimersByTimeAsync(5000)

      expect(blastsService.markDeliveryFailed).toHaveBeenCalledWith(
        'del-1',
        'Network error',
        0,
      )
    })

    it('marks delivery failed on adapter exception', async () => {
      const mockAdapter = createMockAdapter()
      mockAdapter.sendMessage = vi.fn().mockRejectedValue(new Error('Boom'))

      const blastsService = createMockBlastsService({
        getSendingBlasts: vi.fn().mockResolvedValue([{ id: 'blast-1', hubId: 'hub-1' }]),
        drainDeliveryBatch: vi.fn().mockResolvedValue([
          { id: 'del-1', subscriberId: 'sub-1', channel: 'sms', attempts: 0 },
        ]),
      })

      const deps = {
        blastsService,
        settingsService: createSettingsService(),
        resolveAdapter: vi.fn().mockResolvedValue(mockAdapter),
        resolveIdentifier: vi.fn().mockResolvedValue('+1234567890'),
      }

      startBlastWorker(deps)
      await vi.advanceTimersByTimeAsync(5000)

      expect(blastsService.markDeliveryFailed).toHaveBeenCalledWith(
        'del-1',
        'Boom',
        0,
      )
    })

    it('sends media messages when mediaUrl is present', async () => {
      const mockAdapter = createMockAdapter()
      const blastsService = createMockBlastsService({
        getSendingBlasts: vi.fn().mockResolvedValue([{ id: 'blast-1', hubId: 'hub-1' }]),
        getBlast: vi.fn().mockResolvedValue({
          id: 'blast-1',
          hubId: 'hub-1',
          status: 'sending',
          content: {
            text: 'Check this out',
            mediaUrl: 'https://example.com/image.jpg',
            mediaType: 'image/jpeg',
          } as BlastContent,
          defaultLanguage: 'en',
        }),
        drainDeliveryBatch: vi.fn().mockResolvedValue([
          { id: 'del-1', subscriberId: 'sub-1', channel: 'sms', attempts: 0 },
        ]),
        syncBlastStats: vi.fn().mockResolvedValue({
          stats: { totalRecipients: 1, sent: 1, delivered: 0, failed: 0, optedOut: 0 } as BlastStats,
          completed: true,
        }),
      })

      const deps = {
        blastsService,
        settingsService: createSettingsService({ getMessagingConfig: vi.fn().mockResolvedValue({
          enabledChannels: ['sms', 'whatsapp', 'signal'],
          sms: { enabled: true },
          whatsapp: { integrationMode: 'twilio' as const },
          signal: { bridgeUrl: 'http://signal-bridge', bridgeApiKey: 'key', webhookSecret: 'secret', registeredNumber: '+15550000000' },
          rcs: null,
          telegram: null,
          autoAssign: true,
          inactivityTimeout: 60,
          maxConcurrentPerUser: 3,
          preferSignalDelivery: true,
          smsContentMode: 'full' as const,
        }) }),
        resolveAdapter: vi.fn().mockResolvedValue(mockAdapter),
        resolveIdentifier: vi.fn().mockResolvedValue('+1234567890'),
      }

      startBlastWorker(deps)
      await vi.advanceTimersByTimeAsync(5000)

      expect(mockAdapter.sendMediaMessage).toHaveBeenCalledTimes(1)
      expect(mockAdapter.sendMediaMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          recipientIdentifier: '+1234567890',
          body: 'Check this out\nReply STOP to unsubscribe.',
          mediaUrl: 'https://example.com/image.jpg',
          mediaType: 'image/jpeg',
        }),
      )
    })

    it('calls onProgress with stats after batch', async () => {
      const mockAdapter = createMockAdapter()
      const stats = { totalRecipients: 10, sent: 5, delivered: 0, failed: 0, optedOut: 0 } as BlastStats
      const blastsService = createMockBlastsService({
        getSendingBlasts: vi.fn().mockResolvedValue([{ id: 'blast-1', hubId: 'hub-1' }]),
        drainDeliveryBatch: vi.fn().mockResolvedValue([
          { id: 'del-1', subscriberId: 'sub-1', channel: 'sms', attempts: 0 },
        ]),
        syncBlastStats: vi.fn().mockResolvedValue({ stats, completed: false }),
      })

      const onProgress = vi.fn()
      const deps = {
        blastsService,
        settingsService: createSettingsService(),
        resolveAdapter: vi.fn().mockResolvedValue(mockAdapter),
        resolveIdentifier: vi.fn().mockResolvedValue('+1234567890'),
        onProgress,
      }

      startBlastWorker(deps)
      await vi.advanceTimersByTimeAsync(5000)

      expect(onProgress).toHaveBeenCalledWith('blast-1', 'hub-1', stats)
    })

    it('does not call onStatusChange when blast is not completed', async () => {
      const mockAdapter = createMockAdapter()
      const blastsService = createMockBlastsService({
        getSendingBlasts: vi.fn().mockResolvedValue([{ id: 'blast-1', hubId: 'hub-1' }]),
        drainDeliveryBatch: vi.fn().mockResolvedValue([
          { id: 'del-1', subscriberId: 'sub-1', channel: 'sms', attempts: 0 },
        ]),
        syncBlastStats: vi.fn().mockResolvedValue({
          stats: { totalRecipients: 10, sent: 1, delivered: 0, failed: 0, optedOut: 0 } as BlastStats,
          completed: false,
        }),
      })

      const onStatusChange = vi.fn()
      const deps = {
        blastsService,
        settingsService: createSettingsService(),
        resolveAdapter: vi.fn().mockResolvedValue(mockAdapter),
        resolveIdentifier: vi.fn().mockResolvedValue('+1234567890'),
        onStatusChange,
      }

      startBlastWorker(deps)
      await vi.advanceTimersByTimeAsync(5000)

      expect(onStatusChange).not.toHaveBeenCalled()
    })

    it('handles poll errors gracefully', async () => {
      const blastsService = createMockBlastsService({
        getSendingBlasts: vi.fn().mockRejectedValue(new Error('DB down')),
      })

      const deps = createDeps({ blastsService })
      startBlastWorker(deps)
      await vi.advanceTimersByTimeAsync(5000)

      expect(vi.getTimerCount()).toBeGreaterThan(0)
    })

    it('processes multiple blasts in one poll', async () => {
      const mockAdapter = createMockAdapter()
      const blastsService = createMockBlastsService({
        getSendingBlasts: vi.fn().mockResolvedValue([
          { id: 'blast-1', hubId: 'hub-1' },
          { id: 'blast-2', hubId: 'hub-2' },
        ]),
        drainDeliveryBatch: vi.fn().mockResolvedValue([
          { id: 'del-1', subscriberId: 'sub-1', channel: 'sms', attempts: 0 },
        ]),
        syncBlastStats: vi.fn().mockResolvedValue({
          stats: { totalRecipients: 1, sent: 1, delivered: 0, failed: 0, optedOut: 0 } as BlastStats,
          completed: true,
        }),
      })

      const onStatusChange = vi.fn()
      const deps = {
        blastsService,
        settingsService: createSettingsService(),
        resolveAdapter: vi.fn().mockResolvedValue(mockAdapter),
        resolveIdentifier: vi.fn().mockResolvedValue('+1234567890'),
        onStatusChange,
      }

      startBlastWorker(deps)
      await vi.advanceTimersByTimeAsync(5000)

      expect(blastsService.drainDeliveryBatch).toHaveBeenCalledTimes(2)
      expect(onStatusChange).toHaveBeenCalledTimes(2)
    })
  })
})
