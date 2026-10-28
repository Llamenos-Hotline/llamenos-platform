import { safeFetch } from '../../lib/safe-fetch'
import { buildWebhookUrl } from '../../lib/webhook-url'
import type {
  MessagingAdapter,
  IncomingMessage,
  SendMessageParams,
  SendMediaParams,
  SendResult,
  ChannelStatus,
} from '../adapter'
import type { MessagingChannelType } from '@shared/types'

/**
 * PlivoSMSAdapter -- Plivo SMS implementation of MessagingAdapter.
 * Plivo sends form-encoded webhooks with From, To, Text, MessageUUID, Type, Media0..N.
 * Uses HMAC-SHA256 + nonce for webhook validation (X-Plivo-Signature-V3).
 */
export class PlivoSMSAdapter implements MessagingAdapter {
  readonly channelType: MessagingChannelType = 'sms' as const

  private authId: string
  private authToken: string
  private phoneNumber: string
  private webhookBaseUrl: string

  constructor(authId: string, authToken: string, phoneNumber: string, webhookBaseUrl = '') {
    this.authId = authId
    this.authToken = authToken
    this.phoneNumber = phoneNumber
    this.webhookBaseUrl = webhookBaseUrl
  }

  async parseIncomingMessage(request: Request): Promise<IncomingMessage> {
    const form = await request.clone().formData()

    const from = (form.get('From') as string) || ''
    const text = (form.get('Text') as string) || undefined
    const messageUUID = (form.get('MessageUUID') as string) || ''
    const type = (form.get('Type') as string) || 'sms'

    // Parse media attachments (Plivo uses Media0, Media1, etc. for MMS)
    const mediaUrls: string[] = []
    for (let i = 0; ; i++) {
      const mediaUrl = form.get(`Media${i}`) as string | null
      if (!mediaUrl) break
      mediaUrls.push(mediaUrl)
    }

    return {
      channelType: this.channelType,
      externalId: messageUUID,
      senderIdentifier: from,
      body: text,
      mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
      timestamp: new Date().toISOString(),
      metadata: {
        to: (form.get('To') as string) || '',
        type,
      },
    }
  }

  async validateWebhook(request: Request): Promise<boolean> {
    // Plivo V3 signature validation:
    // 1. Build string: URL (without query) + sorted POST params + nonce
    // 2. HMAC-SHA256 with auth token
    // 3. Compare with X-Plivo-Signature-V3 header
    const signature = request.headers.get('X-Plivo-Signature-V3')
    const nonce = request.headers.get('X-Plivo-Signature-V3-Nonce')
    if (!signature || !nonce) return false

    const url = buildWebhookUrl(request, this.webhookBaseUrl)
    const body = await request.clone().text()
    const params = new URLSearchParams(body)

    // Build validation string: URL (origin + pathname) + sorted params + nonce
    let dataString = url.origin + url.pathname
    const sortedEntries = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b))
    for (const [key, value] of sortedEntries) {
      dataString += key + value
    }
    dataString += '.' + nonce

    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(this.authToken),
      { name: 'HMAC', hash: 'SHA-256' },
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
    const body = {
      src: this.phoneNumber,
      dst: params.recipientIdentifier,
      text: params.body,
    }

    try {
      const res = await this.plivoApi('/Message/', {
        method: 'POST',
        body: JSON.stringify(body),
      })

      if (res.ok) {
        const data = await res.json() as PlivoMessageResponse
        const messageUuid = data.message_uuid?.[0]
        return { success: true, externalId: messageUuid }
      }

      const errorData = await res.json().catch(() => null) as { error?: string } | null
      return {
        success: false,
        error: errorData?.error ?? `Plivo SMS API returned ${res.status}`,
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error sending Plivo SMS',
      }
    }
  }

  async sendMediaMessage(params: SendMediaParams): Promise<SendResult> {
    const body = {
      src: this.phoneNumber,
      dst: params.recipientIdentifier,
      text: params.body,
      media_urls: [params.mediaUrl],
      type: 'mms',
    }

    try {
      const res = await this.plivoApi('/Message/', {
        method: 'POST',
        body: JSON.stringify(body),
      })

      if (res.ok) {
        const data = await res.json() as PlivoMessageResponse
        const messageUuid = data.message_uuid?.[0]
        return { success: true, externalId: messageUuid }
      }

      const errorData = await res.json().catch(() => null) as { error?: string } | null
      return {
        success: false,
        error: errorData?.error ?? `Plivo MMS API returned ${res.status}`,
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error sending Plivo media message',
      }
    }
  }

  async getChannelStatus(): Promise<ChannelStatus> {
    try {
      const res = await this.plivoApi('/', { method: 'GET' })

      if (res.ok) {
        const data = await res.json() as { cash_credits?: string; account_type?: string }
        return {
          connected: true,
          details: {
            provider: 'plivo',
            channel: 'sms',
            credits: data.cash_credits,
            accountType: data.account_type,
            phoneNumber: this.phoneNumber,
          },
        }
      }

      return {
        connected: false,
        error: `Plivo API returned ${res.status}`,
      }
    } catch (err) {
      return {
        connected: false,
        error: err instanceof Error ? err.message : 'Unknown error connecting to Plivo',
      }
    }
  }

  // --- Helpers ---

  private async plivoApi(path: string, init: RequestInit): Promise<Response> {
    return safeFetch(
      `https://api.plivo.com/v1/Account/${this.authId}${path}`,
      {
        ...init,
        headers: {
          'Authorization': 'Basic ' + btoa(`${this.authId}:${this.authToken}`),
          'Content-Type': 'application/json',
          ...init.headers,
        },
      }
    )
  }
}

// --- Helper types ---

interface PlivoMessageResponse {
  message_uuid?: string[]
  api_id?: string
  message?: string
}
