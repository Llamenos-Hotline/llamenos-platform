/**
 * Generated IVR speech (#1347): the self-hosted PBXs have no speech engine, so
 * the worker synthesises every prompt an operator did not upload.
 *
 * The real engine (espeak-ng in the app image) is exercised by the real-call
 * E2E (deploy/docker/tests/telephony/asterisk-call.e2e.ts); here it is a fake
 * that writes what espeak-ng writes to a pipe — 22.05 kHz, streaming header.
 */
import { describe, expect, it, vi } from 'vitest'
import { LANGUAGE_CODES } from '@shared/languages'
import { IVR_PROMPTS } from '@shared/voice-prompts'
import { ivrAudioFormatError } from '@worker/lib/helpers'
import { signIvrMediaPath } from '@worker/lib/ivr-media-url'
import { IvrSpeechService, type SpeechEngine } from '@worker/services/ivr-speech'
import { readPcm16Wav, resample, toIvrWav, writePcm16Wav } from '@worker/services/ivr-speech/audio'
import {
  ESPEAK_NG_VOICES,
  GENERATED_SPEECH_LOCALES,
  SPEECH_FALLBACK_LANGUAGE,
  espeakVoiceFor,
  speechLanguageFor,
} from '@worker/services/ivr-speech/voices'

const SECRET = '3c'.repeat(32)
const ORIGIN = 'http://app:3000'

function tone(frequency: number, sampleRate: number, seconds: number, amplitude = 8000): Int16Array {
  return Int16Array.from({ length: Math.round(sampleRate * seconds) }, (_, i) =>
    Math.round(amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate)),
  )
}

/** A WAV as espeak-ng writes it to stdout: it cannot seek back, so the sizes are placeholders */
function streamingWav(samples: Int16Array, sampleRate = 22050): Uint8Array {
  const wav = writePcm16Wav({ sampleRate, samples })
  const view = new DataView(wav.buffer)
  view.setUint32(4, 0xffffffff, true)
  view.setUint32(40, 0xffffffff, true)
  return wav
}

function rms(samples: Int16Array): number {
  let sum = 0
  for (const s of samples) sum += s * s
  return Math.sqrt(sum / samples.length)
}

/** Dominant frequency by zero crossings — enough for a pure tone */
function frequencyOf(samples: Int16Array, sampleRate: number): number {
  let crossings = 0
  for (let i = 1; i < samples.length; i++) if ((samples[i - 1] < 0) !== (samples[i] < 0)) crossings++
  return (crossings / 2) * (sampleRate / samples.length)
}

function fakeEngine(): SpeechEngine & { synthesize: ReturnType<typeof vi.fn> } {
  return {
    version: vi.fn().mockResolvedValue('espeak-ng 1.52.0 150wpm'),
    synthesize: vi.fn().mockImplementation(async () => streamingWav(tone(440, 22050, 0.5))),
  }
}

describe('generated speech audio', () => {
  it('reads espeak-ng output with a streaming (placeholder-size) header to its end', () => {
    const samples = tone(440, 22050, 0.25)
    const pcm = readPcm16Wav(streamingWav(samples))
    expect(pcm.sampleRate).toBe(22050)
    expect(pcm.samples).toEqual(samples)
  })

  it('turns engine output into the 8 kHz mono 16-bit WAV every provider plays', () => {
    const wav = toIvrWav(streamingWav(tone(1000, 22050, 1)))
    expect(ivrAudioFormatError(wav)).toBeNull()
    // Canonical: a 44-byte header, then exactly the audio.
    expect(new DataView(wav.buffer).getUint32(40, true)).toBe(wav.byteLength - 44)
    const pcm = readPcm16Wav(wav)
    expect(pcm.samples.length).toBe(8000)
    expect(frequencyOf(pcm.samples, 8000)).toBeCloseTo(1000, -1)
  })

  it('filters what the telephone band cannot carry instead of folding it back in as noise', () => {
    // 6 kHz is above the new 4 kHz Nyquist rate: naive decimation would alias it to 2 kHz.
    const aliased = resample({ sampleRate: 22050, samples: tone(6000, 22050, 1) }, 8000)
    const passed = resample({ sampleRate: 22050, samples: tone(1000, 22050, 1) }, 8000)
    expect(rms(aliased.samples)).toBeLessThan(rms(passed.samples) / 100)
  })

  it('refuses engine output that is not mono 16-bit PCM WAV', () => {
    expect(() => readPcm16Wav(new TextEncoder().encode('not audio at all'))).toThrow(/not a WAV/)
    const stereo = writePcm16Wav({ sampleRate: 22050, samples: tone(440, 22050, 0.1) })
    new DataView(stereo.buffer).setUint16(22, 2, true)
    expect(() => readPcm16Wav(stereo)).toThrow(/mono 16-bit/)
    expect(() => toIvrWav(streamingWav(new Int16Array()))).toThrow(/no audio/)
  })
})

