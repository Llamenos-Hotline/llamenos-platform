import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { RCSAdapter } from '@worker/messaging/rcs/adapter'
import { RBMClient } from '@worker/messaging/rcs/rbm-client'
import type { RCSConfig } from '@shared/types'


// Minimal valid-looking service account key (for JSON.parse — never used for real signing)
const FAKE_SERVICE_ACCOUNT = JSON.stringify({
  type: 'service_account',
  project_id: 'test-project',
  private_key_id: 'key-id',
  private_key: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n', // gitleaks:allow
  client_email: 'test@test-project.iam.gserviceaccount.com',
  client_id: '123456789',
  auth_uri: 'https://accounts.google.com/o/oauth2/auth',
  token_uri: 'https://oauth2.googleapis.com/token',
})

const rcsConfig: RCSConfig = {
  agentId: 'test-agent',
  serviceAccountKey: FAKE_SERVICE_ACCOUNT,
  webhookSecret: 'rcs-webhook-secret',
  fallbackToSms: false,
}

// Mock RBMClient to avoid real JWT/OAuth calls
vi.mock('@worker/messaging/rcs/rbm-client', () => {
  const RBMClientMock = vi.fn()
  RBMClientMock.prototype.sendMessage = vi.fn()
  RBMClientMock.prototype.checkStatus = vi.fn()
  return { RBMClient: RBMClientMock }
})

