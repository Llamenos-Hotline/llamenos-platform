import { safeFetch } from '../lib/safe-fetch'
import { buildWebhookUrl } from '../lib/webhook-url'
import { createLogger } from '../lib/logger'
import {
  assertHangupResponse,
  assertRecordingDeleted,
  collectRingResults,
  assertCallLogDeleted,
  combineReadings,
  enforcementFailed,
  inventoryReading,
  unreadable,
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
  ProviderSettingReading,
} from '@protocol/schemas/settings'
import { getPrompt, getVoicemailThanks } from '@shared/voice-prompts'
import { IvrVoiceCatalog, buildIvrLanguageMenu } from './ivr-menu'
import { holdMusicUrl } from './hold-music'

/**
 * Whether Twilio's `AnsweredBy` (sent on the answer URL because legs are
 * dialled with `MachineDetection`) says an automated answerer picked up.
 * `human` and `unknown` are answers: `unknown` is Twilio's "could not decide
 * in time", and refusing it would drop a real pickup. Everything else —
 * `machine_start`, `machine_end_beep`, `machine_end_silence`,
 * `machine_end_other`, `fax` — is a machine. A missing value is not a machine.
 */
export function isMachineAnsweredBy(answeredBy: string | null | undefined): boolean {
  return !!answeredBy && answeredBy !== 'human' && answeredBy !== 'unknown'
}

/**
 * Twilio TwiML `<Say language>` codes — the explicit, ordered list of locales
 * Twilio has a voice for. A locale absent here is not speakable on Twilio and is
 * never offered in the IVR menu (no "closest language" substitution).
 */
export const TWILIO_VOICES = new IvrVoiceCatalog<string>('twilio', [
  ['en', 'en-US'],
  ['es', 'es-MX'],
  ['zh', 'cmn-CN'],
  ['tl', 'fil-PH'],
  ['vi', 'vi-VN'],
  ['ar', 'ar-XA'],
  ['fr', 'fr-FR'],
  ['ko', 'ko-KR'],
  ['ru', 'ru-RU'],
  ['hi', 'hi-IN'],
  ['pt', 'pt-BR'],
  ['de', 'de-DE'],
])

function getTwilioVoice(lang: string): string {
  return TWILIO_VOICES.voiceForPrompt(lang)
}


/** Escape XML special characters for safe TwiML embedding */
function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/** Generate TwiML: <Play> if custom audio exists, <Say> fallback */
function sayOrPlay(promptKey: string, lang: string, audioUrls?: AudioUrlMap, text?: string): string {
  const audioUrl = audioUrls?.[`${promptKey}:${lang}`]
  if (audioUrl) {
    return `<Play>${escapeXml(audioUrl)}</Play>`
  }
  const voice = getTwilioVoice(lang)
  const content = text ?? getPrompt(promptKey, lang)
  return `<Say language="${voice}">${escapeXml(content)}</Say>`
}

/** Build XML-escaped hub query param suffix for TwiML callback URLs */
function hubXmlParam(hubId?: string): string {
  return hubId ? `&amp;hub=${escapeXml(encodeURIComponent(hubId))}` : ''
}

const logger = createLogger('telephony.twilio')

/**
 * TwilioAdapter — Twilio implementation of TelephonyAdapter.
 */
export class TwilioAdapter implements TelephonyAdapter {
  protected accountSid: string
  protected authToken: string
  protected phoneNumber: string
  protected webhookBaseUrl: string

  constructor(accountSid: string, authToken: string, phoneNumber: string, webhookBaseUrl = '') {
    this.accountSid = accountSid
    this.authToken = authToken
    this.phoneNumber = phoneNumber
    this.webhookBaseUrl = webhookBaseUrl
  }

  async handleLanguageMenu(params: LanguageMenuParams): Promise<TelephonyResponse> {
    const menu = buildIvrLanguageMenu(params.enabledLanguages, TWILIO_VOICES)
    const hp = hubXmlParam(params.hubId)

    if (menu.kind === 'single') {
      return this.twiml(`
        <Response>
          <Redirect method="POST">/api/telephony/language-selected?auto=1&amp;forceLang=${menu.language}${hp}</Redirect>
        </Response>
      `)
    }

    const hubParam = params.hubId ? `?hub=${escapeXml(encodeURIComponent(params.hubId))}` : ''
    const sayElements = menu.options
      .map(o => `<Say language="${o.voice}">${escapeXml(o.prompt)}</Say>`)
      .join('\n          ')

    return this.twiml(`
      <Response>
        <Gather numDigits="1" action="/api/telephony/language-selected${hubParam}" method="POST" timeout="8">
          ${sayElements}
        </Gather>
        <Redirect method="POST">/api/telephony/language-selected?auto=1${hp}</Redirect>
      </Response>
    `)
  }

