/**
 * RCSAdapter — implements MessagingAdapter for Google RCS Business Messaging.
 *
 * Uses Google RBM API for rich messaging features:
 * - Rich cards and carousels
 * - Suggested replies and actions
 * - Delivery and read receipts
 * - Media attachments
 */

import type { RCSConfig } from '@shared/types'
import { hashPhone } from '../../lib/crypto'
import type {
  MessagingAdapter,
  IncomingMessage,
  SendMessageParams,
  SendMediaParams,
  SendResult,
  ChannelStatus,
  MessageStatusUpdate,
} from '../adapter'
import type { MessageDeliveryStatus } from '../../types'
import { constantTimeEqual, hasWebhookSecret, missingWebhookSecretMessage } from '../webhook-secret'
import { RBMClient } from './rbm-client'
import type {
  RBMWebhookPayload,
  GoogleServiceAccountKey,
  RBMSuggestion,
  RBMCardContent,
} from './types'

export class RCSAdapter implements MessagingAdapter {
  readonly channelType = 'rcs' as const
  private client: RBMClient
  private config: RCSConfig
  private hmacSecret: string

  constructor(config: RCSConfig, hmacSecret: string) {
    this.config = config
    this.hmacSecret = hmacSecret

    const serviceAccountKey = JSON.parse(config.serviceAccountKey) as GoogleServiceAccountKey

    this.client = new RBMClient(config.agentId, serviceAccountKey)
  }

  /**
   * Parse an incoming RBM webhook into a normalized IncomingMessage.
   *
   * Handles text messages, media files, location sharing, and suggested replies.
   */
  async parseIncomingMessage(request: Request): Promise<IncomingMessage> {
    const payload = await request.json() as RBMWebhookPayload

    if (!payload.message) {
      throw new Error('RCS webhook has no message content')
    }

    const senderIdentifier = payload.senderId
    const identifierHash = hashPhone(senderIdentifier, this.hmacSecret)

    const mediaUrls: string[] = []
    const mediaTypes: string[] = []
    if (payload.message.userFile) {
      mediaUrls.push(payload.message.userFile.payload.fileUri)
      mediaTypes.push(payload.message.userFile.payload.mimeType)
    }

    const metadata: Record<string, string> = {
      agentId: payload.agentId,
    }

    if (payload.message.suggestionResponse) {
      metadata.postbackData = payload.message.suggestionResponse.postbackData
      metadata.suggestionType = payload.message.suggestionResponse.type
    }

    if (payload.message.location) {
      metadata.locationLat = String(payload.message.location.latitude)
      metadata.locationLng = String(payload.message.location.longitude)
      if (payload.message.location.label) {
        metadata.locationLabel = payload.message.location.label
      }
    }

    return {
      channelType: 'rcs',
      externalId: payload.message.messageId,
      senderIdentifier,
      senderIdentifierHash: identifierHash,
      body: payload.message.text || payload.message.suggestionResponse?.text,
      mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
      mediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
      timestamp: payload.message.sendTime,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    }
  }

  /**
   * Validate the webhook request by checking the Authorization bearer token.
   * Uses constant-time comparison to prevent timing attacks. Fails closed:
   * with no webhookSecret configured nothing can be authenticated, so
   * nothing is accepted.
   */
  async validateWebhook(request: Request): Promise<boolean> {
    if (!hasWebhookSecret(this.config.webhookSecret)) {
      return false
    }

    // Google RBM uses a bearer token for webhook validation
    const authHeader = request.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return false
    }

    const token = authHeader.slice(7)
    return constantTimeEqual(token, this.config.webhookSecret)
  }

  /**
   * Send a text message via RBM API.
   */
  async sendMessage(params: SendMessageParams): Promise<SendResult> {
    try {
      const response = await this.client.sendMessage(params.recipientIdentifier, {
        text: params.body,
      })

      if (response.error) {
        return { success: false, error: response.error.message }
      }

      return { success: true, externalId: response.name }
    } catch (err) {
      return {
        success: false,
        error: `RCS send failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  /**
   * Send a media message via RBM API.
   */
  async sendMediaMessage(params: SendMediaParams): Promise<SendResult> {
    try {
      const response = await this.client.sendMessage(params.recipientIdentifier, {
        text: params.body || undefined,
        contentInfo: {
          fileUrl: params.mediaUrl,
          forceRefresh: true,
        },
      })

      if (response.error) {
        return { success: false, error: response.error.message }
      }

      return { success: true, externalId: response.name }
    } catch (err) {
      return {
        success: false,
        error: `RCS media send failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  /**
   * Send a rich card message with optional suggestions.
   */
  async sendRichCard(params: {
    recipientIdentifier: string
    card: RBMCardContent
    conversationId: string
  }): Promise<SendResult> {
    try {
      const response = await this.client.sendMessage(params.recipientIdentifier, {
        richCard: {
          standaloneCard: {
            cardOrientation: 'VERTICAL',
            cardContent: params.card,
          },
        },
      })

      if (response.error) {
        return { success: false, error: response.error.message }
      }

      return { success: true, externalId: response.name }
    } catch (err) {
      return {
        success: false,
        error: `RCS rich card send failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  /**
   * Send a carousel of rich cards.
   */
  async sendCarousel(params: {
    recipientIdentifier: string
    cards: RBMCardContent[]
    cardWidth: 'SMALL' | 'MEDIUM'
    conversationId: string
  }): Promise<SendResult> {
    try {
      const response = await this.client.sendMessage(params.recipientIdentifier, {
        richCard: {
          carouselCard: {
            cardWidth: params.cardWidth,
            cardContents: params.cards,
          },
        },
      })

      if (response.error) {
        return { success: false, error: response.error.message }
      }

      return { success: true, externalId: response.name }
    } catch (err) {
      return {
        success: false,
        error: `RCS carousel send failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  /**
   * Send a message with suggested replies or actions.
   */
  async sendMessageWithSuggestions(params: {
    recipientIdentifier: string
    body: string
    suggestions: RBMSuggestion[]
    conversationId: string
  }): Promise<SendResult> {
    try {
      const response = await this.client.sendMessage(params.recipientIdentifier, {
        text: params.body,
        suggestions: params.suggestions,
      })

      if (response.error) {
        return { success: false, error: response.error.message }
      }

      return { success: true, externalId: response.name }
    } catch (err) {
      return {
        success: false,
        error: `RCS suggestions send failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  /**
   * Check RBM agent status by attempting to get an access token.
   */
  async getChannelStatus(): Promise<ChannelStatus> {
    if (!hasWebhookSecret(this.config.webhookSecret)) {
      return { connected: false, error: missingWebhookSecretMessage('rcs') }
    }
    const result = await this.client.checkStatus()
    return {
      connected: result.connected,
      details: result.details,
      error: result.error,
    }
  }

  /**
   * Parse RBM delivery and read receipts into normalized status updates.
   */
  async parseStatusWebhook(request: Request): Promise<MessageStatusUpdate | MessageStatusUpdate[] | null> {
    try {
      const payload = await request.clone().json() as RBMWebhookPayload

      if (!payload.event) {
        return null
      }

      const statusMap: Record<string, MessageDeliveryStatus> = {
        'DELIVERED': 'delivered',
        'READ': 'read',
      }

      const normalizedStatus = statusMap[payload.event.eventType]
      if (!normalizedStatus) {
        return null
      }

      return {
        externalId: payload.event.eventId,
        status: normalizedStatus,
        timestamp: payload.event.sendTime,
      }
    } catch {
      return null
    }
  }
}
