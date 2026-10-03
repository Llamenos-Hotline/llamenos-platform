import { safeFetch } from '../lib/safe-fetch'
import { buildWebhookUrl } from '../lib/webhook-url'
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
 * Plivo `<Speak language>` codes (Polly voices) — the explicit, ordered list of
 * locales Plivo has a voice for. Absent locales are never offered in the IVR menu.
 */
export const PLIVO_VOICES = new IvrVoiceCatalog<string>('plivo', [
  ['en', 'en-US'],
  ['es', 'es-MX'],
  ['zh', 'cmn-CN'],
  ['vi', 'vi-VN'],
  ['ar', 'ar-XA'],
  ['fr', 'fr-FR'],
  ['ko', 'ko-KR'],
  ['ru', 'ru-RU'],
  ['hi', 'hi-IN'],
  ['pt', 'pt-BR'],
  ['de', 'de-DE'],
])

function getPlivoVoice(lang: string): string {
  return PLIVO_VOICES.voiceForPrompt(lang)
}

/** Build a <Speak> element */
function speak(text: string, lang: string): string {
  const voice = getPlivoVoice(lang)
  return `<Speak language="${voice}">${escapeXml(text)}</Speak>`
}

/** Build a <Play> element */
function play(url: string): string {
  return `<Play>${escapeXml(url)}</Play>`
}

