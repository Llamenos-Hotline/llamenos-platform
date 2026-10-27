import type {
  MessagingAdapter,
  IncomingMessage,
  SendMessageParams,
  SendMediaParams,
  SendResult,
  ChannelStatus,
  MessageStatusUpdate,
} from '../adapter'
import type { SignalConfig } from '@shared/types'
import type { MessageDeliveryStatus } from '../../types'
import type {
  SignalWebhookPayload,
  SignalSendRequest,
  SignalSendResponse,
  SignalAboutResponse,
  SignalReaction,
} from './types'
import { timingSafeEqual } from 'node:crypto'
import { safeFetch } from '../../lib/safe-fetch'

/**
 * SignalAdapter — MessagingAdapter implementation for the Signal channel.
 *
 * Communicates with a signal-cli-rest-api bridge instance to send/receive
 * Signal messages. The bridge handles the Signal protocol; this adapter
 * normalizes its HTTP API into the MessagingAdapter interface.
 */
export class SignalAdapter implements MessagingAdapter {
  readonly channelType = 'signal' as const

  private readonly bridgeUrl: string
  private readonly bridgeApiKey: string
  private readonly webhookSecret: string
  private readonly registeredNumber: string

  constructor(config: SignalConfig) {
    // Strip trailing slash from bridge URL for consistent path construction
    this.bridgeUrl = config.bridgeUrl.replace(/\/+$/, '')
    this.bridgeApiKey = config.bridgeApiKey
    this.webhookSecret = config.webhookSecret
    this.registeredNumber = config.registeredNumber
  }

  /**
   * Parse an incoming signal-cli-rest-api webhook into a normalized IncomingMessage.
   */
  async parseIncomingMessage(request: Request): Promise<IncomingMessage> {
    const payload = await request.json() as SignalWebhookPayload
    const { envelope } = payload

    const source = envelope.source
    const sourceUuid = envelope.sourceUuid
    // Use Signal UUID as the sender identifier when available, fall back to phone
    const senderIdentifier = sourceUuid ?? source

    const dataMessage = envelope.dataMessage
    const body = dataMessage?.message ?? undefined

    // Extract attachment URLs and MIME types
    const attachments = dataMessage?.attachments
    const mediaUrls: string[] = []
    const mediaTypes: string[] = []
    if (attachments && attachments.length > 0) {
      for (const att of attachments) {
        // signal-cli-rest-api serves attachments at /v1/attachments/{id}
        mediaUrls.push(`${this.bridgeUrl}/v1/attachments/${att.id}`)
        mediaTypes.push(att.contentType)
      }
    }

    // Build metadata from available envelope fields
    const metadata: Record<string, string> = {}
    if (source) {
      metadata['source'] = source
    }
    if (sourceUuid) {
      metadata['sourceUuid'] = sourceUuid
    }
    if (envelope.sourceName) {
      metadata['sourceName'] = envelope.sourceName
    }
    if (envelope.sourceDevice !== undefined) {
      metadata['sourceDevice'] = String(envelope.sourceDevice)
    }
    if (dataMessage?.groupInfo) {
      metadata['groupId'] = dataMessage.groupInfo.groupId
    }

    return {
      channelType: 'signal',
      externalId: String(envelope.timestamp),
      senderIdentifier,
      aliases: sourceUuid && source ? [source] : undefined,
      body,
      mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
      mediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
      timestamp: new Date(envelope.timestamp).toISOString(),
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    }
  }

  /**
   * Validate the webhook request by checking the Authorization bearer token.
   * Uses constant-time comparison to prevent timing attacks.
   */
  async validateWebhook(request: Request): Promise<boolean> {
    const authHeader = request.headers.get('Authorization')
    if (!authHeader) {
      return false
    }

    const parts = authHeader.split(' ')
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      return false
    }

