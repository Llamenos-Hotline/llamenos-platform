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
import type { WhatsAppConfig } from '@shared/types'
import type {
  MetaWebhookPayload,
  MetaInboundMessage,
  TwilioWhatsAppInbound,
} from './types'
import { MetaDirectClient } from './meta-client'
import { TwilioWhatsAppClient } from './twilio-client'

/** Union type for the underlying client */
type WhatsAppClient = MetaDirectClient | TwilioWhatsAppClient

/**
 * WhatsAppAdapter -- implements MessagingAdapter for WhatsApp.
 *
 * Supports two integration modes:
 * - "direct": Meta Cloud API (Graph API) via MetaDirectClient
 * - "twilio": Twilio Messaging API with whatsapp: prefix via TwilioWhatsAppClient
 *
 * The adapter normalizes both providers into the shared IncomingMessage format
 * and delegates outbound messaging to the appropriate client.
 */
export class WhatsAppAdapter implements MessagingAdapter {
  readonly channelType = 'whatsapp' as const

  private readonly config: WhatsAppConfig
  private readonly client: WhatsAppClient
  private readonly integrationMode: 'twilio' | 'direct'

  constructor(config: WhatsAppConfig) {
    this.config = config
    this.integrationMode = config.integrationMode

    if (config.integrationMode === 'direct') {
      if (!config.phoneNumberId || !config.businessAccountId || !config.accessToken || !config.appSecret) {
        throw new Error(
          'WhatsApp direct mode requires phoneNumberId, businessAccountId, accessToken, and appSecret',
        )
      }
      this.client = new MetaDirectClient(
        config.phoneNumberId,
        config.businessAccountId,
        config.accessToken,
        config.appSecret,
      )
    } else {
      // Twilio mode -- credentials come from the telephony provider config,
      // not the WhatsApp config itself. The factory handles proper construction.
      throw new Error(
        'Twilio WhatsApp mode must be constructed via createWhatsAppAdapter factory',
      )
    }
  }

  /**
   * Alternate constructor for Twilio mode, used by the factory.
   */
  static createWithTwilioClient(
    config: WhatsAppConfig,
    client: TwilioWhatsAppClient,
  ): WhatsAppAdapter {
    const adapter = Object.create(WhatsAppAdapter.prototype) as WhatsAppAdapter
    Object.defineProperty(adapter, 'channelType', { value: 'whatsapp' as const })
    Object.defineProperty(adapter, 'config', { value: config })
    Object.defineProperty(adapter, 'client', { value: client })
    Object.defineProperty(adapter, 'integrationMode', { value: config.integrationMode })
    return adapter
  }

  /**
   * Parse an incoming webhook request into a normalized IncomingMessage.
   */
  async parseIncomingMessage(request: Request): Promise<IncomingMessage> {
    if (this.integrationMode === 'direct') {
      return this.parseMetaWebhook(request)
    }
    return this.parseTwilioWebhook(request)
  }

  /**
   * Validate the webhook signature from the provider.
   */
  async validateWebhook(request: Request): Promise<boolean> {
    return this.client.validateSignature(request)
  }

