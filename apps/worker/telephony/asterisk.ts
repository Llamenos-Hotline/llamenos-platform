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
 * ARI command types — JSON commands sent to the sip-bridge sidecar
 * (executed by sip-bridge/src/command-handler.ts; the two vocabularies are held
 * together by deploy/docker/tests/telephony/asterisk-bridge-contract.test.ts).
 *
 * Every command acts on the channel of the webhook it answers. `metadata` is
 * the query string of the callback the command triggers — the same context a
 * Twilio action URL carries (hub, callSid, lang), which the telephony routes
 * read from `url.searchParams`.
 */
interface AriCommandBase {
  action: string
}

interface AriPlayCommand extends AriCommandBase {
  action: 'play'
  url: string
}

interface AriGatherCommand extends AriCommandBase {
  action: 'gather'
  numDigits: number
  timeout: number
  callbackEvent: 'language_selected' | 'captcha_response'
  metadata?: Record<string, string>
}

interface AriQueueCommand extends AriCommandBase {
  action: 'queue'
  queueName: string
  waitMusicEvent: 'wait_music'
  exitEvent: 'queue_exit'
  metadata: Record<string, string>
}

interface AriBridgeCommand extends AriCommandBase {
  action: 'bridge'
  queueName: string
  record: boolean
}

interface AriRecordCommand extends AriCommandBase {
  action: 'record'
  maxDuration: number
  finishOnKey: string
  callbackEvent: 'recording_complete'
  metadata: Record<string, string>
}

interface AriHangupCommand extends AriCommandBase {
  action: 'hangup'
  reason?: string
}

interface AriLeaveQueueCommand extends AriCommandBase {
  action: 'leave_queue'
}

type AriCommand =
  | AriPlayCommand
  | AriGatherCommand
  | AriQueueCommand
  | AriBridgeCommand
  | AriRecordCommand
  | AriHangupCommand
  | AriLeaveQueueCommand

/**
 * AsteriskAdapter — communicates with the sip-bridge sidecar running
 * alongside Asterisk. Sends JSON commands; receives JSON webhooks.
 *
 * Extends SipBridgeAdapter which provides shared bridge communication,
 * webhook validation/parsing, and recording retrieval.
 */
export class AsteriskAdapter extends SipBridgeAdapter {
  constructor(
    private ariUrl: string,
    private ariUsername: string,
    private ariPassword: string,
    phoneNumber: string,
    bridgeCallbackUrl: string,
    bridgeSecret: string,
  ) {
    super(phoneNumber, bridgeCallbackUrl, bridgeSecret)
  }

  getEndpointFormat(phone: string): string {
    return `PJSIP/${phone}@trunk`
  }

  getPbxType(): string {
    return 'asterisk'
  }

  // --- JSON command helpers ---

  private ariJson(commands: AriCommand[]): TelephonyResponse {
    return this.json(commands)
  }

  /** Play a prompt: the operator's upload for the caller's language, else generated speech */
  private ariPrompt(
    promptKey: string,
    lang: string,
    audioUrls: AudioUrlMap | undefined,
    speechUrl: SpeechUrlBuilder | undefined,
    text?: (speechLang: string) => string,
  ): AriCommand {
    return this.play(this.promptUrl(promptKey, lang, audioUrls, speechUrl, text))
  }

  /** Play text no operator can upload (it varies per call, or has no prompt type) as generated speech */
  private ariSpeech(text: (speechLang: string) => string, lang: string, speechUrl: SpeechUrlBuilder | undefined): AriCommand {
    return this.play(this.generatedSpeechUrl(text, lang, speechUrl))
  }

  /** Hold the caller; wait-music and queue-exit callbacks carry the call's context */
  private ariQueue(callSid: string, lang: string, hubId?: string): AriQueueCommand {
    return {
      action: 'queue',
      queueName: callSid,
      waitMusicEvent: 'wait_music',
      exitEvent: 'queue_exit',
      metadata: callContext(callSid, lang, hubId),
    }
  }

  // --- IVR / Call flow ---

  async handleLanguageMenu(params: LanguageMenuParams): Promise<TelephonyResponse> {
    const menu = buildIvrLanguageMenu(params.enabledLanguages, ASTERISK_VOICES)

    if (menu.kind === 'single') {
      return this.ariJson([
        {
          action: 'gather',
          numDigits: 0,
          timeout: 0,
          callbackEvent: 'language_selected',
          metadata: { auto: '1', forceLang: menu.language, ...hubParam(params.hubId) },
        },
      ])
    }

    return this.ariJson([
      // Each option in its own language: ASTERISK_VOICES offers only languages generated speech speaks.
      ...menu.options.map((o) => this.ariSpeech(() => o.prompt, o.language, params.speechUrl)),
      {
        action: 'gather',
        numDigits: 1,
        timeout: 8,
        callbackEvent: 'language_selected',
        metadata: hubParam(params.hubId),
      },
    ])
  }

