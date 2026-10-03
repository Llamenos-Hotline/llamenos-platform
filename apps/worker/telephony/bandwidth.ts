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
import { getPrompt, getVoicemailThanks } from '@shared/voice-prompts'
import { IvrVoiceCatalog, buildIvrLanguageMenu } from './ivr-menu'

/**
 * Bandwidth `<SpeakSentence locale gender>` voices — the explicit, ordered list
 * of locales Bandwidth has a voice for. Absent locales are never offered in the
 * IVR menu.
 */
export const BANDWIDTH_VOICES = new IvrVoiceCatalog<{ locale: string; gender: string }>('bandwidth', [
  ['en', { locale: 'en_US', gender: 'female' }],
  ['es', { locale: 'es_MX', gender: 'female' }],
  ['zh', { locale: 'zh_CN', gender: 'female' }],
  ['ar', { locale: 'ar_XA', gender: 'female' }],
  ['fr', { locale: 'fr_FR', gender: 'female' }],
  ['ko', { locale: 'ko_KR', gender: 'female' }],
  ['ru', { locale: 'ru_RU', gender: 'female' }],
  ['hi', { locale: 'hi_IN', gender: 'female' }],
  ['pt', { locale: 'pt_BR', gender: 'female' }],
  ['de', { locale: 'de_DE', gender: 'female' }],
])

