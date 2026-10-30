import { safeFetch } from '../lib/safe-fetch'
import { createLogger } from '../lib/logger'
import {
  ProviderRecordingDeleteError,
  assertHangupResponse,
  assertRecordingDeleted,
  collectRingResults,
} from './adapter'
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
import type {
  ProviderRecordingPosture,
  ProviderRetentionStatement,
  ProviderSettingEnforcement,
} from '@protocol/schemas/settings'
import { getPrompt, getVoicemailThanks } from '@shared/voice-prompts'
import { IvrVoiceCatalog, buildIvrLanguageMenu } from './ivr-menu'

/**
 * Vonage NCCO talk `language` codes — the explicit, ordered list of locales
 * Vonage has a voice for. Absent locales are never offered in the IVR menu.
 */
export const VONAGE_VOICES = new IvrVoiceCatalog<{ language: string; style?: number }>('vonage', [
  ['en', { language: 'en-US' }],
  ['es', { language: 'es-MX' }],
  ['zh', { language: 'cmn-CN' }],
  ['tl', { language: 'fil-PH' }],
  ['vi', { language: 'vi-VN' }],
  ['ar', { language: 'ar' }],
  ['fr', { language: 'fr-FR' }],
  ['ko', { language: 'ko-KR' }],
  ['ru', { language: 'ru-RU' }],
  ['hi', { language: 'hi-IN' }],
  ['pt', { language: 'pt-BR' }],
  ['de', { language: 'de-DE' }],
])

function getVonageVoice(lang: string) {
  return VONAGE_VOICES.voiceForPrompt(lang)
}

/** Build a talk action */
function talk(text: string, lang: string, bargeIn = false): Record<string, unknown> {
  const voice = getVonageVoice(lang)
  return { action: 'talk', text, language: voice.language, ...(bargeIn ? { bargeIn: true } : {}) }
}

/** Build a stream action (play audio URL) */
function stream(url: string, bargeIn = false): Record<string, unknown> {
  return { action: 'stream', streamUrl: [url], ...(bargeIn ? { bargeIn: true } : {}) }
}

/** Build a talk or stream action depending on custom audio */
function sayOrStream(promptKey: string, lang: string, audioUrls?: AudioUrlMap, textOverride?: string, bargeIn = false): Record<string, unknown> {
  const audioUrl = audioUrls?.[`${promptKey}:${lang}`]
  if (audioUrl) return stream(audioUrl, bargeIn)
  const text = textOverride ?? getPrompt(promptKey, lang)
  return talk(text, lang, bargeIn)
}

/** Build hub query param suffix for callback URLs */
function hubQP(hubId?: string): string {
  return hubId ? `&hub=${encodeURIComponent(hubId)}` : ''
}

/** Build hub query param as first param (?hub=...) for URLs with no existing params */
function hubQPFirst(hubId?: string): string {
  return hubId ? `?hub=${encodeURIComponent(hubId)}` : ''
}

const logger = createLogger('telephony.vonage')

/**
 * VonageAdapter — Vonage Voice API implementation of TelephonyAdapter.
 * Uses NCCO (Nexmo Call Control Object) JSON format instead of TwiML XML.
 */
export class VonageAdapter implements TelephonyAdapter {
  private apiKey: string
  private apiSecret: string
  private applicationId: string
  private phoneNumber: string
  // Vonage Voice API requires JWT auth with private key for API calls
  // For webhook responses, we return NCCO JSON
  // Private key stored as string (PEM format)
  private privateKey?: string

  constructor(apiKey: string, apiSecret: string, applicationId: string, phoneNumber: string, privateKey?: string) {
    this.apiKey = apiKey
    this.apiSecret = apiSecret
    this.applicationId = applicationId
    this.phoneNumber = phoneNumber
    this.privateKey = privateKey
  }

  private ncco(actions: Record<string, unknown>[]): TelephonyResponse {
    return {
      contentType: 'application/json',
      body: JSON.stringify(actions),
    }
  }

