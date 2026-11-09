import { safeFetch } from '../lib/safe-fetch'
import { createLogger } from '../lib/logger'
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
  RecordingPostureContext,
} from './adapter'
import {
  ProviderRecordingDeleteError,
  assertRecordingDeleted,
  collectRingResults,
  combineReadings,
  enforcementFailed,
  inventoryReading,
  unreadable,
} from './adapter'
import type {
  ProviderRecordingPosture,
  ProviderRetentionStatement,
  ProviderSettingEnforcement,
  ProviderSettingReading,
} from '@protocol/schemas/settings'
import { getPrompt, getVoicemailThanks } from '@shared/voice-prompts'
import { IvrVoiceCatalog, buildIvrLanguageMenu } from './ivr-menu'
import { holdMusicUrl } from './hold-music'
import { isMachineAnsweredBy } from './twilio'

const TELNYX_API_BASE = 'https://api.telnyx.com/v2'

/** A recording resource from GET /v2/recordings/{id}. */
interface TelnyxRecording {
  id: string
  created_at?: string
  download_urls?: { mp3?: string; wav?: string }
}

/** A Telnyx TeXML `<Say>` voice: the Polly voice id, plus the locale it speaks. */
interface TelnyxVoice {
  voice: string
  language: string
}

/**
 * Telnyx TTS voices (AWS Polly via Telnyx) — the explicit, ordered list of
 * locales Telnyx has a voice for. Absent locales are never offered in the IVR menu.
 * `voice` is the `<Say voice>` value in Telnyx's direct Polly notation.
 */
export const TELNYX_VOICES = new IvrVoiceCatalog<TelnyxVoice>('telnyx', [
  ['en', { voice: 'AWS.Polly.Joanna-Neural', language: 'en-US' }],
  ['es', { voice: 'AWS.Polly.Lupe-Neural', language: 'es-US' }],
  ['zh', { voice: 'AWS.Polly.Zhiyu-Neural', language: 'cmn-CN' }],
  ['ar', { voice: 'AWS.Polly.Zeina', language: 'arb' }],
  ['fr', { voice: 'AWS.Polly.Lea-Neural', language: 'fr-FR' }],
  ['ko', { voice: 'AWS.Polly.Seoyeon-Neural', language: 'ko-KR' }],
  ['ru', { voice: 'AWS.Polly.Tatyana', language: 'ru-RU' }],
  ['hi', { voice: 'AWS.Polly.Kajal-Neural', language: 'hi-IN' }],
  ['pt', { voice: 'AWS.Polly.Camila-Neural', language: 'pt-BR' }],
  ['de', { voice: 'AWS.Polly.Vicki-Neural', language: 'de-DE' }],
])

/** Escape XML special characters for safe TeXML embedding */
function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/** `<Say>` in the locale's Telnyx voice */
function say(lang: string, text: string): string {
  const { voice, language } = TELNYX_VOICES.voiceForPrompt(lang)
  return `<Say voice="${voice}" language="${language}">${escapeXml(text)}</Say>`
}

/** Generate TeXML: `<Play>` if custom audio exists, `<Say>` fallback. Uploaded audio always wins (#1350). */
function sayOrPlay(promptKey: string, lang: string, audioUrls?: AudioUrlMap, text?: string): string {
  const audioUrl = audioUrls?.[`${promptKey}:${lang}`]
  if (audioUrl) return `<Play>${escapeXml(audioUrl)}</Play>`
  return say(lang, text ?? getPrompt(promptKey, lang))
}

/** Hub query param suffix for a callback URL */
function hubQP(hubId?: string): string {
  return hubId ? `&hub=${encodeURIComponent(hubId)}` : ''
}

/**
 * Thin wrapper around the Telnyx v2 REST API: the TeXML call-creation endpoint,
 * call hangup, recordings, and the account's webhook-signing public key.
 */