  async handleIncomingCall(params: IncomingCallParams): Promise<TelephonyResponse> {
    const lang = params.callerLanguage
    const hp = hubXmlParam(params.hubId)
    const greetingText = getPrompt('greeting', lang).replace('{name}', params.hotlineName)
    const greetingTwiml = sayOrPlay('greeting', lang, params.audioUrls, greetingText)
    // #1505: if this hub records answered calls, the caller is told before they
    // can be connected. Omitted on the rate-limited path below — that call is
    // hung up and never recorded.
    const noticeTwiml = params.callRecordingEnabled
      ? sayOrPlay('recordingNotice', lang, params.audioUrls)
      : ''

    if (params.rateLimited) {
      const rateLimitTwiml = sayOrPlay('rateLimited', lang, params.audioUrls)
      return this.twiml(`
        <Response>
          ${greetingTwiml}
          ${rateLimitTwiml}
          <Hangup/>
        </Response>
      `)
    }

    if (params.voiceCaptchaEnabled && params.captchaDigits) {
      const captchaTwiml = sayOrPlay('captchaPrompt', lang, params.audioUrls)
      return this.twiml(`
        <Response>
          ${this.captchaChallenge(params.callSid, lang, params.hubId, params.captchaDigits, greetingTwiml + noticeTwiml + captchaTwiml, 0)}
        </Response>
      `)
    }

    const holdTwiml = sayOrPlay('pleaseHold', lang, params.audioUrls)
    return this.twiml(`
      <Response>
        ${greetingTwiml}
        ${noticeTwiml}
        ${holdTwiml}
        <Enqueue waitUrl="/api/telephony/wait-music?lang=${lang}${hp}" action="/api/telephony/queue-exit?callSid=${params.callSid}&amp;lang=${lang}${hp}" method="POST">${params.callSid}</Enqueue>
      </Response>
    `)
  }

  async handleCaptchaResponse(params: CaptchaResponseParams): Promise<TelephonyResponse> {
    const lang = params.callerLanguage
    const tLang = getTwilioVoice(lang)
    const hp = hubXmlParam(params.hubId)

    if (params.outcome === 'pass') {
      return this.twiml(`
        <Response>
          <Say language="${tLang}">${escapeXml(getPrompt('captchaSuccess', lang))}</Say>
          <Enqueue waitUrl="/api/telephony/wait-music?lang=${lang}${hp}" action="/api/telephony/queue-exit?callSid=${params.callSid}&amp;lang=${lang}${hp}" method="POST">${params.callSid}</Enqueue>
        </Response>
      `)
    }

    const lead = params.outcome === 'retry'
      ? sayOrPlay('captchaRetry', lang)
      : sayOrPlay('captchaPrompt', lang, params.audioUrls)
    return this.twiml(`
      <Response>
        ${this.captchaChallenge(params.callSid, lang, params.hubId, params.digitsToSpeak, lead, params.round)}
      </Response>
    `)
  }

  /**
   * One CAPTCHA challenge: `lead`, the digits, the star hint, then a gather for
   * the answer.
   *
   * - `finishOnKey` stays Twilio's default `#`, so `*` is collected as a digit
   *   and arrives in `Digits` (the server reads it as "say them again"); with
   *   `numDigits="4"` a lone `*` is submitted once `timeout` elapses.
   * - With no input at all `<Gather>` falls through to the next verb (Twilio
   *   requests `action` only when it received input), so a `<Redirect>` to the
   *   same route follows it: the server learns of the timeout as a submission
   *   with no digits, counts it, and gives the second attempt.
   */
  private captchaChallenge(callSid: string, lang: string, hubId: string | undefined, digits: string, lead: string, round: number): string {
    const tLang = getTwilioVoice(lang)
    const action = `/api/telephony/captcha?callSid=${callSid}&amp;lang=${lang}&amp;round=${round}${hubXmlParam(hubId)}`
    return `
          <Gather numDigits="4" action="${action}" method="POST" timeout="10">
            ${lead}
            <Say language="${tLang}">${escapeXml(digits.split('').join(', '))}.</Say>
            ${sayOrPlay('captchaRepeatHint', lang)}
          </Gather>
          <Redirect method="POST">${action}</Redirect>`
  }