  private async vonageApi(path: string, init: RequestInit): Promise<Response> {
    // Vonage Voice API uses JWT auth; for simplicity, use Basic auth with api_key:api_secret
    // Full JWT auth requires private key signing (RS256)
    const auth = btoa(`${this.apiKey}:${this.apiSecret}`)
    return safeFetch(`https://api.nexmo.com${path}`, {
      ...init,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    })
  }

  async handleLanguageMenu(params: LanguageMenuParams): Promise<TelephonyResponse> {
    const menu = buildIvrLanguageMenu(params.enabledLanguages, VONAGE_VOICES)
    const hp = hubQP(params.hubId)

    if (menu.kind === 'single') {
      const lang = menu.language
      return this.ncco([
        { action: 'talk', text: ' ' },
        {
          action: 'notify',
          payload: { lang, auto: true },
          eventUrl: ['/api/telephony/language-selected?auto=1&forceLang=' + lang + hp],
          eventMethod: 'POST',
        },
      ])
    }

    return this.ncco([
      {
        action: 'input',
        type: ['dtmf'],
        dtmf: { maxDigits: 1, timeOut: 8 },
        eventUrl: ['/api/telephony/language-selected' + hubQPFirst(params.hubId)],
        eventMethod: 'POST',
      },
      ...menu.options.map(o => talk(o.prompt, o.language, true)),
    ])
  }

  async handleIncomingCall(params: IncomingCallParams): Promise<TelephonyResponse> {
    const lang = params.callerLanguage
    const hp = hubQP(params.hubId)
    const greetingText = getPrompt('greeting', lang).replace('{name}', params.hotlineName)
    const greetingAction = sayOrStream('greeting', lang, params.audioUrls, greetingText)
    // #1505: disclose provider-side recording before the caller can be connected.
    const noticeActions = params.callRecordingEnabled
      ? [sayOrStream('recordingNotice', lang, params.audioUrls)]
      : []

    if (params.rateLimited) {
      const rateLimitAction = sayOrStream('rateLimited', lang, params.audioUrls)
      return this.ncco([greetingAction, rateLimitAction])
    }

    if (params.voiceCaptchaEnabled && params.captchaDigits) {
      const captchaAction = sayOrStream('captchaPrompt', lang, params.audioUrls, undefined, true)
      return this.ncco(this.captchaChallenge(
        params.callSid, lang, params.hubId, params.captchaDigits,
        [greetingAction, ...noticeActions, captchaAction], 0,
      ))
    }

    const holdAction = sayOrStream('pleaseHold', lang, params.audioUrls)
    return this.ncco([
      greetingAction,
      ...noticeActions,
      holdAction,
      {
        action: 'conversation',
        name: params.callSid,
        startOnEnter: false,
        endOnExit: false,
        musicOnHoldUrl: ['/api/telephony/wait-music?lang=' + lang + hp],
      },
    ])
  }

  async handleCaptchaResponse(params: CaptchaResponseParams): Promise<TelephonyResponse> {
    const lang = params.callerLanguage
    const hp = hubQP(params.hubId)

    if (params.outcome === 'pass') {
      return this.ncco([
        talk(getPrompt('captchaSuccess', lang), lang),
        {
          action: 'conversation',
          name: params.callSid,
          startOnEnter: false,
          endOnExit: false,
          musicOnHoldUrl: ['/api/telephony/wait-music?lang=' + lang + hp],
        },
      ])
    }

    const lead = params.outcome === 'retry'
      ? sayOrStream('captchaRetry', lang, undefined, undefined, true)
      : sayOrStream('captchaPrompt', lang, params.audioUrls, undefined, true)
    return this.ncco(this.captchaChallenge(params.callSid, lang, params.hubId, params.digitsToSpeak, [lead], params.round))
  }