class TelnyxApiClient {
  private apiKey: string
  private cachedPublicKey: string | null = null

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  /** End a call leg. A TeXML `CallSid` is the leg's call control id, which this endpoint takes. */
  async hangup(callSid: string): Promise<void> {
    const url = `${TELNYX_API_BASE}/calls/${encodeURIComponent(callSid)}/actions/hangup`
    const res = await safeFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })

    if (!res.ok) {
      const errorText = await res.text().catch(() => 'unknown error')
      throw new Error(`Telnyx API error (hangup): ${res.status} ${errorText}`)
    }
  }

  /**
   * Place an outbound call through the TeXML application (connection-scoped
   * endpoint, so no account id is needed). Telnyx fetches the call's
   * instructions from `Url` once the callee answers — NOT on every call event —
   * and reports progress to `StatusCallback`.
   */
  async createTexmlCall(connectionId: string, params: {
    To: string
    From: string
    Url: string
    StatusCallback: string
    Timeout: number
    MachineDetection: 'Enable'
  }): Promise<string> {
    const res = await safeFetch(`${TELNYX_API_BASE}/texml/calls/${encodeURIComponent(connectionId)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...params,
        Method: 'POST',
        StatusCallbackMethod: 'POST',
        StatusCallbackEvent: 'initiated ringing answered completed',
      }),
    })

    if (!res.ok) {
      const errorText = await res.text().catch(() => 'unknown error')
      throw new Error(`Telnyx API error (createTexmlCall): ${res.status} ${errorText}`)
    }

    const data = await res.json() as { call_sid?: string }
    if (!data.call_sid) throw new Error('Telnyx API error (createTexmlCall): the response carried no call_sid')
    return data.call_sid
  }

  async getRecording(url: string): Promise<ArrayBuffer> {
    const res = await safeFetch(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      timeoutMs: 60_000,
    })
    if (!res.ok) {
      throw new Error(`Telnyx API error (getRecording): ${res.status}`)
    }
    return res.arrayBuffer()
  }

  /** An authenticated request against the v2 REST API. Network failures reject. */
  async api(method: 'GET' | 'DELETE' | 'PATCH', path: string, body?: unknown): Promise<Response> {
    return safeFetch(`${TELNYX_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }

  async getPublicKey(): Promise<string> {
    const url = `${TELNYX_API_BASE}/public_key`
    const res = await safeFetch(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    })
    if (!res.ok) {
      throw new Error(`Telnyx API error (getPublicKey): ${res.status}`)
    }
    const data = await res.json() as { data: { public_key: string } }
    return data.data.public_key
  }

  async verifyWebhookSignature(signature: string, timestamp: string, rawBody: string): Promise<boolean> {
    if (!this.cachedPublicKey) {
      this.cachedPublicKey = await this.getPublicKey()
    }

    const signingPayload = `${timestamp}|${rawBody}`
    const pubKeyBytes = Uint8Array.from(atob(this.cachedPublicKey), (c) => c.charCodeAt(0))
    const sigBytes = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0))
    const payloadBytes = new TextEncoder().encode(signingPayload)

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      pubKeyBytes,
      { name: 'Ed25519' },
      false,
      ['verify'],
    )
    return crypto.subtle.verify('Ed25519', cryptoKey, sigBytes, payloadBytes)
  }
}

/** Telnyx's `CallStatus` / `DialCallStatus` values, normalised. */
const CALL_STATUS_MAP: Record<string, WebhookCallStatus['status']> = {
  initiated: 'initiated',
  queued: 'initiated',
  ringing: 'ringing',
  'in-progress': 'answered',
  completed: 'completed',
  busy: 'busy',
  'no-answer': 'no-answer',
  failed: 'failed',
  canceled: 'failed',
}

/** `QueueResult` of an `<Enqueue action>` request, normalised. */
const QUEUE_RESULT_MAP: Record<string, WebhookQueueResult['result']> = {
  leave: 'leave',
  'queue-full': 'queue-full',
  error: 'error',
  bridged: 'bridged',
  hangup: 'hangup',
}

const logger = createLogger('telephony.telnyx')