  /**
   * Send a text message to a recipient.
   */
  async sendMessage(params: SendMessageParams): Promise<SendResult> {
    try {
      if (this.integrationMode === 'direct') {
        const metaClient = this.client as MetaDirectClient
        const res = await metaClient.sendTextMessage(
          params.recipientIdentifier,
          params.body,
        )
        return {
          success: true,
          externalId: res.messages[0]?.id,
        }
      }

      const twilioClient = this.client as TwilioWhatsAppClient
      const res = await twilioClient.sendTextMessage(
        params.recipientIdentifier,
        params.body,
      )
      return {
        success: true,
        externalId: res.sid,
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /**
   * Send a media message to a recipient.
   */
  async sendMediaMessage(params: SendMediaParams): Promise<SendResult> {
    try {
      if (this.integrationMode === 'direct') {
        const metaClient = this.client as MetaDirectClient
        const res = await metaClient.sendMediaMessage(
          params.recipientIdentifier,
          params.mediaUrl,
          params.mediaType,
        )
        return {
          success: true,
          externalId: res.messages[0]?.id,
        }
      }

      const twilioClient = this.client as TwilioWhatsAppClient
      const res = await twilioClient.sendMediaMessage(
        params.recipientIdentifier,
        params.mediaUrl,
        params.mediaType,
        params.body || undefined,
      )
      return {
        success: true,
        externalId: res.sid,
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /**
   * Check if the WhatsApp channel is properly configured and the API is reachable.
   */
  async getChannelStatus(): Promise<ChannelStatus> {
    try {
      const health = await this.client.checkHealth()
      if (health.ok) {
        return {
          connected: true,
          details: {
            integrationMode: this.integrationMode,
            provider: this.integrationMode === 'direct' ? 'meta-direct' : 'twilio',
          },
        }
      }
      return {
        connected: false,
        error: health.error,
        details: {
          integrationMode: this.integrationMode,
        },
      }
    } catch (err) {
      return {
        connected: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  // --- Private: Meta Cloud API parsing ---

  private async parseMetaWebhook(request: Request): Promise<IncomingMessage> {
    const payload = await request.clone().json() as MetaWebhookPayload

    const entry = payload.entry[0]
    if (!entry) {
      throw new Error('WhatsApp webhook has no entry')
    }

    const change = entry.changes[0]
    if (!change) {
      throw new Error('WhatsApp webhook has no changes')
    }

    const value = change.value
    const messages = value.messages
    if (!messages || messages.length === 0) {
      throw new Error('WhatsApp webhook has no messages (may be a status update)')
    }

    const msg: MetaInboundMessage = messages[0]
    const contact = value.contacts?.[0]

    const { body, mediaUrls, mediaTypes } = this.extractMetaContent(msg)

    return {
      channelType: 'whatsapp',
      externalId: msg.id,
      senderIdentifier: msg.from,
      body,
      mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
      mediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
      timestamp: new Date(parseInt(msg.timestamp, 10) * 1000).toISOString(),
      metadata: {
        ...(contact?.profile.name ? { profileName: contact.profile.name } : {}),
        ...(contact?.wa_id ? { waId: contact.wa_id } : {}),
        messageType: msg.type,
        phoneNumberId: value.metadata.phone_number_id,
      },
    }
  }

  /**
   * Extract text body and media references from a Meta inbound message.
   */
  private extractMetaContent(msg: MetaInboundMessage): {
    body: string | undefined
    mediaUrls: string[]
    mediaTypes: string[]
  } {
    const mediaUrls: string[] = []
    const mediaTypes: string[] = []
    let body: string | undefined

    switch (msg.type) {
      case 'text':
        body = msg.text?.body
        break

      case 'image':
        if (msg.image) {
          mediaUrls.push(msg.image.id)
          mediaTypes.push(msg.image.mime_type)
          body = msg.image.caption
        }
        break

      case 'video':
        if (msg.video) {
          mediaUrls.push(msg.video.id)
          mediaTypes.push(msg.video.mime_type)
          body = msg.video.caption
        }
        break

      case 'audio':
        if (msg.audio) {
          mediaUrls.push(msg.audio.id)
          mediaTypes.push(msg.audio.mime_type)
        }
        break

      case 'document':
        if (msg.document) {
          mediaUrls.push(msg.document.id)
          mediaTypes.push(msg.document.mime_type)
          body = msg.document.caption
        }
        break

      case 'location':
        if (msg.location) {
          body = `Location: ${msg.location.latitude}, ${msg.location.longitude}`
          if (msg.location.name) {
            body += ` (${msg.location.name})`
          }
          if (msg.location.address) {
            body += ` - ${msg.location.address}`
          }
        }
        break

      case 'contacts':
        if (msg.contacts && msg.contacts.length > 0) {
          const names = msg.contacts.map(c => c.name.formatted_name)
          body = `Shared contact(s): ${names.join(', ')}`
        }
        break

      case 'reaction':
        if (msg.reaction) {
          body = `Reaction: ${msg.reaction.emoji} on message ${msg.reaction.message_id}`
        }
        break

      case 'interactive':
        if (msg.interactive) {
          if (msg.interactive.type === 'button_reply' && msg.interactive.button_reply) {
            body = msg.interactive.button_reply.title
          } else if (msg.interactive.type === 'list_reply' && msg.interactive.list_reply) {
            body = msg.interactive.list_reply.title
          }
        }
        break
    }

    return { body, mediaUrls, mediaTypes }
  }

  /**
   * Parse status webhook updates from WhatsApp.
   * Both Meta and Twilio send delivery status updates.
   */
  async parseStatusWebhook(request: Request): Promise<MessageStatusUpdate | null> {
    if (this.integrationMode === 'direct') {
      return this.parseMetaStatusWebhook(request)
    }
    return this.parseTwilioStatusWebhook(request)
  }

  /**
   * Parse Meta Cloud API status webhooks.
   * Meta sends statuses in the same webhook format as messages.
   */
  private async parseMetaStatusWebhook(request: Request): Promise<MessageStatusUpdate | null> {
    try {
      const payload = await request.clone().json() as MetaWebhookPayload

      const entry = payload.entry?.[0]
      if (!entry) return null

      const change = entry.changes?.[0]
      if (!change) return null

      const statuses = change.value?.statuses
      if (!statuses || statuses.length === 0) return null

      const status = statuses[0]
      if (!status.id || !status.status) return null

      // Map Meta status to our normalized status
      const statusMap: Record<string, MessageDeliveryStatus> = {
        'sent': 'sent',
        'delivered': 'delivered',
        'read': 'read',
        'failed': 'failed',
      }

      const normalizedStatus = statusMap[status.status]
      if (!normalizedStatus) return null

      return {
        externalId: status.id,
        status: normalizedStatus,
        timestamp: status.timestamp
          ? new Date(parseInt(status.timestamp, 10) * 1000).toISOString()
          : new Date().toISOString(),
        failureReason: normalizedStatus === 'failed' && status.errors?.length
          ? status.errors[0].message || status.errors[0].title
          : undefined,
      }
    } catch {
      return null
    }
  }

  /**
   * Parse Twilio WhatsApp status callbacks.
   * Same format as regular Twilio SMS status callbacks.
   */
  private async parseTwilioStatusWebhook(request: Request): Promise<MessageStatusUpdate | null> {
    try {
      const form = await request.clone().formData()

      const messageSid = (form.get('MessageSid') as string) || ''
      const messageStatus = (form.get('MessageStatus') as string) || ''
      const errorCode = form.get('ErrorCode') as string | null
      const errorMessage = form.get('ErrorMessage') as string | null

      if (!messageSid || !messageStatus) return null

      // Map Twilio status to our normalized status
      const statusMap: Record<string, MessageDeliveryStatus> = {
        'queued': 'pending',
        'sending': 'pending',
        'sent': 'sent',
        'delivered': 'delivered',
        'read': 'read',
        'undelivered': 'failed',
        'failed': 'failed',
      }

      const status = statusMap[messageStatus.toLowerCase()]
      if (!status) return null

      return {
        externalId: messageSid,
        status,
        timestamp: new Date().toISOString(),
        failureReason: status === 'failed' && (errorMessage || errorCode)
          ? `${errorCode || 'ERR'}: ${errorMessage || 'Message delivery failed'}`
          : undefined,
      }
    } catch {
      return null
    }
  }

  // --- Private: Twilio WhatsApp parsing ---

  private async parseTwilioWebhook(request: Request): Promise<IncomingMessage> {
    const formData = await request.clone().formData()

    const data: TwilioWhatsAppInbound = {
      MessageSid: formData.get('MessageSid') as string,
      AccountSid: formData.get('AccountSid') as string,
      From: formData.get('From') as string,
      To: formData.get('To') as string,
      Body: formData.get('Body') as string,
      NumMedia: formData.get('NumMedia') as string,
      MediaUrl0: (formData.get('MediaUrl0') as string) || undefined,
      MediaContentType0: (formData.get('MediaContentType0') as string) || undefined,
      MediaUrl1: (formData.get('MediaUrl1') as string) || undefined,
      MediaContentType1: (formData.get('MediaContentType1') as string) || undefined,
      MediaUrl2: (formData.get('MediaUrl2') as string) || undefined,
      MediaContentType2: (formData.get('MediaContentType2') as string) || undefined,
      ProfileName: (formData.get('ProfileName') as string) || undefined,
    }

    // Strip the "whatsapp:" prefix from the phone number
    const rawFrom = data.From.replace(/^whatsapp:/, '')

    // Collect media attachments
    const mediaUrls: string[] = []
    const mediaTypes: string[] = []
    const numMedia = parseInt(data.NumMedia || '0', 10)

    for (let i = 0; i < numMedia && i < 10; i++) {
      const url = formData.get(`MediaUrl${i}`) as string | null
      const mimeType = formData.get(`MediaContentType${i}`) as string | null
      if (url) {
        mediaUrls.push(url)
        if (mimeType) {
          mediaTypes.push(mimeType)
        }
      }
    }

    return {
      channelType: 'whatsapp',
      externalId: data.MessageSid,
      senderIdentifier: rawFrom,
      body: data.Body || undefined,
      mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
      mediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
      timestamp: new Date().toISOString(),
      metadata: {
        ...(data.ProfileName ? { profileName: data.ProfileName } : {}),
        twilioAccountSid: data.AccountSid,
      },
    }
  }
}