  /**
   * One CAPTCHA challenge: `lead`, the digits, the star hint, then an `input`.
   *
   * `submitOnHash` stays false, so a `*` is an ordinary key press delivered in
   * `dtmf.digits` (the server reads it as "say them again"), submitted after
   * `timeOut` seconds without a further press. The input event is sent to
   * `eventUrl` after that pause whether or not anything was pressed, so a
   * timeout reaches the server as a submission with no digits.
   */
  private captchaChallenge(callSid: string, lang: string, hubId: string | undefined, digits: string, lead: Record<string, unknown>[], round: number): Record<string, unknown>[] {
    return [
      ...lead,
      talk(digits.split('').join(', ') + '.', lang, true),
      sayOrStream('captchaRepeatHint', lang, undefined, undefined, true),
      {
        action: 'input',
        type: ['dtmf'],
        dtmf: { maxDigits: 4, timeOut: 10 },
        eventUrl: [`/api/telephony/captcha?callSid=${callSid}&lang=${lang}&round=${round}${hubQP(hubId)}`],
        eventMethod: 'POST',
      },
    ]
  }

  async handleCallAnswered(params: CallAnsweredParams): Promise<TelephonyResponse> {
    // CRIT-W1: Hub and pubkey resolved from DB in /call-recording — no URL params needed
    // #1505: omit `record` (and its recording callback) entirely unless this hub
    // opted in, so Vonage never writes the conversation audio to disk.
    const recording = params.recordCall
      ? {
          record: true,
          eventUrl: [`${params.callbackUrl}/api/telephony/call-recording?parentCallSid=${params.parentCallSid}`],
          eventMethod: 'POST',
        }
      : {}
    return this.ncco([
      {
        action: 'conversation',
        name: params.parentCallSid,
        startOnEnter: true,
        endOnExit: true,
        ...recording,
      },
    ])
  }

  async handleWaitMusic(lang: string, audioUrls?: AudioUrlMap, queueTime?: number, queueTimeout?: number): Promise<TelephonyResponse> {
    if (queueTime !== undefined && queueTime >= (queueTimeout ?? 90)) {
      // Signal to leave the conversation/queue
      return this.ncco([])
    }

    const waitAction = sayOrStream('waitMessage', lang, audioUrls)
    return this.ncco([
      waitAction,
      {
        action: 'stream',
        streamUrl: ['https://com.twilio.music.soft-rock.s3.amazonaws.com/_ghost_-_promo_2_sample_pack.mp3'],
      },
    ])
  }

  async handleVoicemail(params: VoicemailParams): Promise<TelephonyResponse> {
    const lang = params.callerLanguage
    const hp = hubQP(params.hubId)
    const voicemailAction = sayOrStream('voicemailPrompt', lang, params.audioUrls)
    return this.ncco([
      voicemailAction,
      {
        action: 'record',
        endOnSilence: 5,
        endOnKey: '#',
        beepStart: true,
        timeOut: params.maxRecordingSeconds ?? 120,
        eventUrl: [`${params.callbackUrl}/api/telephony/voicemail-recording?callSid=${params.callSid}${hp}`],
        eventMethod: 'POST',
      },
      talk(getVoicemailThanks(lang), lang),
    ])
  }

  rejectCall(): TelephonyResponse {
    return this.ncco([])
  }

  /** An answered Vonage call with an empty NCCO ends immediately. */
  hangupResponse(): TelephonyResponse {
    return this.ncco([])
  }

  async hangupCall(callSid: string): Promise<void> {
    const res = await this.vonageApi(`/v1/calls/${callSid}`, {
      method: 'PUT',
      body: JSON.stringify({ action: 'hangup' }),
    })
    await assertHangupResponse(res, 'Vonage')
  }