/**
 * TelnyxAdapter — Telnyx TeXML application implementation.
 *
 * TeXML is Telnyx's TwiML-compatible model: every IVR step is a TeXML document
 * returned from a webhook, and each step names the URL of the next one
 * (`<Gather action>`, `<Redirect>`, `<Enqueue action>`, `<Record action>`). The
 * route a callback reaches therefore says which step it belongs to, which is
 * what the Call Control event model could not do (#2305). REST is used only to
 * place a volunteer's ring leg, to end a leg, and for recordings.
 */
export class TelnyxAdapter implements TelephonyAdapter {
  private client: TelnyxApiClient
  private connectionId: string
  private phoneNumber: string
  private webhookBaseUrl: string

  /**
   * `connectionId` is the TeXML application's id. `webhookBaseUrl` is the
   * public origin Telnyx reaches this server on; callback URLs inside TeXML
   * documents are absolute when it is set.
   */
  constructor(apiKey: string, connectionId: string, phoneNumber: string, webhookBaseUrl = '') {
    this.client = new TelnyxApiClient(apiKey)
    this.connectionId = connectionId
    this.phoneNumber = phoneNumber
    this.webhookBaseUrl = webhookBaseUrl.replace(/\/+$/, '')
  }

  /** An absolute (or, with no base configured, root-relative) URL of one of this server's telephony webhooks, XML-escaped. */
  private hook(pathAndQuery: string): string {
    return escapeXml(`${this.webhookBaseUrl}/api/telephony/${pathAndQuery}`)
  }

  // --- IVR Methods ---

  async handleLanguageMenu(params: LanguageMenuParams): Promise<TelephonyResponse> {
    const menu = buildIvrLanguageMenu(params.enabledLanguages, TELNYX_VOICES)
    const hp = hubQP(params.hubId)

    if (menu.kind === 'single') {
      return this.texml(`
        <Response>
          <Redirect method="POST">${this.hook(`language-selected?auto=1&forceLang=${menu.language}${hp}`)}</Redirect>
        </Response>
      `)
    }

    const hubParam = params.hubId ? `?hub=${encodeURIComponent(params.hubId)}` : ''
    const sayElements = menu.options
      .map(o => `<Say voice="${o.voice.voice}" language="${o.voice.language}">${escapeXml(o.prompt)}</Say>`)
      .join('\n          ')

    return this.texml(`
      <Response>
        <Gather numDigits="1" action="${this.hook(`language-selected${hubParam}`)}" timeout="8">
          ${sayElements}
        </Gather>
        <Redirect method="POST">${this.hook(`language-selected?auto=1${hp}`)}</Redirect>
      </Response>
    `)
  }

  async handleIncomingCall(params: IncomingCallParams): Promise<TelephonyResponse> {
    const lang = params.callerLanguage
    const greetingText = getPrompt('greeting', lang).replace('{name}', params.hotlineName)
    const greetingTexml = sayOrPlay('greeting', lang, params.audioUrls, greetingText)
    // #1505: disclose provider-side recording before the caller can be connected.
    // Not spoken on the rate-limited path below — that call is hung up, never recorded.
    const noticeTexml = params.callRecordingEnabled
      ? sayOrPlay('recordingNotice', lang, params.audioUrls)
      : ''

    if (params.rateLimited) {
      const rateLimitTexml = sayOrPlay('rateLimited', lang, params.audioUrls)
      return this.texml(`
        <Response>
          ${greetingTexml}
          ${rateLimitTexml}
          <Hangup/>
        </Response>
      `)
    }

    if (params.voiceCaptchaEnabled && params.captchaDigits) {
      const captchaTexml = sayOrPlay('captchaPrompt', lang, params.audioUrls)
      return this.texml(`
        <Response>
          ${this.captchaChallenge(params.callSid, lang, params.hubId, params.captchaDigits, greetingTexml + noticeTexml + captchaTexml, 0)}
        </Response>
      `)
    }

    const holdTexml = sayOrPlay('pleaseHold', lang, params.audioUrls)
    return this.texml(`
      <Response>
        ${greetingTexml}
        ${noticeTexml}
        ${holdTexml}
        ${this.enqueue(params.callSid, lang, params.hubId)}
      </Response>
    `)
  }

