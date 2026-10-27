/**
 * Tests for TwilioSMSAdapter error handling fixes.
 * Verifies that sendMessage and sendMediaMessage catch network errors
 * (matching behavior of Plivo, Vonage, and other adapters).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { TwilioSMSAdapter } from '@worker/messaging/sms/twilio'


describe('TwilioSMSAdapter — error handling (bug fixes)', () => {
  let adapter: TwilioSMSAdapter
  let fetchMock: ReturnType<typeof vi.fn>
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    adapter = new TwilioSMSAdapter('AC-account-123', 'auth-token-abc', '+15551234567')
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  describe('sendMessage', () => {
    it('returns failure result on network error instead of throwing', async () => {
      fetchMock.mockRejectedValue(new Error('Network timeout'))

      const result = await adapter.sendMessage({
        recipientIdentifier: '+15559876543',
        body: 'Test',
        conversationId: 'conv-1',
      })

      expect(result.success).toBe(false)
      expect(result.error).toBe('Network timeout')
    })

    it('returns failure result on non-Error thrown values', async () => {
      fetchMock.mockRejectedValue('string error')

      const result = await adapter.sendMessage({
        recipientIdentifier: '+15559876543',
        body: 'Test',
        conversationId: 'conv-1',
      })

      expect(result.success).toBe(false)
      expect(result.error).toBe('Unknown error sending Twilio SMS')
    })
  })

  describe('sendMediaMessage', () => {
    it('returns failure result on network error instead of throwing', async () => {
      fetchMock.mockRejectedValue(new Error('DNS resolution failed'))

      const result = await adapter.sendMediaMessage({
        recipientIdentifier: '+15559876543',
        body: 'Check this',
        mediaUrl: 'https://example.com/image.jpg',
        mediaType: 'image/jpeg',
        conversationId: 'conv-1',
      })

      expect(result.success).toBe(false)
      expect(result.error).toBe('DNS resolution failed')
    })
  })

  describe('deleteMessage', () => {
    it('throws on non-2xx response', async () => {
      fetchMock.mockResolvedValue(new Response(null, { status: 404 }))

      await expect(adapter.deleteMessage('SM123')).rejects.toThrow(
        'Failed to delete message SM123: Twilio API returned 404',
      )
    })

    it('succeeds on 2xx response', async () => {
      fetchMock.mockResolvedValue(new Response(null, { status: 204 }))

      await expect(adapter.deleteMessage('SM123')).resolves.toBeUndefined()
    })
  })
})
