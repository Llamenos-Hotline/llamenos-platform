import { safeFetch } from '../../lib/safe-fetch'
import { buildWebhookUrl } from '../../lib/webhook-url'
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
import type { MessagingChannelType } from '@shared/types'

/**
 * TwilioSMSAdapter -- Twilio SMS implementation of MessagingAdapter.
 * Parses Twilio SMS webhooks (form-encoded), sends messages via Twilio REST API,
 * and validates webhook signatures using HMAC-SHA1.
 */
export class TwilioSMSAdapter implements MessagingAdapter {
  readonly channelType: MessagingChannelType = 'sms' as const

  protected accountSid: string
  protected authToken: string
  protected phoneNumber: string
  protected webhookBaseUrl: string

  constructor(accountSid: string, authToken: string, phoneNumber: string, webhookBaseUrl = '') {
    this.accountSid = accountSid
    this.authToken = authToken
    this.phoneNumber = phoneNumber
    this.webhookBaseUrl = webhookBaseUrl
  }

  async parseIncomingMessage(request: Request): Promise<IncomingMessage> {
    const form = await request.clone().formData()

    const from = (form.get('From') as string) || ''
    const body = (form.get('Body') as string) || undefined
    const messageSid = (form.get('MessageSid') as string) || ''
    const numMedia = parseInt((form.get('NumMedia') as string) || '0', 10)

    const mediaUrls: string[] = []
    const mediaTypes: string[] = []
    for (let i = 0; i < numMedia; i++) {
      const url = form.get(`MediaUrl${i}`) as string
      const contentType = form.get(`MediaContentType${i}`) as string
      if (url) mediaUrls.push(url)
      if (contentType) mediaTypes.push(contentType)
    }

    return {
      channelType: this.channelType,
      externalId: messageSid,
      senderIdentifier: from,
      body,
      mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
      mediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
      timestamp: new Date().toISOString(),
      metadata: {
        to: (form.get('To') as string) || '',
      },
    }
  }

  async validateWebhook(request: Request): Promise<boolean> {
    const signature = request.headers.get('X-Twilio-Signature')
    if (!signature) return false

    const url = buildWebhookUrl(request, this.webhookBaseUrl)
    const body = await request.clone().text()
    const params = new URLSearchParams(body)

    // Build the data string: full URL + sorted form key-value pairs concatenated
    let dataString = url.toString()
    const sortedEntries = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b))
    for (const [key, value] of sortedEntries) {
      dataString += key + value
    }

    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(this.authToken),
      { name: 'HMAC', hash: 'SHA-1' },
      false,
      ['sign']
    )
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(dataString))
    const expected = btoa(String.fromCharCode(...new Uint8Array(sig)))

    // Constant-time comparison to prevent timing attacks
    if (signature.length !== expected.length) return false
    const aBuf = encoder.encode(signature)
    const bBuf = encoder.encode(expected)
    let result = 0
    for (let i = 0; i < aBuf.length; i++) {
      result |= aBuf[i] ^ bBuf[i]
    }
    return result === 0
  }

  async sendMessage(params: SendMessageParams): Promise<SendResult> {
    const body = new URLSearchParams({
      To: params.recipientIdentifier,
      From: this.phoneNumber,
      Body: params.body,
    })

    try {
      const res = await this.twilioMessagesApi(body)
      if (res.ok) {
        const data = await res.json() as { sid: string }
        return { success: true, externalId: data.sid }
      }

      const errorData = await res.json().catch(() => null) as { message?: string } | null
      return {
        success: false,
        error: errorData?.message ?? `Twilio SMS API returned ${res.status}`,
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error sending Twilio SMS',
      }
    }
  }

  async sendMediaMessage(params: SendMediaParams): Promise<SendResult> {
    const body = new URLSearchParams({
      To: params.recipientIdentifier,
      From: this.phoneNumber,
      Body: params.body,
      MediaUrl: params.mediaUrl,
    })

    try {
      const res = await this.twilioMessagesApi(body)
      if (res.ok) {
        const data = await res.json() as { sid: string }
        return { success: true, externalId: data.sid }
      }

      const errorData = await res.json().catch(() => null) as { message?: string } | null
      return {
        success: false,
        error: errorData?.message ?? `Twilio SMS API returned ${res.status}`,
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error sending Twilio MMS',
      }
    }
  }

  async getChannelStatus(): Promise<ChannelStatus> {
    try {
      const res = await safeFetch(
        `${this.getApiBaseUrl()}.json`,
        {
          method: 'GET',
          headers: {
            'Authorization': 'Basic ' + btoa(`${this.accountSid}:${this.authToken}`),
          },
        }
      )

      if (res.ok) {
        const data = await res.json() as { status?: string; friendly_name?: string }
        return {
          connected: true,
          details: {
            provider: 'twilio',
            channel: 'sms',
            accountStatus: data.status,
            accountName: data.friendly_name,
            phoneNumber: this.phoneNumber,
          },
        }
      }

      return {
        connected: false,
        error: `Twilio API returned ${res.status}`,
      }
    } catch (err) {
      return {
        connected: false,
        error: err instanceof Error ? err.message : 'Unknown error connecting to Twilio',
      }
    }
  }

  /**
   * Delete a message from Twilio logs (for provider-side cleanup).
   * Throws if the deletion request fails.
   */
  async deleteMessage(messageSid: string): Promise<void> {
    const res = await safeFetch(
      `${this.getApiBaseUrl()}/Messages/${messageSid}.json`,
      {
        method: 'DELETE',
        headers: {
          'Authorization': 'Basic ' + btoa(`${this.accountSid}:${this.authToken}`),
        },
      }
    )
    if (!res.ok) {
      throw new Error(`Failed to delete message ${messageSid}: Twilio API returned ${res.status}`)
    }
  }

  /**
   * Parse Twilio status callback webhook.
   * Twilio sends status updates as form-encoded POST to a configured StatusCallback URL.
   * Status values: queued, failed, sent, delivered, undelivered
   */
  async parseStatusWebhook(request: Request): Promise<MessageStatusUpdate | null> {
    try {
      const form = await request.clone().formData()

      const messageSid = (form.get('MessageSid') as string) || ''
      const messageStatus = (form.get('MessageStatus') as string) || ''
      const errorCode = form.get('ErrorCode') as string | null
      const errorMessage = form.get('ErrorMessage') as string | null

      if (!messageSid || !messageStatus) {
        return null
      }

      // Map Twilio status to our normalized status
      const statusMap: Record<string, MessageDeliveryStatus> = {
        'queued': 'pending',
        'sending': 'pending',
        'sent': 'sent',
        'delivered': 'delivered',
        'undelivered': 'failed',
        'failed': 'failed',
      }

      const status = statusMap[messageStatus.toLowerCase()]
      if (!status) {
        return null
      }

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

  // --- Helpers ---

  protected getApiBaseUrl(): string {
    return `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}`
  }

  protected async twilioMessagesApi(body: URLSearchParams): Promise<Response> {
    return safeFetch(
      `${this.getApiBaseUrl()}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + btoa(`${this.accountSid}:${this.authToken}`),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      }
    )
  }
}
