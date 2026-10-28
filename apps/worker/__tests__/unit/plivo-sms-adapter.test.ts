import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { PlivoSMSAdapter } from '@worker/messaging/sms/plivo'


describe('PlivoSMSAdapter', () => {
  let adapter: PlivoSMSAdapter
  let fetchMock: ReturnType<typeof vi.fn>

  const authId = 'plivo-auth-id'
  const authToken = 'plivo-auth-token'
  const phoneNumber = '+15551234567'

  beforeEach(() => {
    adapter = new PlivoSMSAdapter(authId, authToken, phoneNumber)
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
    it('parses basic SMS form webhook fields', async () => {
      const form = new URLSearchParams({
        MessageUUID: 'PLV-MSG-001',
        From: '+15559876543',
        To: '+15551234567',
        Text: 'Hello from Plivo',
        Type: 'sms',
      })
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: form.toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })

      const result = await adapter.parseIncomingMessage(request)
      expect(result.channelType).toBe('sms')
      expect(result.externalId).toBe('PLV-MSG-001')
      expect(result.senderIdentifier).toBe('+15559876543')
      expect(result).not.toHaveProperty('senderIdentifierHash')
      expect(result.body).toBe('Hello from Plivo')
      expect(result.metadata?.to).toBe('+15551234567')
      expect(result.timestamp).toBeTruthy()
    })

    it('parses MMS with media attachments', async () => {
      const form = new URLSearchParams({
        MessageUUID: 'PLV-MMS-001',
        From: '+15559876543',
        Type: 'mms',
        Media0: 'https://example.com/image.jpg',
        Media1: 'https://example.com/doc.pdf',
      })
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: form.toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })

      const result = await adapter.parseIncomingMessage(request)
      expect(result.externalId).toBe('PLV-MMS-001')
      expect(result.mediaUrls).toEqual([
        'https://example.com/image.jpg',
        'https://example.com/doc.pdf',
      ])
      expect(result.mediaUrls).toHaveLength(2)
    })

    it('handles missing text gracefully', async () => {
      const form = new URLSearchParams({
        MessageUUID: 'PLV-MSG-002',
        From: '+15559876543',
        Type: 'sms',
      })
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: form.toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })

      const result = await adapter.parseIncomingMessage(request)
      expect(result.body).toBeUndefined()
      expect(result.mediaUrls).toBeUndefined()
    })

    it('leaves hashing to the router: same same number, same senderIdentifier, no hash', async () => {
      const makeRequest = () =>
        new Request('https://example.com/webhook', {
          method: 'POST',
          body: new URLSearchParams({ MessageUUID: 'PLV-1', From: '+15559876543', Type: 'sms' }).toString(),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        })
      const r1 = await adapter.parseIncomingMessage(makeRequest())
      const r2 = await adapter.parseIncomingMessage(makeRequest())
      expect(r1.senderIdentifier).toBe(r2.senderIdentifier)
      expect(r1).not.toHaveProperty('senderIdentifierHash')
    })
  })

  // --- validateWebhook ---

  describe('validateWebhook', () => {
    it('rejects missing signature header', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: 'From=%2B15559876543&Text=Hello',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Plivo-Signature-V3-Nonce': 'some-nonce',
        },
      })
      expect(await adapter.validateWebhook(request)).toBe(false)
    })

    it('rejects missing nonce header', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: 'From=%2B15559876543&Text=Hello',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Plivo-Signature-V3': 'some-signature==',
        },
      })
      expect(await adapter.validateWebhook(request)).toBe(false)
    })

    it('rejects invalid signature', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: 'From=%2B15559876543&Text=Hello',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Plivo-Signature-V3': 'aW52YWxpZA==',
          'X-Plivo-Signature-V3-Nonce': 'test-nonce',
        },
      })
      expect(await adapter.validateWebhook(request)).toBe(false)
    })

    it('accepts valid HMAC-SHA256 + nonce signature', async () => {
      const url = 'https://example.com/api/sms/incoming'
      const bodyStr = 'From=%2B15559876543&Text=Hello'
      const nonce = 'test-nonce-12345'
      const params = new URLSearchParams(bodyStr)

      // Build validation string: origin + pathname + sorted params + '.' + nonce
      const parsedUrl = new URL(url)
      let dataString = parsedUrl.origin + parsedUrl.pathname
      const sortedEntries = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b))
      for (const [key, value] of sortedEntries) {
        dataString += key + value
      }
      dataString += '.' + nonce

      const encoder = new TextEncoder()
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(authToken),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      )
      const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(dataString))
      const signature = btoa(String.fromCharCode(...new Uint8Array(sig)))

      const request = new Request(url, {
        method: 'POST',
        body: bodyStr,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Plivo-Signature-V3': signature,
          'X-Plivo-Signature-V3-Nonce': nonce,
        },
      })
      expect(await adapter.validateWebhook(request)).toBe(true)
    })
  })

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends SMS via Plivo API and returns externalId', async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({ message_uuid: ['PLV-OUT-001'] }),
          { status: 202 },
        ),
      )

      const result = await adapter.sendMessage({
        recipientIdentifier: '+15559876543',
        body: 'Test message',
        conversationId: 'conv-1',
      })

      expect(result.success).toBe(true)
      expect(result.externalId).toBe('PLV-OUT-001')
      expect(fetchMock).toHaveBeenCalledTimes(1)

      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toContain(`/Account/${authId}/Message/`)
      expect(init?.method).toBe('POST')
      expect(init?.headers?.['Authorization']).toBe('Basic ' + btoa(`${authId}:${authToken}`))

      const sentBody = JSON.parse(init?.body as string)
      expect(sentBody.src).toBe(phoneNumber)
      expect(sentBody.dst).toBe('+15559876543')
      expect(sentBody.text).toBe('Test message')
    })

    it('returns error on API failure', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ error: 'Invalid phone number' }), { status: 400 }),
      )

      const result = await adapter.sendMessage({
        recipientIdentifier: 'invalid',
        body: 'Test',
        conversationId: 'conv-1',
      })

      expect(result.success).toBe(false)
      expect(result.error).toBe('Invalid phone number')
    })

    it('returns error on network failure', async () => {
      fetchMock.mockRejectedValue(new Error('Connection refused'))

      const result = await adapter.sendMessage({
        recipientIdentifier: '+15559876543',
        body: 'Test',
        conversationId: 'conv-1',
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('Connection refused')
    })
  })

  // --- sendMediaMessage ---

  describe('sendMediaMessage', () => {
    it('sends MMS via Plivo API with media_urls', async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({ message_uuid: ['PLV-MMS-OUT-001'] }),
          { status: 202 },
        ),
      )

      const result = await adapter.sendMediaMessage({
        recipientIdentifier: '+15559876543',
        body: 'Image caption',
        mediaUrl: 'https://example.com/photo.jpg',
        mediaType: 'image/jpeg',
        conversationId: 'conv-1',
      })

      expect(result.success).toBe(true)
      expect(result.externalId).toBe('PLV-MMS-OUT-001')

      const [, init] = fetchMock.mock.calls[0]
      const sentBody = JSON.parse(init?.body as string)
      expect(sentBody.media_urls).toEqual(['https://example.com/photo.jpg'])
      expect(sentBody.type).toBe('mms')
    })

    it('returns error when MMS API returns non-ok', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ error: 'Media URL unreachable' }), { status: 400 }),
      )

      const result = await adapter.sendMediaMessage({
        recipientIdentifier: '+15559876543',
        body: '',
        mediaUrl: 'https://bad-url.example.com/photo.jpg',
        mediaType: 'image/jpeg',
        conversationId: 'conv-1',
      })

      expect(result.success).toBe(false)
      expect(result.error).toBe('Media URL unreachable')
    })
  })

  // --- getChannelStatus ---

  describe('getChannelStatus', () => {
    it('returns connected when account API succeeds', async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({ cash_credits: '50.00', account_type: 'prepaid' }),
          { status: 200 },
        ),
      )

      const status = await adapter.getChannelStatus()
      expect(status.connected).toBe(true)
      expect(status.details?.provider).toBe('plivo')
      expect(status.details?.channel).toBe('sms')
      expect(status.details?.credits).toBe('50.00')
      expect(status.details?.accountType).toBe('prepaid')
      expect(status.details?.phoneNumber).toBe(phoneNumber)
    })

    it('uses Basic auth for account endpoint', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ cash_credits: '0' }), { status: 200 }),
      )

      await adapter.getChannelStatus()
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toContain(`/Account/${authId}/`)
      expect(init?.headers?.['Authorization']).toBe('Basic ' + btoa(`${authId}:${authToken}`))
    })

    it('returns disconnected when API returns non-ok', async () => {
      fetchMock.mockResolvedValue(new Response('Unauthorized', { status: 401 }))

      const status = await adapter.getChannelStatus()
      expect(status.connected).toBe(false)
      expect(status.error).toContain('401')
    })

    it('returns disconnected on network error', async () => {
      fetchMock.mockRejectedValue(new Error('Timeout'))

      const status = await adapter.getChannelStatus()
      expect(status.connected).toBe(false)
      expect(status.error).toBe('Timeout')
    })
  })
})