/** Build Speak or Play based on custom audio availability */
function sayOrPlay(promptKey: string, lang: string, audioUrls?: AudioUrlMap, textOverride?: string): string {
  const audioUrl = audioUrls?.[`${promptKey}:${lang}`]
  if (audioUrl) return play(audioUrl)
  const text = textOverride ?? getPrompt(promptKey, lang)
  return speak(text, lang)
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/** Build XML-escaped hub query param suffix for Plivo XML callback URLs */
function hubXmlParam(hubId?: string): string {
  return hubId ? `&amp;hub=${escapeXml(encodeURIComponent(hubId))}` : ''
}

/** Build hub query param suffix for non-XML URLs */
function _hubQueryParam(hubId?: string): string {
  return hubId ? `&hub=${encodeURIComponent(hubId)}` : ''
}

/**
 * PlivoAdapter — Plivo implementation of TelephonyAdapter.
 * Uses Plivo XML format (similar to TwiML but with different tag names).
 *
 * Key differences from TwiML:
 * - <Speak> instead of <Say>
 * - <GetDigits> instead of <Gather>
 * - <Dial><Number> for outbound calls
 * - <Conference> for call queuing/bridging
 * - <Record> with different attributes
 * - <Hangup/> and <Wait length="N"/>
 * - REST API: POST /v1/Account/{auth_id}/Call/
 * - Webhooks use form data with CallUUID, From, To, Digits, CallStatus
 */
export class PlivoAdapter implements TelephonyAdapter {
  private authId: string
  private authToken: string
  private phoneNumber: string
  private webhookBaseUrl: string

  constructor(authId: string, authToken: string, phoneNumber: string, webhookBaseUrl = '') {
    this.authId = authId
    this.authToken = authToken
    this.phoneNumber = phoneNumber
    this.webhookBaseUrl = webhookBaseUrl
  }

  private plivoXml(xml: string): TelephonyResponse {
    return {
      contentType: 'application/xml',
      body: `<Response>${xml}</Response>`.trim(),
    }
  }

  private async plivoApi(path: string, init: RequestInit): Promise<Response> {
    return safeFetch(`https://api.plivo.com/v1/Account/${this.authId}${path}`, {
      ...init,
      headers: {
        'Authorization': 'Basic ' + btoa(`${this.authId}:${this.authToken}`),
        'Content-Type': 'application/json',
        ...init.headers,
      },
    })
  }

  async handleLanguageMenu(params: LanguageMenuParams): Promise<TelephonyResponse> {
    const menu = buildIvrLanguageMenu(params.enabledLanguages, PLIVO_VOICES)
    const hp = hubXmlParam(params.hubId)

    if (menu.kind === 'single') {
      return this.plivoXml(`
        <Redirect method="POST">/api/telephony/language-selected?auto=1&amp;forceLang=${menu.language}${hp}</Redirect>
      `)
    }

    const hubParam = params.hubId ? `?hub=${escapeXml(encodeURIComponent(params.hubId))}` : ''
    const speakElements = menu.options
      .map(o => `<Speak language="${o.voice}">${escapeXml(o.prompt)}</Speak>`)
      .join('\n        ')

    return this.plivoXml(`
      <GetDigits numDigits="1" action="/api/telephony/language-selected${hubParam}" method="POST" timeout="8" redirect="true">
        ${speakElements}
      </GetDigits>
      <Redirect method="POST">/api/telephony/language-selected?auto=1${hp}</Redirect>
    `)
  }

  async handleIncomingCall(params: IncomingCallParams): Promise<TelephonyResponse> {
    const lang = params.callerLanguage
    const hp = hubXmlParam(params.hubId)
    const greetingText = getPrompt('greeting', lang).replace('{name}', params.hotlineName)
    const greetingXml = sayOrPlay('greeting', lang, params.audioUrls, greetingText)

    if (params.rateLimited) {
      const rateLimitXml = sayOrPlay('rateLimited', lang, params.audioUrls)
      return this.plivoXml(`
        ${greetingXml}
        ${rateLimitXml}
        <Hangup/>
      `)
    }

    if (params.voiceCaptchaEnabled && params.captchaDigits) {
      const digits = params.captchaDigits
      const captchaXml = sayOrPlay('captchaPrompt', lang, params.audioUrls)
      return this.plivoXml(`
        <GetDigits numDigits="4" action="/api/telephony/captcha?callSid=${params.callSid}&amp;lang=${lang}${hp}" method="POST" timeout="10" redirect="true">
          ${greetingXml}
          ${captchaXml}
          ${speak(digits.split('').join(', ') + '.', lang)}
        </GetDigits>
        ${speak(getPrompt('captchaTimeout', lang), lang)}
        <Hangup/>
      `)
    }

    const holdXml = sayOrPlay('pleaseHold', lang, params.audioUrls)
    return this.plivoXml(`
      ${greetingXml}
      ${holdXml}
      <Conference waitSound="/api/telephony/wait-music?lang=${lang}${hp}" action="/api/telephony/queue-exit?callSid=${params.callSid}&amp;lang=${lang}${hp}" method="POST" startConferenceOnEnter="false" endConferenceOnExit="false" stayAlone="true">${params.callSid}</Conference>
    `)
  }

  async handleCaptchaResponse(params: CaptchaResponseParams): Promise<TelephonyResponse> {
    const lang = params.callerLanguage
    const hp = hubXmlParam(params.hubId)

    if (params.digits === params.expectedDigits) {
      return this.plivoXml(`
        ${speak(getPrompt('captchaSuccess', lang), lang)}
        <Conference waitSound="/api/telephony/wait-music?lang=${lang}${hp}" action="/api/telephony/queue-exit?callSid=${params.callSid}&amp;lang=${lang}${hp}" method="POST" startConferenceOnEnter="false" endConferenceOnExit="false" stayAlone="true">${params.callSid}</Conference>
      `)
    }

    return this.plivoXml(`
      ${speak(getPrompt('captchaFail', lang), lang)}
      <Hangup/>
    `)
  }

  async handleCallAnswered(params: CallAnsweredParams): Promise<TelephonyResponse> {
    // CRIT-W1: Hub and pubkey resolved from DB in /call-recording — no URL params needed
    return this.plivoXml(`
      <Conference record="true" recordFileFormat="mp3" callbackUrl="${escapeXml(params.callbackUrl)}/api/telephony/call-recording?parentCallSid=${params.parentCallSid}" callbackMethod="POST" startConferenceOnEnter="true" endConferenceOnExit="true">${params.parentCallSid}</Conference>
    `)
  }

  async handleWaitMusic(lang: string, audioUrls?: AudioUrlMap, queueTime?: number, queueTimeout?: number): Promise<TelephonyResponse> {
    if (queueTime !== undefined && queueTime >= (queueTimeout ?? 90)) {
      // End the wait — caller will be redirected to voicemail
      return this.plivoXml(`<Hangup/>`)
    }

    const waitXml = sayOrPlay('waitMessage', lang, audioUrls)
    return this.plivoXml(`
      ${waitXml}
      <Play>https://com.twilio.music.soft-rock.s3.amazonaws.com/_ghost_-_promo_2_sample_pack.mp3</Play>
    `)
  }

  async handleVoicemail(params: VoicemailParams): Promise<TelephonyResponse> {
    const lang = params.callerLanguage
    const hp = hubXmlParam(params.hubId)
    const voicemailXml = sayOrPlay('voicemailPrompt', lang, params.audioUrls)
    return this.plivoXml(`
      ${voicemailXml}
      <Record maxLength="${params.maxRecordingSeconds ?? 120}" action="/api/telephony/voicemail-complete?callSid=${params.callSid}&amp;lang=${lang}${hp}" method="POST" callbackUrl="${escapeXml(params.callbackUrl)}/api/telephony/voicemail-recording?callSid=${params.callSid}${hp}" callbackMethod="POST" finishOnKey="#" />
      <Hangup/>
    `)
  }

  rejectCall(): TelephonyResponse {
    return this.plivoXml(`<Hangup reason="rejected"/>`)
  }

  hangupResponse(): TelephonyResponse {
    return this.plivoXml('<Hangup/>')
  }

  async hangupCall(callSid: string): Promise<void> {
    await this.plivoApi(`/Call/${callSid}/`, {
      method: 'DELETE',
    })
  }

  async ringVolunteers(params: RingVolunteersParams): Promise<string[]> {
    const callSids: string[] = []

    const calls = await Promise.allSettled(
      params.volunteers.map(async (vol) => {
        // CRIT-W2: Use opaque callToken instead of raw pubkey in callback URLs
        // CRIT-W1: No ?hub= param — hub resolved from DB server-side
        const body = {
          from: this.phoneNumber,
          to: vol.phone,
          answer_url: `${params.callbackUrl}/api/telephony/user-answer?callToken=${encodeURIComponent(vol.callToken)}`,
          answer_method: 'POST',
          hangup_url: `${params.callbackUrl}/api/telephony/call-status?callToken=${encodeURIComponent(vol.callToken)}`,
          hangup_method: 'POST',
          ring_url: `${params.callbackUrl}/api/telephony/call-status?callToken=${encodeURIComponent(vol.callToken)}`,
          ring_method: 'POST',
          ring_timeout: 30,
          machine_detection: 'hangup',
        }

        const res = await this.plivoApi('/Call/', {
          method: 'POST',
          body: JSON.stringify(body),
        })

        if (res.ok) {
          const data = await res.json() as { request_uuid: string }
          return data.request_uuid
        }
        throw new Error(`Failed to call volunteer`)
      })
    )

    for (const result of calls) {
      if (result.status === 'fulfilled') {
        callSids.push(result.value)
      }
    }

    return callSids
  }

  async cancelRinging(callSids: string[], exceptSid?: string): Promise<void> {
    await Promise.allSettled(
      callSids
        .filter(sid => sid !== exceptSid)
        .map(sid =>
          this.plivoApi(`/Call/${sid}/`, { method: 'DELETE' })
        )
    )
  }

  async validateWebhook(request: Request): Promise<boolean> {
    // Plivo V3 signature validation:
    // 1. Build string: URL (without query) + sorted POST params + nonce
    // 2. HMAC-SHA256 with auth token
    // 3. Compare with X-Plivo-Signature-V3 header
    const signature = request.headers.get('X-Plivo-Signature-V3')
    const nonce = request.headers.get('X-Plivo-Signature-V3-Nonce')
    if (!signature || !nonce) return false

    const url = buildWebhookUrl(request, this.webhookBaseUrl)
    const body = await request.clone().text()
    const params = new URLSearchParams(body)

    // Build validation string: URL + sorted params + nonce
    let dataString = url.origin + url.pathname
    const sortedEntries = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b))
    for (const [key, value] of sortedEntries) {
      dataString += key + value
    }
    dataString += '.' + nonce

    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(this.authToken),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(dataString))
    const expected = btoa(String.fromCharCode(...new Uint8Array(sig)))

    // Constant-time comparison
    if (signature.length !== expected.length) return false
    const aBuf = encoder.encode(signature)
    const bBuf = encoder.encode(expected)
    let result = 0
    for (let i = 0; i < aBuf.length; i++) {
      result |= aBuf[i] ^ bBuf[i]
    }
    return result === 0
  }

  async getCallRecording(callSid: string): Promise<ArrayBuffer | null> {
    // Plivo recording lookup by call UUID
    const res = await this.plivoApi(`/Recording/?call_uuid=${callSid}`, { method: 'GET' })
    if (!res.ok) return null

    const data = await res.json() as { objects?: Array<{ recording_url: string }> }
    if (!data.objects?.length) return null

    const recordingUrl = data.objects[0].recording_url
    const audioRes = await safeFetch(recordingUrl, {
      headers: {
        'Authorization': 'Basic ' + btoa(`${this.authId}:${this.authToken}`),
      },
      timeoutMs: 60_000,
    })
    if (!audioRes.ok) return null
    return audioRes.arrayBuffer()
  }

  async getRecordingAudio(recordingSid: string): Promise<ArrayBuffer | null> {
    // Plivo recording URL is a full URL
    const audioRes = await safeFetch(recordingSid, {
      headers: {
        'Authorization': 'Basic ' + btoa(`${this.authId}:${this.authToken}`),
      },
      timeoutMs: 60_000,
    })
    if (!audioRes.ok) return null
    return audioRes.arrayBuffer()
  }

  // --- Webhook parsing ---
  // Plivo sends webhooks as form-encoded data

  async parseIncomingWebhook(request: Request): Promise<WebhookCallInfo> {
    const form = await request.clone().formData()
    return {
      callSid: (form.get('CallUUID') as string) || '',
      callerNumber: (form.get('From') as string) || '',
      calledNumber: (form.get('To') as string) || undefined,
    }
  }

  async parseLanguageWebhook(request: Request): Promise<WebhookCallInfo & WebhookDigits> {
    const form = await request.clone().formData()
    return {
      callSid: (form.get('CallUUID') as string) || '',
      callerNumber: (form.get('From') as string) || '',
      digits: (form.get('Digits') as string) || '',
    }
  }

  async parseCaptchaWebhook(request: Request): Promise<WebhookDigits & { callerNumber: string }> {
    const form = await request.clone().formData()
    return {
      digits: (form.get('Digits') as string) || '',
      callerNumber: (form.get('From') as string) || '',
    }
  }

  async parseCallStatusWebhook(request: Request): Promise<WebhookCallStatus> {
    const form = await request.clone().formData()
    const raw = (form.get('CallStatus') as string) || ''
    const STATUS_MAP: Record<string, WebhookCallStatus['status']> = {
      ringing: 'ringing',
      'in-progress': 'answered',
      completed: 'completed',
      busy: 'busy',
      'no-answer': 'no-answer',
      failed: 'failed',
      cancel: 'failed',
      hangup: 'completed',
    }
    return { status: STATUS_MAP[raw] ?? 'failed' }
  }

  async parseQueueWaitWebhook(request: Request): Promise<WebhookQueueWait> {
    const form = await request.clone().formData()
    return {
      queueTime: parseInt((form.get('ConferenceDuration') as string) || '0', 10),
    }
  }

  async parseQueueExitWebhook(request: Request): Promise<WebhookQueueResult> {
    const form = await request.clone().formData()
    const status = (form.get('ConferenceAction') as string) || ''
    if (status === 'enter') return { result: 'bridged' }
    if (status === 'exit') return { result: 'hangup' }
    return { result: 'error' }
  }

  async parseRecordingWebhook(request: Request): Promise<WebhookRecordingStatus> {
    const form = await request.clone().formData()
    const recordUrl = form.get('RecordUrl') as string
    return {
      status: recordUrl ? 'completed' : 'failed',
      recordingSid: (form.get('RecordingID') as string) || undefined,
      callSid: (form.get('CallUUID') as string) || undefined,
    }
  }

  handleVoicemailComplete(lang: string): TelephonyResponse {
    return this.plivoXml(`
      ${speak(getVoicemailThanks(lang), lang)}
      <Hangup/>
    `)
  }

  emptyResponse(): TelephonyResponse {
    return this.plivoXml('')
  }
}