  async ringVolunteers(params: RingVolunteersParams): Promise<string[]> {
    const calls = await Promise.allSettled(
      params.volunteers.map(async (vol) => {
        // CRIT-W2: Use opaque callToken instead of raw pubkey in callback URLs
        // CRIT-W1: No ?hub= param — hub resolved from DB server-side
        const body = {
          to: [{ type: 'phone', number: vol.phone.replace('+', '') }],
          from: { type: 'phone', number: this.phoneNumber.replace('+', '') },
          answer_url: [`${params.callbackUrl}/api/telephony/user-answer?callToken=${encodeURIComponent(vol.callToken)}`],
          answer_method: 'POST',
          event_url: [`${params.callbackUrl}/api/telephony/call-status?callToken=${encodeURIComponent(vol.callToken)}`],
          event_method: 'POST',
          ringing_timer: 30,
          machine_detection: 'hangup',
        }

        const res = await this.vonageApi('/v1/calls', {
          method: 'POST',
          body: JSON.stringify(body),
        })

        if (res.ok) {
          const data = await res.json() as { uuid: string }
          return data.uuid
        }
        throw new Error(`Failed to call volunteer: ${res.status}`)
      })
    )

    // Throws when EVERY leg failed (total outage) — see AllDialsFailedError. A partial
    // failure returns whatever succeeded (#1136).
    return collectRingResults(calls, 'Vonage', (msg, err) => logger.error(msg, err))
  }

  async cancelRinging(callSids: string[], exceptSid?: string): Promise<void> {
    await Promise.allSettled(
      callSids
        .filter(sid => sid !== exceptSid)
        .map(sid =>
          this.vonageApi(`/v1/calls/${sid}`, {
            method: 'PUT',
            body: JSON.stringify({ action: 'hangup' }),
          })
        )
    )
  }

  async validateWebhook(request: Request): Promise<boolean> {
    // Vonage signs webhooks using a signature secret (HMAC-SHA256)
    // The signature is sent in the Authorization header or as a query parameter
    // We validate using the apiSecret as the signing key
    const url = new URL(request.url)

    // Epic 258 H16: Timestamp check applies unconditionally (before signature check)
    // to prevent replay attacks even when a valid signature is present
    const timestamp = url.searchParams.get('timestamp')
    if (!timestamp) return false
    const ts = parseInt(timestamp, 10)
    if (isNaN(ts) || Math.abs(Date.now() / 1000 - ts) > 60) return false

    const sig = url.searchParams.get('sig')
    if (!sig) return false

    // Reconstruct signing input: sort all query params (excluding sig), concatenate
    const params = Array.from(url.searchParams.entries())
      .filter(([key]) => key !== 'sig')
      .sort(([a], [b]) => a.localeCompare(b))

    let sigInput = ''
    for (const [key, value] of params) {
      sigInput += `&${key}=${value}`
    }

    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(this.apiSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )
    const signed = await crypto.subtle.sign('HMAC', key, encoder.encode(sigInput))
    const expected = Array.from(new Uint8Array(signed))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')

    // Constant-time comparison
    if (sig.length !== expected.length) return false
    const aBuf = encoder.encode(sig.toLowerCase())
    const bBuf = encoder.encode(expected)
    let result = 0
    for (let i = 0; i < aBuf.length; i++) {
      result |= aBuf[i] ^ bBuf[i]
    }
    return result === 0
  }

  async getCallRecording(callSid: string): Promise<ArrayBuffer | null> {
    // Vonage provides recording URL in the recording webhook
    // Fetch from the Vonage recordings API
    const res = await this.vonageApi(`/v1/calls/${callSid}`, { method: 'GET' })
    if (!res.ok) return null

    const data = await res.json() as { recording_url?: string }
    if (!data.recording_url) return null

    const audioRes = await safeFetch(data.recording_url, {
      headers: { 'Authorization': `Basic ${btoa(`${this.apiKey}:${this.apiSecret}`)}` },
      timeoutMs: 60_000,
    })
    if (!audioRes.ok) return null
    return audioRes.arrayBuffer()
  }

