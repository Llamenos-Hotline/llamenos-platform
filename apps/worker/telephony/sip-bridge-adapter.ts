import { safeFetch } from '../lib/safe-fetch'
import type {
  TelephonyAdapter,
  IncomingCallParams,
  CaptchaResponseParams,
  CallAnsweredParams,
  LanguageMenuParams,
  RingVolunteersParams,
  VoicemailParams,
  TelephonyResponse,
  AudioUrlMap,
  WebhookCallInfo,
  WebhookDigits,
  WebhookCallStatus,
  WebhookQueueResult,
  WebhookQueueWait,
  WebhookRecordingStatus,
} from './adapter'

/**
 * Webhook payload from the sip-bridge sidecar.
 * Both Asterisk and FreeSWITCH bridge services emit this same JSON format.
 * Dual field names (channelId/callSid, callerNumber/from) supported for
 * backwards compatibility during the transition.
 */
export interface BridgeWebhookPayload {
  event?: string
  channelId?: string
  callSid?: string
  callerNumber?: string
  calledNumber?: string
  from?: string
  to?: string
  digits?: string
  state?: string
  status?: string
  queueTime?: number
  result?: string
  reason?: string
  recordingStatus?: string
  recordingName?: string
  recordingSid?: string
}

/**
 * SipBridgeAdapter — abstract base class for PBX-backed telephony adapters.
 *
 * Extracts shared code from AsteriskAdapter and FreeSwitchAdapter:
 * - HMAC-signed bridge requests (bridgeRequest)
 * - Webhook signature validation with replay protection
 * - JSON webhook parsing (all parse*Webhook methods)
 * - Call recording retrieval (getCallRecording, getRecordingAudio)
 * - Call management (hangupCall, ringVolunteers, cancelRinging)
 *
 * Subclasses implement IVR/call-flow methods (handleLanguageMenu, etc.)
 * which differ per PBX (JSON commands for Asterisk, mod_httapi XML for FreeSWITCH).
 */
export abstract class SipBridgeAdapter implements TelephonyAdapter {
  constructor(
    protected readonly phoneNumber: string,
    protected readonly bridgeCallbackUrl: string,
    protected readonly bridgeSecret: string,
  ) {}

  /** PBX-specific endpoint format: e.g. "PJSIP/phone@trunk" or "sofia/internal/phone@trunk" */
  abstract getEndpointFormat(phone: string): string

  /** PBX type name for logging/debugging */
  abstract getPbxType(): string

  // --- IVR / Call flow (must be implemented by subclass) ---
  abstract handleLanguageMenu(params: LanguageMenuParams): Promise<TelephonyResponse>
  abstract handleIncomingCall(params: IncomingCallParams): Promise<TelephonyResponse>
  abstract handleCaptchaResponse(params: CaptchaResponseParams): Promise<TelephonyResponse>
  abstract handleCallAnswered(params: CallAnsweredParams): Promise<TelephonyResponse>
  abstract handleVoicemail(params: VoicemailParams): Promise<TelephonyResponse>
  abstract handleWaitMusic(
    lang: string,
    audioUrls?: AudioUrlMap,
    queueTime?: number,
    queueTimeout?: number,
  ): Promise<TelephonyResponse>
  abstract rejectCall(): TelephonyResponse
  abstract handleVoicemailComplete(lang: string): TelephonyResponse
  abstract emptyResponse(): TelephonyResponse

  /** ARI and ESL both express "end this leg" as a hangup command. */
  hangupResponse(): TelephonyResponse {
    return this.rejectCall()
  }

  // --- Call management (shared — REST calls to bridge) ---

  async hangupCall(callSid: string): Promise<void> {
    await this.bridgeRequest('POST', '/hangup', { channelId: callSid })
  }

  async ringVolunteers(params: RingVolunteersParams): Promise<string[]> {
    const { callSid, callerNumber, volunteers, callbackUrl, hubId } = params
    const result = await this.bridgeRequest('POST', '/ring', {
      parentCallSid: callSid,
      callerNumber,
      volunteers: volunteers.map((v) => ({ pubkey: v.callToken, phone: v.phone })),
      callbackUrl,
      hubId,
    })
    return (result as { channelIds?: string[] })?.channelIds ?? []
  }

  async cancelRinging(callSids: string[], exceptSid?: string): Promise<void> {
    await this.bridgeRequest('POST', '/cancel-ringing', {
      channelIds: callSids,
      exceptId: exceptSid,
    })
  }

  async getCallRecording(callSid: string): Promise<ArrayBuffer | null> {
    return this.fetchRecording(`/recordings/call/${callSid}`)
  }

  async getRecordingAudio(recordingSid: string): Promise<ArrayBuffer | null> {
    return this.fetchRecording(`/recordings/${recordingSid}`)
  }

  // --- Webhook validation (shared) ---