  async handleCallAnswered(params: CallAnsweredParams): Promise<TelephonyResponse> {
    // CRIT-W1: Hub and pubkey are resolved from DB in /call-recording — no URL params needed
    // #1505: no recording attributes at all unless this hub opted in. An absent
    // `record` attribute means Twilio never writes the audio to disk, so there
    // is nothing at the provider to leak, fetch, or forget to delete.
    const recordAttrs = params.recordCall
      ? ` record="record-from-answer" recordingStatusCallback="${params.callbackUrl}/api/telephony/call-recording?parentCallSid=${params.parentCallSid}" recordingStatusCallbackEvent="completed"`
      : ''
    return this.twiml(`
      <Response>
        <Dial${recordAttrs}>
          <Queue>${params.parentCallSid}</Queue>
        </Dial>
      </Response>
    `)
  }

  async handleWaitMusic(lang: string, audioUrls?: AudioUrlMap, queueTime?: number, queueTimeout?: number): Promise<TelephonyResponse> {
    // After timeout in queue with no answer, leave queue → triggers voicemail
    if (queueTime !== undefined && queueTime >= (queueTimeout ?? 90)) {
      return this.twiml(`<Response><Leave/></Response>`)
    }

    const waitTwiml = sayOrPlay('waitMessage', lang, audioUrls)
    const holdMusic = holdMusicUrl(audioUrls)
    return this.twiml(`
      <Response>
        ${waitTwiml}
        ${holdMusic ? `<Play>${escapeXml(holdMusic)}</Play>` : ''}
      </Response>
    `)
  }

  async handleVoicemail(params: VoicemailParams): Promise<TelephonyResponse> {
    const lang = params.callerLanguage
    const hp = hubXmlParam(params.hubId)
    const voicemailTwiml = sayOrPlay('voicemailPrompt', lang, params.audioUrls)
    return this.twiml(`
      <Response>
        ${voicemailTwiml}
        <Record maxLength="${params.maxRecordingSeconds ?? 120}" action="/api/telephony/voicemail-complete?callSid=${params.callSid}&amp;lang=${lang}${hp}" recordingStatusCallback="${params.callbackUrl}/api/telephony/voicemail-recording?callSid=${params.callSid}${hp}" recordingStatusCallbackEvent="completed" />
        <Hangup/>
      </Response>
    `)
  }

  rejectCall(): TelephonyResponse {
    return this.twiml('<Response><Reject reason="rejected"/></Response>')
  }

  hangupResponse(): TelephonyResponse {
    return this.twiml('<Response><Hangup/></Response>')
  }

  async hangupCall(callSid: string): Promise<void> {
    const res = await this.twilioApi(`/Calls/${callSid}.json`, {
      method: 'POST',
      body: new URLSearchParams({ Status: 'completed' }),
    })
    // 21220: "Call is not in-progress" — the call already completed, i.e. disconnected.
    if (res.status === 400 && (await res.clone().text().catch(() => '')).includes('21220')) return
    await assertHangupResponse(res, 'Twilio')
  }

  async ringVolunteers(params: RingVolunteersParams): Promise<string[]> {
    const calls = await Promise.allSettled(
      params.volunteers.map(async (vol) => {
        // CRIT-W2: Use opaque callToken instead of raw pubkey in callback URLs
        // CRIT-W1: No ?hub= param — hub is resolved from DB call record server-side
        const body = new URLSearchParams({
          To: vol.phone,
          From: this.phoneNumber,
          Url: `${params.callbackUrl}/api/telephony/user-answer?callToken=${encodeURIComponent(vol.callToken)}`,
          StatusCallback: `${params.callbackUrl}/api/telephony/call-status?callToken=${encodeURIComponent(vol.callToken)}`,
          Timeout: '30',
          MachineDetection: 'Enable',
        })
        // Twilio REST API requires separate params per event (not space-separated)
        body.append('StatusCallbackEvent', 'initiated')
        body.append('StatusCallbackEvent', 'ringing')
        body.append('StatusCallbackEvent', 'answered')
        body.append('StatusCallbackEvent', 'completed')

        const res = await this.twilioApi('/Calls.json', {
          method: 'POST',
          body,
        })

        if (res.ok) {
          const data = await res.json() as { sid: string }
          return data.sid
        }
        throw new Error(`Failed to call volunteer: ${res.status}`)
      })
    )

    // Throws when EVERY leg failed (total outage) — see AllDialsFailedError. A partial
    // failure returns whatever succeeded (#1136).
    return collectRingResults(calls, 'Twilio', (msg, err) => logger.error(msg, err))
  }

