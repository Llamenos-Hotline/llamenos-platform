import { safeFetch } from '../../lib/safe-fetch'
import type { ChannelStatus } from '../adapter'
import { TwilioSMSAdapter } from './twilio'
import { buildWebhookUrl } from '../../lib/webhook-url'

/**
 * SignalWireSMSAdapter -- extends TwilioSMSAdapter since SignalWire is API-compatible.
 * Only the base URL and webhook validation header differ.
 * SignalWire uses a "space" subdomain: https://{space}.signalwire.com
 */
export class SignalWireSMSAdapter extends TwilioSMSAdapter {
  private space: string

  constructor(accountSid: string, authToken: string, phoneNumber: string, space: string, webhookBaseUrl = '') {
    super(accountSid, authToken, phoneNumber, webhookBaseUrl)
    this.space = space
  }

  protected override getApiBaseUrl(): string {
    return `https://${this.space}.signalwire.com/api/laml/2010-04-01/Accounts/${this.accountSid}`
  }

  override async validateWebhook(request: Request): Promise<boolean> {
    // SignalWire may send either X-SignalWire-Signature or X-Twilio-Signature
    const signature = request.headers.get('X-SignalWire-Signature')
      || request.headers.get('X-Twilio-Signature')
    if (!signature) return false

    const url = buildWebhookUrl(request, this.webhookBaseUrl)
    const body = await request.clone().text()
    const params = new URLSearchParams(body)

    // Build the data string: full URL + sorted form key-value pairs concatenated
    let dataString = url.toString()
    const sortedKeys = Array.from(params.keys()).sort()
    for (const key of sortedKeys) {
      dataString += key + params.get(key)
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

  override async getChannelStatus(): Promise<ChannelStatus> {
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
            provider: 'signalwire',
            channel: 'sms',
            space: this.space,
            accountStatus: data.status,
            accountName: data.friendly_name,
            phoneNumber: this.phoneNumber,
          },
        }
      }

      return {
        connected: false,
        error: `SignalWire API returned ${res.status}`,
      }
    } catch (err) {
      return {
        connected: false,
        error: err instanceof Error ? err.message : 'Unknown error connecting to SignalWire',
      }
    }
  }
}