  async getRecordingAudio(recordingSid: string): Promise<ArrayBuffer | null> {
    // Vonage recording URLs are full URLs, not SIDs. The handle comes from a
    // webhook body, so it must name a Vonage file before this adapter's
    // credentials are sent to it.
    const ref = parseVonageRecordingUrl(recordingSid)
    if (!ref) return null
    const audioRes = await safeFetch(`${ref.origin}/v1/files/${ref.id}`, {
      headers: { 'Authorization': `Basic ${btoa(`${this.apiKey}:${this.apiSecret}`)}` },
      timeoutMs: 60_000,
    })
    if (!audioRes.ok) return null
    return audioRes.arrayBuffer()
  }

  /**
   * The handle is the `recording_url` from the record webhook —
   * `https://api.nexmo.com/v1/files/<id>` (or a regional api-*.nexmo.com host).
   * The file is a Media API item; `DELETE /v3/media/<id>` on the same host
   * destroys it (Media API reference, which accepts the key:secret Basic
   * credentials this adapter uses). Vonage would otherwise keep it 30 days.
   */
  /**
   * Recordings belong to the Vonage application that made them; its id is a
   * globally unique UUID and not a credential. Never the API key or secret.
   */
  providerAccountId(): string {
    return `vonage:${this.applicationId}`
  }