  async validateWebhook(request: Request): Promise<boolean> {
    const signature = request.headers.get('X-Bridge-Signature')
    if (!signature) return false

    const body = await request.clone().text()
    const timestamp = request.headers.get('X-Bridge-Timestamp') || ''
    const url = request.url

    // W05-M08: Reject webhooks with timestamps older than 60 seconds (tightened from 300s)
    const tsMs = parseInt(timestamp, 10)
    if (isNaN(tsMs) || Math.abs(Date.now() - tsMs) > 60_000) {
      return false
    }

    const payload = `${timestamp}.${url}.${body}`

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(this.bridgeSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
    const expectedSig = btoa(String.fromCharCode(...new Uint8Array(sig)))

    // Constant-time comparison to prevent timing attacks
    if (signature.length !== expectedSig.length) return false
    const encoder = new TextEncoder()
    const aBuf = encoder.encode(signature)
    const bBuf = encoder.encode(expectedSig)
    let result = 0
    for (let i = 0; i < aBuf.length; i++) {
      result |= aBuf[i] ^ bBuf[i]
    }
    return result === 0
  }

  // --- Webhook parsing (shared — JSON payloads from bridge) ---

  async parseIncomingWebhook(request: Request): Promise<WebhookCallInfo> {
    const data = (await request.clone().json()) as BridgeWebhookPayload
    return {
      callSid: data.channelId || data.callSid || '',
      callerNumber: data.callerNumber || data.from || '',
      calledNumber: data.calledNumber || data.to || undefined,
    }
  }

  async parseLanguageWebhook(request: Request): Promise<WebhookCallInfo & WebhookDigits> {
    const data = (await request.clone().json()) as BridgeWebhookPayload
    return {
      callSid: data.channelId || data.callSid || '',
      callerNumber: data.callerNumber || data.from || '',
      digits: data.digits || '',
    }
  }

  async parseCaptchaWebhook(request: Request): Promise<WebhookDigits & { callerNumber: string }> {
    const data = (await request.clone().json()) as BridgeWebhookPayload
    return {
      digits: data.digits || '',
      callerNumber: data.callerNumber || data.from || '',
    }
  }

  async parseCallStatusWebhook(request: Request): Promise<WebhookCallStatus> {
    const data = (await request.clone().json()) as BridgeWebhookPayload
    return { status: mapBridgeStatus(data.state || data.status || '') }
  }

  async parseQueueWaitWebhook(request: Request): Promise<WebhookQueueWait> {
    const data = (await request.clone().json()) as BridgeWebhookPayload
    return { queueTime: data.queueTime || 0 }
  }

  async parseQueueExitWebhook(request: Request): Promise<WebhookQueueResult> {
    const data = (await request.clone().json()) as BridgeWebhookPayload
    return { result: mapQueueResult(data.result || data.reason || '') }
  }

  async parseRecordingWebhook(request: Request): Promise<WebhookRecordingStatus> {
    const data = (await request.clone().json()) as BridgeWebhookPayload
    return {
      status: data.recordingStatus === 'done' ? 'completed' : 'failed',
      recordingSid: data.recordingName || data.recordingSid,
      callSid: data.channelId || data.callSid,
    }
  }

  // --- Protected helpers for subclasses ---

  protected json(commands: unknown[]): TelephonyResponse {
    return {
      contentType: 'application/json',
      body: JSON.stringify({ commands }),
    }
  }

  protected speak(text: string, lang: string): { action: 'speak'; text: string; language: string } {
    return { action: 'speak', text, language: this.mapLanguage(lang) }
  }

  protected play(url: string): { action: 'play'; url: string } {
    return { action: 'play', url }
  }

  /**
   * Language code mapping — subclasses can override for PBX-specific TTS engines.
   * Default maps common locale codes to TTS engine language codes.
   */
  protected mapLanguage(lang: string): string {
    return lang
  }

  // --- Private helpers ---

  private async fetchRecording(path: string): Promise<ArrayBuffer | null> {
    try {
      const result = await this.bridgeRequest('GET', path)
      if (result && typeof result === 'object' && 'audio' in result) {
        const base64 = (result as { audio: string }).audio
        const binary = atob(base64)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
        return bytes.buffer
      }
      return null
    } catch {
      return null
    }
  }

  protected async bridgeRequest(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = `${this.bridgeCallbackUrl}${path}`
    const timestamp = Date.now().toString()
    const bodyStr = body ? JSON.stringify(body) : ''
    const payload = `${timestamp}.${url}.${bodyStr}`

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(this.bridgeSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
    const signature = btoa(String.fromCharCode(...new Uint8Array(sig)))

    const response = await safeFetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Signature': signature,
        'X-Bridge-Timestamp': timestamp,
      },
      body: bodyStr || undefined,
      timeoutMs: 10_000,
      ssrfGuard: false,
    })

    if (!response.ok) {
      throw new Error(
        `${this.getPbxType()} bridge request failed: ${response.status} ${response.statusText}`
      )
    }

    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      return response.json()
    }
    return null
  }
}

// --- Shared helpers ---

function mapBridgeStatus(state: string): WebhookCallStatus['status'] {
  switch (state.toLowerCase()) {
    case 'ring':
    case 'ringing':
      return 'ringing'
    case 'up':
    case 'answered':
      return 'answered'
    case 'down':
    case 'hangup':
    case 'completed':
      return 'completed'
    case 'busy':
      return 'busy'
    case 'noanswer':
    case 'no-answer':
      return 'no-answer'
    case 'congestion':
    case 'failed':
      return 'failed'
    default:
      return 'initiated'
  }
}

function mapQueueResult(result: string): WebhookQueueResult['result'] {
  switch (result.toLowerCase()) {
    case 'bridged':
    case 'answered':
      return 'bridged'
    case 'leave':
    case 'timeout':
      return 'leave'
    case 'full':
    case 'queue-full':
      return 'queue-full'
    case 'hangup':
    case 'caller-hangup':
      return 'hangup'
    default:
      return 'error'
  }
}
