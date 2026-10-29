import { TwilioAdapter } from './twilio'
import { buildWebhookUrl } from '../lib/webhook-url'
import type { ProviderSettingReading } from '@protocol/schemas/settings'

/**
 * SignalWire adapter — extends TwilioAdapter since SignalWire is API-compatible.
 * Only the base URLs and authentication differ.
 * SignalWire uses a "space" subdomain: https://{space}.signalwire.com
 */
export class SignalWireAdapter extends TwilioAdapter {
  private space: string

  constructor(projectId: string, apiToken: string, phoneNumber: string, space: string, webhookBaseUrl = '') {
    super(projectId, apiToken, phoneNumber, webhookBaseUrl)
    this.space = space
  }

  protected override getApiBaseUrl(): string {
    return `https://${this.space}.signalwire.com/api/laml/2010-04-01/Accounts/${this.accountSid}`
  }

  protected override getRecordingBaseUrl(): string {
    return `https://${this.space}.signalwire.com/api/laml/2010-04-01/Accounts/${this.accountSid}`
  }

  protected override get providerLabel(): string {
    return 'SignalWire'
  }

  /** SignalWire SIP trunks carry no features — no recording, no call control. */
  protected override async readTrunkRecording(trunkSid: string): Promise<ProviderSettingReading> {
    return { state: 'off', evidence: `SignalWire SIP trunk ${trunkSid} has no recording feature` }
  }

  /**
   * SignalWire publishes no account-level transcription setting to read: cXML
   * transcription is per-<Record> (which this server never sets) and SWML
   * live_transcribe is per-script, covered by the number-routing reading.
   */
  protected override async readAccountTranscriptionSettings(): Promise<ProviderSettingReading[]> {
    return []
  }

  override async validateWebhook(request: Request): Promise<boolean> {
    // SignalWire uses the same X-Twilio-Signature HMAC-SHA1 validation as Twilio
    // but may send X-SignalWire-Signature header instead
    const signature = request.headers.get('X-SignalWire-Signature') || request.headers.get('X-Twilio-Signature')
    if (!signature) return false

    const url = buildWebhookUrl(request, this.webhookBaseUrl)
    const body = await request.clone().text()
    const params = new URLSearchParams(body)

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

    if (signature.length !== expected.length) return false
    const aBuf = encoder.encode(signature)
    const bBuf = encoder.encode(expected)
    let result = 0
    for (let i = 0; i < aBuf.length; i++) {
      result |= aBuf[i] ^ bBuf[i]
    }
    return result === 0
  }
}