describe('RCSAdapter', () => {
  let adapter: RCSAdapter
  let rbmClientMock: {
    sendMessage: ReturnType<typeof vi.fn>
    checkStatus: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    vi.clearAllMocks()
    adapter = new RCSAdapter(rcsConfig)
    // Get the mocked instance
    const MockedRBMClient = vi.mocked(RBMClient)
    rbmClientMock = MockedRBMClient.mock.instances[0] as unknown as typeof rbmClientMock
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('channelType', () => {
    it('is rcs', () => {
      expect(adapter.channelType).toBe('rcs')
    })
  })

  // --- parseIncomingMessage ---

  describe('parseIncomingMessage', () => {
    it('parses a text message', async () => {
      const payload = {
        agentId: 'test-agent',
        senderId: '+15559876543',
        message: {
          messageId: 'RCS-MSG-001',
          text: 'Hello via RCS',
          sendTime: '2024-01-01T12:00:00Z',
        },
      }
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseIncomingMessage(request)
      expect(result.channelType).toBe('rcs')
      expect(result.externalId).toBe('RCS-MSG-001')
      expect(result.senderIdentifier).toBe('+15559876543')
      expect(result).not.toHaveProperty('senderIdentifierHash')
      expect(result.body).toBe('Hello via RCS')
      expect(result.timestamp).toBe('2024-01-01T12:00:00Z')
      expect(result.metadata?.agentId).toBe('test-agent')
    })

    it('parses a message with media file', async () => {
      const payload = {
        agentId: 'test-agent',
        senderId: '+15559876543',
        message: {
          messageId: 'RCS-MSG-002',
          sendTime: '2024-01-01T12:00:00Z',
          userFile: {
            payload: {
              fileUri: 'https://storage.googleapis.com/file.jpg',
              mimeType: 'image/jpeg',
            },
          },
        },
      }
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseIncomingMessage(request)
      expect(result.mediaUrls).toEqual(['https://storage.googleapis.com/file.jpg'])
      expect(result.mediaTypes).toEqual(['image/jpeg'])
    })

    it('parses a suggestion response', async () => {
      const payload = {
        agentId: 'test-agent',
        senderId: '+15559876543',
        message: {
          messageId: 'RCS-MSG-003',
          sendTime: '2024-01-01T12:00:00Z',
          suggestionResponse: {
            text: 'Yes',
            postbackData: 'confirm_yes',
            type: 'REPLY',
          },
        },
      }
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseIncomingMessage(request)
      expect(result.body).toBe('Yes')
      expect(result.metadata?.postbackData).toBe('confirm_yes')
      expect(result.metadata?.suggestionType).toBe('REPLY')
    })

    it('parses a location message', async () => {
      const payload = {
        agentId: 'test-agent',
        senderId: '+15559876543',
        message: {
          messageId: 'RCS-MSG-004',
          sendTime: '2024-01-01T12:00:00Z',
          location: {
            latitude: 40.7128,
            longitude: -74.006,
            label: 'New York',
          },
        },
      }
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseIncomingMessage(request)
      expect(result.metadata?.locationLat).toBe('40.7128')
      expect(result.metadata?.locationLng).toBe('-74.006')
      expect(result.metadata?.locationLabel).toBe('New York')
    })

    it('throws when webhook has no message content', async () => {
      const payload = {
        agentId: 'test-agent',
        senderId: '+15559876543',
        event: { eventType: 'DELIVERED', eventId: 'evt-1', sendTime: '2024-01-01T12:00:00Z' },
      }
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
      })

      await expect(adapter.parseIncomingMessage(request)).rejects.toThrow(
        'RCS webhook has no message content',
      )
    })
  })

  // --- validateWebhook ---

  describe('validateWebhook', () => {
    it.each([undefined, '', '   '])('fails closed when webhookSecret is %j, even with a Bearer header', async (secret) => {
      const adapterNoSecret = new RCSAdapter(
        { ...rcsConfig, webhookSecret: secret as unknown as string },
      )
      const unsigned = new Request('https://example.com/webhook', {
        method: 'POST',
        body: '{}',
        headers: { 'Content-Type': 'application/json' },
      })
      expect(await adapterNoSecret.validateWebhook(unsigned)).toBe(false)
      // A forger who guesses the empty secret must not get in either.
      const emptyBearer = new Request('https://example.com/webhook', {
        method: 'POST',
        body: '{}',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret ?? ''}` },
      })
      expect(await adapterNoSecret.validateWebhook(emptyBearer)).toBe(false)
    })

    it('reports the missing secret in channel status instead of probing RBM', async () => {
      const adapterNoSecret = new RCSAdapter(
        { ...rcsConfig, webhookSecret: '' },
      )
      const status = await adapterNoSecret.getChannelStatus()
      expect(status.connected).toBe(false)
      expect(status.error).toContain('webhook secret is required')
    })

    it('rejects missing Authorization header', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: '{}',
        headers: { 'Content-Type': 'application/json' },
      })
      expect(await adapter.validateWebhook(request)).toBe(false)
    })

    it('rejects non-Bearer Authorization', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: '{}',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Basic dXNlcjpwYXNz',
        },
      })
      expect(await adapter.validateWebhook(request)).toBe(false)
    })

    it('rejects wrong Bearer token', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: '{}',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer wrong-token',
        },
      })
      expect(await adapter.validateWebhook(request)).toBe(false)
    })

    it('accepts correct Bearer token', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: '{}',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer rcs-webhook-secret',
        },
      })
      expect(await adapter.validateWebhook(request)).toBe(true)
    })
  })

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends text message via RBM API', async () => {
      rbmClientMock.sendMessage.mockResolvedValue({
        name: 'phones/15559876543/agentMessages/RCS-OUT-001',
      })

      const result = await adapter.sendMessage({
        recipientIdentifier: '+15559876543',
        body: 'Hello via RCS',
        conversationId: 'conv-1',
      })

      expect(result.success).toBe(true)
      expect(result.externalId).toBe('phones/15559876543/agentMessages/RCS-OUT-001')
      expect(rbmClientMock.sendMessage).toHaveBeenCalledWith('+15559876543', { text: 'Hello via RCS' })
    })

    it('returns error when RBM API returns error', async () => {
      rbmClientMock.sendMessage.mockResolvedValue({
        error: { message: 'Phone number not RCS capable', code: 400 },
      })

      const result = await adapter.sendMessage({
        recipientIdentifier: '+15559876543',
        body: 'Test',
        conversationId: 'conv-1',
      })

      expect(result.success).toBe(false)
      expect(result.error).toBe('Phone number not RCS capable')
    })

    it('returns error on network failure', async () => {
      rbmClientMock.sendMessage.mockRejectedValue(new Error('OAuth token fetch failed'))

      const result = await adapter.sendMessage({
        recipientIdentifier: '+15559876543',
        body: 'Test',
        conversationId: 'conv-1',
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('OAuth token fetch failed')
    })
  })

  // --- sendMediaMessage ---

  describe('sendMediaMessage', () => {
    it('sends media message with contentInfo', async () => {
      rbmClientMock.sendMessage.mockResolvedValue({
        name: 'phones/15559876543/agentMessages/RCS-MEDIA-001',
      })

      const result = await adapter.sendMediaMessage({
        recipientIdentifier: '+15559876543',
        body: 'Image caption',
        mediaUrl: 'https://example.com/photo.jpg',
        mediaType: 'image/jpeg',
        conversationId: 'conv-1',
      })

      expect(result.success).toBe(true)
      expect(result.externalId).toBe('phones/15559876543/agentMessages/RCS-MEDIA-001')
      expect(rbmClientMock.sendMessage).toHaveBeenCalledWith(
        '+15559876543',
        expect.objectContaining({
          contentInfo: expect.objectContaining({ fileUrl: 'https://example.com/photo.jpg' }),
        }),
      )
    })

    it('returns error when media API returns error', async () => {
      rbmClientMock.sendMessage.mockResolvedValue({
        error: { message: 'Media URL not accessible', code: 400 },
      })

      const result = await adapter.sendMediaMessage({
        recipientIdentifier: '+15559876543',
        body: '',
        mediaUrl: 'https://bad.example.com/photo.jpg',
        mediaType: 'image/jpeg',
        conversationId: 'conv-1',
      })

      expect(result.success).toBe(false)
      expect(result.error).toBe('Media URL not accessible')
    })
  })

  // --- getChannelStatus ---

  describe('getChannelStatus', () => {
    it('returns connected when RBM agent is reachable', async () => {
      rbmClientMock.checkStatus.mockResolvedValue({
        connected: true,
        details: { agentId: 'test-agent' },
      })

      const status = await adapter.getChannelStatus()
      expect(status.connected).toBe(true)
      expect(status.details?.agentId).toBe('test-agent')
    })

    it('returns disconnected on auth failure', async () => {
      rbmClientMock.checkStatus.mockResolvedValue({
        connected: false,
        error: 'Invalid service account credentials',
      })

      const status = await adapter.getChannelStatus()
      expect(status.connected).toBe(false)
      expect(status.error).toBe('Invalid service account credentials')
    })
  })

  // --- parseStatusWebhook ---

  describe('parseStatusWebhook', () => {
    const makeEventRequest = (eventType: string) =>
      new Request('https://example.com/status', {
        method: 'POST',
        body: JSON.stringify({
          agentId: 'test-agent',
          senderId: '+15559876543',
          event: {
            eventType,
            eventId: 'EVT-001',
            sendTime: '2024-01-01T12:00:00Z',
          },
        }),
        headers: { 'Content-Type': 'application/json' },
      })

    it('maps DELIVERED → delivered', async () => {
      const result = await adapter.parseStatusWebhook(makeEventRequest('DELIVERED'))
      expect(result).not.toBeNull()
      if (!result || Array.isArray(result)) throw new Error('Expected single result')
      expect(result.status).toBe('delivered')
      expect(result.externalId).toBe('EVT-001')
      expect(result.timestamp).toBe('2024-01-01T12:00:00Z')
    })

    it('maps READ → read', async () => {
      const result = await adapter.parseStatusWebhook(makeEventRequest('READ'))
      expect(result).not.toBeNull()
      if (!result || Array.isArray(result)) throw new Error('Expected single result')
      expect(result.status).toBe('read')
    })

    it('returns null for unknown event type', async () => {
      const result = await adapter.parseStatusWebhook(makeEventRequest('TYPING'))
      expect(result).toBeNull()
    })

    it('returns null when event field is missing', async () => {
      const request = new Request('https://example.com/status', {
        method: 'POST',
        body: JSON.stringify({
          agentId: 'test-agent',
          senderId: '+15559876543',
          message: { messageId: 'MSG-1', text: 'hello', sendTime: '2024-01-01T12:00:00Z' },
        }),
        headers: { 'Content-Type': 'application/json' },
      })
      const result = await adapter.parseStatusWebhook(request)
      expect(result).toBeNull()
    })
  })
})
