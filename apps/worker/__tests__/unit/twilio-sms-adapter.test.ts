import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { TwilioSMSAdapter } from '@worker/messaging/sms/twilio'


describe('TwilioSMSAdapter', () => {
  let adapter: TwilioSMSAdapter
  let fetchMock: ReturnType<typeof vi.fn>

  const accountSid = 'AC-account-123'
  const authToken = 'auth-token-abc'
  const phoneNumber = '+15551234567'

  beforeEach(() => {
    adapter = new TwilioSMSAdapter(accountSid, authToken, phoneNumber)
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
    it('parses basic SMS webhook fields', async () => {
      const form = new URLSearchParams({
        MessageSid: 'SM123',
        From: '+15559876543',
        To: '+15551234567',
        Body: 'Hello world',
        NumMedia: '0',
      })
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: form.toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })

      const result = await adapter.parseIncomingMessage(request)
      expect(result.channelType).toBe('sms')
      expect(result.externalId).toBe('SM123')
      expect(result.senderIdentifier).toBe('+15559876543')
      expect(result).not.toHaveProperty('senderIdentifierHash')
      expect(result.body).toBe('Hello world')
      expect(result.mediaUrls).toBeUndefined()
      expect(result.mediaTypes).toBeUndefined()
      expect(result.timestamp).toBeTruthy()
      expect(result.metadata?.to).toBe('+15551234567')
    })

    it('parses MMS webhook with media attachments', async () => {
      const form = new URLSearchParams({
        MessageSid: 'MM456',
        From: '+15559876543',
        To: '+15551234567',
        Body: 'Check this out',
        NumMedia: '2',
        MediaUrl0: 'https://example.com/image1.jpg',
        MediaContentType0: 'image/jpeg',
        MediaUrl1: 'https://example.com/audio.mp3',
        MediaContentType1: 'audio/mpeg',
      })
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: form.toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })

      const result = await adapter.parseIncomingMessage(request)
      expect(result.externalId).toBe('MM456')
      expect(result.body).toBe('Check this out')
      expect(result.mediaUrls).toEqual([
        'https://example.com/image1.jpg',
        'https://example.com/audio.mp3',
      ])
      expect(result.mediaTypes).toEqual(['image/jpeg', 'audio/mpeg'])
    })

    it('handles empty body gracefully', async () => {
      const form = new URLSearchParams({
        MessageSid: 'SM789',
        From: '+15559876543',
        NumMedia: '0',
      })
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: form.toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })

      const result = await adapter.parseIncomingMessage(request)
      expect(result.body).toBeUndefined()
    })

    it('leaves hashing to the router: same same phone, same senderIdentifier, no hash', async () => {
      const makeRequest = () =>
        new Request('https://example.com/webhook', {
          method: 'POST',
          body: new URLSearchParams({ MessageSid: 'SM1', From: '+15559876543', NumMedia: '0' }).toString(),
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
    it('rejects missing X-Twilio-Signature header', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: 'From=%2B15559876543&Body=Hello',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })
      const result = await adapter.validateWebhook(request)
      expect(result).toBe(false)
    })

    it('rejects invalid signature', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: 'From=%2B15559876543&Body=Hello',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Twilio-Signature': 'invalidsignature==',
        },
      })
      const result = await adapter.validateWebhook(request)
      expect(result).toBe(false)
    })

    it('accepts valid HMAC-SHA1 signature', async () => {
      const url = 'https://example.com/api/sms/incoming'
      const bodyStr = 'Body=Hello&From=%2B15559876543'
      const params = new URLSearchParams(bodyStr)

      let dataString = url
      const sortedEntries = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b))
      for (const [key, value] of sortedEntries) {
        dataString += key + value
      }

      const encoder = new TextEncoder()
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(authToken),
        { name: 'HMAC', hash: 'SHA-1' },
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
          'X-Twilio-Signature': signature,
        },
      })
      const result = await adapter.validateWebhook(request)
      expect(result).toBe(true)
    })

    it('handles multi-value parameters correctly in signature', async () => {
      const url = 'https://example.com/api/sms/incoming'
      const params = new URLSearchParams()
      params.append('Body', 'Hello')
      params.append('From', '+15559876543')
      params.append('From', '+15551111111')

      let dataString = url
      const sortedEntries = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b))
      for (const [key, value] of sortedEntries) {
        dataString += key + value
      }

      const encoder = new TextEncoder()
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(authToken),
        { name: 'HMAC', hash: 'SHA-1' },
        false,
        ['sign'],
      )
      const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(dataString))
      const signature = btoa(String.fromCharCode(...new Uint8Array(sig)))

      const request = new Request(url, {
        method: 'POST',
        body: params.toString(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Twilio-Signature': signature,
        },
      })
      const result = await adapter.validateWebhook(request)
      expect(result).toBe(true)
    })
  })

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends SMS via Twilio Messages API', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ sid: 'SM-out-123' }), { status: 200 }),
      )

      const result = await adapter.sendMessage({
        recipientIdentifier: '+15559876543',
        body: 'Hello from Llámenos',
        conversationId: 'conv-1',
      })

      expect(result.success).toBe(true)
      expect(result.externalId).toBe('SM-out-123')
      expect(fetchMock).toHaveBeenCalledTimes(1)

      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toContain(`/Accounts/${accountSid}/Messages.json`)
      expect(init?.method).toBe('POST')

      const body = new URLSearchParams(init?.body as string)
      expect(body.get('To')).toBe('+15559876543')
      expect(body.get('From')).toBe(phoneNumber)
      expect(body.get('Body')).toBe('Hello from Llámenos')
    })

    it('returns error on API failure', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ message: 'Invalid phone number' }), { status: 400 }),
      )

      const result = await adapter.sendMessage({
        recipientIdentifier: '+15559876543',
        body: 'Test',
        conversationId: 'conv-1',
      })

      expect(result.success).toBe(false)
      expect(result.error).toBe('Invalid phone number')
    })

    it('returns error on network failure', async () => {
      fetchMock.mockRejectedValue(new Error('Network timeout'))

      const result = await adapter.sendMessage({
        recipientIdentifier: '+15559876543',
        body: 'Test',
        conversationId: 'conv-1',
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('Network timeout')
    })

    it('returns error on network failure for sendMediaMessage', async () => {
      fetchMock.mockRejectedValue(new Error('Connection reset'))

      const result = await adapter.sendMediaMessage({
        recipientIdentifier: '+15559876543',
        body: 'Test',
        mediaUrl: 'https://example.com/photo.jpg',
        mediaType: 'image/jpeg',
        conversationId: 'conv-1',
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('Connection reset')
    })
  })

  // --- sendMediaMessage ---

  describe('sendMediaMessage', () => {
    it('sends MMS via Twilio Messages API with MediaUrl', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ sid: 'MM-out-456' }), { status: 200 }),
      )

      const result = await adapter.sendMediaMessage({
        recipientIdentifier: '+15559876543',
        body: 'Here is an image',
        mediaUrl: 'https://example.com/photo.jpg',
        mediaType: 'image/jpeg',
        conversationId: 'conv-1',
      })

      expect(result.success).toBe(true)
      expect(result.externalId).toBe('MM-out-456')

      const [, init] = fetchMock.mock.calls[0]
      const body = new URLSearchParams(init?.body as string)
      expect(body.get('MediaUrl')).toBe('https://example.com/photo.jpg')
      expect(body.get('Body')).toBe('Here is an image')
    })

    it('returns error when API returns non-ok', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ message: 'Media URL unreachable' }), { status: 400 }),
      )

      const result = await adapter.sendMediaMessage({
        recipientIdentifier: '+15559876543',
        body: '',
        mediaUrl: 'https://example.com/photo.jpg',
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
        new Response(JSON.stringify({ status: 'active', friendly_name: 'Test Account' }), { status: 200 }),
      )

      const status = await adapter.getChannelStatus()
      expect(status.connected).toBe(true)
      expect(status.details?.provider).toBe('twilio')
      expect(status.details?.channel).toBe('sms')
      expect(status.details?.accountStatus).toBe('active')
      expect(status.details?.accountName).toBe('Test Account')
      expect(status.details?.phoneNumber).toBe(phoneNumber)
    })

    it('returns disconnected when account API fails', async () => {
      fetchMock.mockResolvedValue(
        new Response('Unauthorized', { status: 401 }),
      )

      const status = await adapter.getChannelStatus()
      expect(status.connected).toBe(false)
      expect(status.error).toContain('401')
    })

    it('returns disconnected on network error', async () => {
      fetchMock.mockRejectedValue(new Error('Connection refused'))

      const status = await adapter.getChannelStatus()
      expect(status.connected).toBe(false)
      expect(status.error).toBe('Connection refused')
    })
  })

  // --- deleteMessage ---

  describe('deleteMessage', () => {
    it('calls DELETE on Twilio Messages API', async () => {
      fetchMock.mockResolvedValue(new Response(null, { status: 204 }))

      await adapter.deleteMessage('SM-del-123')

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toContain(`/Accounts/${accountSid}/Messages/SM-del-123.json`)
      expect(init?.method).toBe('DELETE')
    })

    it('throws when API returns error status', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ message: 'Message not found' }), { status: 404 }),
      )

      await expect(adapter.deleteMessage('SM-nonexistent')).rejects.toThrow('Failed to delete message SM-nonexistent: Twilio API returned 404')
    })

    it('throws on network failure', async () => {
      fetchMock.mockRejectedValue(new Error('Network error'))

      await expect(adapter.deleteMessage('SM-123')).rejects.toThrow('Network error')
    })
  })

  // --- parseStatusWebhook ---

  describe('parseStatusWebhook', () => {
    const makeStatusRequest = (params: Record<string, string>) => {
      const form = new URLSearchParams(params)
      return new Request('https://example.com/status', {
        method: 'POST',
        body: form.toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })
    }

    it('maps queued → pending', async () => {
      const request = makeStatusRequest({ MessageSid: 'SM1', MessageStatus: 'queued' })
      const result = await adapter.parseStatusWebhook(request)
      expect(result?.status).toBe('pending')
      expect(result?.externalId).toBe('SM1')
    })

    it('maps sent → sent', async () => {
      const request = makeStatusRequest({ MessageSid: 'SM2', MessageStatus: 'sent' })
      const result = await adapter.parseStatusWebhook(request)
      expect(result?.status).toBe('sent')
    })

    it('maps delivered → delivered', async () => {
      const request = makeStatusRequest({ MessageSid: 'SM3', MessageStatus: 'delivered' })
      const result = await adapter.parseStatusWebhook(request)
      expect(result?.status).toBe('delivered')
    })

    it('maps undelivered → failed with error info', async () => {
      const request = makeStatusRequest({
        MessageSid: 'SM4',
        MessageStatus: 'undelivered',
        ErrorCode: '30003',
        ErrorMessage: 'Landline or unreachable carrier',
      })
      const result = await adapter.parseStatusWebhook(request)
      expect(result?.status).toBe('failed')
      expect(result?.failureReason).toContain('30003')
    })

    it('maps failed → failed', async () => {
      const request = makeStatusRequest({ MessageSid: 'SM5', MessageStatus: 'failed' })
      const result = await adapter.parseStatusWebhook(request)
      expect(result?.status).toBe('failed')
    })

    it('returns null for unknown status', async () => {
      const request = makeStatusRequest({ MessageSid: 'SM6', MessageStatus: 'unknown_status' })
      const result = await adapter.parseStatusWebhook(request)
      expect(result).toBeNull()
    })

    it('returns null when MessageSid is missing', async () => {
      const request = makeStatusRequest({ MessageStatus: 'delivered' })
      const result = await adapter.parseStatusWebhook(request)
      expect(result).toBeNull()
    })
  })
})
