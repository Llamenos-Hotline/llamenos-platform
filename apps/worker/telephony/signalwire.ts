import { TwilioAdapter } from './twilio'
import type {
  ProviderRetentionStatement,
  ProviderSettingEnforcement,
  ProviderSettingReading,
} from '@protocol/schemas/settings'

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

  /** Nothing to turn off: a SignalWire SIP trunk has no recording feature. */
  protected override async enforceTrunkRecording(trunkSid: string): Promise<ProviderSettingEnforcement> {
    return { setting: 'recording', target: `SIP trunk ${trunkSid}`, outcome: 'already-off', evidence: `SignalWire SIP trunk ${trunkSid} has no recording feature` }
  }

  /** No account-level transcription switch exists to turn off (see readAccountTranscriptionSettings). */
  protected override async enforceAccountTranscription(): Promise<ProviderSettingEnforcement[]> {
    return [{
      setting: 'transcription',
      target: 'account',
      outcome: 'not-settable',
      reason: 'SignalWire publishes no account-level transcription setting: cXML transcription is per-<Record>, which this server never sets, and SWML live_transcribe is per-script',
    }]
  }

  override providerRetention(): ProviderRetentionStatement {
    return {
      removed: [
        {
          what: 'Voicemail and call recordings',
          how: 'DELETE /Recordings/{Sid} on the compatibility API once fetched — a call recording after the server holds its own sealed copy. A refusal stays in heldAtProvider and is retried.',
        },
        {
          what: 'Call log records of the caller\'s call and of every volunteer ring leg (they name both phone numbers)',
          how: 'DELETE /Calls/{Sid} on the compatibility API once the call has ended. A refusal stays in heldAtProvider and is retried.',
        },
      ],
      retained: [
        {
          what: 'SMS message records, including bodies',
          reason: 'This server does not delete messages at SignalWire. SignalWire documents DELETE /Messages/{Sid} for messages no longer in flight; attached media must be deleted separately.',
        },
        {
          what: 'Recordings and transcriptions this server did not request',
          reason: 'Not deleted automatically: they are reported under recording and transcription instead, and may belong to another use of the space.',
        },
        {
          what: 'Space usage, billing and log records outside the compatibility API',
          reason: 'No SignalWire API to delete them could be found in its documentation.',
        },
      ],
      source: 'SignalWire compatibility API documentation (Calls, Recordings, Messages), checked 2026-10-29',
    }
  }

  override async validateWebhook(request: Request): Promise<boolean> {
    // SignalWire uses the same X-Twilio-Signature HMAC-SHA1 validation as Twilio
    // but may send X-SignalWire-Signature header instead
    const signature = request.headers.get('X-SignalWire-Signature') || request.headers.get('X-Twilio-Signature')
    if (!signature) return false

    const dataString = await this.signingInput(request)

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