    const token = parts[1]
    const tokenBuf = Buffer.from(token)
    const secretBuf = Buffer.from(this.webhookSecret)
    if (tokenBuf.length !== secretBuf.length) return false
    return timingSafeEqual(tokenBuf, secretBuf)
  }

  /**
   * Send a text message via the signal-cli-rest-api bridge.
   */
  async sendMessage(params: SendMessageParams): Promise<SendResult> {
    const sendRequest: SignalSendRequest = {
      number: this.registeredNumber,
      recipients: [params.recipientIdentifier],
      message: params.body,
    }

    try {
      const response = await safeFetch(`${this.bridgeUrl}/v2/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.bridgeApiKey}`,
        },
        body: JSON.stringify(sendRequest),
        timeoutMs: 10_000,
        ssrfGuard: false,
      })

      if (!response.ok) {
        const errorText = await response.text()
        return {
          success: false,
          error: `Signal bridge returned ${response.status}: ${errorText}`,
        }
      }

      const result = await response.json() as SignalSendResponse
      return {
        success: true,
        externalId: String(result.timestamp),
      }
    } catch (err) {
      return {
        success: false,
        error: `Signal bridge request failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  /**
   * Send a message with a media attachment via the signal-cli-rest-api bridge.
   * Downloads the media from the provided URL, base64-encodes it, and includes
   * it in the send request as a base64 attachment.
   */
  async sendMediaMessage(params: SendMediaParams): Promise<SendResult> {
    try {
      // Download the media from the provided URL
      const mediaResponse = await safeFetch(params.mediaUrl, { timeoutMs: 60_000, ssrfGuard: true })
      if (!mediaResponse.ok) {
        return {
          success: false,
          error: `Failed to download media from ${params.mediaUrl}: ${mediaResponse.status}`,
        }
      }

      const mediaBuffer = await mediaResponse.arrayBuffer()
      const base64Data = uint8ArrayToBase64(new Uint8Array(mediaBuffer))

      // Format: data:{mimeType};base64,{data} as expected by signal-cli-rest-api
      const base64Attachment = `data:${params.mediaType};base64,${base64Data}`

      const sendRequest: SignalSendRequest = {
        number: this.registeredNumber,
        recipients: [params.recipientIdentifier],
        message: params.body,
        base64_attachments: [base64Attachment],
      }

      const response = await safeFetch(`${this.bridgeUrl}/v2/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.bridgeApiKey}`,
        },
        body: JSON.stringify(sendRequest),
        timeoutMs: 10_000,
        ssrfGuard: false,
      })

      if (!response.ok) {
        const errorText = await response.text()
        return {
          success: false,
          error: `Signal bridge returned ${response.status}: ${errorText}`,
        }
      }

      const result = await response.json() as SignalSendResponse
      return {
        success: true,
        externalId: String(result.timestamp),
      }
    } catch (err) {
      return {
        success: false,
        error: `Signal media send failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  /**
   * Check the Signal bridge status by querying its /v1/about endpoint.
   */
  async getChannelStatus(): Promise<ChannelStatus> {
    try {
      const response = await safeFetch(`${this.bridgeUrl}/v1/about`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.bridgeApiKey}`,
        },
        timeoutMs: 10_000,
        ssrfGuard: false,
      })

      if (!response.ok) {
        return {
          connected: false,
          error: `Signal bridge returned ${response.status}`,
        }
      }

      const about = await response.json() as SignalAboutResponse
      return {
        connected: true,
        details: {
          signalCliVersion: about.versions['signal-cli'],
          apiVersion: about.versions['signal-cli-rest-api'],
          mode: about.mode,
          registeredNumber: about.number ?? this.registeredNumber,
        },
      }
    } catch (err) {
      return {
        connected: false,
        error: `Signal bridge unreachable: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  /**
   * Parse Signal receipt messages (delivered, read) into normalized status updates.
   * signal-cli-rest-api sends receiptMessage webhooks when the recipient's device
   * acknowledges delivery or read status.
   *
   * Returns an array since Signal receipts can batch-acknowledge multiple messages.
   */
  async parseStatusWebhook(request: Request): Promise<MessageStatusUpdate[]> {
    try {
      const payload = await request.clone().json() as SignalWebhookPayload
      const { envelope } = payload

      // Handle receipt messages (delivery/read receipts)
      if (envelope.receiptMessage) {
        const { type, timestamps } = envelope.receiptMessage
        if (!timestamps || timestamps.length === 0) return []

        // Map Signal receipt type to normalized status
        const statusMap: Record<string, MessageDeliveryStatus> = {
          'DELIVERY': 'delivered',
          'READ': 'read',
        }

        const normalizedStatus = statusMap[type.toUpperCase()]
        if (!normalizedStatus) return []

        const webhookTimestamp = new Date(envelope.timestamp).toISOString()

        return timestamps.map(ts => ({
          externalId: String(ts),
          status: normalizedStatus,
          timestamp: webhookTimestamp,
        }))
      }

      return []
    } catch {
      return []
    }
  }

  /**
   * Parse a reaction from a Signal webhook payload.
   * Returns null if the webhook is not a reaction message.
   */
  parseReaction(payload: SignalWebhookPayload): SignalReaction | null {
    const reaction = payload.envelope.dataMessage?.reaction
    if (!reaction) return null

    return {
      emoji: reaction.emoji,
      targetAuthor: reaction.targetAuthor,
      targetTimestamp: reaction.targetTimestamp,
      isRemove: reaction.remove ?? false,
    }
  }

  /**
   * Check if a webhook payload is a typing indicator.
   * Returns typing state info or null if not a typing message.
   */
  parseTypingIndicator(payload: SignalWebhookPayload): {
    sender: string
    isTyping: boolean
    timestamp: string
  } | null {
    const typing = payload.envelope.typingMessage
    if (!typing) return null

    return {
      sender: payload.envelope.sourceUuid ?? payload.envelope.source,
      isTyping: typing.action.toUpperCase() === 'STARTED',
      timestamp: new Date(typing.timestamp).toISOString(),
    }
  }

  /**
   * Send a reaction to a message via the signal-cli-rest-api bridge.
   */
  async sendReaction(params: {
    recipientIdentifier: string
    emoji: string
    targetAuthor: string
    targetTimestamp: number
    remove?: boolean
  }): Promise<SendResult> {
    try {
      const response = await safeFetch(`${this.bridgeUrl}/v1/reactions/${encodeURIComponent(this.registeredNumber)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.bridgeApiKey}`,
        },
        body: JSON.stringify({
          recipient: params.recipientIdentifier,
          reaction: params.emoji,
          target_author: params.targetAuthor,
          timestamp: params.targetTimestamp,
          remove: params.remove ?? false,
        }),
        timeoutMs: 10_000,
        ssrfGuard: false,
      })

      if (!response.ok) {
        const errorText = await response.text()
        return {
          success: false,
          error: `Signal bridge returned ${response.status}: ${errorText}`,
        }
      }

      return { success: true }
    } catch (err) {
      return {
        success: false,
        error: `Signal reaction send failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  /**
   * Send a read receipt to the sender, acknowledging message reception.
   */
  async sendReceipt(params: {
    recipientIdentifier: string
    targetTimestamps: number[]
    type?: 'read' | 'viewed'
  }): Promise<SendResult> {
    try {
      const response = await safeFetch(`${this.bridgeUrl}/v1/receipts/${encodeURIComponent(this.registeredNumber)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.bridgeApiKey}`,
        },
        body: JSON.stringify({
          recipient: params.recipientIdentifier,
          timestamps: params.targetTimestamps,
          receipt_type: params.type ?? 'read',
        }),
        timeoutMs: 10_000,
        ssrfGuard: false,
      })

      if (!response.ok) {
        const errorText = await response.text()
        return {
          success: false,
          error: `Signal bridge returned ${response.status}: ${errorText}`,
        }
      }

      return { success: true }
    } catch (err) {
      return {
        success: false,
        error: `Signal receipt send failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }
}

/**
 * Convert a Uint8Array to a base64 string.
 * Uses btoa which is available in Cloudflare Workers.
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}