  async handleCaptchaResponse(params: CaptchaResponseParams): Promise<TelephonyResponse> {
    const lang = params.callerLanguage

    if (params.outcome === 'pass') {
      return this.texml(`
        <Response>
          ${say(lang, getPrompt('captchaSuccess', lang))}
          ${this.enqueue(params.callSid, lang, params.hubId)}
        </Response>
      `)
    }

    const lead = params.outcome === 'retry'
      ? sayOrPlay('captchaRetry', lang)
      : sayOrPlay('captchaPrompt', lang, params.audioUrls)
    return this.texml(`
      <Response>
        ${this.captchaChallenge(params.callSid, lang, params.hubId, params.digitsToSpeak, lead, params.round)}
      </Response>
    `)
  }

  /**
   * Put the caller in the queue named for their call. Hold music and the wait
   * message come from `/wait-music` (re-requested by Telnyx each time the wait
   * document finishes); `/queue-exit` runs when the caller leaves the queue.
   */
  private enqueue(callSid: string, lang: string, hubId: string | undefined): string {
    const hp = hubQP(hubId)
    return `<Enqueue waitUrl="${this.hook(`wait-music?lang=${lang}${hp}`)}" waitUrlMethod="POST" action="${this.hook(`queue-exit?callSid=${encodeURIComponent(callSid)}&lang=${lang}${hp}`)}" method="POST">${escapeXml(callSid)}</Enqueue>`
  }

  /**
   * One CAPTCHA challenge: `lead`, the digits, the star hint, then a gather for
   * the answer. A gather that hears nothing falls through to the `<Redirect>`
   * to the same route, so the server learns of the timeout as a submission with
   * no digits and counts it.
   */
  private captchaChallenge(callSid: string, lang: string, hubId: string | undefined, digits: string, lead: string, round: number): string {
    const action = this.hook(`captcha?callSid=${encodeURIComponent(callSid)}&lang=${lang}&round=${round}${hubQP(hubId)}`)
    return `
          <Gather numDigits="4" validDigits="0123456789*" action="${action}" timeout="10">
            ${lead}
            ${say(lang, `${digits.split('').join(', ')}.`)}
            ${sayOrPlay('captchaRepeatHint', lang)}
          </Gather>
          <Redirect method="POST">${action}</Redirect>`
  }

  async handleCallAnswered(params: CallAnsweredParams): Promise<TelephonyResponse> {
    // CRIT-W1: Hub and pubkey are resolved from DB in /call-recording — no URL params needed
    // #1505: no recording attributes at all unless this hub opted in. An absent
    // `record` attribute means Telnyx never writes the audio to disk.
    // Telnyx documents `<Dial record>` for the Number and Sip nouns only; a
    // queue bridge is not on that list, so say so each time it is asked for.
    if (params.recordCall) {
      logger.warn('Call recording requested on a <Dial><Queue> bridge, which Telnyx does not list as recordable — the recording may not be made')
    }
    const recordAttrs = params.recordCall
      ? ` record="record-from-answer" recordingStatusCallback="${escapeXml(`${params.callbackUrl}/api/telephony/call-recording?parentCallSid=${encodeURIComponent(params.parentCallSid)}`)}" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed"`
      : ''
    return this.texml(`
      <Response>
        <Dial${recordAttrs}>
          <Queue>${escapeXml(params.parentCallSid)}</Queue>
        </Dial>
      </Response>
    `)
  }

