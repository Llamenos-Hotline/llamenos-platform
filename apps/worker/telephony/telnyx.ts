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
import { DEFAULT_LANGUAGE } from '@shared/languages'
import { getPrompt } from '@shared/voice-prompts'
import { IvrVoiceCatalog, buildIvrLanguageMenu } from './ivr-menu'

const TELNYX_API_BASE = 'https://api.telnyx.com/v2'

/**
 * Telnyx TTS voices (AWS Polly via Telnyx) — the explicit, ordered list of
 * locales Telnyx has a voice for. Absent locales are never offered in the IVR menu.
 */
export const TELNYX_VOICES = new IvrVoiceCatalog<{ voice: string; language: string }>('telnyx', [
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

function getTelnyxVoice(lang: string): { voice: string; language: string } {
  return TELNYX_VOICES.voiceForPrompt(lang)
}

function encodeClientState(state: Record<string, unknown>): string {
  return btoa(JSON.stringify(state))
}

function decodeClientState(state: string): Record<string, unknown> | null {
  try {
    return JSON.parse(atob(state)) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Thin wrapper around the Telnyx REST API for issuing call control commands.
 */
class TelnyxCallControlClient {
  private apiKey: string
  private cachedPublicKey: string | null = null

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  async command(callControlId: string, action: string, body?: Record<string, unknown>): Promise<void> {
    const url = `${TELNYX_API_BASE}/calls/${encodeURIComponent(callControlId)}/actions/${action}`
    const res = await safeFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : '{}',
    })

    if (!res.ok) {
      const errorText = await res.text().catch(() => 'unknown error')
      throw new Error(`Telnyx API error (${action}): ${res.status} ${errorText}`)
    }
  }

  async createCall(params: {
    to: string
    from: string
    connection_id: string
    webhook_url?: string
    webhook_url_method?: string
    client_state?: string
    timeout_secs?: number
  }): Promise<{ call_control_id: string; call_leg_id: string; call_session_id: string }> {
    const url = `${TELNYX_API_BASE}/calls`
    const body: Record<string, unknown> = {
      to: params.to,
      from: params.from,
      connection_id: params.connection_id,
    }
    if (params.webhook_url) body.webhook_url = params.webhook_url
    if (params.webhook_url_method) body.webhook_url_method = params.webhook_url_method
    if (params.client_state) body.client_state = params.client_state
    if (params.timeout_secs) body.timeout_secs = params.timeout_secs

    const res = await safeFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const errorText = await res.text().catch(() => 'unknown error')
      throw new Error(`Telnyx API error (createCall): ${res.status} ${errorText}`)
    }

    const data = await res.json() as {
      data: {
        call_control_id: string
        call_leg_id: string
        call_session_id: string
      }
    }
    return data.data
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

/**
 * Map Telnyx hangup_cause to normalized call status.
 */
function mapHangupCauseToStatus(cause: string): WebhookCallStatus['status'] {
  const STATUS_MAP: Record<string, WebhookCallStatus['status']> = {
    normal_clearing: 'completed',
    originator_cancel: 'failed',
    timeout: 'no-answer',
    busy: 'busy',
    user_busy: 'busy',
    call_rejected: 'failed',
    no_user_response: 'no-answer',
    no_answer: 'no-answer',
    subscriber_absent: 'no-answer',
    normal_unspecified: 'completed',
    unallocated_number: 'failed',
    network_out_of_order: 'failed',
    recovery_on_timer_expire: 'no-answer',
    interworking: 'failed',
  }
  return STATUS_MAP[cause] ?? 'failed'
}

function hubQP(hubId?: string): string {
  return hubId ? `&hub=${encodeURIComponent(hubId)}` : ''
}

/**
 * TelnyxAdapter — Telnyx Call Control API implementation.
 *
 * All IVR methods issue API commands internally and return empty responses.
 * Call state is passed via base64 client_state between webhook events.
 */
export class TelnyxAdapter implements TelephonyAdapter {
  private apiKey: string
  private client: TelnyxCallControlClient
  private connectionId: string
  private phoneNumber: string

  constructor(apiKey: string, connectionId: string, phoneNumber: string) {
    this.apiKey = apiKey
    this.client = new TelnyxCallControlClient(apiKey)
    this.connectionId = connectionId
    this.phoneNumber = phoneNumber
  }

  // --- IVR Methods ---

  async handleLanguageMenu(params: LanguageMenuParams): Promise<TelephonyResponse> {
    const menu = buildIvrLanguageMenu(params.enabledLanguages, TELNYX_VOICES)

    const clientState = encodeClientState({
      hubId: params.hubId,
      lang: DEFAULT_LANGUAGE,
      callSid: params.callSid,
      phase: 'language',
    })

    await this.client.command(params.callSid, 'answer', { client_state: clientState })

    if (menu.kind === 'single') {
      const lang = menu.language
      const skipState = encodeClientState({
        hubId: params.hubId,
        lang,
        callSid: params.callSid,
      })
      const { voice, language } = getTelnyxVoice(lang)
      await this.client.command(params.callSid, 'speak', {
        payload: ' ',
        voice,
        language,
        client_state: skipState,
      })
      return this.emptyResponse()
    }

    const menuText = menu.options.map(o => o.prompt).join(' ')
    const { voice, language } = getTelnyxVoice(DEFAULT_LANGUAGE)

    await this.client.command(params.callSid, 'gather_using_speak', {
      payload: menuText,
      voice,
      language,
      minimum_digits: 1,
      maximum_digits: 1,
      timeout_millis: 8000,
      client_state: clientState,
    })

    return this.emptyResponse()
  }

  async handleIncomingCall(params: IncomingCallParams): Promise<TelephonyResponse> {
    const lang = params.callerLanguage
    const { voice, language } = getTelnyxVoice(lang)
    const greetingText = getPrompt('greeting', lang).replace('{name}', params.hotlineName)

    if (params.rateLimited) {
      const rateLimitText = getPrompt('rateLimited', lang)
      await this.client.command(params.callSid, 'speak', {
        payload: `${greetingText} ${rateLimitText}`,
        voice,
        language,
      })
      await this.client.command(params.callSid, 'hangup', {})
      return this.emptyResponse()
    }

    if (params.voiceCaptchaEnabled && params.captchaDigits) {
      const digits = params.captchaDigits
      const captchaText = getPrompt('captchaPrompt', lang)
      const digitsSpoken = digits.split('').join(', ')
      const captchaState = encodeClientState({
        hubId: params.hubId,
        lang,
        callSid: params.callSid,
        phase: 'captcha',
      })

      await this.client.command(params.callSid, 'speak', {
        payload: greetingText,
        voice,
        language,
      })

      await this.client.command(params.callSid, 'gather_using_speak', {
        payload: `${captchaText} ${digitsSpoken}.`,
        voice,
        language,
        minimum_digits: 1,
        maximum_digits: 4,
        timeout_millis: 10000,
        client_state: captchaState,
      })

      return this.emptyResponse()
    }

    const holdText = getPrompt('pleaseHold', lang)
    const queueState = encodeClientState({
      hubId: params.hubId,
      lang,
      callSid: params.callSid,
      phase: 'queue',
    })

    await this.client.command(params.callSid, 'speak', {
      payload: `${greetingText} ${holdText}`,
      voice,
      language,
      client_state: queueState,
    })

    await this.client.command(params.callSid, 'playback_start', {
      audio_url: 'https://com.twilio.music.soft-rock.s3.amazonaws.com/_ghost_-_promo_2_sample_pack.mp3',
      loop: 'infinity',
      client_state: queueState,
    })

    return this.emptyResponse()
  }

  async handleCaptchaResponse(params: CaptchaResponseParams): Promise<TelephonyResponse> {
    const lang = params.callerLanguage
    const { voice, language } = getTelnyxVoice(lang)

    if (params.digits === params.expectedDigits) {
      const successText = getPrompt('captchaSuccess', lang)
      const queueState = encodeClientState({
        hubId: params.hubId,
        lang,
        callSid: params.callSid,
        phase: 'queue',
      })

      await this.client.command(params.callSid, 'speak', {
        payload: successText,
        voice,
        language,
        client_state: queueState,
      })

      await this.client.command(params.callSid, 'playback_start', {
        audio_url: 'https://com.twilio.music.soft-rock.s3.amazonaws.com/_ghost_-_promo_2_sample_pack.mp3',
        loop: 'infinity',
        client_state: queueState,
      })

      return this.emptyResponse()
    }

    const failText = getPrompt('captchaFail', lang)
    await this.client.command(params.callSid, 'speak', {
      payload: failText,
      voice,
      language,
    })
    await this.client.command(params.callSid, 'hangup', {})

    return this.emptyResponse()
  }

  async handleCallAnswered(params: CallAnsweredParams): Promise<TelephonyResponse> {
    await this.client.command(params.parentCallSid, 'bridge', {
      call_control_id: params.parentCallSid,
    })

    await this.client.command(params.parentCallSid, 'record_start', {
      format: 'mp3',
      channels: 'single',
      client_state: encodeClientState({
        lang: 'en',
        callSid: params.parentCallSid,
        hubId: params.hubId,
      }),
    })

    return this.emptyResponse()
  }

  async handleVoicemail(params: VoicemailParams): Promise<TelephonyResponse> {
    const lang = params.callerLanguage
    const { voice, language } = getTelnyxVoice(lang)
    const voicemailText = getPrompt('voicemailPrompt', lang)

    const vmState = encodeClientState({
      hubId: params.hubId,
      lang,
      callSid: params.callSid,
    })

    await this.client.command(params.callSid, 'speak', {
      payload: voicemailText,
      voice,
      language,
      client_state: vmState,
    })

    await this.client.command(params.callSid, 'record_start', {
      format: 'mp3',
      play_beep: true,
      max_length_secs: params.maxRecordingSeconds ?? 120,
      client_state: vmState,
    })

    return this.emptyResponse()
  }

  async handleWaitMusic(
    _lang: string,
    _audioUrls?: AudioUrlMap,
    queueTime?: number,
    queueTimeout?: number,
  ): Promise<TelephonyResponse> {
    if (queueTime !== undefined && queueTime >= (queueTimeout ?? 90)) {
      return {
        contentType: 'application/json',
        body: JSON.stringify({ leave: true }),
      }
    }

    return this.emptyResponse()
  }

  handleVoicemailComplete(_lang: string): TelephonyResponse {
    return this.emptyResponse()
  }

  rejectCall(): TelephonyResponse {
    return this.emptyResponse()
  }

  /**
   * Telnyx is call-control: legs are ended by API command, not by the webhook
   * response. The losing leg is ended by cancelRinging / hangupCall.
   */
  hangupResponse(): TelephonyResponse {
    return this.emptyResponse()
  }

  emptyResponse(): TelephonyResponse {
    return {
      contentType: 'application/json',
      body: '{}',
    }
  }

  // --- Call Control Methods ---

  async hangupCall(callSid: string): Promise<void> {
    await this.client.command(callSid, 'hangup', {})
  }

  async ringVolunteers(params: RingVolunteersParams): Promise<string[]> {
    const callControlIds: string[] = []
    const hubParam = hubQP(params.hubId)

    const calls = await Promise.allSettled(
      params.volunteers.map(async (vol) => {
        const clientState = encodeClientState({
          lang: 'en',
          callSid: params.callSid,
          hubId: params.hubId,
        })

        const result = await this.client.createCall({
          to: vol.phone,
          from: this.phoneNumber,
          connection_id: this.connectionId,
          webhook_url: `${params.callbackUrl}/api/telephony/user-answer?callToken=${encodeURIComponent(vol.callToken)}${hubParam}`,
          webhook_url_method: 'POST',
          client_state: clientState,
          timeout_secs: 30,
        })

        return result.call_control_id
      }),
    )

    for (const result of calls) {
      if (result.status === 'fulfilled') {
        callControlIds.push(result.value)
      }
    }

    return callControlIds
  }

  async cancelRinging(callSids: string[], exceptSid?: string): Promise<void> {
    await Promise.allSettled(
      callSids
        .filter((sid) => sid !== exceptSid)
        .map((sid) => this.client.command(sid, 'hangup', {})),
    )
  }

  // --- Recording Methods ---

  async getCallRecording(_callSid: string): Promise<ArrayBuffer | null> {
    return null
  }

  async getRecordingAudio(recordingSid: string): Promise<ArrayBuffer | null> {
    try {
      return await this.client.getRecording(recordingSid)
    } catch {
      return null
    }
  }

  // --- Webhook Validation ---

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
      return await this.client.verifyWebhookSignature(signature, timestamp, rawBody)
    } catch {
      return false
    }
  }

  // --- Webhook Parsing ---

  async parseIncomingWebhook(request: Request): Promise<WebhookCallInfo> {
    const body = await request.clone().json() as Record<string, unknown>
    const data = body.data as Record<string, unknown> | undefined
    const payload = data?.payload as Record<string, string> | undefined

    return {
      callSid: payload?.call_control_id ?? '',
      callerNumber: payload?.from ?? '',
      calledNumber: payload?.to ?? undefined,
    }
  }

  async parseLanguageWebhook(request: Request): Promise<WebhookCallInfo & WebhookDigits> {
    const body = await request.clone().json() as Record<string, unknown>
    const data = body.data as Record<string, unknown> | undefined
    const payload = data?.payload as Record<string, string> | undefined
    const clientState = payload?.client_state ? decodeClientState(payload.client_state) : null

    return {
      callSid: payload?.call_control_id ?? (clientState?.callSid as string) ?? '',
      callerNumber: payload?.from ?? '',
      digits: payload?.digits ?? '',
    }
  }

  async parseCaptchaWebhook(request: Request): Promise<WebhookDigits & { callerNumber: string }> {
    const body = await request.clone().json() as Record<string, unknown>
    const data = body.data as Record<string, unknown> | undefined
    const payload = data?.payload as Record<string, string> | undefined

    return {
      digits: payload?.digits ?? '',
      callerNumber: payload?.from ?? '',
    }
  }

  async parseCallStatusWebhook(request: Request): Promise<WebhookCallStatus> {
    const body = await request.clone().json() as Record<string, unknown>
    const data = body.data as Record<string, unknown> | undefined
    const payload = data?.payload as Record<string, string> | undefined
    const eventType = data?.event_type as string

    if (eventType === 'call.initiated') {
      return { status: 'initiated' }
    }
    if (eventType === 'call.answered') {
      return { status: 'answered' }
    }
    if (eventType === 'call.hangup') {
      return { status: mapHangupCauseToStatus(payload?.hangup_cause ?? 'normal_clearing') }
    }

    return { status: 'failed' }
  }

  async parseQueueWaitWebhook(_request: Request): Promise<WebhookQueueWait> {
    return { queueTime: 0 }
  }

  async parseQueueExitWebhook(request: Request): Promise<WebhookQueueResult> {
    const body = await request.clone().json() as Record<string, unknown>
    const data = body.data as Record<string, unknown> | undefined
    const eventType = data?.event_type as string
    const payload = data?.payload as Record<string, string> | undefined

    if (eventType === 'call.bridged') {
      return { result: 'bridged' }
    }
    if (eventType === 'call.hangup') {
      const cause = payload?.hangup_cause ?? ''
      if (cause === 'normal_clearing') return { result: 'hangup' }
      if (cause === 'originator_cancel') return { result: 'hangup' }
      return { result: 'error' }
    }

    return { result: 'error' }
  }

  async parseRecordingWebhook(request: Request): Promise<WebhookRecordingStatus> {
    const body = await request.clone().json() as Record<string, unknown>
    const data = body.data as Record<string, unknown> | undefined
    const payload = data?.payload as Record<string, unknown> | undefined
    const recordingUrls = payload?.recording_urls as Record<string, string> | undefined

    if (recordingUrls?.mp3) {
      return {
        status: 'completed',
        recordingSid: recordingUrls.mp3,
        callSid: (payload?.call_control_id as string) ?? undefined,
      }
    }

    return { status: 'failed' }
  }
}