  async deleteRecording(recordingSid: string): Promise<void> {
    const ref = parseVonageRecordingUrl(recordingSid)
    if (!ref) throw new ProviderRecordingDeleteError('Vonage', null, `unrecognised recording handle ${JSON.stringify(recordingSid)}`)
    const res = await safeFetch(`${ref.origin}/v3/media/${ref.id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Basic ${btoa(`${this.apiKey}:${this.apiSecret}`)}` },
    })
    await assertRecordingDeleted(res, 'Vonage')
  }

  /**
   * Vonage records only on an NCCO `record` action and transcribes only when
   * that action asks — but it publishes neither an account-level setting nor an
   * API listing an account's call recordings or transcripts, so neither can be
   * READ. Both are reported unknown rather than inferred from this server's
   * own NCCO.
   */
  async probeRecordingPosture(_context: RecordingPostureContext): Promise<ProviderRecordingPosture> {
    return {
      recording: {
        state: 'unknown',
        reason: 'Vonage publishes no account-level recording setting and no API listing an account\'s call recordings',
      },
      transcription: {
        state: 'unknown',
        reason: 'Vonage publishes no account-level transcription setting and no API listing an account\'s transcripts',
      },
    }
  }

  /** Nothing is writable: Vonage publishes no account-level recording or transcription setting. */
  async enforceRecordingPosture(): Promise<ProviderSettingEnforcement[]> {
    return [
      { setting: 'recording', target: 'account', outcome: 'not-settable', reason: 'Vonage publishes no account-level recording setting; a call is recorded only when its NCCO asks, and this server\'s NCCO asks only for voicemail and opted-in calls' },
      { setting: 'transcription', target: 'account', outcome: 'not-settable', reason: 'Vonage publishes no account-level transcription setting; a transcript is made only when an NCCO record action asks, which this server never does' },
    ]
  }

  providerRetention(): ProviderRetentionStatement {
    return {
      removed: [
        {
          what: 'Voicemail and call recordings',
          how: 'Media API DELETE /v3/media/{id} once fetched — a call recording after the server holds its own sealed copy. A refusal stays in heldAtProvider and is retried.',
        },
      ],
      retained: [
        {
          what: 'Call detail records of the caller\'s call and of every volunteer ring leg (they name both phone numbers), kept 13 months',
          reason: 'Vonage\'s Redact API removes the numbers from a voice CDR, but only once Vonage support has provisioned access, and not until the CDR has reached long-term storage. This server does not call it.',
        },
        {
          what: 'Vonage server logs (about 15 days; Messages API logs about 10 days)',
          reason: 'Vonage documents that the Redact API cannot redact server logs.',
        },
        {
          what: 'Call legs in the Conversation API',
          reason: 'Vonage documents leg deletion under inconsistent API versions (/v0.3/legs, /beta/legs); this server does not delete legs.',
        },
        {
          what: 'SMS and Messages API records, including content',
          reason: 'This server does not redact them; the Redact API (messages, sms products) needs the same provisioning and long-term-storage delay.',
        },
      ],
      source: 'Vonage developer documentation (Redact API technical details, Media API), checked 2026-10-29',
    }
  }

  // --- Webhook parsing ---
  // Vonage sends webhooks as JSON (not form data like Twilio)

  async parseIncomingWebhook(request: Request): Promise<WebhookCallInfo> {
    const data = await request.clone().json() as Record<string, string>
    return {
      callSid: data.uuid || data.conversation_uuid || '',
      callerNumber: data.from || '',
      calledNumber: data.to || undefined,
    }
  }

  async parseLanguageWebhook(request: Request): Promise<WebhookCallInfo & WebhookDigits> {
    const data = await request.clone().json() as Record<string, unknown>
    const dtmf = data.dtmf as Record<string, string> | undefined
    return {
      callSid: (data.uuid || data.conversation_uuid || '') as string,
      callerNumber: (data.from || '') as string,
      digits: dtmf?.digits || '',
    }
  }

  async parseCaptchaWebhook(request: Request): Promise<WebhookDigits & { callerNumber: string }> {
    const data = await request.clone().json() as Record<string, unknown>
    const dtmf = data.dtmf as Record<string, string> | undefined
    return {
      digits: dtmf?.digits || '',
      callerNumber: (data.from || '') as string,
    }
  }

  async parseCallStatusWebhook(request: Request): Promise<WebhookCallStatus> {
    const data = await request.clone().json() as Record<string, string>
    const STATUS_MAP: Record<string, WebhookCallStatus['status']> = {
      started: 'initiated',
      ringing: 'ringing',
      answered: 'answered',
      completed: 'completed',
      busy: 'busy',
      timeout: 'no-answer',
      unanswered: 'no-answer',
      failed: 'failed',
      rejected: 'failed',
      cancelled: 'failed',
    }
    return { status: STATUS_MAP[data.status] ?? 'failed' }
  }

  async parseQueueWaitWebhook(request: Request): Promise<WebhookQueueWait> {
    const data = await request.clone().json() as Record<string, string>
    return {
      queueTime: parseInt(data.duration || '0', 10),
    }
  }

  async parseQueueExitWebhook(request: Request): Promise<WebhookQueueResult> {
    const data = await request.clone().json() as Record<string, string>
    const status = data.status || ''
    if (status === 'answered') return { result: 'bridged' }
    if (status === 'completed') return { result: 'hangup' }
    return { result: 'error' }
  }

  async parseRecordingWebhook(request: Request): Promise<WebhookRecordingStatus> {
    const data = await request.clone().json() as Record<string, string>
    return {
      status: data.recording_url ? 'completed' : 'failed',
      recordingSid: data.recording_url || undefined,
      callSid: data.conversation_uuid || undefined,
    }
  }

  handleVoicemailComplete(lang: string): TelephonyResponse {
    return this.ncco([
      talk(getVoicemailThanks(lang), lang),
    ])
  }

  emptyResponse(): TelephonyResponse {
    return this.ncco([])
  }
}

const VONAGE_FILE_ID = /^[0-9a-fA-F-]{8,64}$/

/** Split a Vonage recording URL into the host it lives on and its Media API id. */
export function parseVonageRecordingUrl(url: string): { origin: string; id: string } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  if (!/^api(-[a-z0-9-]+)?\.nexmo\.com$/.test(parsed.hostname)) return null
  const match = /^\/v1\/files\/([^/]+)$/.exec(parsed.pathname)
  if (!match || !VONAGE_FILE_ID.test(match[1])) return null
  return { origin: parsed.origin, id: match[1] }
}
