import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { TelegramAdapter } from '@worker/messaging/telegram/adapter'
import type { TelegramConfig } from '@shared/types'


const botConfig: TelegramConfig = {
  enabled: true,
  botToken: 'bot123:TestBotToken',
  webhookSecret: 'my-webhook-secret',
}

describe('TelegramAdapter', () => {
  let adapter: TelegramAdapter
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    adapter = new TelegramAdapter(botConfig)
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('channelType', () => {
    it('is telegram', () => {
      expect(adapter.channelType).toBe('telegram')
    })
  })

  // --- parseIncomingMessage ---

  describe('parseIncomingMessage', () => {
    const makeUpdate = (overrides: Record<string, unknown> = {}) => ({
      update_id: 100,
      message: {
        message_id: 42,
        from: {
          id: 987654321,
          is_bot: false,
          first_name: 'Test',
          last_name: 'User',
          username: 'testuser',
          language_code: 'en',
        },
        chat: {
          id: 987654321,
          type: 'private',
          first_name: 'Test',
          last_name: 'User',
        },
        date: 1700000000,
        text: 'Hello Telegram',
        ...overrides,
      },
    })

    it('parses a text message', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify(makeUpdate()),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseIncomingMessage(request)
      expect(result.channelType).toBe('telegram')
      expect(result.externalId).toBe('42')
      expect(result.senderIdentifier).toBe('987654321')
      expect(result).not.toHaveProperty('senderIdentifierHash')
      expect(result.body).toBe('Hello Telegram')
      expect(result.mediaUrls).toBeUndefined()
      expect(result.metadata?.chatId).toBe('987654321')
      expect(result.metadata?.chatType).toBe('private')
      expect(result.metadata?.username).toBe('testuser')
      expect(result.metadata?.firstName).toBe('Test')
      expect(result.metadata?.lastName).toBe('User')
      expect(result.metadata?.languageCode).toBe('en')
    })

    it('parses a photo message', async () => {
      const update = {
        update_id: 101,
        message: {
          message_id: 43,
          from: { id: 987654321, is_bot: false, first_name: 'Test' },
          chat: { id: 987654321, type: 'private' },
          date: 1700000001,
          caption: 'Photo caption',
          photo: [
            { file_id: 'small-photo-id', file_unique_id: 'uid1', width: 100, height: 100 },
            { file_id: 'large-photo-id', file_unique_id: 'uid2', width: 800, height: 600 },
          ],
        },
      }
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify(update),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseIncomingMessage(request)
      expect(result.body).toBe('Photo caption')
      // Uses the largest (last) photo
      expect(result.mediaUrls).toEqual(['telegram:file:large-photo-id'])
      expect(result.mediaTypes).toEqual(['image/jpeg'])
    })

    it('parses a voice message', async () => {
      const update = {
        update_id: 102,
        message: {
          message_id: 44,
          from: { id: 987654321, is_bot: false, first_name: 'Test' },
          chat: { id: 987654321, type: 'private' },
          date: 1700000002,
          voice: {
            file_id: 'voice-file-id',
            file_unique_id: 'voice-uid',
            duration: 15,
            mime_type: 'audio/ogg',
          },
        },
      }
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify(update),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseIncomingMessage(request)
      expect(result.body).toBeUndefined()
      expect(result.mediaUrls).toEqual(['telegram:file:voice-file-id'])
      expect(result.mediaTypes).toEqual(['audio/ogg'])
    })

    it('parses a document message', async () => {
      const update = {
        update_id: 103,
        message: {
          message_id: 45,
          from: { id: 987654321, is_bot: false, first_name: 'Test' },
          chat: { id: 987654321, type: 'private' },
          date: 1700000003,
          document: {
            file_id: 'doc-file-id',
            file_unique_id: 'doc-uid',
            file_name: 'report.pdf',
            mime_type: 'application/pdf',
          },
        },
      }
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify(update),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseIncomingMessage(request)
      expect(result.mediaUrls).toEqual(['telegram:file:doc-file-id'])
      expect(result.mediaTypes).toEqual(['application/pdf'])
    })

    it('parses an edited message with edited metadata', async () => {
      const update = {
        update_id: 104,
        edited_message: {
          message_id: 46,
          from: { id: 987654321, is_bot: false, first_name: 'Test' },
          chat: { id: 987654321, type: 'private' },
          date: 1700000000,
          edit_date: 1700000010,
          text: 'Edited text',
        },
      }
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify(update),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseIncomingMessage(request)
      expect(result.body).toBe('Edited text')
      expect(result.metadata?.edited).toBe('true')
    })

    it('throws when update has no message', async () => {
      const update = { update_id: 105 }
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify(update),
        headers: { 'Content-Type': 'application/json' },
      })

      await expect(adapter.parseIncomingMessage(request)).rejects.toThrow(
        'Update does not contain a message',
      )
    })

    it('leaves hashing to the router: same same user, same senderIdentifier, no hash', async () => {
      const makeRequest = () =>
        new Request('https://example.com/webhook', {
          method: 'POST',
          body: JSON.stringify({
            update_id: 1,
            message: {
              message_id: 1,
              from: { id: 987654321, is_bot: false, first_name: 'Test' },
              chat: { id: 987654321, type: 'private' },
              date: 1700000000,
              text: 'Hi',
            },
          }),
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
    it.each([undefined, '', '   '])('fails closed when webhookSecret is %j, even with a matching header', async (secret) => {
      const adapterNoSecret = new TelegramAdapter(
        { enabled: true, botToken: 'tok', webhookSecret: secret as unknown as string },
      )
      const unsigned = new Request('https://example.com/webhook', {
        method: 'POST',
        body: '{}',
        headers: { 'Content-Type': 'application/json' },
      })
      expect(await adapterNoSecret.validateWebhook(unsigned)).toBe(false)
      const emptyHeader = new Request('https://example.com/webhook', {
        method: 'POST',
        body: '{}',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': secret ?? '',
        },
      })
      expect(await adapterNoSecret.validateWebhook(emptyHeader)).toBe(false)
    })

    it('reports the missing secret in channel status instead of calling getMe', async () => {
      const adapterNoSecret = new TelegramAdapter(
        { enabled: true, botToken: 'tok', webhookSecret: '' },
      )
      const status = await adapterNoSecret.getChannelStatus()
      expect(status.connected).toBe(false)
      expect(status.error).toContain('webhook secret is required')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('refuses to register a webhook without a secret_token', async () => {
      const adapterNoSecret = new TelegramAdapter(
        { enabled: true, botToken: 'tok', webhookSecret: '' },
      )
      const result = await adapterNoSecret.registerWebhook('https://hotline.example/api/messaging/telegram/webhook')
      expect(result.ok).toBe(false)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('registers the webhook with the configured secret_token', async () => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      const url = 'https://hotline.example/api/messaging/telegram/webhook'
      const result = await adapter.registerWebhook(url)
      expect(result).toEqual({ ok: true })
      const [calledUrl, init] = fetchMock.mock.calls[0]
      expect(String(calledUrl)).toContain('/setWebhook')
      expect(JSON.parse((init as RequestInit).body as string)).toEqual({ url, secret_token: 'my-webhook-secret' })
    })

    it('surfaces a Telegram setWebhook rejection', async () => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: false, description: 'Unauthorized' }), { status: 401 }))
      const result = await adapter.registerWebhook('https://hotline.example/api/messaging/telegram/webhook')
      expect(result).toEqual({ ok: false, error: 'Unauthorized' })
    })

    it('rejects missing X-Telegram-Bot-Api-Secret-Token header', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: '{}',
        headers: { 'Content-Type': 'application/json' },
      })
      expect(await adapter.validateWebhook(request)).toBe(false)
    })

    it('rejects wrong secret token', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: '{}',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': 'wrong-secret',
        },
      })
      expect(await adapter.validateWebhook(request)).toBe(false)
    })

    it('accepts correct secret token', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: '{}',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': 'my-webhook-secret',
        },
      })
      expect(await adapter.validateWebhook(request)).toBe(true)
    })
  })

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends text message via Bot API', async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({ ok: true, result: { message_id: 99, chat: {}, date: 1700000000, text: 'Reply' } }),
          { status: 200 },
        ),
      )

      const result = await adapter.sendMessage({
        recipientIdentifier: '987654321',
        body: 'Hello from bot',
        conversationId: 'conv-1',
      })

      expect(result.success).toBe(true)
      expect(result.externalId).toBe('99')
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toContain('/sendMessage')
      const body = JSON.parse(init?.body as string)
      expect(body.chat_id).toBe(987654321)
      expect(body.text).toBe('Hello from bot')
    })

    it('returns error for non-numeric chat ID', async () => {
      const result = await adapter.sendMessage({
        recipientIdentifier: 'not-a-number',
        body: 'Test',
        conversationId: 'conv-1',
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid Telegram chat ID')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('returns error when Bot API returns ok=false', async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }),
          { status: 200 },
        ),
      )

      const result = await adapter.sendMessage({
        recipientIdentifier: '987654321',
        body: 'Test',
        conversationId: 'conv-1',
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('chat not found')
    })

    it('returns error on network failure', async () => {
      fetchMock.mockRejectedValue(new Error('Telegram unreachable'))

      const result = await adapter.sendMessage({
        recipientIdentifier: '987654321',
        body: 'Test',
        conversationId: 'conv-1',
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('Telegram unreachable')
    })
  })

  // --- sendMediaMessage ---

  describe('sendMediaMessage', () => {
    const makeSuccessResponse = () =>
      new Response(
        JSON.stringify({ ok: true, result: { message_id: 100, chat: {}, date: 1700000000 } }),
        { status: 200 },
      )

    it('routes image/* to sendPhoto', async () => {
      fetchMock.mockResolvedValue(makeSuccessResponse())

      const result = await adapter.sendMediaMessage({
        recipientIdentifier: '987654321',
        body: 'Nice photo',
        mediaUrl: 'https://example.com/photo.jpg',
        mediaType: 'image/jpeg',
        conversationId: 'conv-1',
      })

      expect(result.success).toBe(true)
      const [url] = fetchMock.mock.calls[0]
      expect(url).toContain('/sendPhoto')
    })

    it('routes audio/ogg to sendVoice', async () => {
      fetchMock.mockResolvedValue(makeSuccessResponse())

      await adapter.sendMediaMessage({
        recipientIdentifier: '987654321',
        body: '',
        mediaUrl: 'https://example.com/voice.ogg',
        mediaType: 'audio/ogg',
        conversationId: 'conv-1',
      })

      const [url] = fetchMock.mock.calls[0]
      expect(url).toContain('/sendVoice')
    })

    it('routes other media to sendDocument', async () => {
      fetchMock.mockResolvedValue(makeSuccessResponse())

      await adapter.sendMediaMessage({
        recipientIdentifier: '987654321',
        body: '',
        mediaUrl: 'https://example.com/report.pdf',
        mediaType: 'application/pdf',
        conversationId: 'conv-1',
      })

      const [url] = fetchMock.mock.calls[0]
      expect(url).toContain('/sendDocument')
    })

    it('returns error for non-numeric chat ID', async () => {
      const result = await adapter.sendMediaMessage({
        recipientIdentifier: 'not-a-number',
        body: '',
        mediaUrl: 'https://example.com/photo.jpg',
        mediaType: 'image/jpeg',
        conversationId: 'conv-1',
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid Telegram chat ID')
    })
  })

  // --- getChannelStatus ---

  describe('getChannelStatus', () => {
    it('returns connected with bot info when getMe succeeds', async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            result: {
              id: 111111111,
              is_bot: true,
              first_name: 'Test Bot',
              username: 'testbot',
            },
          }),
          { status: 200 },
        ),
      )

      const status = await adapter.getChannelStatus()
      expect(status.connected).toBe(true)
      expect(status.details?.botId).toBe(111111111)
      expect(status.details?.botUsername).toBe('testbot')
      expect(status.details?.botName).toBe('Test Bot')
    })

    it('returns disconnected when getMe fails', async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({ ok: false, description: 'Unauthorized' }),
          { status: 200 },
        ),
      )

      const status = await adapter.getChannelStatus()
      expect(status.connected).toBe(false)
      expect(status.error).toContain('Unauthorized')
    })

    it('returns disconnected on network error', async () => {
      fetchMock.mockRejectedValue(new Error('Connection timed out'))

      const status = await adapter.getChannelStatus()
      expect(status.connected).toBe(false)
      expect(status.error).toContain('Connection timed out')
    })
  })
})
