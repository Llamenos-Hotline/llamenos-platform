import { timingSafeEqual } from 'node:crypto'
import type { TelegramConfig } from '@shared/types'
import { hashPhone } from '../../lib/crypto'
import { createLogger } from '../../lib/logger'

const logger = createLogger('messaging.telegram')
import type {
  MessagingAdapter,
  IncomingMessage,
  SendMessageParams,
  SendMediaParams,
  SendResult,
  ChannelStatus,
} from '../adapter'
import { TelegramBotClient } from './client'
import type { TelegramUpdate } from './types'

/**
 * TelegramAdapter — MessagingAdapter implementation for Telegram.
 *
 * Uses the Telegram Bot API directly (no bridge container needed).
 * Inbound messages arrive as webhook POSTs containing Update objects.
 * Outbound messages are sent via the Bot API HTTP methods.
 */
export class TelegramAdapter implements MessagingAdapter {
  readonly channelType = 'telegram' as const

  private readonly client: TelegramBotClient
  private readonly webhookSecret: string | undefined
  private readonly hmacSecret: string

  constructor(config: TelegramConfig, hmacSecret: string) {
    this.client = new TelegramBotClient(config.botToken)
    this.webhookSecret = config.webhookSecret
    this.hmacSecret = hmacSecret
  }

  /**
   * Parse an incoming Telegram Update webhook into a normalized IncomingMessage.
   *
   * Handles text messages, voice messages, photos, and documents.
   * Voice messages include the file_id for downstream transcription via getFile.
   */
  async parseIncomingMessage(request: Request): Promise<IncomingMessage> {
    const raw = await request.json() as TelegramUpdate

    // Accept both new messages and edited messages
    const message = raw.message ?? raw.edited_message
    if (!message) {
      throw new Error('Update does not contain a message')
    }

    const from = message.from
    if (!from) {
      throw new Error('Message has no sender (from field)')
    }

    // Use Telegram user ID as the stable sender identifier
    const senderIdentifier = String(from.id)
    // HMAC hash the user ID for privacy-preserving storage
    const senderIdentifierHash = hashPhone(senderIdentifier, this.hmacSecret)

    // Extract text content: prefer text, fall back to caption (for media messages)
    const body = message.text ?? message.caption ?? undefined

    // Extract attachments
    const mediaUrls: string[] = []
    const mediaTypes: string[] = []

    if (message.voice) {
      // Voice messages: store file_id as URL — downstream uses getFile to download
      mediaUrls.push(`telegram:file:${message.voice.file_id}`)
      mediaTypes.push(message.voice.mime_type ?? 'audio/ogg')
    }

    if (message.photo && message.photo.length > 0) {
      // Photos come in multiple sizes; use the largest (last in array)
      const largest = message.photo[message.photo.length - 1]
      mediaUrls.push(`telegram:file:${largest.file_id}`)
      mediaTypes.push('image/jpeg') // Telegram always serves photos as JPEG
    }

    if (message.document) {
      mediaUrls.push(`telegram:file:${message.document.file_id}`)
      mediaTypes.push(message.document.mime_type ?? 'application/octet-stream')
    }

    // Build metadata from available fields
    const metadata: Record<string, string> = {
      chatId: String(message.chat.id),
      chatType: message.chat.type,
    }
    if (from.username) metadata.username = from.username
    if (from.first_name) metadata.firstName = from.first_name
    if (from.last_name) metadata.lastName = from.last_name
    if (from.language_code) metadata.languageCode = from.language_code
    if (raw.edited_message) metadata.edited = 'true'

    return {
      channelType: 'telegram',
      externalId: String(message.message_id),
      senderIdentifier,
      senderIdentifierHash,
      body,
      mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
      mediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
      timestamp: new Date(message.date * 1000).toISOString(),
      metadata,
    }
  }

  /**
   * Validate the webhook request by checking the X-Telegram-Bot-Api-Secret-Token header.
   *
   * When a secret_token is set via setWebhook, Telegram includes it in every
   * webhook request as this header. Uses constant-time comparison.
   */
  async validateWebhook(request: Request): Promise<boolean> {
    if (!this.webhookSecret) {
      logger.warn('Accepting unauthenticated Telegram webhook — no webhookSecret configured')
      return true
    }

    const token = request.headers.get('X-Telegram-Bot-Api-Secret-Token')
    if (!token) return false

    return constantTimeEqual(token, this.webhookSecret)
  }

  /**
   * Send a text message to a Telegram chat.
   */
  async sendMessage(params: SendMessageParams): Promise<SendResult> {
    try {
      const chatId = Number(params.recipientIdentifier)
      if (Number.isNaN(chatId)) {
        return { success: false, error: 'Invalid Telegram chat ID (must be numeric)' }
      }

      const result = await this.client.sendMessage(chatId, params.body)
      if (!result.ok) {
        return { success: false, error: result.error }
      }

      return {
        success: true,
        externalId: result.result ? String(result.result.message_id) : undefined,
      }
    } catch (err) {
      return {
        success: false,
        error: `Telegram send failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  /**
   * Send a media message to a Telegram chat.
   *
   * Routes to the appropriate Telegram method based on media MIME type:
   * - image/* -> sendPhoto
   * - audio/ogg -> sendVoice
   * - everything else -> sendDocument
   */
  async sendMediaMessage(params: SendMediaParams): Promise<SendResult> {
    try {
      const chatId = Number(params.recipientIdentifier)
      if (Number.isNaN(chatId)) {
        return { success: false, error: 'Invalid Telegram chat ID (must be numeric)' }
      }

      let result: { ok: boolean; result?: { message_id: number }; error?: string }

      if (params.mediaType.startsWith('image/')) {
        result = await this.client.sendPhoto(chatId, params.mediaUrl, params.body || undefined)
      } else if (params.mediaType === 'audio/ogg' || params.mediaType.startsWith('audio/')) {
        result = await this.client.sendVoice(chatId, params.mediaUrl)
      } else {
        result = await this.client.sendDocument(chatId, params.mediaUrl, params.body || undefined)
      }

      if (!result.ok) {
        return { success: false, error: result.error }
      }

      return {
        success: true,
        externalId: result.result ? String(result.result.message_id) : undefined,
      }
    } catch (err) {
      return {
        success: false,
        error: `Telegram media send failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  /**
   * Check if the bot is properly configured by calling getMe.
   */
  async getChannelStatus(): Promise<ChannelStatus> {
    try {
      const result = await this.client.getMe()
      if (!result.ok || !result.result) {
        return {
          connected: false,
          error: result.error ?? 'getMe returned unsuccessful response',
        }
      }

      return {
        connected: true,
        details: {
          botId: result.result.id,
          botUsername: result.result.username,
          botName: result.result.first_name,
        },
      }
    } catch (err) {
      return {
        connected: false,
        error: `Telegram unreachable: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }
}

/**
 * Constant-time string comparison to prevent timing attacks on webhook secrets.
 * Delegates to Node's built-in timingSafeEqual after encoding to UTF-8 buffers.
 * Returns false immediately when lengths differ (the length itself is not secret here
 * since HMAC outputs are always the same length for valid tokens).
 */
function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}
