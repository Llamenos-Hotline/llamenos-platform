import type {
  IncomingCallParams,
  CaptchaResponseParams,
  CallAnsweredParams,
  LanguageMenuParams,
  VoicemailParams,
  TelephonyResponse,
  AudioUrlMap,
} from './adapter'
import { SipBridgeAdapter } from './sip-bridge-adapter'
import { getPrompt, getVoicemailThanks } from '@shared/voice-prompts'
import { IvrVoiceCatalog, buildIvrLanguageMenu } from './ivr-menu'

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

  private fsSpeak(text: string, lang: string): string {
    return `\n    <speak voice="${getFliteVoice(lang)}">${escapeXml(text)}</speak>`
  }

  private fsPlay(url: string): string {
    return `\n    <playback file="${escapeXml(url)}"/>`
  }

  private fsSpeakOrPlay(
    promptKey: string,
    lang: string,
    audioUrls?: AudioUrlMap,
    text?: string,
  ): string {
    const audioUrl = audioUrls?.[`${promptKey}:${lang}`]
    if (audioUrl) return this.fsPlay(audioUrl)
    const content = text ?? getPrompt(promptKey, lang)
    return this.fsSpeak(content, lang)
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

    const promptXml = menu.options.map(o => this.fsSpeak(o.prompt, o.language)).join('')

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
      hubId,
    } = params
    // The same prompts, in the same order, as every cloud adapter: an operator
    // uploads exactly these keys (settings VALID_PROMPT_TYPES).
    const greetingXml = this.fsSpeakOrPlay(
      'greeting',
      lang,
      audioUrls,
      getPrompt('greeting', lang).replace('{name}', params.hotlineName),
    )

    if (rateLimited) {
      const speakXml = greetingXml + this.fsSpeakOrPlay('rateLimited', lang, audioUrls)
      const hangupXml = '\n    <hangup/>'
      return this.xmlResponse(this.doc(speakXml + hangupXml))
    }

    if (voiceCaptchaEnabled && params.captchaDigits) {
      const digits = params.captchaDigits
      const speakXml =
        greetingXml +
        this.fsSpeakOrPlay('captchaPrompt', lang, audioUrls) +
        this.fsSpeak(digits.split('').join(' '), lang)
      const callbackUrl = this.buildCallbackUrl('/api/telephony/captcha', hubId)
      const bindXml = `\n    <bind strip="#">~\\d{4} ${escapeXml(callbackUrl)}</bind>`
      const timeoutXml = '\n    <pause milliseconds="10000"/>'
      return this.xmlResponse(
        this.doc(speakXml + bindXml + timeoutXml, {
          call_phase: 'captcha',
        }),
      )
    }

    const speakXml = greetingXml + this.fsSpeakOrPlay('pleaseHold', lang, audioUrls)
    const parkXml = `\n    <execute application="park"/>`
    return this.xmlResponse(
      this.doc(speakXml + parkXml, {
        call_phase: 'queue',
        queue_name: callSid,
      }),
    )
  }

  async handleCaptchaResponse(params: CaptchaResponseParams): Promise<TelephonyResponse> {
    const { digits, expectedDigits, callerLanguage: lang, callSid } = params

    if (digits === expectedDigits) {
      const speakXml = this.fsSpeak(getPrompt('captchaSuccess', lang), lang)
      const parkXml = `\n    <execute application="park"/>`
      return this.xmlResponse(
        this.doc(speakXml + parkXml, {
          call_phase: 'queue',
          queue_name: callSid,
        }),
      )
    }

    const failXml = this.fsSpeak(getPrompt('captchaFail', lang), lang)
    const hangupXml = '\n    <hangup/>'
    return this.xmlResponse(this.doc(failXml + hangupXml))
  }

  async handleCallAnswered(params: CallAnsweredParams): Promise<TelephonyResponse> {
    const { parentCallSid } = params
    const bridgeXml = `\n    <execute application="intercept" data="${escapeXml(parentCallSid)}"/>`
    return this.xmlResponse(this.doc(bridgeXml))
  }

  async handleVoicemail(params: VoicemailParams): Promise<TelephonyResponse> {
    const { callerLanguage: lang, audioUrls, maxRecordingSeconds, hubId } = params
    const maxSeconds = maxRecordingSeconds || 120
    const speakXml = this.fsSpeakOrPlay('voicemailPrompt', lang, audioUrls)
    const callbackUrl = this.buildCallbackUrl('/api/telephony/voicemail-recording', hubId)
    const recordXml = `\n    <record name="voicemail_${Date.now()}.wav" error-file="silence_stream://250" beep-file="tone_stream://%(250,0,800)" limit="${maxSeconds}" action="${escapeXml(callbackUrl)}"/>`
    return this.xmlResponse(this.doc(speakXml + recordXml))
  }

  async handleWaitMusic(
    lang: string,
    audioUrls?: AudioUrlMap,
    queueTime?: number,
    queueTimeout?: number,
  ): Promise<TelephonyResponse> {
    const timeout = queueTimeout || 90
    if (queueTime && queueTime >= timeout) {
      const leaveXml = `\n    <execute application="transfer" data="voicemail"/>`
      return this.xmlResponse(this.doc(leaveXml))
    }
    const musicXml = this.fsSpeakOrPlay('waitMessage', lang, audioUrls)
    return this.xmlResponse(this.doc(musicXml))
  }

  rejectCall(): TelephonyResponse {
    const hangupXml = '\n    <hangup cause="CALL_REJECTED"/>'
    return this.xmlResponse(this.doc(hangupXml))
  }

  handleVoicemailComplete(lang: string): TelephonyResponse {
    const speakXml = this.fsSpeak(getVoicemailThanks(lang), lang)
    const hangupXml = '\n    <hangup/>'
    return this.xmlResponse(this.doc(speakXml + hangupXml))
  }

  emptyResponse(): TelephonyResponse {
    return this.xmlResponse(this.doc(''))
  }
}

// --- Helpers ---

/**
 * FreeSWITCH TTS voices (mod_flite) — the explicit, ordered list of locales
 * FreeSWITCH can speak. Flite ships English voices only, so FreeSWITCH offers
 * no multi-language IVR menu until a multilingual TTS engine is configured.
 */
export const FREESWITCH_VOICES = new IvrVoiceCatalog<string>('freeswitch', [
  ['en', 'slt'],
])

function getFliteVoice(lang: string): string {
  return FREESWITCH_VOICES.voiceForPrompt(lang)
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