describe('generated speech voices', () => {
  it('every shipped locale is either spoken or has a declared fallback — never silence', () => {
    for (const code of LANGUAGE_CODES) {
      const voiced = GENERATED_SPEECH_LOCALES.includes(code)
      const fallback = SPEECH_FALLBACK_LANGUAGE[code]
      expect(voiced !== (fallback !== undefined), `${code}: voiced xor declared fallback`).toBe(true)
      expect(GENERATED_SPEECH_LOCALES, `${code} is generated in a spoken language`).toContain(speechLanguageFor(code))
    }
  })

  it('declares only shipped locales, once each, each with an IVR self-announcement', () => {
    const locales = ESPEAK_NG_VOICES.map(([locale]) => locale)
    expect(new Set(locales).size).toBe(locales.length)
    for (const locale of [...locales, ...Object.keys(SPEECH_FALLBACK_LANGUAGE)]) expect(LANGUAGE_CODES).toContain(locale)
    for (const locale of locales) expect(IVR_PROMPTS[locale], locale).toBeTruthy()
  })

  it('speaks a caller in their own language when it can, else in the declared fallback', () => {
    expect(speechLanguageFor('ht')).toBe('ht')
    expect(speechLanguageFor('tl')).toBe('en')
    expect(speechLanguageFor('mix')).toBe('es')
    // espeak-ng has an Arabic voice, but unvowelled Arabic text comes out unintelligible.
    expect(speechLanguageFor('ar')).toBe('en')
    expect(speechLanguageFor('xx')).toBe('en')
  })
})