  async handleVoicemail(params: VoicemailParams): Promise<TelephonyResponse> {
    const lang = params.callerLanguage
    const hp = hubQP(params.hubId)
    const voicemailTexml = sayOrPlay('voicemailPrompt', lang, params.audioUrls)
    const complete = this.hook(`voicemail-complete?callSid=${encodeURIComponent(params.callSid)}&lang=${lang}${hp}`)
    const recordingCallback = escapeXml(`${params.callbackUrl}/api/telephony/voicemail-recording?callSid=${encodeURIComponent(params.callSid)}${hp}`)
    return this.texml(`
      <Response>
        ${voicemailTexml}
        <Record maxLength="${params.maxRecordingSeconds ?? 120}" playBeep="true" action="${complete}" method="POST" recordingStatusCallback="${recordingCallback}" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed"/>
        <Hangup/>
      </Response>
    `)
  }

  async handleWaitMusic(
    lang: string,
    audioUrls?: AudioUrlMap,
    queueTime?: number,
    queueTimeout?: number,
  ): Promise<TelephonyResponse> {
    // After timeout in queue with no answer, leave queue → triggers voicemail
    if (queueTime !== undefined && queueTime >= (queueTimeout ?? 90)) {
      return this.texml('<Response><Leave/></Response>')
    }

    const waitTexml = sayOrPlay('waitMessage', lang, audioUrls)
    const holdMusic = holdMusicUrl(audioUrls)
    return this.texml(`
      <Response>
        ${waitTexml}
        ${holdMusic ? `<Play>${escapeXml(holdMusic)}</Play>` : ''}
      </Response>
    `)
  }

  handleVoicemailComplete(lang: string): TelephonyResponse {
    return this.texml(`
      <Response>
        ${say(lang, getVoicemailThanks(lang))}
        <Hangup/>
      </Response>
    `)
  }

  rejectCall(): TelephonyResponse {
    return this.texml('<Response><Reject reason="rejected"/></Response>')
  }

  hangupResponse(): TelephonyResponse {
    return this.texml('<Response><Hangup/></Response>')
  }

  emptyResponse(): TelephonyResponse {
    return this.texml('<Response/>')
  }

  private texml(xml: string): TelephonyResponse {
    return { contentType: 'text/xml', body: xml.trim() }
  }

  // --- Call Control Methods ---

  async hangupCall(callSid: string): Promise<void> {
    await this.client.hangup(callSid)
  }

  async ringVolunteers(params: RingVolunteersParams): Promise<string[]> {
    const hubParam = hubQP(params.hubId)

    const calls = await Promise.allSettled(
      params.volunteers.map((vol) => {
        // CRIT-W2: Use opaque callToken instead of raw pubkey in callback URLs.
        // `Url` is fetched when the volunteer ANSWERS and nothing else; every
        // progress event (initiated, ringing, answered, completed) goes to
        // `StatusCallback`. A single URL for both is what made call.initiated
        // claim the answer before anyone picked up (#1135).
        const token = encodeURIComponent(vol.callToken)
        return this.client.createTexmlCall(this.connectionId, {
          To: vol.phone,
          From: this.phoneNumber,
          Url: `${params.callbackUrl}/api/telephony/user-answer?callToken=${token}${hubParam}`,
          StatusCallback: `${params.callbackUrl}/api/telephony/call-status?callToken=${token}${hubParam}`,
          Timeout: 30,
          MachineDetection: 'Enable',
        })
      }),
    )

    // Throws when EVERY leg failed (total outage) — see AllDialsFailedError. A partial
    // failure returns whatever succeeded (#1136).
    return collectRingResults(calls, 'Telnyx', (msg, err) => logger.error(msg, err))
  }

  async cancelRinging(callSids: string[], exceptSid?: string): Promise<void> {
    await Promise.allSettled(
      callSids
        .filter((sid) => sid !== exceptSid)
        .map((sid) => this.client.hangup(sid)),
    )
  }

  // --- Recording Methods ---

  async getCallRecording(_callSid: string): Promise<ArrayBuffer | null> {
    return null
  }

