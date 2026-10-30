import type {
  IncomingCallParams,
  CaptchaResponseParams,
  CallAnsweredParams,
  LanguageMenuParams,
  VoicemailParams,
  TelephonyResponse,
  AudioUrlMap,
  SpeechUrlBuilder,
} from './adapter'
import { SipBridgeAdapter } from './sip-bridge-adapter'
import { getPrompt, getVoicemailThanks } from '@shared/voice-prompts'
import { IvrVoiceCatalog, buildIvrLanguageMenu } from './ivr-menu'
import { GENERATED_SPEECH_LOCALES } from '../services/ivr-speech/voices'

/**
 * FreeSwitchAdapter — generates mod_httapi XML responses for FreeSWITCH.
 *
 * FreeSWITCH's mod_httapi module POSTs channel variables to an HTTP endpoint
 * and expects XML documents back that control call flow.
 *
 * Extends SipBridgeAdapter which provides shared bridge communication,
 * webhook validation/parsing, and recording retrieval.
 */
export class FreeSwitchAdapter extends SipBridgeAdapter {
  constructor(
    phoneNumber: string,
    bridgeCallbackUrl: string,
    bridgeSecret: string,
    private readonly callbackBaseUrl: string,
  ) {
    super(phoneNumber, bridgeCallbackUrl, bridgeSecret)
  }

  getEndpointFormat(phone: string): string {
    return `sofia/internal/${phone}@trunk`
  }

  getPbxType(): string {
    return 'freeswitch'
  }

  // --- mod_httapi XML helpers ---

  private doc(work: string, params?: Record<string, string>): string {
    let paramsXml = ''
    if (params && Object.keys(params).length > 0) {
      const entries = Object.entries(params)
        .map(([k, v]) => `    <param name="${escapeXml(k)}" value="${escapeXml(v)}"/>`)
        .join('\n')
      paramsXml = `\n  <params>\n${entries}\n  </params>`
    }
    return `<document type="xml/freeswitch-httapi">${paramsXml}\n  <work>${work}\n  </work>\n</document>`
  }

  private fsPlay(url: string): string {
    return `\n    <playback file="${escapeXml(url)}"/>`
  }

  /** Play a prompt: the operator's upload for the caller's language, else generated speech */
  private fsPrompt(
    promptKey: string,
    lang: string,
    audioUrls: AudioUrlMap | undefined,
    speechUrl: SpeechUrlBuilder | undefined,
    text?: (speechLang: string) => string,
  ): string {
    return this.fsPlay(this.promptUrl(promptKey, lang, audioUrls, speechUrl, text))
  }

  /** Play text no operator can upload (it varies per call, or has no prompt type) as generated speech */
  private fsSpeech(text: (speechLang: string) => string, lang: string, speechUrl: SpeechUrlBuilder | undefined): string {
    return this.fsPlay(this.generatedSpeechUrl(text, lang, speechUrl))
  }

  private buildCallbackUrl(path: string, hubId?: string): string {
    const base = `${this.callbackBaseUrl}${path}`
    return hubId
      ? `${base}${base.includes('?') ? '&' : '?'}hub=${encodeURIComponent(hubId)}`
      : base
  }

  private xmlResponse(xml: string): TelephonyResponse {
    return {
      contentType: 'text/xml',
      body: xml,
    }
  }

  // --- IVR / Call flow ---

  async handleLanguageMenu(params: LanguageMenuParams): Promise<TelephonyResponse> {
    const { hubId } = params
    const menu = buildIvrLanguageMenu(params.enabledLanguages, FREESWITCH_VOICES)

    if (menu.kind === 'single') {
      const lang = menu.language
      const setVars = [
        `\n    <execute application="set" data="caller_lang=${escapeXml(lang)}"/>`,
        `\n    <execute application="set" data="call_phase=language_selected"/>`,
      ].join('')
      const callbackUrl = this.buildCallbackUrl('/api/telephony/incoming', hubId)
      const continueXml = `\n    <execute application="set" data="httapi_url=${escapeXml(callbackUrl)}"/>`
      return this.xmlResponse(
        this.doc(setVars + continueXml, {
          caller_lang: lang,
          call_phase: 'language_selected',
        }),
      )
    }

    // Each option in its own language: FREESWITCH_VOICES offers only languages generated speech speaks.
    const promptXml = menu.options.map((o) => this.fsSpeech(() => o.prompt, o.language, params.speechUrl)).join('')

    const callbackUrl = this.buildCallbackUrl('/api/telephony/language-selected', hubId)
    const bindXml = `\n    <bind strip="#">~\\d ${escapeXml(callbackUrl)}</bind>`
    const timeoutXml = '\n    <pause milliseconds="8000"/>'

    return this.xmlResponse(this.doc(promptXml + bindXml + timeoutXml))
  }