describe('IvrSpeechService', () => {
  const PROMPT = 'Por favor espere mientras le conectamos.'

  it('serves the audio a minted URL names — synthesised once, in the locale’s voice', async () => {
    const engine = fakeEngine()
    const service = new IvrSpeechService(SECRET, engine)
    const url = new URL((await service.urlBuilder(ORIGIN))(PROMPT, 'es'))
    expect(url.origin).toBe(ORIGIN)
    expect(url.pathname).toMatch(/^\/api\/ivr-speech\/[0-9a-f]{12}\/es\/[A-Za-z0-9_-]+\.wav$/)
    // The prompt text is in the path, not readable at a glance — but it is not a secret.
    expect(url.pathname).not.toContain('Por favor')

    const first = await service.audioFor(url.pathname, url.searchParams)
    const again = await service.audioFor(url.pathname, url.searchParams)
    expect(first).not.toBeNull()
    expect(ivrAudioFormatError(first!.wav)).toBeNull()
    expect(again!.etag).toBe(first!.etag)
    // Minting started synthesis; the fetches reused it.
    expect(engine.synthesize).toHaveBeenCalledTimes(1)
    expect(engine.synthesize).toHaveBeenCalledWith(PROMPT, espeakVoiceFor('es'))
  })

  it('names a different URL when the text changes, so no PBX cache replays a stale prompt', async () => {
    const build = await new IvrSpeechService(SECRET, fakeEngine()).urlBuilder(ORIGIN)
    expect(build('Hola.', 'es')).not.toBe(build('Hola de nuevo.', 'es'))
    expect(build('Hola.', 'es')).toBe(build('Hola.', 'es'))
  })

  it('names a different URL after an engine upgrade', async () => {
    const before = await new IvrSpeechService(SECRET, fakeEngine()).urlBuilder(ORIGIN)
    const upgraded = fakeEngine()
    upgraded.version = vi.fn().mockResolvedValue('espeak-ng 1.53.0 150wpm')
    const after = await new IvrSpeechService(SECRET, upgraded).urlBuilder(ORIGIN)
    expect(after(PROMPT, 'es')).not.toBe(before(PROMPT, 'es'))
  })

  it('synthesises nothing for a URL it did not sign — it is not an open speech endpoint', async () => {
    const engine = fakeEngine()
    const service = new IvrSpeechService(SECRET, engine)
    const url = new URL((await service.urlBuilder(ORIGIN))(PROMPT, 'es'))
    engine.synthesize.mockClear()

    const otherText = url.pathname.replace(/\/[^/]+\.wav$/, `/${Buffer.from('Llame a otro número').toString('base64url')}.wav`)
    expect(await service.audioFor(otherText, url.searchParams)).toBeNull()
    expect(await service.audioFor(url.pathname, new URLSearchParams())).toBeNull()
    const foreign = new IvrSpeechService('9d'.repeat(32), fakeEngine())
    expect(await foreign.audioFor(url.pathname, url.searchParams)).toBeNull()
    expect(engine.synthesize).not.toHaveBeenCalled()
  })

  it('refuses a signed path that names no voice or no text', async () => {
    const service = new IvrSpeechService(SECRET, fakeEngine())
    const signed = (path: string) => new URL(`${ORIGIN}${signIvrMediaPath(SECRET, path)}`)
    const tl = signed(`/api/ivr-speech/0123456789ab/tl/${Buffer.from('Pakihintay').toString('base64url')}.wav`)
    expect(await service.audioFor(tl.pathname, tl.searchParams)).toBeNull()
    const blank = signed(`/api/ivr-speech/0123456789ab/es/${Buffer.from('   ').toString('base64url')}.wav`)
    expect(await service.audioFor(blank.pathname, blank.searchParams)).toBeNull()
  })

  it('will not mint speech for a locale it has no voice for: the adapter must resolve the fallback', async () => {
    const build = await new IvrSpeechService(SECRET, fakeEngine()).urlBuilder(ORIGIN)
    expect(() => build('Pakihintay habang kinokonekta ka namin.', 'tl')).toThrow(/speechLanguageFor/)
  })

  it('fails loudly when the engine fails, rather than serving an empty prompt', async () => {
    const engine = fakeEngine()
    engine.synthesize.mockRejectedValue(new Error('espeak-ng exited 1'))
    const service = new IvrSpeechService(SECRET, engine)
    const url = new URL((await service.urlBuilder(ORIGIN))(PROMPT, 'es'))
    await expect(service.audioFor(url.pathname, url.searchParams)).rejects.toThrow(/espeak-ng exited 1/)
  })

  it('keeps its cache within its byte budget, dropping the least recently used clip', async () => {
    const engine = fakeEngine()
    // Each clip: 0.5 s at 8 kHz = 8000 bytes + header. Room for two.
    const service = new IvrSpeechService(SECRET, engine, 2 * 8044)
    const build = await service.urlBuilder(ORIGIN)
    const fetch = async (text: string) => {
      const url = new URL(build(text, 'es'))
      return service.audioFor(url.pathname, url.searchParams)
    }
    await fetch('uno')
    await fetch('dos')
    await fetch('uno') // uno is now the most recent
    await fetch('tres') // evicts dos
    engine.synthesize.mockClear()
    await fetch('uno')
    expect(engine.synthesize).not.toHaveBeenCalled()
    await fetch('dos')
    expect(engine.synthesize).toHaveBeenCalledTimes(1)
  })
})
