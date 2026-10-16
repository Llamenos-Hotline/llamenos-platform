/**
 * The voice CAPTCHA's answer must not be readable from the request log (#1352).
 *
 * On a self-hosted PBX every prompt is a `play` of a URL the worker mints, and
 * the PBX fetches it through the worker — so the request logger records the
 * URL's path. Generated speech names its text in that path; for the CAPTCHA
 * the text is the answer the caller must key in. The same path is the key of
 * Asterisk's media-cache entry (astdb, on disk) and is what the sip-bridge
 * logs when a prompt fails to play.
 *
 * Real adapters, real IvrSpeechService (fake engine), real request logger and
 * real media route: the PBX's fetch of every clip in a CAPTCHA response is
 * replayed and the log lines it produced are inspected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'
import { requestLogger } from '@worker/middleware/request-logger'
import ivrMedia from '@worker/routes/ivr-media'
import { IvrSpeechService, type SpeechEngine } from '@worker/services/ivr-speech'
import { writePcm16Wav } from '@worker/services/ivr-speech/audio'
import { AsteriskAdapter } from '@worker/telephony/asterisk'
import { FreeSwitchAdapter } from '@worker/telephony/freeswitch'
import type { SipBridgeAdapter } from '@worker/telephony/sip-bridge-adapter'
import type { SpeechUrlBuilder, TelephonyResponse } from '@worker/telephony/adapter'

const SECRET = '5e'.repeat(32)
const ORIGIN = 'http://app:3000'

function engine(): SpeechEngine {
  const samples = Int16Array.from({ length: 11025 }, (_, i) => Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 22050)))
  return {
    version: async () => 'espeak-ng 1.52.0 150wpm',
    synthesize: async () => writePcm16Wav({ sampleRate: 22050, samples }),
  }
}

const PBXS: Array<{ name: string; adapter: SipBridgeAdapter; playUrls: (res: TelephonyResponse) => string[] }> = [
  {
    name: 'Asterisk',
    adapter: new AsteriskAdapter('http://ari.local:8088', 'admin', 'password', '+15551234567', 'http://callback.local/webhooks', 'bridge-secret'),
    playUrls: (res) =>
      (JSON.parse(res.body).commands as Array<{ action: string; url?: string }>)
        .flatMap((c) => (c.action === 'play' && c.url ? [c.url] : [])),
  },
  {
    name: 'FreeSWITCH',
    adapter: new FreeSwitchAdapter('+15551234567', 'http://bridge.local/webhooks', 'bridge-secret', 'http://callback.local'),
    playUrls: (res) =>
      [...res.body.matchAll(/<playback file="([^"]+)"\/>/g)].map((m) => m[1].replaceAll('&amp;', '&')),
  },
]

/** Every way a digit has been written into a speech path: bare, or base64url-encoded text */
function digitForms(digit: string): string[] {
  return [`/${digit}.wav`, `/${Buffer.from(digit, 'utf8').toString('base64url')}.wav`, `/${digit}/`]
}

let logged: string[]

beforeEach(() => {
  logged = []
  const capture = (chunk: string | Uint8Array) => {
    logged.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }
  vi.spyOn(process.stdout, 'write').mockImplementation(capture)
  vi.spyOn(process.stderr, 'write').mockImplementation(capture)
})

afterEach(() => {
  vi.restoreAllMocks()
})

function makeApp(speech: IvrSpeechService) {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('services', { ivrSpeech: speech } as unknown as AppEnv['Variables']['services'])
    c.env = { HMAC_SECRET: SECRET } as AppEnv['Bindings']
    await next()
  })
  app.use('*', requestLogger)
  app.route('/api', ivrMedia)
  return app
}

async function captchaClips(pbx: (typeof PBXS)[number], speechUrl: SpeechUrlBuilder, digits: string) {
  const res = await pbx.adapter.handleIncomingCall({
    callSid: 'CA-captcha',
    callerNumber: '+15550001111',
    voiceCaptchaEnabled: true,
    rateLimited: false,
    callerLanguage: 'es',
    hotlineName: 'Test Hotline',
    captchaDigits: digits,
    speechUrl,
  })
  // Uploaded-prompt URLs aside, every clip the caller hears is generated speech.
  return pbx.playUrls(res).filter((url) => url.startsWith(`${ORIGIN}/api/ivr-speech/`))
}

describe.each(PBXS)('$name CAPTCHA speech (#1352)', (pbx) => {
  it('the PBX fetching the challenge leaves no digit of it in the request log', async () => {
    const speech = new IvrSpeechService(SECRET, engine())
    const app = makeApp(speech)
    const digits = '4827'
    const clips = await captchaClips(pbx, await speech.urlBuilder(ORIGIN), digits)
    // The greeting and the CAPTCHA prompt, then a clip per digit.
    expect(clips.length).toBeGreaterThanOrEqual(digits.length)

    logged = []
    for (const url of clips) {
      const res = await app.request(url)
      expect(res.status, 'every clip the caller hears is served').toBe(200)
      expect(res.headers.get('Content-Type')).toBe('audio/wav')
    }

    const requestLines = logged.filter((line) => line.includes('"namespace":"request-logger"'))
    // A start and a completion line per fetch: the log is written, not suppressed.
    expect(requestLines).toHaveLength(clips.length * 2)
    for (const line of requestLines) {
      for (const digit of digits) {
        for (const form of digitForms(digit)) expect(line, `log line carries ${JSON.stringify(form)}`).not.toContain(form)
      }
    }
  })

  it('the digit clips are keyed to the server secret — nobody can name them offline', async () => {
    const mine = await captchaClips(pbx, await new IvrSpeechService(SECRET, engine()).urlBuilder(ORIGIN), '1111')
    const theirs = await captchaClips(pbx, await new IvrSpeechService('a1'.repeat(32), engine()).urlBuilder(ORIGIN), '1111')
    const path = (url: string) => new URL(url).pathname
    expect(path(mine.at(-1)!)).not.toBe(path(theirs.at(-1)!))
  })

  it('every call shares the same ten digit clips, so the PBX media cache stays bounded', async () => {
    const build = await new IvrSpeechService(SECRET, engine()).urlBuilder(ORIGIN)
    const first = (await captchaClips(pbx, build, '3579')).slice(-4)
    const second = (await captchaClips(pbx, build, '9753')).slice(-4)
    expect(second).toEqual([...first].reverse())
    expect(new Set(first).size).toBe(4)
  })

  it('a clip URL minted for one digit plays that digit', async () => {
    const synthesize = vi.fn(engine().synthesize)
    const speech = new IvrSpeechService(SECRET, { ...engine(), synthesize })
    const app = makeApp(speech)
    const clips = await captchaClips(pbx, await speech.urlBuilder(ORIGIN), '2468')
    await Promise.all(clips.map((url) => app.request(url)))
    const spokenDigits = synthesize.mock.calls.map(([text]) => text).filter((text) => /^\d$/.test(text))
    expect(spokenDigits.sort()).toEqual(['2', '4', '6', '8'])
  })
})
