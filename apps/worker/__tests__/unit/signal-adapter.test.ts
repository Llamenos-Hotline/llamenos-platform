import { describe, it, expect, beforeEach } from 'vitest'
import { SignalAdapter } from '../../messaging/signal/adapter'
import type { SignalWebhookPayload } from '../../messaging/signal/types'

describe('SignalAdapter', () => {
  let adapter: SignalAdapter

  beforeEach(() => {
    adapter = new SignalAdapter(
      {
        bridgeUrl: 'http://localhost:8080',
        bridgeApiKey: 'test-api-key',
        webhookSecret: 'test-webhook-secret',
        registeredNumber: '+15551234567',
      },
    )
  })

  describe('parseStatusWebhook', () => {
    it('parses delivery receipts', async () => {
      const payload: SignalWebhookPayload = {
        envelope: {
          source: '+15559876543',
          sourceUuid: 'uuid-abc-123',
          timestamp: 1700000000000,
          receiptMessage: {
            type: 'DELIVERY',
            timestamps: [1699999990000],
          },
        },
      }

      const request = new Request('http://localhost/webhook', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseStatusWebhook(request)
      expect(result).toHaveLength(1)
      expect(result[0].externalId).toBe('1699999990000')
      expect(result[0].status).toBe('delivered')
      expect(result[0].timestamp).toBeTruthy()
    })

    it('parses read receipts with multiple timestamps', async () => {
      const payload: SignalWebhookPayload = {
        envelope: {
          source: '+15559876543',
          timestamp: 1700000000000,
          receiptMessage: {
            type: 'READ',
            timestamps: [1699999990000, 1699999995000],
          },
        },
      }

      const request = new Request('http://localhost/webhook', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseStatusWebhook(request)
      expect(result).toHaveLength(2)
      expect(result[0].status).toBe('read')
      expect(result[0].externalId).toBe('1699999990000')
      expect(result[1].externalId).toBe('1699999995000')
    })

    it('returns empty array for unknown receipt types', async () => {
      const payload: SignalWebhookPayload = {
        envelope: {
          source: '+15559876543',
          timestamp: 1700000000000,
          receiptMessage: {
            type: 'UNKNOWN',
            timestamps: [1699999990000],
          },
        },
      }

      const request = new Request('http://localhost/webhook', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseStatusWebhook(request)
      expect(result).toHaveLength(0)
    })

    it('returns empty array for non-receipt webhooks', async () => {
      const payload: SignalWebhookPayload = {
        envelope: {
          source: '+15559876543',
          timestamp: 1700000000000,
          dataMessage: {
            message: 'Hello',
            timestamp: 1700000000000,
          },
        },
      }

      const request = new Request('http://localhost/webhook', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseStatusWebhook(request)
      expect(result).toHaveLength(0)
    })

    it('returns empty array for empty timestamps', async () => {
      const payload: SignalWebhookPayload = {
        envelope: {
          source: '+15559876543',
          timestamp: 1700000000000,
          receiptMessage: {
            type: 'DELIVERY',
            timestamps: [],
          },
        },
      }

      const request = new Request('http://localhost/webhook', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseStatusWebhook(request)
      expect(result).toHaveLength(0)
    })
  })

  describe('parseReaction', () => {
    it('parses emoji reactions', () => {
      const payload: SignalWebhookPayload = {
        envelope: {
          source: '+15559876543',
          sourceUuid: 'uuid-abc-123',
          timestamp: 1700000000000,
          dataMessage: {
            timestamp: 1700000000000,
            reaction: {
              emoji: '\u{1F44D}',
              targetAuthor: '+15551234567',
              targetTimestamp: 1699999990000,
            },
          },
        },
      }

      const result = adapter.parseReaction(payload)
      expect(result).not.toBeNull()
      expect(result!.emoji).toBe('\u{1F44D}')
      expect(result!.targetAuthor).toBe('+15551234567')
      expect(result!.targetTimestamp).toBe(1699999990000)
      expect(result!.isRemove).toBe(false)
    })

    it('returns null for non-reaction messages', () => {
      const payload: SignalWebhookPayload = {
        envelope: {
          source: '+15559876543',
          timestamp: 1700000000000,
          dataMessage: {
            message: 'Hello',
            timestamp: 1700000000000,
          },
        },
      }

      const result = adapter.parseReaction(payload)
      expect(result).toBeNull()
    })

    it('returns null for receipt messages', () => {
      const payload: SignalWebhookPayload = {
        envelope: {
          source: '+15559876543',
          timestamp: 1700000000000,
          receiptMessage: {
            type: 'DELIVERY',
            timestamps: [1699999990000],
          },
        },
      }

      const result = adapter.parseReaction(payload)
      expect(result).toBeNull()
    })

    it('detects reaction removal', () => {
      const payload: SignalWebhookPayload = {
        envelope: {
          source: '+15559876543',
          timestamp: 1700000000000,
          dataMessage: {
            timestamp: 1700000000000,
            reaction: {
              emoji: '\u{1F44D}',
              targetAuthor: '+15551234567',
              targetTimestamp: 1699999990000,
              remove: true,
            },
          },
        },
      }

      const result = adapter.parseReaction(payload)
      expect(result).not.toBeNull()
      expect(result!.isRemove).toBe(true)
    })
  })

  describe('parseTypingIndicator', () => {
    it('parses typing started', () => {
      const payload: SignalWebhookPayload = {
        envelope: {
          source: '+15559876543',
          sourceUuid: 'uuid-abc-123',
          timestamp: 1700000000000,
          typingMessage: {
            action: 'STARTED',
            timestamp: 1700000000000,
          },
        },
      }

      const result = adapter.parseTypingIndicator(payload)
      expect(result).not.toBeNull()
      expect(result!.sender).toBe('uuid-abc-123')
      expect(result!.isTyping).toBe(true)
    })

    it('parses typing stopped', () => {
      const payload: SignalWebhookPayload = {
        envelope: {
          source: '+15559876543',
          sourceUuid: 'uuid-abc-123',
          timestamp: 1700000000000,
          typingMessage: {
            action: 'STOPPED',
            timestamp: 1700000000000,
          },
        },
      }

      const result = adapter.parseTypingIndicator(payload)
      expect(result).not.toBeNull()
      expect(result!.isTyping).toBe(false)
    })

    it('falls back to phone number when no UUID', () => {
      const payload: SignalWebhookPayload = {
        envelope: {
          source: '+15559876543',
          timestamp: 1700000000000,
          typingMessage: {
            action: 'STARTED',
            timestamp: 1700000000000,
          },
        },
      }

      const result = adapter.parseTypingIndicator(payload)
      expect(result).not.toBeNull()
      expect(result!.sender).toBe('+15559876543')
    })

    it('returns null for non-typing messages', () => {
      const payload: SignalWebhookPayload = {
        envelope: {
          source: '+15559876543',
          timestamp: 1700000000000,
          dataMessage: {
            message: 'Hello',
            timestamp: 1700000000000,
          },
        },
      }

      const result = adapter.parseTypingIndicator(payload)
      expect(result).toBeNull()
    })
  })

  describe('validateWebhook', () => {
    it('validates correct bearer token', async () => {
      const request = new Request('http://localhost/webhook', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-webhook-secret',
          'Content-Type': 'application/json',
        },
        body: '{}',
      })

      const result = await adapter.validateWebhook(request)
      expect(result).toBe(true)
    })

    it('rejects incorrect bearer token', async () => {
      const request = new Request('http://localhost/webhook', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer wrong-secret',
          'Content-Type': 'application/json',
        },
        body: '{}',
      })

      const result = await adapter.validateWebhook(request)
      expect(result).toBe(false)
    })

    it('rejects missing authorization header', async () => {
      const request = new Request('http://localhost/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })

      const result = await adapter.validateWebhook(request)
      expect(result).toBe(false)
    })

    it('rejects non-bearer auth scheme', async () => {
      const request = new Request('http://localhost/webhook', {
        method: 'POST',
        headers: {
          'Authorization': 'Basic dGVzdDp0ZXN0',
          'Content-Type': 'application/json',
        },
        body: '{}',
      })

      const result = await adapter.validateWebhook(request)
      expect(result).toBe(false)
    })
  })

  describe('parseIncomingMessage', () => {
    it('parses text message with UUID', async () => {
      const payload: SignalWebhookPayload = {
        envelope: {
          source: '+15559876543',
          sourceUuid: 'uuid-abc-123',
          sourceName: 'Test User',
          sourceDevice: 1,
          timestamp: 1700000000000,
          dataMessage: {
            message: 'Hello world',
            timestamp: 1700000000000,
          },
        },
      }

      const request = new Request('http://localhost/webhook', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseIncomingMessage(request)
      expect(result.channelType).toBe('signal')
      expect(result.senderIdentifier).toBe('uuid-abc-123')
      expect(result.body).toBe('Hello world')
      expect(result.externalId).toBe('1700000000000')
      expect(result.metadata?.sourceUuid).toBe('uuid-abc-123')
      expect(result.metadata?.sourceName).toBe('Test User')
    })

    it('parses message with attachments', async () => {
      const payload: SignalWebhookPayload = {
        envelope: {
          source: '+15559876543',
          timestamp: 1700000000000,
          dataMessage: {
            message: 'Check this out',
            timestamp: 1700000000000,
            attachments: [
              {
                id: 'att-1',
                contentType: 'image/jpeg',
                size: 12345,
              },
            ],
          },
        },
      }

      const request = new Request('http://localhost/webhook', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseIncomingMessage(request)
      expect(result.mediaUrls).toHaveLength(1)
      expect(result.mediaUrls![0]).toBe('http://localhost:8080/v1/attachments/att-1')
      expect(result.mediaTypes![0]).toBe('image/jpeg')
    })
  })
})