function getBandwidthVoice(lang: string): { locale: string; gender: string } {
  return BANDWIDTH_VOICES.voiceForPrompt(lang)
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function speakOrPlay(promptKey: string, lang: string, audioUrls?: AudioUrlMap, text?: string): string {
  const audioUrl = audioUrls?.[`${promptKey}:${lang}`]
  if (audioUrl) {
    return `<PlayAudio>${escapeXml(audioUrl)}</PlayAudio>`
  }
  const { locale, gender } = getBandwidthVoice(lang)
  const content = text ?? getPrompt(promptKey, lang)
  return `<SpeakSentence locale="${locale}" gender="${gender}">${escapeXml(content)}</SpeakSentence>`
}

function hubXmlParam(hubId?: string): string {
  return hubId ? `&amp;hub=${escapeXml(encodeURIComponent(hubId))}` : ''
}

function hubQP(hubId?: string): string {
  return hubId ? `&hub=${encodeURIComponent(hubId)}` : ''
}

/**
 * BandwidthAdapter — Bandwidth Voice API v2 implementation.
 *
 * Returns BXML XML for IVR flows, uses REST API for call control.
 */
export class BandwidthAdapter implements TelephonyAdapter {
  private accountId: string
  private apiToken: string
  private apiSecret: string
  private applicationId: string
  private phoneNumber: string

  constructor(accountId: string, apiToken: string, apiSecret: string, applicationId: string, phoneNumber: string) {
    this.accountId = accountId
    this.apiToken = apiToken
    this.apiSecret = apiSecret
    this.applicationId = applicationId
    this.phoneNumber = phoneNumber
  }

  private bxml(xml: string): TelephonyResponse {
    return {
      contentType: 'application/xml',
      body: `<Response>${xml}</Response>`.trim(),
    }
  }

  private getApiBaseUrl(): string {
    return `https://voice.bandwidth.com/api/v2/accounts/${this.accountId}`
  }

  private async bandwidthApi(path: string, init: RequestInit): Promise<Response> {
    const auth = btoa(`${this.apiToken}:${this.apiSecret}`)
    return safeFetch(`${this.getApiBaseUrl()}${path}`, {
      ...init,
      headers: {
        Authorization: `Basic ${auth}`,
        ...init.headers,
      },
    })
  }

  // --- IVR Methods ---

  async handleLanguageMenu(params: LanguageMenuParams): Promise<TelephonyResponse> {
    const menu = buildIvrLanguageMenu(params.enabledLanguages, BANDWIDTH_VOICES)
    const hp = hubXmlParam(params.hubId)

    if (menu.kind === 'single') {
      return this.bxml(`
        <Redirect redirectUrl="/api/telephony/language-selected?auto=1&amp;forceLang=${menu.language}${hp}"/>
      `)
    }

    const hubParam = params.hubId ? `?hub=${escapeXml(encodeURIComponent(params.hubId))}` : ''
    const speakElements = menu.options
      .map(o => `<SpeakSentence locale="${o.voice.locale}" gender="${o.voice.gender}">${escapeXml(o.prompt)}</SpeakSentence>`)
      .join('\n        ')

    return this.bxml(`
      <Gather maxDigits="1" gatherUrl="/api/telephony/language-selected${hubParam}" firstDigitTimeout="8" repeatCount="1">
        ${speakElements}
      </Gather>
      <Redirect redirectUrl="/api/telephony/language-selected?auto=1${hp}"/>
    `)
  }

  async handleIncomingCall(params: IncomingCallParams): Promise<TelephonyResponse> {
    const lang = params.callerLanguage
    const { locale, gender } = getBandwidthVoice(lang)
    const hp = hubXmlParam(params.hubId)
    const greetingText = getPrompt('greeting', lang).replace('{name}', params.hotlineName)
    const greetingBxml = speakOrPlay('greeting', lang, params.audioUrls, greetingText)

    if (params.rateLimited) {
      const rateLimitBxml = speakOrPlay('rateLimited', lang, params.audioUrls)
      return this.bxml(`
        ${greetingBxml}
        ${rateLimitBxml}
        <Hangup/>
      `)
    }

    if (params.voiceCaptchaEnabled && params.captchaDigits) {
      const digits = params.captchaDigits
      const captchaBxml = speakOrPlay('captchaPrompt', lang, params.audioUrls)
      return this.bxml(`
        <Gather maxDigits="4" gatherUrl="/api/telephony/captcha?callSid=${params.callSid}&amp;lang=${lang}${hp}" firstDigitTimeout="10" repeatCount="1">
          ${greetingBxml}
          ${captchaBxml}
          <SpeakSentence locale="${locale}" gender="${gender}">${escapeXml(digits.split('').join(', '))}.</SpeakSentence>
        </Gather>
        <SpeakSentence locale="${locale}" gender="${gender}">${escapeXml(getPrompt('captchaTimeout', lang))}</SpeakSentence>
        <Hangup/>
      `)
    }

    const holdBxml = speakOrPlay('pleaseHold', lang, params.audioUrls)
    return this.bxml(`
      ${greetingBxml}
      ${holdBxml}
      <Redirect redirectUrl="/api/telephony/wait-music?lang=${lang}&amp;callSid=${params.callSid}${hp}"/>
    `)
  }

  async handleCaptchaResponse(params: CaptchaResponseParams): Promise<TelephonyResponse> {
    const lang = params.callerLanguage
    const { locale, gender } = getBandwidthVoice(lang)
    const hp = hubXmlParam(params.hubId)

    if (params.digits === params.expectedDigits) {
      return this.bxml(`
        <SpeakSentence locale="${locale}" gender="${gender}">${getPrompt('captchaSuccess', lang)}</SpeakSentence>
        <Redirect redirectUrl="/api/telephony/wait-music?lang=${lang}&amp;callSid=${params.callSid}${hp}"/>
      `)
    }

    return this.bxml(`
      <SpeakSentence locale="${locale}" gender="${gender}">${getPrompt('captchaFail', lang)}</SpeakSentence>
      <Hangup/>
    `)
  }

  async handleCallAnswered(params: CallAnsweredParams): Promise<TelephonyResponse> {
    return this.bxml(`
      <StartRecording recordingAvailableUrl="${escapeXml(params.callbackUrl)}/api/telephony/call-recording?parentCallSid=${escapeXml(params.parentCallSid)}"/>
      <Bridge targetCall="${escapeXml(params.parentCallSid)}"/>
    `)
  }

  async handleVoicemail(params: VoicemailParams): Promise<TelephonyResponse> {
    const lang = params.callerLanguage
    const hp = hubXmlParam(params.hubId)
    const voicemailBxml = speakOrPlay('voicemailPrompt', lang, params.audioUrls)
    return this.bxml(`
      ${voicemailBxml}
      <Record maxDuration="${params.maxRecordingSeconds ?? 120}" recordCompleteUrl="/api/telephony/voicemail-complete?callSid=${params.callSid}&amp;lang=${lang}${hp}" recordingAvailableUrl="${escapeXml(params.callbackUrl)}/api/telephony/voicemail-recording?callSid=${params.callSid}${hp}"/>
      <Hangup/>
    `)
  }

  async handleWaitMusic(
    lang: string,
    audioUrls?: AudioUrlMap,
    queueTime?: number,
    queueTimeout?: number,
  ): Promise<TelephonyResponse> {
    if (queueTime !== undefined && queueTime >= (queueTimeout ?? 90)) {
      return this.bxml('<Response><Hangup/></Response>')
    }

    const waitBxml = speakOrPlay('waitMessage', lang, audioUrls)
    return this.bxml(`
      ${waitBxml}
      <PlayAudio>https://com.twilio.music.soft-rock.s3.amazonaws.com/_ghost_-_promo_2_sample_pack.mp3</PlayAudio>
      <Redirect redirectUrl="/api/telephony/wait-music?lang=${lang}"/>
    `)
  }

  handleVoicemailComplete(lang: string): TelephonyResponse {
    const { locale, gender } = getBandwidthVoice(lang)
    return this.bxml(`
      <SpeakSentence locale="${locale}" gender="${gender}">${getVoicemailThanks(lang)}</SpeakSentence>
      <Hangup/>
    `)
  }

  rejectCall(): TelephonyResponse {
    return this.bxml('<Response><Hangup/></Response>')
  }

  hangupResponse(): TelephonyResponse {
    return this.bxml('<Response><Hangup/></Response>')
  }

  emptyResponse(): TelephonyResponse {
    return this.bxml('<Response/>')
  }

  // --- Call Control Methods ---

  async hangupCall(callSid: string): Promise<void> {
    await this.bandwidthApi(`/calls/${callSid}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'completed' }),
    })
  }

  async ringVolunteers(params: RingVolunteersParams): Promise<string[]> {
    const callIds: string[] = []
    const hubParam = hubQP(params.hubId)

    const calls = await Promise.allSettled(
      params.volunteers.map(async (vol) => {
        const res = await this.bandwidthApi('/calls', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: this.phoneNumber,
            to: vol.phone,
            applicationId: this.applicationId,
            answerUrl: `${params.callbackUrl}/api/telephony/user-answer?callToken=${encodeURIComponent(vol.callToken)}${hubParam}`,
            disconnectUrl: `${params.callbackUrl}/api/telephony/call-status?callToken=${encodeURIComponent(vol.callToken)}${hubParam}`,
            callTimeout: 30,
            tag: JSON.stringify({
              parentCallSid: params.callSid,
              callToken: vol.callToken,
              hubId: params.hubId,
            }),
          }),
        })

        if (res.ok) {
          const data = (await res.json()) as { callId: string }
          return data.callId
        }
        throw new Error(`Failed to call volunteer: ${res.status}`)
      }),
    )

    for (const result of calls) {
      if (result.status === 'fulfilled') {
        callIds.push(result.value)
      }
    }

    return callIds
  }

  async cancelRinging(callSids: string[], exceptSid?: string): Promise<void> {
    await Promise.allSettled(
      callSids
        .filter((sid) => sid !== exceptSid)
        .map((sid) =>
          this.bandwidthApi(`/calls/${sid}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ state: 'completed' }),
          }),
        ),
    )
  }

  // --- Recording Methods ---

  async getCallRecording(callSid: string): Promise<ArrayBuffer | null> {
    const res = await this.bandwidthApi(`/calls/${callSid}/recordings`, { method: 'GET' })
    if (!res.ok) return null

    const data = (await res.json()) as Array<{ recordingId: string; mediaUrl?: string }>
    if (!data.length) return null

    const recordingId = data[0].recordingId
    return this.getRecordingAudio(recordingId)
  }

  async getRecordingAudio(recordingSid: string): Promise<ArrayBuffer | null> {
    const audioRes = await this.bandwidthApi(`/recordings/${recordingSid}/media`, { method: 'GET' })
    if (!audioRes.ok) return null
    return audioRes.arrayBuffer()
  }

  // --- Webhook Validation ---

  async validateWebhook(request: Request): Promise<boolean> {
    const authHeader = request.headers.get('Authorization')
    if (!authHeader?.startsWith('Basic ')) return false

    try {
      const decoded = atob(authHeader.slice(6))
      const [username, password] = decoded.split(':')
      const expectedUser = this.apiToken
      const expectedPass = this.apiSecret

      if (!username || !password) return false
      if (username.length !== expectedUser.length || password.length !== expectedPass.length) {
        return false
      }

      const encoder = new TextEncoder()
      const aUser = encoder.encode(username)
      const bUser = encoder.encode(expectedUser)
      const aPass = encoder.encode(password)
      const bPass = encoder.encode(expectedPass)

      let result = 0
      for (let i = 0; i < aUser.length; i++) {
        result |= aUser[i] ^ bUser[i]
      }
      for (let i = 0; i < aPass.length; i++) {
        result |= aPass[i] ^ bPass[i]
      }
      return result === 0
    } catch {
      return false
    }
  }

  // --- Webhook Parsing ---

  async parseIncomingWebhook(request: Request): Promise<WebhookCallInfo> {
    const body = await request.clone().json() as Record<string, unknown>
    const event = body as Record<string, string>

    return {
      callSid: event.callId ?? '',
      callerNumber: event.from ?? '',
      calledNumber: event.to ?? undefined,
    }
  }

  async parseLanguageWebhook(request: Request): Promise<WebhookCallInfo & WebhookDigits> {
    const body = await request.clone().json() as Record<string, unknown>
    const event = body as Record<string, string>

    return {
      callSid: event.callId ?? '',
      callerNumber: event.from ?? '',
      digits: event.digits ?? '',
    }
  }

  async parseCaptchaWebhook(request: Request): Promise<WebhookDigits & { callerNumber: string }> {
    const body = await request.clone().json() as Record<string, unknown>
    const event = body as Record<string, string>

    return {
      digits: event.digits ?? '',
      callerNumber: event.from ?? '',
    }
  }

  async parseCallStatusWebhook(request: Request): Promise<WebhookCallStatus> {
    const body = await request.clone().json() as Record<string, unknown>
    const event = body as Record<string, string>
    const eventType = event.eventType

    if (eventType === 'initiate') return { status: 'initiated' }
    if (eventType === 'answer') return { status: 'answered' }
    if (eventType === 'disconnect') {
      return { status: mapBandwidthDisconnectCause(event.cause ?? 'unknown') }
    }

    return { status: 'failed' }
  }

  async parseQueueWaitWebhook(_request: Request): Promise<WebhookQueueWait> {
    return { queueTime: 0 }
  }

  async parseQueueExitWebhook(request: Request): Promise<WebhookQueueResult> {
    const body = await request.clone().json() as Record<string, unknown>
    const event = body as Record<string, string>
    const eventType = event.eventType

    if (eventType === 'transferComplete') return { result: 'bridged' }
    if (eventType === 'disconnect') {
      const cause = event.cause ?? ''
      if (cause === 'hangup' || cause === 'cancel') return { result: 'hangup' }
      return { result: 'error' }
    }

    return { result: 'error' }
  }

  async parseRecordingWebhook(request: Request): Promise<WebhookRecordingStatus> {
    const body = await request.clone().json() as Record<string, unknown>
    const event = body as Record<string, string>

    if (event.eventType === 'recordingAvailable' || event.eventType === 'recordComplete') {
      return {
        status: 'completed',
        recordingSid: event.recordingId ?? undefined,
        callSid: event.callId ?? undefined,
      }
    }

    return { status: 'failed' }
  }
}

function mapBandwidthDisconnectCause(cause: string): WebhookCallStatus['status'] {
  const map: Record<string, WebhookCallStatus['status']> = {
    hangup: 'completed',
    busy: 'busy',
    cancel: 'failed',
    rejected: 'failed',
    forbidden: 'failed',
    timeout: 'no-answer',
    normal_clearing: 'completed',
  }
  return map[cause] ?? 'failed'
}
