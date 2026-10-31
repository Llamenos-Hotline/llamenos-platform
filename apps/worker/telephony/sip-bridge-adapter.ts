import { safeFetch } from '../lib/safe-fetch'
import { getPrompt } from '@shared/voice-prompts'
import { speechLanguageFor } from '../services/ivr-speech/voices'
import { AllDialsFailedError, ProviderRecordingDeleteError } from './adapter'
import type {
  ProviderRecordingPosture,
  ProviderRetentionStatement,
  ProviderSettingEnforcement,
} from '@protocol/schemas/settings'
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
  SpeechUrlBuilder,
  WebhookCallInfo,
  WebhookDigits,
  WebhookCallStatus,
  WebhookQueueResult,
  WebhookQueueWait,
  WebhookRecordingStatus,
  RecordingPostureContext,
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
 * `error` code the bridge's /ring answers a total outage with (every leg refused by the
 * PBX/trunk). Mirrors RING_ALL_DIALS_FAILED in sip-bridge/src/command-handler.ts — the
 * two sides are separate packages, so keep them in step.
 */
const BRIDGE_ALL_DIALS_FAILED = 'all-dials-failed'

/**
 * A non-2xx answer from the bridge. Carries the bridge's machine-readable `error` code
 * (and, for a total ring outage, how many legs it tried) so callers can classify the
 * failure instead of pattern-matching the message.
 */
class BridgeRequestError extends Error {
  readonly code?: string
  readonly attempted?: number

