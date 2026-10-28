import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { VonageSMSAdapter } from '@worker/messaging/sms/vonage'


describe('VonageSMSAdapter', () => {
  let adapter: VonageSMSAdapter
  let fetchMock: ReturnType<typeof vi.fn>

  const apiKey = 'vonage-api-key'
  const apiSecret = 'vonage-api-secret'
  const phoneNumber = '+15551234567'

  beforeEach(() => {
    adapter = new VonageSMSAdapter(apiKey, apiSecret, phoneNumber)
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('channelType', () => {
    it('is sms', () => {
      expect(adapter.channelType).toBe('sms')
    })
  })

  // --- parseIncomingMessage ---

  describe('parseIncomingMessage', () => {
    it('parses basic SMS JSON webhook fields', async () => {
      const payload = {
        msisdn: '15559876543',
        to: '15551234567',
        text: 'Hello from Vonage',
        messageId: 'VON-MSG-001',
        type: 'text',
        'message-timestamp': '2024-01-01 12:00:00',
      }
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseIncomingMessage(request)
      expect(result.channelType).toBe('sms')
      expect(result.externalId).toBe('VON-MSG-001')
      expect(result.senderIdentifier).toBe('+15559876543')
      expect(result).not.toHaveProperty('senderIdentifierHash')
      expect(result.body).toBe('Hello from Vonage')
      expect(result.metadata?.to).toBe('15551234567')
      expect(result.timestamp).toBe('2024-01-01 12:00:00')
    })

    it('normalizes msisdn without + prefix to E.164', async () => {
      const payload = {
        msisdn: '447700900123',
        to: '15551234567',
        messageId: 'VON-MSG-002',
        type: 'text',
        text: 'UK message',
      }
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseIncomingMessage(request)
      expect(result.senderIdentifier).toBe('+447700900123')
    })

    it('preserves + prefix if already present', async () => {
      const payload = {
        msisdn: '+15559876543',
        to: '15551234567',
        messageId: 'VON-MSG-003',
        type: 'text',
      }
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseIncomingMessage(request)
      expect(result.senderIdentifier).toBe('+15559876543')
    })

    it('handles missing text gracefully', async () => {
      const payload = {
        msisdn: '15559876543',
        messageId: 'VON-MSG-004',
        type: 'text',
      }
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseIncomingMessage(request)
      expect(result.body).toBeUndefined()
    })

    it('leaves hashing to the router: same same number, same senderIdentifier, no hash', async () => {
      const makeRequest = () =>
        new Request('https://example.com/webhook', {
          method: 'POST',
          body: JSON.stringify({ msisdn: '15559876543', messageId: 'VON-1', type: 'text' }),
          headers: { 'Content-Type': 'application/json' },
        })
      const r1 = await adapter.parseIncomingMessage(makeRequest())
      const r2 = await adapter.parseIncomingMessage(makeRequest())
      expect(r1.senderIdentifier).toBe(r2.senderIdentifier)
      expect(r1).not.toHaveProperty('senderIdentifierHash')
    })
  })

  // --- validateWebhook ---

  describe('validateWebhook', () => {
    it('rejects missing X-Vonage-Signature header', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify({ msisdn: '15559876543' }),
        headers: { 'Content-Type': 'application/json' },
      })
      expect(await adapter.validateWebhook(request)).toBe(false)
    })

    it('rejects invalid signature', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify({ msisdn: '15559876543' }),
        headers: {
          'Content-Type': 'application/json',
          'X-Vonage-Signature': 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        },
      })
      expect(await adapter.validateWebhook(request)).toBe(false)
    })

    it('accepts valid HMAC-SHA256 signature over raw body', async () => {
      const body = JSON.stringify({ msisdn: '15559876543', messageId: 'VON-1' })
      const encoder = new TextEncoder()
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(apiSecret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      )
      const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body))
      const signature = Array.from(new Uint8Array(sig))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')

      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body,
        headers: {
          'Content-Type': 'application/json',
          'X-Vonage-Signature': signature,
        },
      })
      expect(await adapter.validateWebhook(request)).toBe(true)
    })
  })

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends SMS via Vonage REST API and returns externalId', async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            messages: [{ status: '0', 'message-id': 'VON-OUT-001' }],
          }),
          { status: 200 },
        ),
      )

      const result = await adapter.sendMessage({
        recipientIdentifier: '+15559876543',
        body: 'Hello from tests',
        conversationId: 'conv-1',
      })

      expect(result.success).toBe(true)
      expect(result.externalId).toBe('VON-OUT-001')
      expect(fetchMock).toHaveBeenCalledTimes(1)

      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('https://rest.nexmo.com/sms/json')
      expect(init?.method).toBe('POST')

      const sentBody = JSON.parse(init?.body as string)
      expect(sentBody.api_key).toBe(apiKey)
      expect(sentBody.api_secret).toBe(apiSecret)
      expect(sentBody.to).toBe('15559876543') // stripped + prefix
      expect(sentBody.text).toBe('Hello from tests')
    })

    it('returns error when Vonage message status is non-zero', async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            messages: [{ status: '6', 'error-text': 'The message was invalid' }],
          }),
          { status: 200 },
        ),
      )

      const result = await adapter.sendMessage({
        recipientIdentifier: '+15559876543',
        body: 'Test',
        conversationId: 'conv-1',
      })

      expect(result.success).toBe(false)
      expect(result.error).toBe('The message was invalid')
    })

    it('returns error when API returns non-ok status', async () => {
      fetchMock.mockResolvedValue(
        new Response('Internal Server Error', { status: 500 }),
      )

      const result = await adapter.sendMessage({
        recipientIdentifier: '+15559876543',
        body: 'Test',
        conversationId: 'conv-1',
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('500')
    })

    it('returns error on network failure', async () => {
      fetchMock.mockRejectedValue(new Error('Network unreachable'))

      const result = await adapter.sendMessage({
        recipientIdentifier: '+15559876543',
        body: 'Test',
        conversationId: 'conv-1',
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('Network unreachable')
    })
  })

  // --- sendMediaMessage ---

  describe('sendMediaMessage', () => {
    it('sends media via Vonage Messages API with Basic auth', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ message_uuid: 'MMS-UUID-001' }), { status: 202 }),
      )

      const result = await adapter.sendMediaMessage({
        recipientIdentifier: '+15559876543',
        body: 'Check this image',
        mediaUrl: 'https://example.com/photo.jpg',
        mediaType: 'image/jpeg',
        conversationId: 'conv-1',
      })

      expect(result.success).toBe(true)
      expect(result.externalId).toBe('MMS-UUID-001')

      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('https://api.nexmo.com/v1/messages')
      expect(init?.headers?.['Authorization']).toBe('Basic ' + btoa(`${apiKey}:${apiSecret}`))
    })

    it('returns error when media API returns non-ok', async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({ title: 'Unprocessable Entity', detail: 'Invalid media URL' }),
          { status: 422 },
        ),
      )

      const result = await adapter.sendMediaMessage({
        recipientIdentifier: '+15559876543',
        body: '',
        mediaUrl: 'https://example.com/invalid.jpg',
        mediaType: 'image/jpeg',
        conversationId: 'conv-1',
      })

      expect(result.success).toBe(false)
      expect(result.error).toBe('Invalid media URL')
    })
  })

  // --- getChannelStatus ---

  describe('getChannelStatus', () => {
    it('returns connected when balance API succeeds', async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({ value: 10.25, autoReload: false }),
          { status: 200 },
        ),
      )

      const status = await adapter.getChannelStatus()
      expect(status.connected).toBe(true)
      expect(status.details?.provider).toBe('vonage')
      expect(status.details?.channel).toBe('sms')
      expect(status.details?.balance).toBe(10.25)
      expect(status.details?.autoReload).toBe(false)
      expect(status.details?.phoneNumber).toBe(phoneNumber)
    })

    it('passes api_key and api_secret as query params', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ value: 5.0 }), { status: 200 }),
      )

      await adapter.getChannelStatus()
      const [url] = fetchMock.mock.calls[0]
      expect(url).toContain(`api_key=${apiKey}`)
      expect(url).toContain(`api_secret=${apiSecret}`)
    })

    it('returns disconnected when API returns non-ok', async () => {
      fetchMock.mockResolvedValue(new Response('Unauthorized', { status: 401 }))

      const status = await adapter.getChannelStatus()
      expect(status.connected).toBe(false)
      expect(status.error).toContain('401')
    })

    it('returns disconnected on network error', async () => {
      fetchMock.mockRejectedValue(new Error('DNS lookup failed'))

      const status = await adapter.getChannelStatus()
      expect(status.connected).toBe(false)
      expect(status.error).toBe('DNS lookup failed')
    })
  })
})