  async cancelRinging(callSids: string[], exceptSid?: string): Promise<void> {
    await Promise.allSettled(
      callSids
        .filter(sid => sid !== exceptSid)
        .map(sid =>
          this.twilioApi(`/Calls/${sid}.json`, {
            method: 'POST',
            body: new URLSearchParams({ Status: 'completed' }),
          })
        )
    )
  }

  async validateWebhook(request: Request): Promise<boolean> {
    const signature = request.headers.get('X-Twilio-Signature')
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

  /**
   * The canonical string Twilio signs: the full URL, query included, then the
   * POST params sorted by name and decoded. Shared by `validateWebhook` and
   * `webhookReplayKey`, so a request re-encoded or with its params reordered —
   * which still validates — is recognised as the same request.
   */
  protected async signingInput(request: Request): Promise<string> {
    const url = buildWebhookUrl(request, this.webhookBaseUrl)
    const params = new URLSearchParams(await request.clone().text())
    let dataString = url.toString()
    const sortedEntries = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b))
    for (const [key, value] of sortedEntries) {
      dataString += key + value
    }
    return dataString
  }

  async webhookReplayKey(request: Request): Promise<string> {
    return this.signingInput(request)
  }

  async getCallRecording(callSid: string): Promise<ArrayBuffer | null> {
    const res = await this.twilioApi(`/Calls/${callSid}/Recordings.json`, {
      method: 'GET',
    })
    if (!res.ok) return null

    const data = await res.json() as { recordings?: Array<{ sid: string }> }
    if (!data.recordings?.length) return null

    const recordingSid = data.recordings[0].sid
    const audioRes = await safeFetch(
      `${this.getRecordingBaseUrl()}/Recordings/${recordingSid}.wav`,
      {
        headers: {
          'Authorization': 'Basic ' + btoa(`${this.accountSid}:${this.authToken}`),
        },
        timeoutMs: 60_000,
      }
    )

    if (!audioRes.ok) return null
    return audioRes.arrayBuffer()
  }

  async getRecordingAudio(recordingSid: string): Promise<ArrayBuffer | null> {
    const audioRes = await safeFetch(
      `${this.getRecordingBaseUrl()}/Recordings/${recordingSid}.wav`,
      {
        headers: {
          'Authorization': 'Basic ' + btoa(`${this.accountSid}:${this.authToken}`),
        },
        timeoutMs: 60_000,
      }
    )
    if (!audioRes.ok) return null
    return audioRes.arrayBuffer()
  }

  /** Display name used in errors and posture evidence — SignalWire overrides it. */
  protected get providerLabel(): string {
    return 'Twilio'
  }

  providerAccountId(): string {
    return `${this.providerLabel.toLowerCase()}:${this.getApiBaseUrl()}`
  }

  async deleteRecording(recordingSid: string): Promise<void> {
    const res = await this.twilioApi(`/Recordings/${encodeURIComponent(recordingSid)}.json`, { method: 'DELETE' })
    await assertRecordingDeleted(res, this.providerLabel)
  }

  /**
   * `DELETE /Calls/{Sid}.json` (#2309). Twilio documents that the record then
   * no longer appears in the API or console logs, that it refuses a call still
   * in progress, and that recordings and transcriptions are NOT deleted with
   * it — those go through `deleteRecording`. SignalWire's compatibility API
   * documents the same route.
   */
  async deleteCallLog(callSid: string): Promise<void> {
    const res = await this.twilioApi(`/Calls/${encodeURIComponent(callSid)}.json`, { method: 'DELETE' })
    await assertCallLogDeleted(res, this.providerLabel)
  }

  async enforceRecordingPosture(): Promise<ProviderSettingEnforcement[]> {
    const [recording, transcription] = await Promise.all([
      this.enforceNumberRecording(),
      this.enforceAccountTranscription(),
    ])
    return [...recording, ...transcription]
  }

  /**
   * The number routes either to this server (whose TwiML records only
   * voicemail and opted-in calls), to an Elastic SIP trunk with its own
   * recording mode, or somewhere this server cannot see into.
   */
  private async enforceNumberRecording(): Promise<ProviderSettingEnforcement[]> {
    const target = `number ${this.phoneNumber}`
    const lookup = await this.lookupNumber()
    if ('reading' in lookup) {
      return [{ setting: 'recording', target, outcome: 'failed', reason: lookup.reading.reason }]
    }
    const { number } = lookup
    if (number.trunk_sid) return [await this.enforceTrunkRecording(number.trunk_sid)]
    if (number.voice_application_sid) {
      return [{
        setting: 'recording',
        target,
        outcome: 'not-settable',
        reason: `${this.phoneNumber} runs TwiML application ${number.voice_application_sid}; ${this.providerLabel} has no recording switch for it, and this server does not rewrite another application's routing`,
      }]
    }
    const reading = this.readVoiceUrl(number.voice_url ?? '')
    if (reading.state === 'off') return [{ setting: 'recording', target, outcome: 'already-off', evidence: reading.evidence }]
    return [{
      setting: 'recording',
      target,
      outcome: 'not-settable',
      reason: reading.state === 'unknown'
        ? `${reading.reason}; ${this.providerLabel} has no number-level recording switch, and this server does not rewrite the number's routing`
        : reading.evidence,
    }]
  }

  /** Elastic SIP trunk recording — `POST /v1/Trunks/{Sid}/Recording` with `Mode=do-not-record`. SignalWire overrides it. */
  protected async enforceTrunkRecording(trunkSid: string): Promise<ProviderSettingEnforcement> {
    const target = `SIP trunk ${trunkSid}`
    const current = await this.readTrunkRecording(trunkSid)
    if (current.state === 'off') return { setting: 'recording', target, outcome: 'already-off', evidence: current.evidence }
    let res: Response
    try {
      res = await this.twilioPost(
        `https://trunking.twilio.com/v1/Trunks/${encodeURIComponent(trunkSid)}/Recording`,
        new URLSearchParams({ Mode: 'do-not-record' }),
      )
    } catch (err) {
      return enforcementFailed('recording', target, 'Twilio', err)
    }
    if (!res.ok) return enforcementFailed('recording', target, 'Twilio', res)
    const was = current.state === 'on' ? ` (${current.evidence})` : ''
    return { setting: 'recording', target, outcome: 'disabled', evidence: `Twilio accepted recording mode do-not-record for SIP trunk ${trunkSid}${was}` }
  }

  /**
   * Conversational Intelligence: every service with `auto_transcribe` gets
   * `AutoTranscribe=false` (`POST /v2/Services/{Sid}`; Twilio documents up to
   * five minutes to propagate). SignalWire overrides it.
   */
  protected async enforceAccountTranscription(): Promise<ProviderSettingEnforcement[]> {
    const target = 'Conversational Intelligence services'
    let res: Response
    try {
      res = await this.twilioGet('https://intelligence.twilio.com/v2/Services?PageSize=50')
    } catch (err) {
      return [enforcementFailed('transcription', target, 'Twilio', err)]
    }
    if (!res.ok) return [enforcementFailed('transcription', target, 'Twilio', res)]
    const data = await res.json() as { services?: Array<{ sid: string; unique_name?: string; auto_transcribe?: boolean }> }
    const services = data.services ?? []
    const auto = services.filter(svc => svc.auto_transcribe === true)
    if (auto.length === 0) {
      return [{ setting: 'transcription', target, outcome: 'already-off', evidence: `${services.length} Twilio Intelligence service(s), none auto-transcribing` }]
    }
    return Promise.all(auto.map(async (svc): Promise<ProviderSettingEnforcement> => {
      const svcTarget = `Intelligence service ${svc.unique_name || svc.sid}`
      let update: Response
      try {
        update = await this.twilioPost(
          `https://intelligence.twilio.com/v2/Services/${encodeURIComponent(svc.sid)}`,
          new URLSearchParams({ AutoTranscribe: 'false' }),
        )
      } catch (err) {
        return enforcementFailed('transcription', svcTarget, 'Twilio', err)
      }
      if (!update.ok) return enforcementFailed('transcription', svcTarget, 'Twilio', update)
      return { setting: 'transcription', target: svcTarget, outcome: 'disabled', evidence: `Twilio accepted AutoTranscribe=false for ${svcTarget} (Twilio documents up to five minutes to propagate)` }
    }))
  }

  providerRetention(): ProviderRetentionStatement {
    return {
      removed: [
        {
          what: 'Voicemail and call recordings',
          how: 'DELETE /Recordings/{Sid} once fetched — a call recording after the server holds its own sealed copy. A refusal stays in heldAtProvider and is retried.',
        },
        {
          what: 'Call log records of the caller\'s call and of every volunteer ring leg (they name both phone numbers)',
          how: 'DELETE /Calls/{Sid} once the call has ended; Twilio refuses while a call is in progress. A refusal stays in heldAtProvider and is retried.',
        },
      ],
      retained: [
        {
          what: 'SMS and WhatsApp message records, including bodies',
          reason: 'This server does not delete messages at Twilio. Twilio documents DELETE /Messages/{Sid}, and says message bodies may persist in its database backups for up to 30 days after a deletion.',
        },
        {
          what: 'Recordings and transcriptions this server did not request',
          reason: 'Not deleted automatically: they are reported under recording and transcription instead, and may belong to another use of the account.',
        },
        {
          what: 'Account usage and billing records',
          reason: 'Twilio keeps per-account usage for billing; the Usage Records API is read-only.',
        },
        {
          what: 'Debugger and error logs of webhook requests',
          reason: 'They can carry request parameters such as phone numbers; this server does not delete them.',
        },
      ],
      source: 'Twilio REST API documentation (Call, Recording, Message, Transcription resources), checked 2026-10-29',
    }
  }

  async probeRecordingPosture(context: RecordingPostureContext): Promise<ProviderRecordingPosture> {
    const [routing, inventory, transcripts, extraRecording, extraTranscription] = await Promise.all([
      this.readNumberRouting(),
      this.readRecordingInventory(context),
      this.readTranscriptionInventory(),
      this.readAccountRecordingSettings(),
      this.readAccountTranscriptionSettings(),
    ])
    return {
      recording: combineReadings([routing, inventory, ...extraRecording]),
      transcription: combineReadings([routing, transcripts, ...extraTranscription]),
    }
  }

  /**
   * Who answers the hotline number. Recording can be requested by whatever
   * TwiML the number runs, so a number that does not route to this server
   * cannot be vouched for; a number on an Elastic SIP trunk records per the
   * trunk's own setting (read by the Twilio-only override).
   */
  protected async readNumberRouting(): Promise<ProviderSettingReading> {
    const lookup = await this.lookupNumber()
    if ('reading' in lookup) return lookup.reading
    const { number } = lookup
    if (number.trunk_sid) return this.readTrunkRecording(number.trunk_sid)
    if (number.voice_application_sid) {
      return {
        state: 'unknown',
        reason: `${this.phoneNumber} runs TwiML application ${number.voice_application_sid}, whose TwiML this probe cannot read — it could record or transcribe`,
      }
    }
    return this.readVoiceUrl(number.voice_url ?? '')
  }

  /** The hotline number's routing, or why it could not be read. */
  private async lookupNumber(): Promise<
    | { number: { voice_url?: string | null; trunk_sid?: string | null; voice_application_sid?: string | null } }
    | { reading: Extract<ProviderSettingReading, { state: 'unknown' }> }
  > {
    const label = this.providerLabel
    const what = `the configuration of ${this.phoneNumber}`
    let res: Response
    try {
      res = await this.twilioApi(`/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(this.phoneNumber)}`, { method: 'GET' })
    } catch (err) {
      return { reading: unreadable(label, what, err) }
    }
    if (!res.ok) return { reading: unreadable(label, what, res) }
    const data = await res.json() as {
      incoming_phone_numbers?: Array<{ voice_url?: string | null; trunk_sid?: string | null; voice_application_sid?: string | null }>
    }
    const number = data.incoming_phone_numbers?.[0]
    if (!number) return { reading: { state: 'unknown', reason: `${this.phoneNumber} is not a number on this ${label} account` } }
    return { number }
  }

  private readVoiceUrl(voiceUrl: string): ProviderSettingReading {
    let url: URL
    try {
      url = new URL(voiceUrl)
    } catch {
      return { state: 'unknown', reason: `${this.phoneNumber} has no usable voice URL (${JSON.stringify(voiceUrl)})` }
    }
    const ours = url.pathname.startsWith('/api/telephony/')
      && (!this.webhookBaseUrl || url.origin === new URL(this.webhookBaseUrl).origin)
    if (!ours) {
      return {
        state: 'unknown',
        reason: `${this.phoneNumber} routes to ${url.origin}${url.pathname}, not this server; TwiML served from there could record or transcribe`,
      }
    }
    return {
      state: 'off',
      evidence: `${this.phoneNumber} routes to this server, which asks ${this.providerLabel} to record only voicemail and opted-in calls, and never to transcribe`,
    }
  }

  /** Elastic SIP trunk recording — Twilio only; SignalWire trunks cannot record. */
  protected async readTrunkRecording(trunkSid: string): Promise<ProviderSettingReading> {
    const what = `the recording mode of SIP trunk ${trunkSid}`
    let res: Response
    try {
      res = await this.twilioGet(`https://trunking.twilio.com/v1/Trunks/${encodeURIComponent(trunkSid)}`)
    } catch (err) {
      return unreadable('Twilio', what, err)
    }
    if (!res.ok) return unreadable('Twilio', what, res)
    const data = await res.json() as { recording?: { mode?: string } }
    const mode = data.recording?.mode
    if (!mode) return { state: 'unknown', reason: `${what} was not in Twilio's answer` }
    if (mode === 'do-not-record') return { state: 'off', evidence: `SIP trunk ${trunkSid} recording mode is do-not-record` }
    return { state: 'on', evidence: `SIP trunk ${trunkSid} recording mode is ${mode}` }
  }

  private async readRecordingInventory(context: RecordingPostureContext): Promise<ProviderSettingReading> {
    const label = this.providerLabel
    let res: Response
    try {
      res = await this.twilioApi('/Recordings.json?PageSize=50', { method: 'GET' })
    } catch (err) {
      return unreadable(label, 'the account\'s recordings', err)
    }
    if (!res.ok) return unreadable(label, 'the account\'s recordings', res)
    const data = await res.json() as { recordings?: Array<{ sid: string; date_created?: string | null }> }
    return inventoryReading({
      provider: label,
      what: 'recordings',
      source: `the newest ${label} recordings`,
      listed: (data.recordings ?? []).map(r => ({ handle: r.sid, createdAt: r.date_created ? new Date(r.date_created) : null })),
      context,
    })
  }

  /** This server never asks the provider to transcribe, so any transcription is one it did not request. */
  private async readTranscriptionInventory(): Promise<ProviderSettingReading> {
    const label = this.providerLabel
    let res: Response
    try {
      res = await this.twilioApi('/Transcriptions.json?PageSize=20', { method: 'GET' })
    } catch (err) {
      return unreadable(label, 'the account\'s transcriptions', err)
    }
    if (!res.ok) return unreadable(label, 'the account\'s transcriptions', res)
    const data = await res.json() as { transcriptions?: unknown[] }
    const count = data.transcriptions?.length ?? 0
    return count > 0
      ? { state: 'on', evidence: `${label} holds ${count} transcription(s); this server never requests one` }
      : { state: 'off', evidence: `${label} holds no <Record transcribe> transcriptions` }
  }

  /** Account-level recording settings beyond the number — none on SignalWire. */
  protected async readAccountRecordingSettings(): Promise<ProviderSettingReading[]> {
    return []
  }

  /**
   * Twilio Conversational Intelligence: a service with `auto_transcribe`
   * transcribes EVERY recording made on the account, and its transcripts do
   * not appear under /Transcriptions.
   */
  protected async readAccountTranscriptionSettings(): Promise<ProviderSettingReading[]> {
    const what = 'Conversational Intelligence services'
    let res: Response
    try {
      res = await this.twilioGet('https://intelligence.twilio.com/v2/Services?PageSize=50')
    } catch (err) {
      return [unreadable('Twilio', what, err)]
    }
    if (!res.ok) return [unreadable('Twilio', what, res)]
    const data = await res.json() as { services?: Array<{ sid: string; unique_name?: string; auto_transcribe?: boolean }> }
    const auto = (data.services ?? []).filter(svc => svc.auto_transcribe === true)
    if (auto.length > 0) {
      return [{
        state: 'on',
        evidence: `Twilio Intelligence service(s) ${auto.map(svc => svc.unique_name || svc.sid).join(', ')} auto-transcribe every recording on the account`,
      }]
    }
    return [{ state: 'off', evidence: `${data.services?.length ?? 0} Twilio Intelligence service(s), none auto-transcribing` }]
  }

  /** GET an absolute Twilio URL (trunking, intelligence) with this account's credentials. */
  protected twilioGet(url: string): Promise<Response> {
    return safeFetch(url, {
      method: 'GET',
      headers: { 'Authorization': 'Basic ' + btoa(`${this.accountSid}:${this.authToken}`) },
    })
  }

  /** POST a form to an absolute Twilio URL (trunking, intelligence) with this account's credentials. */
  protected twilioPost(url: string, body: URLSearchParams): Promise<Response> {
    return safeFetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(`${this.accountSid}:${this.authToken}`),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    })
  }

  // --- Webhook parsing ---

  async parseIncomingWebhook(request: Request): Promise<WebhookCallInfo> {
    const form = await request.clone().formData()
    return {
      callSid: form.get('CallSid') as string,
      callerNumber: form.get('From') as string,
      calledNumber: (form.get('To') as string) || undefined,
      answeredByMachine: isMachineAnsweredBy(form.get('AnsweredBy') as string | null),
    }
  }

  async parseLanguageWebhook(request: Request): Promise<WebhookCallInfo & WebhookDigits> {
    const form = await request.clone().formData()
    return {
      callSid: form.get('CallSid') as string,
      callerNumber: form.get('From') as string,
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
    const raw = form.get('CallStatus') as string
    const STATUS_MAP: Record<string, WebhookCallStatus['status']> = {
      initiated: 'initiated',
      ringing: 'ringing',
      'in-progress': 'answered',
      completed: 'completed',
      busy: 'busy',
      'no-answer': 'no-answer',
      failed: 'failed',
      canceled: 'failed',
    }
    return { status: STATUS_MAP[raw] ?? 'failed' }
  }

  async parseQueueWaitWebhook(request: Request): Promise<WebhookQueueWait> {
    const form = await request.clone().formData()
    return {
      queueTime: parseInt((form.get('QueueTime') as string) || '0', 10),
    }
  }

  async parseQueueExitWebhook(request: Request): Promise<WebhookQueueResult> {
    const form = await request.clone().formData()
    const raw = form.get('QueueResult') as string
    const RESULT_MAP: Record<string, WebhookQueueResult['result']> = {
      'leave': 'leave',
      'queue-full': 'queue-full',
      'error': 'error',
      'bridged': 'bridged',
      'hangup': 'hangup',
    }
    return { result: RESULT_MAP[raw] ?? 'error' }
  }

  async parseRecordingWebhook(request: Request): Promise<WebhookRecordingStatus> {
    const form = await request.clone().formData()
    const raw = form.get('RecordingStatus') as string
    return {
      status: raw === 'completed' ? 'completed' : 'failed',
      // RecordingUrl ends in the same sid; a callback missing the field still
      // names the recording, and an unaddressed recording cannot be deleted.
      recordingSid: (form.get('RecordingSid') as string)
        || twilioRecordingSidFromUrl(form.get('RecordingUrl') as string | null)
        || undefined,
      callSid: (form.get('CallSid') as string) || undefined,
    }
  }

  // --- Additional response methods ---

  handleVoicemailComplete(lang: string): TelephonyResponse {
    const voice = getTwilioVoice(lang)
    return this.twiml(`
      <Response>
        <Say language="${voice}">${getVoicemailThanks(lang)}</Say>
        <Hangup/>
      </Response>
    `)
  }

  emptyResponse(): TelephonyResponse {
    return this.twiml('<Response/>')
  }

  // --- Helpers ---

  protected twiml(xml: string): TelephonyResponse {
    return {
      contentType: 'text/xml',
      body: xml.trim(),
    }
  }

  protected getApiBaseUrl(): string {
    return `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}`
  }

  protected getRecordingBaseUrl(): string {
    return `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}`
  }

  protected async twilioApi(path: string, init: RequestInit): Promise<Response> {
    return safeFetch(
      `${this.getApiBaseUrl()}${path}`,
      {
        ...init,
        headers: {
          'Authorization': 'Basic ' + btoa(`${this.accountSid}:${this.authToken}`),
          ...(init.body instanceof URLSearchParams
            ? { 'Content-Type': 'application/x-www-form-urlencoded' }
            : {}),
          ...init.headers,
        },
      }
    )
  }
}

/**
 * The sid at the end of a recording-status callback's `RecordingUrl`
 * (`…/Accounts/{account}/Recordings/{sid}`, optionally with a media
 * extension) — Twilio `RE…` sids and SignalWire UUIDs alike.
 */
export function twilioRecordingSidFromUrl(url: string | null | undefined): string | null {
  if (!url) return null
  let path: string
  try {
    path = new URL(url).pathname
  } catch {
    return null
  }
  return /\/Recordings\/([A-Za-z0-9-]+)(?:\.[a-z0-9]+)?$/.exec(path)?.[1] ?? null
}
