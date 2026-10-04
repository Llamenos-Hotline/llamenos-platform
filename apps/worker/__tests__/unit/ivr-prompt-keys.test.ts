/**
 * #1346 — every IVR prompt an adapter plays from an upload must be one an
 * operator can upload. A key nobody can upload is never in the audio map, so
 * the adapter always falls back to speech: the provider's own, or on a
 * self-hosted PBX the worker's generated speech (#1347) — never the
 * operator's recording.
 *
 * Each adapter is driven through every call-flow step that takes an audio map.
 * The map records every key the adapter looks up; each is then offered to the
 * real upload path (SettingsService.uploadIvrAudio), which refuses a prompt
 * type it does not know before it touches storage.
 */
import { describe, it, expect } from 'vitest'
import type { AudioUrlMap, TelephonyAdapter } from '@worker/telephony/adapter'
import { TwilioAdapter } from '@worker/telephony/twilio'
import { VonageAdapter } from '@worker/telephony/vonage'
import { PlivoAdapter } from '@worker/telephony/plivo'
import { BandwidthAdapter } from '@worker/telephony/bandwidth'
import { AsteriskAdapter } from '@worker/telephony/asterisk'
import { FreeSwitchAdapter } from '@worker/telephony/freeswitch'
import { SettingsService } from '@worker/services/settings'
import { createMockDb } from './mock-db'
import { fakeSpeech } from '../helpers/fake-speech'

/** The adapters that play uploaded prompts. Telnyx takes no audio map at all. */
const ADAPTERS: Record<string, () => TelephonyAdapter> = {
  twilio: () => new TwilioAdapter('AC1', 'token', '+15551234567'),
  vonage: () => new VonageAdapter('key', 'secret', 'app', '+15551234567'),
  plivo: () => new PlivoAdapter('id', 'token', '+15551234567'),
  bandwidth: () => new BandwidthAdapter('acct', 'token', 'secret', 'app', '+15551234567'),
  asterisk: () => new AsteriskAdapter('http://ari', 'u', 'p', '+15551234567', 'http://cb', 'secret'),
  freeswitch: () => new FreeSwitchAdapter('+15551234567', 'http://cb', 'secret', 'http://app'),
}

const LANG = 'en'
const url = (key: string) => `https://app.example/api/ivr-audio/${key}/${LANG}`

/** An audio map holding an upload for every key asked of it, recording each lookup */
function recordingAudioMap(): { audioUrls: AudioUrlMap; requested: string[] } {
  const requested: string[] = []
  const audioUrls = new Proxy<AudioUrlMap>({}, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined
      const [key, lang] = prop.split(':')
      if (lang !== LANG) return undefined
      requested.push(key)
      return url(key)
    },
  })
  return { audioUrls, requested }
}

const incoming = { callSid: 'CA1', callerNumber: '+15550000000', callerLanguage: LANG, hotlineName: 'Test', speechUrl: fakeSpeech }

/** Every flow step that takes an audio map, and the uploads its caller hears, in order */
const FLOWS: Array<{ step: string; hears: string[]; run: (a: TelephonyAdapter, audioUrls: AudioUrlMap) => Promise<{ body: string }> }> = [
  {
    step: 'a caller who is queued',
    hears: ['greeting', 'pleaseHold'],
    run: (a, audioUrls) => a.handleIncomingCall({ ...incoming, voiceCaptchaEnabled: false, rateLimited: false, audioUrls }),
  },
  {
    step: 'a rate-limited caller',
    hears: ['greeting', 'rateLimited'],
    run: (a, audioUrls) => a.handleIncomingCall({ ...incoming, voiceCaptchaEnabled: false, rateLimited: true, audioUrls }),
  },
  {
    step: 'a caller asked to solve the voice CAPTCHA',
    hears: ['greeting', 'captchaPrompt'],
    run: (a, audioUrls) =>
      a.handleIncomingCall({ ...incoming, voiceCaptchaEnabled: true, rateLimited: false, captchaDigits: '4821', audioUrls }),
  },
  {
    step: 'a caller waiting in the queue',
    hears: ['waitMessage'],
    run: (a, audioUrls) => a.handleWaitMusic(LANG, audioUrls, 10, 90, fakeSpeech),
  },
  {
    step: 'a caller sent to voicemail',
    hears: ['voicemailPrompt'],
    run: (a, audioUrls) =>
      a.handleVoicemail({ callSid: 'CA1', callerLanguage: LANG, callbackUrl: 'https://app.example', audioUrls, speechUrl: fakeSpeech }),
  },
]

/**
 * Prompts every adapter plays from an upload, but that the upload path does
 * not accept yet. Named, not silently skipped: every caller hears the
 * provider's or the worker's generated speech, never the operator's voice.
 */
const NOT_YET_UPLOADABLE = new Set(['voicemailPrompt'])

/** Whether the real upload path accepts this prompt type (it fails on the empty file next, never storing it) */
async function uploadable(promptType: string): Promise<boolean> {
  const { db } = createMockDb()
  const settings = new SettingsService(db as never)
  const error = await settings.uploadIvrAudio(promptType, LANG, '', 0).then(() => null, (e: Error) => e.message)
  if (error === 'Invalid prompt type') return false
  expect(error).toBe('Empty file')
  return true
}

describe.each(Object.entries(ADAPTERS))('%s adapter IVR prompts (#1346)', (_name, create) => {
  it.each(FLOWS)('plays the uploads $hears to $step, in that order', async ({ hears, run }) => {
    const { audioUrls, requested } = recordingAudioMap()
    const res = await run(create(), audioUrls)
    expect(requested).toEqual(hears)
    // Played, not just looked up: each upload's URL is in the response, in order.
    const positions = hears.map((key) => res.body.indexOf(url(key)))
    expect(positions.every((p) => p >= 0), res.body).toBe(true)
    expect(positions).toEqual([...positions].sort((x, y) => x - y))
  })

  it('asks only for prompts an operator can upload', async () => {
    const requested = new Set<string>()
    for (const { run } of FLOWS) {
      const map = recordingAudioMap()
      await run(create(), map.audioUrls)
      for (const key of map.requested) requested.add(key)
    }
    for (const key of requested) {
      expect(await uploadable(key), `${key} is played from an upload`).toBe(!NOT_YET_UPLOADABLE.has(key))
    }
  })
})