  async handleIncomingCall(params: IncomingCallParams): Promise<TelephonyResponse> {
    const {
      rateLimited,
      voiceCaptchaEnabled,
      callerLanguage: lang,
      callSid,
      audioUrls,
      speechUrl,
      hubId,
    } = params
    // The same prompts, in the same order, as every cloud adapter: an operator
    // uploads exactly these keys (settings VALID_PROMPT_TYPES); a prompt nobody
    // uploaded is generated speech.
    const greetingXml = this.fsPrompt('greeting', lang, audioUrls, speechUrl, (speechLang) =>
      getPrompt('greeting', speechLang).replace('{name}', params.hotlineName),
    )

    // #1505: disclose provider-side recording before the caller can be connected.
    // Omitted on the rate-limited path — that call is hung up and never recorded.
    const noticeXml = params.callRecordingEnabled
      ? this.fsPrompt('recordingNotice', lang, audioUrls, speechUrl)
      : ''

    if (rateLimited) {
      const speakXml = greetingXml + this.fsPrompt('rateLimited', lang, audioUrls, speechUrl)
      const hangupXml = '\n    <hangup/>'
      return this.xmlResponse(this.doc(speakXml + hangupXml))
    }

    if (voiceCaptchaEnabled && params.captchaDigits) {
      const leadXml = greetingXml + noticeXml + this.fsPrompt('captchaPrompt', lang, audioUrls, speechUrl)
      return this.xmlResponse(
        this.doc(this.captchaChallenge(callSid, lang, hubId, params.captchaDigits, speechUrl, leadXml, 0), {
          call_phase: 'captcha',
        }),
      )
    }

    const speakXml = greetingXml + noticeXml + this.fsPrompt('pleaseHold', lang, audioUrls, speechUrl)
    const parkXml = `\n    <execute application="park"/>`
    return this.xmlResponse(
      this.doc(speakXml + parkXml, {
        call_phase: 'queue',
        queue_name: callSid,
      }),
    )
  }

  async handleCaptchaResponse(params: CaptchaResponseParams): Promise<TelephonyResponse> {
    const { callerLanguage: lang, callSid, audioUrls, speechUrl, hubId } = params

    if (params.outcome === 'pass') {
      const speakXml = this.fsSpeech((speechLang) => getPrompt('captchaSuccess', speechLang), lang, speechUrl)
      const parkXml = `\n    <execute application="park"/>`
      return this.xmlResponse(
        this.doc(speakXml + parkXml, {
          call_phase: 'queue',
          queue_name: callSid,
        }),
      )
    }

    const leadXml = params.outcome === 'retry'
      ? this.fsSpeech((speechLang) => getPrompt('captchaRetry', speechLang), lang, speechUrl)
      : this.fsPrompt('captchaPrompt', lang, audioUrls, speechUrl)
    return this.xmlResponse(
      this.doc(this.captchaChallenge(callSid, lang, hubId, params.digitsToSpeak, speechUrl, leadXml, params.round), {
        call_phase: 'captcha',
      }),
    )
  }