  /**
   * The recording handle is the `RecordingSid` of the recording-status
   * callback — the id of the recording resource, which `/v2/recordings/{id}`
   * returns with its download URLs and deletes.
   */
  async getRecordingAudio(recordingSid: string): Promise<ArrayBuffer | null> {
    try {
      const res = await this.client.api('GET', `/recordings/${encodeURIComponent(recordingSid)}`)
      if (!res.ok) return null
      const body = await res.json() as { data?: TelnyxRecording }
      const url = body.data?.download_urls?.mp3 ?? body.data?.download_urls?.wav
      if (!url) return null
      return await this.client.getRecording(url)
    } catch {
      return null
    }
  }

  /**
   * The TeXML application (connection) id: not a secret, and a connection
   * belongs to exactly one Telnyx account. Never the API key.
   */
  providerAccountId(): string {
    return `telnyx:${this.connectionId}`
  }

  /** Telnyx fills the form-encoded `ConnectionId` in TeXML requests. Exactly one must be present: a body repeating the field is not one Telnyx wrote. */
  async webhookNamesOwnAccount(request: Request): Promise<boolean> {
    if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) return false
    try {
      const ids = new URLSearchParams(await request.clone().text()).getAll('ConnectionId')
      return ids.length === 1 && ids[0] === this.connectionId
    } catch {
      return false
    }
  }

  async deleteRecording(recordingSid: string): Promise<void> {
    let res: Response
    try {
      res = await this.client.api('DELETE', `/recordings/${encodeURIComponent(recordingSid)}`)
    } catch (err) {
      if (err instanceof ProviderRecordingDeleteError) throw err
      throw new ProviderRecordingDeleteError('Telnyx', null, err instanceof Error ? err.message : String(err))
    }
    await assertRecordingDeleted(res, 'Telnyx')
  }

  async probeRecordingPosture(context: RecordingPostureContext): Promise<ProviderRecordingPosture> {
    const [numberSetting, inventory, transcripts] = await Promise.all([
      this.readNumberRecordingSetting(),
      this.readRecordingInventory(context),
      this.readTranscriptionInventory(),
    ])
    return {
      recording: combineReadings([numberSetting, inventory]),
      transcription: transcripts,
    }
  }

  /** Telnyx records every inbound call to a number when its voice settings say so. */
  private async readNumberRecordingSetting(): Promise<ProviderSettingReading> {
    const read = await this.readNumberVoice()
    if ('reading' in read) return read.reading
    return read.enabled
      ? { state: 'on', evidence: `${this.phoneNumber} has inbound call recording enabled` }
      : { state: 'off', evidence: `${this.phoneNumber} has inbound call recording disabled` }
  }

  /** The number's id and its `inbound_call_recording_enabled`, or why they could not be read. */
  private async readNumberVoice(): Promise<{ id: string; enabled: boolean } | { reading: Extract<ProviderSettingReading, { state: 'unknown' }> }> {
    const what = `the voice settings of ${this.phoneNumber}`
    try {
      const listRes = await this.client.api('GET', `/phone_numbers?filter[phone_number]=${encodeURIComponent(this.phoneNumber)}`)
      if (!listRes.ok) return { reading: unreadable('Telnyx', what, listRes) }
      const list = await listRes.json() as { data?: Array<{ id: string }> }
      const id = list.data?.[0]?.id
      if (!id) return { reading: { state: 'unknown', reason: `${this.phoneNumber} is not a number on this Telnyx account` } }
      const voiceRes = await this.client.api('GET', `/phone_numbers/${encodeURIComponent(id)}/voice`)
      if (!voiceRes.ok) return { reading: unreadable('Telnyx', what, voiceRes) }
      const voice = await voiceRes.json() as { data?: { call_recording?: { inbound_call_recording_enabled?: boolean } } }
      const enabled = voice.data?.call_recording?.inbound_call_recording_enabled
      if (enabled === undefined) return { reading: { state: 'unknown', reason: `${what} did not include call_recording` } }
      return { id, enabled }
    } catch (err) {
      return { reading: unreadable('Telnyx', what, err) }
    }
  }

  async enforceRecordingPosture(): Promise<ProviderSettingEnforcement[]> {
    return [
      await this.enforceNumberRecording(),
      {
        setting: 'transcription',
        target: 'account',
        outcome: 'not-settable',
        reason: 'Telnyx documents no account- or number-level transcription switch: a recording transcription exists only when a TeXML verb or command asks for one, which this server never does',
      },
    ]
  }

  /** `PATCH /v2/phone_numbers/{id}/voice` with `call_recording.inbound_call_recording_enabled = false`. */
  private async enforceNumberRecording(): Promise<ProviderSettingEnforcement> {
    const target = `number ${this.phoneNumber}`
    const read = await this.readNumberVoice()
    if ('reading' in read) return { setting: 'recording', target, outcome: 'failed', reason: read.reading.reason }
    if (!read.enabled) {
      return { setting: 'recording', target, outcome: 'already-off', evidence: `${this.phoneNumber} has inbound call recording disabled` }
    }
    let res: Response
    try {
      res = await this.client.api('PATCH', `/phone_numbers/${encodeURIComponent(read.id)}/voice`, {
        call_recording: { inbound_call_recording_enabled: false },
      })
    } catch (err) {
      return enforcementFailed('recording', target, 'Telnyx', err)
    }
    if (!res.ok) return enforcementFailed('recording', target, 'Telnyx', res)
    return { setting: 'recording', target, outcome: 'disabled', evidence: `Telnyx accepted inbound_call_recording_enabled=false for ${this.phoneNumber} (it was enabled)` }
  }

  providerRetention(): ProviderRetentionStatement {
    return {
      removed: [
        {
          what: 'Voicemail and call recordings',
          how: 'DELETE /v2/recordings/{id} once fetched — a call recording after the server holds its own sealed copy. A refusal stays in heldAtProvider and is retried.',
        },
      ],
      retained: [
        {
          what: 'Call detail records of the caller\'s call and of every volunteer ring leg (they name both phone numbers)',
          reason: 'No Telnyx API to delete a call detail record could be found in its documentation.',
        },
        {
          what: 'Messaging detail records, including message text',
          reason: 'Telnyx documents no deletion. Its message redaction blanks text at read time only, only for organisations Telnyx has allowlisted (a PATCH from any other organisation is silently ignored), and never covers records made before it was enabled. This server does not configure it.',
        },
        {
          what: 'Recording transcriptions this server did not request',
          reason: 'Not deleted automatically: they are reported under transcription instead. Telnyx documents DELETE /v2/recording_transcriptions/{id}.',
        },
        {
          what: 'Account usage and billing records',
          reason: 'No Telnyx API to delete them could be found in its documentation.',
        },
      ],
      source: 'Telnyx API documentation (call recordings, phone number voice settings, message redaction), checked 2026-10-29',
    }
  }

  private async readRecordingInventory(context: RecordingPostureContext): Promise<ProviderSettingReading> {
    try {
      const res = await this.client.api('GET', '/recordings?page[size]=50')
      if (!res.ok) return unreadable('Telnyx', 'the account\'s recordings', res)
      const body = await res.json() as { data?: TelnyxRecording[] }
      return inventoryReading({
        provider: 'Telnyx',
        what: 'recordings',
        source: 'the newest Telnyx recordings',
        listed: (body.data ?? []).map(r => ({ handle: r.id, createdAt: r.created_at ? new Date(r.created_at) : null })),
        context,
      })
    } catch (err) {
      return unreadable('Telnyx', 'the account\'s recordings', err)
    }
  }

  /** This server never starts a Telnyx transcription, so any is one it did not request. */
  private async readTranscriptionInventory(): Promise<ProviderSettingReading> {
    try {
      const res = await this.client.api('GET', '/recording_transcriptions')
      if (!res.ok) return unreadable('Telnyx', 'the account\'s recording transcriptions', res)
      const body = await res.json() as { data?: unknown[] }
      const count = body.data?.length ?? 0
      return count > 0
        ? { state: 'on', evidence: `Telnyx holds ${count} recording transcription(s); this server never requests one` }
        : { state: 'off', evidence: 'Telnyx holds no recording transcriptions' }
    } catch (err) {
      return unreadable('Telnyx', 'the account\'s recording transcriptions', err)
    }
  }


  // --- Webhook Validation ---

  /**
   * Telnyx signs the `telnyx-timestamp` header and the raw request body with
   * Ed25519; the verifying key is the account's public key. EVERY inbound
   * request is refused unless that signature verifies — a missing header, a
   * stale timestamp, a key that cannot be fetched, a malformed signature and an
   * empty body all refuse. (An empty body is a GET: the signature would then
   * cover nothing, and every parameter would arrive in the unsigned query.)
   */
  async validateWebhook(request: Request): Promise<boolean> {
    const signature = request.headers.get('telnyx-signature-ed25519')
    const timestamp = request.headers.get('telnyx-timestamp')

    if (!signature || !timestamp) return false

    const ts = Number.parseInt(timestamp, 10)
    if (Number.isNaN(ts)) return false
    const now = Math.floor(Date.now() / 1000)
    if (Math.abs(now - ts) > 60) return false

    try {
      const rawBody = await request.clone().text()
      if (rawBody === '') return false
      return await this.client.verifyWebhookSignature(signature, timestamp, rawBody)
    } catch {
      return false
    }
  }

  /** Telnyx signs the timestamp header and the raw body. */
  async webhookReplayKey(request: Request): Promise<string> {
    return `${request.headers.get('telnyx-timestamp') ?? ''}\n${await request.clone().text()}`
  }

  // --- Webhook Parsing ---

  /** TeXML requests are form-encoded: `CallSid`, `From`, `To`, `Digits`, `CallStatus`, … */
  private async form(request: Request): Promise<URLSearchParams> {
    return new URLSearchParams(await request.clone().text())
  }

  async parseIncomingWebhook(request: Request): Promise<WebhookCallInfo> {
    const form = await this.form(request)
    return {
      callSid: form.get('CallSid') ?? '',
      callerNumber: form.get('From') ?? '',
      calledNumber: form.get('To') || undefined,
      answeredByMachine: isMachineAnsweredBy(form.get('AnsweredBy')),
    }
  }

  async parseLanguageWebhook(request: Request): Promise<WebhookCallInfo & WebhookDigits> {
    const form = await this.form(request)
    return {
      callSid: form.get('CallSid') ?? '',
      callerNumber: form.get('From') ?? '',
      digits: form.get('Digits') ?? '',
    }
  }

  async parseCaptchaWebhook(request: Request): Promise<WebhookDigits & { callerNumber: string }> {
    const form = await this.form(request)
    return {
      digits: form.get('Digits') ?? '',
      callerNumber: form.get('From') ?? '',
    }
  }

  async parseCallStatusWebhook(request: Request): Promise<WebhookCallStatus> {
    const form = await this.form(request)
    const raw = form.get('CallStatus') ?? form.get('DialCallStatus') ?? ''
    return { status: CALL_STATUS_MAP[raw] ?? 'failed' }
  }

  async parseQueueWaitWebhook(request: Request): Promise<WebhookQueueWait> {
    const form = await this.form(request)
    return { queueTime: Number.parseInt(form.get('QueueTime') ?? '0', 10) || 0 }
  }

  async parseQueueExitWebhook(request: Request): Promise<WebhookQueueResult> {
    const form = await this.form(request)
    return { result: QUEUE_RESULT_MAP[form.get('QueueResult') ?? ''] ?? 'error' }
  }

  async parseRecordingWebhook(request: Request): Promise<WebhookRecordingStatus> {
    const form = await this.form(request)
    return {
      status: form.get('RecordingStatus') === 'completed' ? 'completed' : 'failed',
      recordingSid: form.get('RecordingSid') || undefined,
      callSid: form.get('CallSid') || undefined,
    }
  }
}