  constructor(message: string, body: unknown) {
    super(message)
    this.name = 'BridgeRequestError'
    if (body && typeof body === 'object') {
      const { error, attempted } = body as { error?: unknown; attempted?: unknown }
      if (typeof error === 'string') this.code = error
      if (typeof attempted === 'number') this.attempted = attempted
    }
  }
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
    speechUrl?: SpeechUrlBuilder,
  ): Promise<TelephonyResponse>
  abstract rejectCall(): TelephonyResponse
  abstract handleVoicemailComplete(lang: string, speechUrl?: SpeechUrlBuilder): TelephonyResponse
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
    const { callSid, callerNumber, volunteers, appTargets, callbackUrl, hubId } = params
    let result: unknown
    try {
      result = await this.bridgeRequest('POST', '/ring', {
        parentCallSid: callSid,
        callerNumber,
        volunteers: volunteers.map((v) => ({ pubkey: v.callToken, phone: v.phone })),
        // In-app legs are INVITEs to a registered AOR on this PBX, not calls out
        // through the trunk, so the bridge needs them as their own list. Omitted
        // entirely when there are none, so the bridge's payload is unchanged for
        // a phone-only call.
        ...(appTargets && appTargets.length > 0
          ? { appTargets: appTargets.map((t) => ({ callToken: t.callToken, sipAor: t.sipAor })) }
          : {}),
        callbackUrl,
        hubId,
      })
    } catch (err) {
      // The bridge dials each volunteer leg independently and answers a total outage
      // (every leg refused by the PBX/trunk) with a machine-readable 502, distinct from
      // any other /ring failure. Surface that the same way the REST adapters do — see
      // AllDialsFailedError — so services/ringing.ts retries, the breaker sees it, and
      // the call is reported as a telephony failure rather than a generic error (#1136).
      // A caller who hung up before ringing comes back as a plain empty 200, which is
      // not an outage and must not be counted as one.
      if (err instanceof BridgeRequestError && err.code === BRIDGE_ALL_DIALS_FAILED) {
        throw new AllDialsFailedError(err.attempted ?? volunteers.length + (appTargets?.length ?? 0))
      }
      throw err
    }
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
    return this.fetchRecording(`/recordings/${encodeURIComponent(recordingSid)}`)
  }

  /**
   * The handle is the bridge's recording name (`voicemail-<channel>` /
   * `call-<channel>`). The bridge answers 200 only once the PBX's stored file
   * is gone (or was already gone); any other answer is a failure here.
   */
  providerAccountId(): string {
    return `${this.getPbxType().toLowerCase()}:${this.bridgeCallbackUrl}`
  }

  async deleteRecording(recordingSid: string): Promise<void> {
    try {
      await this.bridgeRequest('DELETE', `/recordings/${encodeURIComponent(recordingSid)}`)
    } catch (err) {
      throw new ProviderRecordingDeleteError(
        this.getPbxType(),
        null,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  /**
   * The PBX is ours, and the bridge records only on this server's command —
   * but a recording configured in the PBX's own dialplan (MixMonitor,
   * record_session) or a speech module never passes through the bridge, so
   * neither can be read from here. Reported unknown, not assumed off.
   */
  async probeRecordingPosture(_context: RecordingPostureContext): Promise<ProviderRecordingPosture> {
    const pbx = this.getPbxType()
    return {
      recording: {
        state: 'unknown',
        reason: `recording configured in the ${pbx} dialplan itself does not pass through the bridge and cannot be read from here`,
      },
      transcription: {
        state: 'unknown',
        reason: `a speech-to-text module loaded in ${pbx} does not pass through the bridge and cannot be read from here`,
      },
    }
  }

  /** Nothing is writable through the bridge: recording and speech modules are PBX-host configuration. */
  async enforceRecordingPosture(): Promise<ProviderSettingEnforcement[]> {
    const pbx = this.getPbxType()
    return [
      { setting: 'recording', target: `${pbx} dialplan`, outcome: 'not-settable', reason: `recording configured in the ${pbx} dialplan is host configuration the bridge cannot change` },
      { setting: 'transcription', target: `${pbx} modules`, outcome: 'not-settable', reason: `a speech-to-text module loaded in ${pbx} is host configuration the bridge cannot change` },
    ]
  }

  providerRetention(): ProviderRetentionStatement {
    const pbx = this.getPbxType()
    return {
      removed: [
        {
          what: 'Voicemail and call recordings on the PBX host',
          how: 'The bridge\'s signed DELETE /recordings/:name once fetched — a call recording after the server holds its own sealed copy. A refusal stays in heldAtProvider and is retried.',
        },
      ],
      retained: [
        {
          what: `${pbx} call detail records and logs on the PBX host`,
          reason: 'They live on the operator\'s own PBX host and are governed by its CDR configuration, not by this server (PBX retention policy: #1320).',
        },
        {
          what: 'Call detail records at the upstream SIP trunk carrier',
          reason: 'The carrier behind the PBX is outside this server\'s reach.',
        },
      ],
      source: `${pbx} deployment configuration of this project, checked 2026-10-29`,
    }
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

  /** The bridge signs `${timestamp}.${url}.${body}` — exactly that is the key. */
  async webhookReplayKey(request: Request): Promise<string> {
    return `${request.headers.get('X-Bridge-Timestamp') || ''}.${request.url}.${await request.clone().text()}`
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

  protected play(url: string): { action: 'play'; url: string } {
    return { action: 'play', url }
  }

  // --- Prompts (shared) ---
  //
  // A PBX has no speech engine the app can rely on, so every prompt is played
  // from a URL: the operator's upload for the caller's language when there is
  // one, else the prompt as speech the worker generates (IvrSpeechService).

  /**
   * Where a prompt is played from. A recording always beats generated speech:
   * the operator's upload in the caller's language; else, when no voice speaks
   * that language, the upload in the language their prompts fall back to; else
   * the prompt as generated speech.
   */
  protected promptUrl(
    promptKey: string,
    lang: string,
    audioUrls: AudioUrlMap | undefined,
    speechUrl: SpeechUrlBuilder | undefined,
    text: (speechLang: string) => string = (speechLang) => getPrompt(promptKey, speechLang),
  ): string {
    const own = audioUrls?.[`${promptKey}:${lang}`]
    if (own) return own
    const speechLang = speechLanguageFor(lang)
    const fallback = speechLang === lang ? undefined : audioUrls?.[`${promptKey}:${speechLang}`]
    return fallback ?? this.generatedSpeechUrl(text, lang, speechUrl)
  }

  /**
   * Text as generated speech, in the language the caller's prompts are spoken
   * in: theirs, or the declared fallback when no offline voice speaks it.
   */
  protected generatedSpeechUrl(
    text: (speechLang: string) => string,
    lang: string,
    speechUrl: SpeechUrlBuilder | undefined,
  ): string {
    if (!speechUrl) {
      throw new Error(`${this.getPbxType()} cannot speak a prompt itself: the route must pass a speech URL builder`)
    }
    const speechLang = speechLanguageFor(lang)
    return speechUrl(text(speechLang), speechLang)
  }

  /**
   * A voice CAPTCHA's digits as generated speech, one clip per digit: ten
   * clips a language, shared by every call, where a clip per challenge would
   * leave a PBX media-cache entry (never evicted) per call. Each clip's URL
   * hides its digit, so the answer is in no log and no cache key (#1352).
   */
  protected captchaDigitUrls(digits: string, lang: string, speechUrl: SpeechUrlBuilder | undefined): string[] {
    if (!speechUrl) {
      throw new Error(`${this.getPbxType()} cannot speak a CAPTCHA itself: the route must pass a speech URL builder`)
    }
    const speechLang = speechLanguageFor(lang)
    return digits.split('').map((digit) => speechUrl.captchaDigit(digit, speechLang))
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
      // Best effort: a proxy's HTML error page or a bare 500 simply carries no code.
      let failure: unknown = null
      try {
        failure = await response.json()
      } catch {
        // no JSON body — leave the error uncoded
      }
      throw new BridgeRequestError(
        `${this.getPbxType()} bridge request failed: ${response.status} ${response.statusText}`,
        failure
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