  /**
   * One CAPTCHA challenge: `lead`, the digits, the star hint, then a digit
   * binding for the answer.
   *
   * - The binding matches either four digits or a lone `*` (the caller asking
   *   to hear them again), and submits the match to the CAPTCHA route.
   * - The callback URL carries the call and its language, as every cloud
   *   adapter's does: the route reads both from the query string.
   * - If nothing matches before the pause ends, the document points
   *   `httapi_url` at the same route, so mod_httapi's next fetch reaches the
   *   server as a submission with no digits — a timeout the server counts —
   *   instead of the call simply ending.
   */
  private captchaChallenge(
    callSid: string,
    lang: string,
    hubId: string | undefined,
    digits: string,
    speechUrl: SpeechUrlBuilder | undefined,
    leadXml: string,
    round: number,
  ): string {
    const callbackUrl = this.buildCallbackUrl(
      `/api/telephony/captcha?callSid=${encodeURIComponent(callSid)}&lang=${encodeURIComponent(lang)}&round=${round}`,
      hubId,
    )
    return (
      leadXml +
      this.captchaDigitUrls(digits, lang, speechUrl).map((url) => this.fsPlay(url)).join('') +
      this.fsSpeech((speechLang) => getPrompt('captchaRepeatHint', speechLang), lang, speechUrl) +
      `\n    <bind strip="#">~^(\\*|\\d{4})$ ${escapeXml(callbackUrl)}</bind>` +
      '\n    <pause milliseconds="10000"/>' +
      `\n    <execute application="set" data="httapi_url=${escapeXml(callbackUrl)}"/>`
    )
  }

  async handleCallAnswered(params: CallAnsweredParams): Promise<TelephonyResponse> {
    const { parentCallSid } = params
    // #1505: this adapter implements no provider-side call recording at all —
    // `intercept` just bridges the legs — so there is no directive to gate and
    // `params.recordCall` is deliberately unused here. It is the one adapter
    // that was never part of the unconditional-recording defect.
    //
    // If bridge recording is ever added to this path it MUST sit behind
    // `params.recordCall`, exactly as every other adapter now does.
    void params.recordCall
    const bridgeXml = `\n    <execute application="intercept" data="${escapeXml(parentCallSid)}"/>`
    return this.xmlResponse(this.doc(bridgeXml))
  }

  async handleVoicemail(params: VoicemailParams): Promise<TelephonyResponse> {
    const { callerLanguage: lang, audioUrls, speechUrl, maxRecordingSeconds, hubId } = params
    const maxSeconds = maxRecordingSeconds || 120
    const speakXml = this.fsPrompt('voicemailPrompt', lang, audioUrls, speechUrl)
    const callbackUrl = this.buildCallbackUrl('/api/telephony/voicemail-recording', hubId)
    const recordXml = `\n    <record name="voicemail_${Date.now()}.wav" error-file="silence_stream://250" beep-file="tone_stream://%(250,0,800)" limit="${maxSeconds}" action="${escapeXml(callbackUrl)}"/>`
    return this.xmlResponse(this.doc(speakXml + recordXml))
  }

  async handleWaitMusic(
    lang: string,
    audioUrls?: AudioUrlMap,
    queueTime?: number,
    queueTimeout?: number,
    speechUrl?: SpeechUrlBuilder,
  ): Promise<TelephonyResponse> {
    const timeout = queueTimeout || 90
    if (queueTime && queueTime >= timeout) {
      const leaveXml = `\n    <execute application="transfer" data="voicemail"/>`
      return this.xmlResponse(this.doc(leaveXml))
    }
    const musicXml = this.fsPrompt('waitMessage', lang, audioUrls, speechUrl)
    return this.xmlResponse(this.doc(musicXml))
  }

  rejectCall(): TelephonyResponse {
    const hangupXml = '\n    <hangup cause="CALL_REJECTED"/>'
    return this.xmlResponse(this.doc(hangupXml))
  }

  handleVoicemailComplete(lang: string, speechUrl?: SpeechUrlBuilder): TelephonyResponse {
    const speakXml = this.fsSpeech((speechLang) => getVoicemailThanks(speechLang), lang, speechUrl)
    const hangupXml = '\n    <hangup/>'
    return this.xmlResponse(this.doc(speakXml + hangupXml))
  }

  emptyResponse(): TelephonyResponse {
    return this.xmlResponse(this.doc(''))
  }
}

// --- Helpers ---

/**
 * The locales a FreeSWITCH IVR can speak: those generated speech has a voice
 * for (the worker synthesises every prompt the operator did not upload, and
 * mod_httapi plays it from its URL). Absent locales are never offered in the
 * IVR menu.
 */
export const FREESWITCH_VOICES = new IvrVoiceCatalog<string>(
  'freeswitch',
  GENERATED_SPEECH_LOCALES.map((locale) => [locale, locale] as const),
)

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
