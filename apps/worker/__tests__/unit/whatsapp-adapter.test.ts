import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WhatsAppAdapter } from '@worker/messaging/whatsapp/adapter'
import { TwilioWhatsAppClient } from '@worker/messaging/whatsapp/twilio-client'
import type { WhatsAppConfig } from '@shared/types'


// --- Test fixtures ---

const directConfig: WhatsAppConfig = {
  integrationMode: 'direct',
  phoneNumberId: 'phone-id-123',
  businessAccountId: 'biz-acct-456',
  accessToken: 'meta-access-token',
  appSecret: 'meta-app-secret',
}

const twilioConfig: WhatsAppConfig = {
  integrationMode: 'twilio',
}

describe('WhatsAppAdapter', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('channelType', () => {
    it('is whatsapp', () => {
      const adapter = new WhatsAppAdapter(directConfig)
      expect(adapter.channelType).toBe('whatsapp')
    })
  })

  describe('constructor', () => {
    it('throws for twilio mode without factory', () => {
      expect(() => new WhatsAppAdapter(twilioConfig)).toThrow(
        'Twilio WhatsApp mode must be constructed via createWhatsAppAdapter factory',
      )
    })

    it('throws for direct mode missing required fields', () => {
      const badConfig: WhatsAppConfig = {
        integrationMode: 'direct',
        phoneNumberId: 'id',
        // missing businessAccountId, accessToken, appSecret
      }
      expect(() => new WhatsAppAdapter(badConfig)).toThrow(
        'WhatsApp direct mode requires',
      )
    })
  })

  // =============================================================================
  // Direct (Meta Cloud API) mode
  // =============================================================================

  describe('direct mode', () => {
    let adapter: WhatsAppAdapter

    beforeEach(() => {
      adapter = new WhatsAppAdapter(directConfig)
    })

    // --- parseIncomingMessage ---

    describe('parseIncomingMessage', () => {
      it('parses a text message', async () => {
        const payload = {
          entry: [{
            changes: [{
              value: {
                metadata: { phone_number_id: 'phone-id-123' },
                messages: [{
                  id: 'wamid-001',
                  from: '15559876543',
                  type: 'text',
                  timestamp: '1700000000',
                  text: { body: 'Hello from WhatsApp' },
                }],
                contacts: [{
                  wa_id: '15559876543',
                  profile: { name: 'Test User' },
                }],
              },
            }],
          }],
        }
        const request = new Request('https://example.com/webhook', {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'Content-Type': 'application/json' },
        })

        const result = await adapter.parseIncomingMessage(request)
        expect(result.channelType).toBe('whatsapp')
        expect(result.externalId).toBe('wamid-001')
        expect(result.senderIdentifier).toBe('15559876543')
        expect(result).not.toHaveProperty('senderIdentifierHash')
        expect(result.body).toBe('Hello from WhatsApp')
        expect(result.metadata?.profileName).toBe('Test User')
        expect(result.metadata?.phoneNumberId).toBe('phone-id-123')
      })

      it('parses an image message with caption', async () => {
        const payload = {
          entry: [{
            changes: [{
              value: {
                metadata: { phone_number_id: 'phone-id-123' },
                messages: [{
                  id: 'wamid-002',
                  from: '15559876543',
                  type: 'image',
                  timestamp: '1700000000',
                  image: {
                    id: 'media-id-abc',
                    mime_type: 'image/jpeg',
                    caption: 'Look at this!',
                  },
                }],
              },
            }],
          }],
        }
        const request = new Request('https://example.com/webhook', {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'Content-Type': 'application/json' },
        })

        const result = await adapter.parseIncomingMessage(request)
        expect(result.body).toBe('Look at this!')
        expect(result.mediaUrls).toEqual(['media-id-abc'])
        expect(result.mediaTypes).toEqual(['image/jpeg'])
      })

      it('parses an audio message without body', async () => {
        const payload = {
          entry: [{
            changes: [{
              value: {
                metadata: { phone_number_id: 'phone-id-123' },
                messages: [{
                  id: 'wamid-003',
                  from: '15559876543',
                  type: 'audio',
                  timestamp: '1700000000',
                  audio: { id: 'audio-file-id', mime_type: 'audio/ogg' },
                }],
              },
            }],
          }],
        }
        const request = new Request('https://example.com/webhook', {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'Content-Type': 'application/json' },
        })

        const result = await adapter.parseIncomingMessage(request)
        expect(result.body).toBeUndefined()
        expect(result.mediaUrls).toEqual(['audio-file-id'])
        expect(result.mediaTypes).toEqual(['audio/ogg'])
      })

      it('parses a location message', async () => {
        const payload = {
          entry: [{
            changes: [{
              value: {
                metadata: { phone_number_id: 'phone-id-123' },
                messages: [{
                  id: 'wamid-004',
                  from: '15559876543',
                  type: 'location',
                  timestamp: '1700000000',
                  location: {
                    latitude: 40.7128,
                    longitude: -74.0060,
                    name: 'New York City',
                    address: 'New York, NY 10007',
                  },
                }],
              },
            }],
          }],
        }
        const request = new Request('https://example.com/webhook', {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'Content-Type': 'application/json' },
        })

        const result = await adapter.parseIncomingMessage(request)
        expect(result.body).toContain('40.7128')
        expect(result.body).toContain('-74.006')
        expect(result.body).toContain('New York City')
      })

      it('throws when webhook has no messages', async () => {
        const payload = {
          entry: [{
            changes: [{
              value: {
                metadata: { phone_number_id: 'phone-id-123' },
                statuses: [{ id: 'wamid-005', status: 'delivered' }],
              },
            }],
          }],
        }
        const request = new Request('https://example.com/webhook', {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'Content-Type': 'application/json' },
        })

        await expect(adapter.parseIncomingMessage(request)).rejects.toThrow(
          'no messages',
        )
      })
    })

    // --- validateWebhook ---

    describe('validateWebhook', () => {
      it('rejects missing X-Hub-Signature-256 header', async () => {
        const request = new Request('https://example.com/webhook', {
          method: 'POST',
          body: '{}',
          headers: { 'Content-Type': 'application/json' },
        })
        expect(await adapter.validateWebhook(request)).toBe(false)
      })

      it('rejects invalid signature', async () => {
        const request = new Request('https://example.com/webhook', {
          method: 'POST',
          body: '{}',
          headers: {
            'Content-Type': 'application/json',
            'X-Hub-Signature-256': 'sha256=deadbeefdeadbeef',
          },
        })
        expect(await adapter.validateWebhook(request)).toBe(false)
      })

      it('accepts valid HMAC-SHA256 signature', async () => {
        const body = JSON.stringify({ entry: [] })
        const encoder = new TextEncoder()
        const key = await crypto.subtle.importKey(
          'raw',
          encoder.encode(directConfig.appSecret),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign'],
        )
        const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body))
        const hexSig = Array.from(new Uint8Array(sig))
          .map(b => b.toString(16).padStart(2, '0'))
          .join('')

        const request = new Request('https://example.com/webhook', {
          method: 'POST',
          body,
          headers: {
            'Content-Type': 'application/json',
            'X-Hub-Signature-256': `sha256=${hexSig}`,
          },
        })
        expect(await adapter.validateWebhook(request)).toBe(true)
      })
    })

    // --- sendMessage ---

    describe('sendMessage', () => {
      it('sends text message via Meta Graph API', async () => {
        fetchMock.mockResolvedValue(
          new Response(JSON.stringify({ messages: [{ id: 'wamid-out-001' }] }), { status: 200 }),
        )

        const result = await adapter.sendMessage({
          recipientIdentifier: '15559876543',
          body: 'Hello there',
          conversationId: 'conv-1',
        })

        expect(result.success).toBe(true)
        expect(result.externalId).toBe('wamid-out-001')
        expect(fetchMock).toHaveBeenCalledTimes(1)
        const [url] = fetchMock.mock.calls[0]
        expect(url).toContain(`/${directConfig.phoneNumberId}/messages`)
      })

      it('returns error on API failure', async () => {
        fetchMock.mockResolvedValue(
          new Response('Bad Request', { status: 400 }),
        )

        const result = await adapter.sendMessage({
          recipientIdentifier: '15559876543',
          body: 'Test',
          conversationId: 'conv-1',
        })

        expect(result.success).toBe(false)
        expect(result.error).toBeTruthy()
      })
    })

    // --- sendMediaMessage ---

    describe('sendMediaMessage', () => {
      it('sends image message via Meta Graph API', async () => {
        fetchMock.mockResolvedValue(
          new Response(JSON.stringify({ messages: [{ id: 'wamid-media-001' }] }), { status: 200 }),
        )

        const result = await adapter.sendMediaMessage({
          recipientIdentifier: '15559876543',
          body: 'Image caption',
          mediaUrl: 'https://example.com/photo.jpg',
          mediaType: 'image/jpeg',
          conversationId: 'conv-1',
        })

        expect(result.success).toBe(true)
        expect(result.externalId).toBe('wamid-media-001')
      })

      it('returns error for unsupported media type', async () => {
        const result = await adapter.sendMediaMessage({
          recipientIdentifier: '15559876543',
          body: '',
          mediaUrl: 'https://example.com/file.xyz',
          mediaType: 'application/x-unknown',
          conversationId: 'conv-1',
        })

        expect(result.success).toBe(false)
        expect(result.error).toBeTruthy()
      })
    })

    // --- getChannelStatus ---

    describe('getChannelStatus', () => {
      it('returns connected when Meta API is reachable', async () => {
        fetchMock.mockResolvedValue(
          new Response(JSON.stringify({ id: directConfig.phoneNumberId }), { status: 200 }),
        )

        const status = await adapter.getChannelStatus()
        expect(status.connected).toBe(true)
        expect(status.details?.integrationMode).toBe('direct')
        expect(status.details?.provider).toBe('meta-direct')
      })

      it('returns disconnected when Meta API returns error', async () => {
        fetchMock.mockResolvedValue(
          new Response('Unauthorized', { status: 401 }),
        )

        const status = await adapter.getChannelStatus()
        expect(status.connected).toBe(false)
        expect(status.error).toBeTruthy()
      })
    })

    // --- parseStatusWebhook ---

    describe('parseStatusWebhook (Meta)', () => {
      const makeStatusPayload = (status: string, errors?: unknown[]) => ({
        entry: [{
          changes: [{
            value: {
              statuses: [{
                id: 'wamid-out-001',
                status,
                timestamp: '1700000000',
                ...(errors ? { errors } : {}),
              }],
            },
          }],
        }],
      })

      it('maps sent → sent', async () => {
        const request = new Request('https://example.com/status', {
          method: 'POST',
          body: JSON.stringify(makeStatusPayload('sent')),
          headers: { 'Content-Type': 'application/json' },
        })
        const result = await adapter.parseStatusWebhook(request)
        expect(result?.status).toBe('sent')
        expect(result?.externalId).toBe('wamid-out-001')
      })

      it('maps delivered → delivered', async () => {
        const request = new Request('https://example.com/status', {
          method: 'POST',
          body: JSON.stringify(makeStatusPayload('delivered')),
          headers: { 'Content-Type': 'application/json' },
        })
        const result = await adapter.parseStatusWebhook(request)
        expect(result?.status).toBe('delivered')
      })

      it('maps read → read', async () => {
        const request = new Request('https://example.com/status', {
          method: 'POST',
          body: JSON.stringify(makeStatusPayload('read')),
          headers: { 'Content-Type': 'application/json' },
        })
        const result = await adapter.parseStatusWebhook(request)
        expect(result?.status).toBe('read')
      })

      it('maps failed → failed with error reason', async () => {
        const request = new Request('https://example.com/status', {
          method: 'POST',
          body: JSON.stringify(makeStatusPayload('failed', [{ message: 'Message undeliverable', title: 'Error' }])),
          headers: { 'Content-Type': 'application/json' },
        })
        const result = await adapter.parseStatusWebhook(request)
        expect(result?.status).toBe('failed')
        expect(result?.failureReason).toContain('Message undeliverable')
      })

      it('returns null for unknown status', async () => {
        const request = new Request('https://example.com/status', {
          method: 'POST',
          body: JSON.stringify(makeStatusPayload('unknown_status')),
          headers: { 'Content-Type': 'application/json' },
        })
        const result = await adapter.parseStatusWebhook(request)
        expect(result).toBeNull()
      })
    })
  })

  // =============================================================================
  // Twilio mode via createWithTwilioClient
  // =============================================================================

  describe('twilio mode', () => {
    let adapter: WhatsAppAdapter
    let twilioClient: TwilioWhatsAppClient

    beforeEach(() => {
      twilioClient = new TwilioWhatsAppClient('AC-acct-123', 'auth-token-abc', '+15551234567')
      adapter = WhatsAppAdapter.createWithTwilioClient(twilioConfig, twilioClient)
    })

    describe('parseIncomingMessage', () => {
      it('strips whatsapp: prefix from sender', async () => {
        const form = new URLSearchParams({
          MessageSid: 'SM-WA-001',
          AccountSid: 'AC-acct-123',
          From: 'whatsapp:+15559876543',
          To: 'whatsapp:+15551234567',
          Body: 'Hello via Twilio WhatsApp',
          NumMedia: '0',
        })
        const request = new Request('https://example.com/webhook', {
          method: 'POST',
          body: form.toString(),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        })

        const result = await adapter.parseIncomingMessage(request)
        expect(result.channelType).toBe('whatsapp')
        expect(result.externalId).toBe('SM-WA-001')
        expect(result.senderIdentifier).toBe('+15559876543')
        expect(result.body).toBe('Hello via Twilio WhatsApp')
      })

      it('parses media attachments', async () => {
        const form = new URLSearchParams({
          MessageSid: 'SM-WA-002',
          AccountSid: 'AC-acct-123',
          From: 'whatsapp:+15559876543',
          To: 'whatsapp:+15551234567',
          Body: '',
          NumMedia: '1',
          MediaUrl0: 'https://example.com/photo.jpg',
          MediaContentType0: 'image/jpeg',
        })
        const request = new Request('https://example.com/webhook', {
          method: 'POST',
          body: form.toString(),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        })

        const result = await adapter.parseIncomingMessage(request)
        expect(result.mediaUrls).toEqual(['https://example.com/photo.jpg'])
        expect(result.mediaTypes).toEqual(['image/jpeg'])
      })

      it('parses more than 3 media attachments (Twilio WhatsApp supports up to 10)', async () => {
        const form = new URLSearchParams({
          MessageSid: 'SM-WA-MEDIA-005',
          AccountSid: 'AC-acct-123',
          From: 'whatsapp:+15559876543',
          To: 'whatsapp:+15551234567',
          Body: 'Multiple images',
          NumMedia: '5',
        })
        for (let i = 0; i < 5; i++) {
          form.set(`MediaUrl${i}`, `https://example.com/image${i}.jpg`)
          form.set(`MediaContentType${i}`, 'image/jpeg')
        }
        const request = new Request('https://example.com/webhook', {
          method: 'POST',
          body: form.toString(),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        })

        const result = await adapter.parseIncomingMessage(request)
        expect(result.mediaUrls).toHaveLength(5)
        expect(result.mediaTypes).toHaveLength(5)
        expect(result.mediaUrls![4]).toBe('https://example.com/image4.jpg')
      })
    })

    describe('sendMessage', () => {
      it('sends via Twilio Messages API', async () => {
        fetchMock.mockResolvedValue(
          new Response(JSON.stringify({ sid: 'SM-WA-OUT-001' }), { status: 201 }),
        )

        const result = await adapter.sendMessage({
          recipientIdentifier: '15559876543',
          body: 'Hello via Twilio',
          conversationId: 'conv-1',
        })

        expect(result.success).toBe(true)
        expect(result.externalId).toBe('SM-WA-OUT-001')
        const [url] = fetchMock.mock.calls[0]
        expect(url).toContain('/Messages.json')
      })
    })

    describe('parseStatusWebhook (Twilio)', () => {
      it('maps queued → pending', async () => {
        const form = new URLSearchParams({
          MessageSid: 'SM-WA-001',
          MessageStatus: 'queued',
        })
        const request = new Request('https://example.com/status', {
          method: 'POST',
          body: form.toString(),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        })
        const result = await adapter.parseStatusWebhook(request)
        expect(result?.status).toBe('pending')
      })

      it('maps delivered → delivered', async () => {
        const form = new URLSearchParams({
          MessageSid: 'SM-WA-002',
          MessageStatus: 'delivered',
        })
        const request = new Request('https://example.com/status', {
          method: 'POST',
          body: form.toString(),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        })
        const result = await adapter.parseStatusWebhook(request)
        expect(result?.status).toBe('delivered')
      })
    })
  })
})