  async handleIncomingCall(params: IncomingCallParams): Promise<TelephonyResponse> {
    const { rateLimited, voiceCaptchaEnabled, callerLanguage: lang, callSid, audioUrls, speechUrl, hubId } = params
    // The same prompts, in the same order, as every cloud adapter: an operator
    // uploads exactly these keys (settings VALID_PROMPT_TYPES); a prompt nobody
    // uploaded is generated speech.
    const greeting = this.ariPrompt('greeting', lang, audioUrls, speechUrl, (speechLang) =>
      getPrompt('greeting', speechLang).replace('{name}', params.hotlineName),
    )

    if (rateLimited) {
      return this.ariJson([
        greeting,
        this.ariPrompt('rateLimited', lang, audioUrls, speechUrl),
        { action: 'hangup' },
      ])
    }

    if (voiceCaptchaEnabled && params.captchaDigits) {
      const digits = params.captchaDigits
      return this.ariJson([
        greeting,
        this.ariPrompt('captchaPrompt', lang, audioUrls, speechUrl),
        ...this.captchaDigitUrls(digits, lang, speechUrl).map((url) => this.play(url)),
        {
          action: 'gather',
          numDigits: 4,
          timeout: 10,
          callbackEvent: 'captcha_response',
          metadata: callContext(callSid, lang, hubId),
        },
      ])
    }

    return this.ariJson([
      greeting,
      this.ariPrompt('pleaseHold', lang, audioUrls, speechUrl),
      this.ariQueue(callSid, lang, hubId),
    ])
  }

  async handleCaptchaResponse(params: CaptchaResponseParams): Promise<TelephonyResponse> {
    const { digits, expectedDigits, callerLanguage: lang, callSid, speechUrl, hubId } = params

    if (digits === expectedDigits) {
      return this.ariJson([
        this.ariSpeech((speechLang) => getPrompt('captchaSuccess', speechLang), lang, speechUrl),
        this.ariQueue(callSid, lang, hubId),
      ])
    }

    return this.ariJson([
      this.ariSpeech((speechLang) => getPrompt('captchaFail', speechLang), lang, speechUrl),
      { action: 'hangup' },
    ])
  }

  async handleCallAnswered(params: CallAnsweredParams): Promise<TelephonyResponse> {
    const { parentCallSid } = params
    return this.ariJson([
      {
        action: 'bridge',
        queueName: parentCallSid,
        record: true,
      },
    ])
  }

  async handleVoicemail(params: VoicemailParams): Promise<TelephonyResponse> {
    const { callerLanguage: lang, audioUrls, speechUrl, maxRecordingSeconds, callSid, hubId } = params
    return this.ariJson([
      this.ariPrompt('voicemailPrompt', lang, audioUrls, speechUrl),
      {
        action: 'record',
        maxDuration: maxRecordingSeconds || 120,
        finishOnKey: '#',
        callbackEvent: 'recording_complete',
        metadata: callContext(callSid, lang, hubId),
      },
    ])
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
      return this.ariJson([{ action: 'leave_queue' }])
    }
    return this.ariJson([this.ariPrompt('waitMessage', lang, audioUrls, speechUrl)])
  }

  rejectCall(): TelephonyResponse {
    return this.ariJson([{ action: 'hangup', reason: 'rejected' }])
  }

  handleVoicemailComplete(lang: string, speechUrl?: SpeechUrlBuilder): TelephonyResponse {
    return this.ariJson([
      this.ariSpeech((speechLang) => getVoicemailThanks(speechLang), lang, speechUrl),
      { action: 'hangup' },
    ])
  }

  emptyResponse(): TelephonyResponse {
    return { contentType: 'application/json', body: JSON.stringify({ commands: [] }) }
  }
}

// --- Helpers ---

/**
 * The locales an Asterisk IVR can speak: those generated speech has a voice
 * for (the worker synthesises every prompt the operator did not upload).
 * Absent locales are never offered in the IVR menu.
 */
export const ASTERISK_VOICES = new IvrVoiceCatalog<string>(
  'asterisk',
  GENERATED_SPEECH_LOCALES.map((locale) => [locale, locale] as const),
)

/** Query params the hub-scoped telephony routes resolve the hub from */
function hubParam(hubId: string | undefined): Record<string, string> {
  return hubId ? { hub: hubId } : {}
}

/** Callback context for a caller leg: the routes read callSid, lang (the caller's, not the TTS voice) and hub */
function callContext(callSid: string, lang: string, hubId: string | undefined): Record<string, string> {
  return { callSid, lang, ...hubParam(hubId) }
}
