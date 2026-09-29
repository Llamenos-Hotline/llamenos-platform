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
import { getPrompt } from '@shared/voice-prompts'
import { IvrVoiceCatalog, buildIvrLanguageMenu } from './ivr-menu'

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

interface AriSpeakCommand extends AriCommandBase {
  action: 'speak'
  text: string
  language: string
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
  | AriSpeakCommand
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

  protected override mapLanguage(lang: string): string {
    return getAsteriskLang(lang)
  }

  // --- JSON command helpers ---

  private ariJson(commands: AriCommand[]): TelephonyResponse {
    return this.json(commands)
  }

  private ariSpeak(text: string, lang: string): AriCommand {
    return { action: 'speak', text, language: getAsteriskLang(lang) }
  }

  private ariPlay(url: string): AriCommand {
    return { action: 'play', url }
  }

  private ariSpeakOrPlay(promptKey: string, lang: string, audioUrls?: AudioUrlMap, text?: string): AriCommand {
    const audioUrl = audioUrls?.[`${promptKey}:${lang}`]
    if (audioUrl) return this.ariPlay(audioUrl)
    const content = text ?? getPrompt(promptKey, lang)
    return this.ariSpeak(content, lang)
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
        this.ariSpeak(' ', menu.language),
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
      ...menu.options.map((o): AriCommand => ({ action: 'speak', text: o.prompt, language: o.voice })),
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
    const { rateLimited, voiceCaptchaEnabled, callerLanguage: lang, callSid, audioUrls, hubId } = params

    if (rateLimited) {
      return this.ariJson([
        this.ariSpeakOrPlay('rateLimited', lang, audioUrls),
        { action: 'hangup' },
      ])
    }

    if (voiceCaptchaEnabled && params.captchaDigits) {
      const digits = params.captchaDigits
      return this.ariJson([
        this.ariSpeakOrPlay(
          'captcha',
          lang,
          audioUrls,
          getPrompt('captcha', lang).replace('{digits}', digits.split('').join(' '))
        ),
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
      this.ariSpeakOrPlay('connecting', lang, audioUrls),
      this.ariQueue(callSid, lang, hubId),
    ])
  }

  async handleCaptchaResponse(params: CaptchaResponseParams): Promise<TelephonyResponse> {
    const { digits, expectedDigits, callerLanguage: lang, callSid, hubId } = params

    if (digits === expectedDigits) {
      return this.ariJson([
        this.ariSpeak(getPrompt('captchaSuccess', lang), lang),
        this.ariQueue(callSid, lang, hubId),
      ])
    }

    return this.ariJson([
      this.ariSpeak(getPrompt('captchaFailed', lang), lang),
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
    const { callerLanguage: lang, audioUrls, maxRecordingSeconds, callSid, hubId } = params
    return this.ariJson([
      this.ariSpeakOrPlay('voicemailPrompt', lang, audioUrls),
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
  ): Promise<TelephonyResponse> {
    const timeout = queueTimeout || 90
    if (queueTime && queueTime >= timeout) {
      return this.ariJson([{ action: 'leave_queue' }])
    }
    return this.ariJson([this.ariSpeakOrPlay('holdMusic', lang, audioUrls)])
  }

  rejectCall(): TelephonyResponse {
    return this.ariJson([{ action: 'hangup', reason: 'rejected' }])
  }

  handleVoicemailComplete(lang: string): TelephonyResponse {
    return this.ariJson([
      this.ariSpeak(getPrompt('voicemailThankYou', lang), lang),
      { action: 'hangup' },
    ])
  }

  emptyResponse(): TelephonyResponse {
    return { contentType: 'application/json', body: JSON.stringify({ commands: [] }) }
  }
}

// --- Helpers ---

/**
 * Asterisk TTS language codes — the explicit, ordered list of locales the
 * Asterisk TTS engine has a voice for. Absent locales are never offered in the
 * IVR menu.
 */
export const ASTERISK_VOICES = new IvrVoiceCatalog<string>('asterisk', [
  ['en', 'en-US'],
  ['es', 'es'],
  ['zh', 'zh'],
  ['vi', 'vi'],
  ['ar', 'ar'],
  ['fr', 'fr'],
  ['ko', 'ko'],
  ['ru', 'ru'],
  ['hi', 'hi'],
  ['pt', 'pt-BR'],
])

/** Query params the hub-scoped telephony routes resolve the hub from */
function hubParam(hubId: string | undefined): Record<string, string> {
  return hubId ? { hub: hubId } : {}
}

/** Callback context for a caller leg: the routes read callSid, lang (the caller's, not the TTS voice) and hub */
function callContext(callSid: string, lang: string, hubId: string | undefined): Record<string, string> {
  return { callSid, lang, ...hubParam(hubId) }
}

function getAsteriskLang(lang: string): string {
  return ASTERISK_VOICES.voiceForPrompt(lang)
}
