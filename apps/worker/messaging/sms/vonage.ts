import { safeFetch } from '../../lib/safe-fetch'
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
 * Vonage SMS webhook payload structure.
 * Vonage sends inbound SMS as JSON with these fields.
 */
interface VonageInboundSMS {
  msisdn: string       // sender phone number (no + prefix)
  to: string           // destination number
  text?: string        // message body
  messageId: string    // Vonage message ID
  type: string         // 'text', 'unicode', etc.
  timestamp?: string
  keyword?: string
  'message-timestamp'?: string
}

/**
 * VonageSMSAdapter -- Vonage (formerly Nexmo) SMS implementation of MessagingAdapter.
 * Vonage uses JSON webhooks, HMAC-SHA256 signature validation,
 * and separate REST endpoints for standard SMS vs. Messages API.
 */
export class VonageSMSAdapter implements MessagingAdapter {
  readonly channelType: MessagingChannelType = 'sms' as const

  private apiKey: string
  private apiSecret: string
  private phoneNumber: string

  constructor(apiKey: string, apiSecret: string, phoneNumber: string) {
    this.apiKey = apiKey
    this.apiSecret = apiSecret
    this.phoneNumber = phoneNumber
  }

  async parseIncomingMessage(request: Request): Promise<IncomingMessage> {
    const data = await request.clone().json() as VonageInboundSMS

    // Vonage uses msisdn (no + prefix) -- normalize to E.164
    const senderNumber = data.msisdn.startsWith('+') ? data.msisdn : `+${data.msisdn}`

    return {
      channelType: this.channelType,
      externalId: data.messageId,
      senderIdentifier: senderNumber,
      body: data.text || undefined,
      timestamp: data['message-timestamp'] || data.timestamp || new Date().toISOString(),
      metadata: {
        to: data.to,
        type: data.type,
      },
    }
  }

  async validateWebhook(request: Request): Promise<boolean> {
    // Vonage uses HMAC-SHA256 signature validation via X-Vonage-Signature header
    const signature = request.headers.get('X-Vonage-Signature')
    if (!signature) return false

    const body = await request.clone().text()

    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(this.apiSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body))
    const expected = Array.from(new Uint8Array(sig))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')

    // Constant-time comparison to prevent timing attacks
    const sigLower = signature.toLowerCase()
    if (sigLower.length !== expected.length) return false
    const aBuf = encoder.encode(sigLower)
    const bBuf = encoder.encode(expected)
    let result = 0
    for (let i = 0; i < aBuf.length; i++) {
      result |= aBuf[i] ^ bBuf[i]
    }
    return result === 0
  }

  async sendMessage(params: SendMessageParams): Promise<SendResult> {
    // Vonage SMS API: POST to rest.nexmo.com/sms/json
    const body = {
      api_key: this.apiKey,
      api_secret: this.apiSecret,
      to: stripPlusPrefix(params.recipientIdentifier),
      from: stripPlusPrefix(this.phoneNumber),
      text: params.body,
    }

    try {
      const res = await safeFetch('https://rest.nexmo.com/sms/json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (res.ok) {
        const data = await res.json() as VonageSMSResponse
        const message = data.messages?.[0]
        if (message && message.status === '0') {
          return { success: true, externalId: message['message-id'] }
        }
        return {
          success: false,
          error: message?.['error-text'] ?? 'Vonage SMS send failed',
        }
      }

      return {
        success: false,
        error: `Vonage SMS API returned ${res.status}`,
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error sending Vonage SMS',
      }
    }
  }

  async sendMediaMessage(params: SendMediaParams): Promise<SendResult> {
    // Vonage Messages API (v1): POST to api.nexmo.com/v1/messages
    // Uses JWT auth (Basic auth with api_key:api_secret as fallback)
    const body = {
      channel: 'sms',
      message_type: 'image',
      to: stripPlusPrefix(params.recipientIdentifier),
      from: stripPlusPrefix(this.phoneNumber),
      image: {
        url: params.mediaUrl,
        caption: params.body,
      },
    }

    try {
      const res = await safeFetch('https://api.nexmo.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Basic ' + btoa(`${this.apiKey}:${this.apiSecret}`),
        },
        body: JSON.stringify(body),
      })

      if (res.ok) {
        const data = await res.json() as { message_uuid?: string }
        return { success: true, externalId: data.message_uuid }
      }

      const errorData = await res.json().catch(() => null) as { title?: string; detail?: string } | null
      return {
        success: false,
        error: errorData?.detail ?? errorData?.title ?? `Vonage Messages API returned ${res.status}`,
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error sending Vonage media message',
      }
    }
  }

  async getChannelStatus(): Promise<ChannelStatus> {
    try {
      // Check account balance as a health indicator
      const res = await safeFetch(
        `https://rest.nexmo.com/account/get-balance?api_key=${this.apiKey}&api_secret=${this.apiSecret}`,
        { method: 'GET' }
      )

      if (res.ok) {
        const data = await res.json() as { value?: number; autoReload?: boolean }
        return {
          connected: true,
          details: {
            provider: 'vonage',
            channel: 'sms',
            balance: data.value,
            autoReload: data.autoReload,
            phoneNumber: this.phoneNumber,
          },
        }
      }

      return {
        connected: false,
        error: `Vonage API returned ${res.status}`,
      }
    } catch (err) {
      return {
        connected: false,
        error: err instanceof Error ? err.message : 'Unknown error connecting to Vonage',
      }
    }
  }
}

// --- Helper types ---

interface VonageSMSResponse {
  messages?: Array<{
    status: string
    'message-id'?: string
    'error-text'?: string
  }>
}

/**
 * Strip the leading '+' from a phone number.
 * Vonage APIs expect numbers without the + prefix.
 */
function stripPlusPrefix(phone: string): string {
  return phone.startsWith('+') ? phone.slice(1) : phone
}
