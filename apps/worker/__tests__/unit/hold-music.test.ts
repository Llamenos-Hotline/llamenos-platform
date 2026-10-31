/**
 * Hold music is the worker's own (#2298). It used to be a file in Twilio's S3
 * bucket, hotlinked by five adapters: a third party saw every call go on hold,
 * and hold depended on a bucket we do not control.
 *
 * What these tests pin:
 *  - the track exists with no configuration and is a WAV every provider plays;
 *  - each of the five adapters hands its provider only the worker's own origin;
 *  - hold survives the old host being unreachable (every outbound fetch fails);
 *  - no externally hosted audio URL can be written back into the source.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { Hono } from 'hono'
import { ivrAudioFormatError } from '@worker/lib/helpers'
import { readPcm16Wav } from '@worker/services/ivr-speech/audio'
import ivrMedia from '@worker/routes/ivr-media'
import {
  HOLD_MUSIC_AUDIO_KEY,
  HOLD_MUSIC_PATH,
  HOLD_MUSIC_SECONDS,
  holdMusicEntry,
  holdMusicUrl,
  holdMusicWav,
} from '@worker/telephony/hold-music'
import { TwilioAdapter } from '@worker/telephony/twilio'
import { SignalWireAdapter } from '@worker/telephony/signalwire'
import { PlivoAdapter } from '@worker/telephony/plivo'
import { BandwidthAdapter } from '@worker/telephony/bandwidth'
import { VonageAdapter } from '@worker/telephony/vonage'
import { TelnyxAdapter } from '@worker/telephony/telnyx'

const ORIGIN = 'https://hotline.example.org'
const HOLD_URL = `${ORIGIN}${HOLD_MUSIC_PATH}`

afterEach(() => vi.restoreAllMocks())

describe('the hold track', () => {
  it('is a playable IVR WAV with no configuration', () => {
    const wav = holdMusicWav()
    expect(ivrAudioFormatError(wav)).toBeNull()
    const pcm = readPcm16Wav(wav)
    expect(pcm.samples.length).toBe(HOLD_MUSIC_SECONDS * pcm.sampleRate)
  })

  it('is audible but quiet, and deterministic', () => {
    const { samples } = readPcm16Wav(holdMusicWav())
    const peak = samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
    expect(peak).toBeGreaterThan(0.2 * 32767)
    expect(peak).toBeLessThan(0.4 * 32767)
    // Same source, same bytes: the render is a pure function.
    expect(Buffer.from(holdMusicWav()).equals(Buffer.from(holdMusicWav()))).toBe(true)
  })

  it('loops without a click at the seam', () => {
    const { samples } = readPcm16Wav(holdMusicWav())
    const last = samples[samples.length - 1]
    const first = samples[0]
    // Adjacent samples inside the tune differ by far less than a click would.
    expect(Math.abs(first - last)).toBeLessThan(0.05 * 32767)
  })

  it('is served unauthenticated from the worker itself', async () => {
    const res = await new Hono().route('/api', ivrMedia).request(HOLD_MUSIC_PATH)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/wav')
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(holdMusicWav()))).toBe(true)
  })

  it('is advertised under a key no prompt can collide with', () => {
    expect(HOLD_MUSIC_AUDIO_KEY).not.toContain(':')
    expect(holdMusicUrl(holdMusicEntry(ORIGIN))).toBe(HOLD_URL)
    expect(holdMusicUrl(undefined)).toBeUndefined()
  })
})

/** Every absolute URL in a provider document, as host-and-path strings */
const urlsIn = (document: string) => document.match(/https?:\/\/[^\s"'<>\\)]+/g) ?? []

describe('every adapter holds on the worker\'s own origin, with the old host unreachable', () => {
  /** An outbound request to anywhere is a failure: hold must need no network from the worker */
  const blockNetwork = () =>
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network access blocked by the test'))

  const audioUrls = holdMusicEntry(ORIGIN)

  const xmlAdapters: Array<[string, () => { handleWaitMusic: (...a: never[]) => Promise<{ body: string }> }]> = [
    ['twilio', () => new TwilioAdapter('AC1', 'tok', '+15551234567')],
    ['signalwire', () => new SignalWireAdapter('11111111-2222-3333-4444-555555555555', 'tok', '+15551234567', 'space')],
    ['plivo', () => new PlivoAdapter('id', 'tok', '+15551234567')],
    ['bandwidth', () => new BandwidthAdapter('acct', 'tok', 'secret', 'app', '+15551234567')],
    ['vonage', () => new VonageAdapter('key', 'secret', 'app-id', '+15551234567')],
  ]

  for (const [name, make] of xmlAdapters) {
    it(`${name}: wait music names only the worker's origin`, async () => {
      const fetchSpy = blockNetwork()
      const adapter = make() as unknown as { handleWaitMusic: (l: string, a: Record<string, string>, q: number, t: number) => Promise<{ body: string }> }
      const res = await adapter.handleWaitMusic('en', audioUrls, 10, 90)
      const urls = urlsIn(res.body)
      expect(urls).toContain(HOLD_URL)
      // Relative callbacks (Bandwidth's Redirect) are fine; an absolute URL must be ours.
      expect(urls.filter((u) => !u.startsWith(`${ORIGIN}/`))).toEqual([])
      expect(res.body).not.toMatch(/amazonaws|twilio\.music/)
      expect(fetchSpy).not.toHaveBeenCalled()
    })
  }

  it('telnyx: both queue paths loop the worker\'s own track and call only the Telnyx API', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    const adapter = new TelnyxAdapter('key', 'conn', '+15551234567')
    await adapter.handleIncomingCall({
      callSid: 'c1', callerNumber: '+15559876543', voiceCaptchaEnabled: false, rateLimited: false,
      callerLanguage: 'en', hotlineName: 'Hotline', callRecordingEnabled: false, audioUrls,
    })
    await adapter.handleCaptchaResponse({
      callSid: 'c2', digits: '1234', expectedDigits: '1234', callerLanguage: 'en', audioUrls,
    })
    const played = fetchSpy.mock.calls
      .filter(([url]) => String(url).endsWith('/actions/playback_start'))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)))
    expect(played).toHaveLength(2)
    for (const body of played) expect(body).toMatchObject({ audio_url: HOLD_URL, loop: 'infinity' })
    for (const [url] of fetchSpy.mock.calls) expect(String(url)).toMatch(/^https:\/\/api\.telnyx\.com\//)
  })
})

// --- Guard: an externally hosted audio URL must not come back (it did, five times) ---

const ROOT = join(__dirname, '../../../..')
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'target', 'generated', '__tests__', '.gradle'])
const SOURCE = /\.(ts|tsx|js|mjs|sh|j2|yml|yaml|conf|cfg|xml|json|kt|swift|rs)$/

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) yield* sourceFiles(path)
    else if (SOURCE.test(entry) && !/\.(test|spec|e2e)\./.test(entry)) yield path
  }
}

/** Where audio is generated or handed to a provider: adapters, routes, bridge, deploy templates */
const AUDIO_SCOPES = ['apps/worker/telephony', 'apps/worker/routes', 'apps/worker/lib', 'apps/worker/services', 'sip-bridge/src', 'deploy']

describe('no externally hosted audio (#2298)', () => {
  const EXTERNAL_AUDIO =
    /https?:\/\/(?!localhost|127\.0\.0\.1|app[:/]|asterisk|freeswitch|kamailio)[^\s"'`<>)]*\.(?:mp3|wav|ogg|opus|m4a|aac|flac)\b|amazonaws\.com[^\s"'`]*\.(?:mp3|wav)|twilio\.music|twilio-cms|com\.twilio\.sounds/i

  it('finds the sources it is meant to scan', () => {
    const scanned = AUDIO_SCOPES.flatMap((scope) => [...sourceFiles(join(ROOT, scope))])
    expect(scanned.some((f) => f.endsWith('apps/worker/telephony/twilio.ts'))).toBe(true)
    expect(scanned.some((f) => f.includes('/sip-bridge/src/'))).toBe(true)
    expect(scanned.some((f) => f.includes('/deploy/'))).toBe(true)
  })

  it('no adapter, route, bridge or deploy template names an external audio file', () => {
    const offenders: string[] = []
    for (const scope of AUDIO_SCOPES) {
      for (const file of sourceFiles(join(ROOT, scope))) {
        readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
          if (EXTERNAL_AUDIO.test(line)) offenders.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`)
        })
      }
    }
    expect(offenders).toEqual([])
  })

  it('the guard itself catches the URL it exists for', () => {
    expect(EXTERNAL_AUDIO.test('https://com.twilio.music.soft-rock.s3.amazonaws.com/_ghost_-_promo_2_sample_pack.mp3')).toBe(true)
    expect(EXTERNAL_AUDIO.test('https://cdn.example.net/hold.wav')).toBe(true)
    expect(EXTERNAL_AUDIO.test('sound:http://app:3000/api/ivr-audio/hold.wav')).toBe(false)
  })

  it('an adapter only ever names a provider API host, never a media host', () => {
    const API_HOSTS = [
      /^https:\/\/api\.twilio\.com\//, /^https:\/\/trunking\.twilio\.com\//, /^https:\/\/intelligence\.twilio\.com\//,
      /^https:\/\/\$\{this\.space\}\.signalwire\.com\//, /^https:\/\/voice\.bandwidth\.com\//,
      /^https:\/\/api\.plivo\.com\//, /^https:\/\/api\.telnyx\.com\//, /^https:\/\/api\.nexmo\.com/,
    ]
    const unexpected: string[] = []
    const dir = join(ROOT, 'apps/worker/telephony')
    for (const file of sourceFiles(dir)) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
        for (const url of line.match(/https?:\/\/[^\s"'`<>)]+/g) ?? []) {
          if (!API_HOSTS.some((re) => re.test(url))) unexpected.push(`${relative(ROOT, file)}:${i + 1}: ${url}`)
        }
      })
    }
    expect(unexpected).toEqual([])
  })
})
