/**
 * Operator-uploaded IVR prompts are played by the PBX (ARI `sound:<url>` via
 * res_http_media_cache) and by cloud providers (`<Play>`), never by the
 * browser. Both only play PCM WAV; a browser recording is WebM/Opus, which
 * they download and play as silence. So:
 *
 *   - the client converts every upload to 8 kHz mono 16-bit PCM WAV
 *     (src/client/lib/ivr-wav.ts), and
 *   - the server refuses anything else, judged by the bytes — never by the
 *     declared content type (apps/worker/lib/helpers.ts ivrAudioFormatError).
 *
 * asterisk-call.e2e.ts proves the accepted format is what a caller hears.
 */
import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'
import settingsRoute from '@worker/routes/settings'
import { ivrAudioFormatError, IVR_LANGUAGE_PATTERN, IVR_PROMPT_TYPE_PATTERN } from '@worker/lib/helpers'
import { encodePcm16Wav, IVR_WAV_SAMPLE_RATE } from '@/lib/ivr-wav'

/** A WAV header with arbitrary format fields, followed by `dataBytes` of silence */
function wav(opts: { format?: number; channels?: number; sampleRate?: number; bits?: number; dataBytes?: number; extraChunk?: Uint8Array } = {}): Uint8Array {
  const { format = 1, channels = 1, sampleRate = 8000, bits = 16, dataBytes = 160, extraChunk = new Uint8Array() } = opts
  const out = new Uint8Array(44 + extraChunk.byteLength + dataBytes)
  const view = new DataView(out.buffer)
  const ascii = (o: number, t: string) => { for (let i = 0; i < 4; i++) out[o + i] = t.charCodeAt(i) }
  ascii(0, 'RIFF')
  view.setUint32(4, out.byteLength - 8, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, format, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * (bits / 8), true)
  view.setUint16(32, channels * (bits / 8), true)
  view.setUint16(34, bits, true)
  out.set(extraChunk, 36)
  ascii(36 + extraChunk.byteLength, 'data')
  view.setUint32(40 + extraChunk.byteLength, dataBytes, true)
  return out
}

describe('ivrAudioFormatError', () => {
  it('accepts what the client uploads: 8 kHz mono 16-bit PCM WAV', () => {
    const tone = Float32Array.from({ length: 800 }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / IVR_WAV_SAMPLE_RATE))
    expect(ivrAudioFormatError(encodePcm16Wav(tone, IVR_WAV_SAMPLE_RATE))).toBeNull()
  })

  it('refuses a browser recording, whatever it is labelled', () => {
    // MediaRecorder output: Matroska/WebM (Chromium) and Ogg (Firefox)
    expect(ivrAudioFormatError(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81]))).toBe('Not a WAV file')
    expect(ivrAudioFormatError(new TextEncoder().encode('OggS\0\x02\0\0\0\0\0\0\0\0'))).toBe('Not a WAV file')
    expect(ivrAudioFormatError(new Uint8Array())).toBe('Not a WAV file')
  })

  it('refuses a WAV no provider plays at the right speed, or at all', () => {
    // espeak-ng writes 22.05 kHz; Asterisk's format_wav reads only 8 kHz
    expect(ivrAudioFormatError(wav({ sampleRate: 22050 }))).toMatch(/8000 Hz, not 22050 Hz/)
    expect(ivrAudioFormatError(wav({ sampleRate: 16000 }))).toMatch(/8000 Hz/)
    expect(ivrAudioFormatError(wav({ channels: 2 }))).toBe('WAV audio must be mono')
    expect(ivrAudioFormatError(wav({ bits: 8 }))).toBe('WAV audio must be 16-bit PCM')
    // IEEE float and µ-law: WAVE_FORMAT 3 and 7
    expect(ivrAudioFormatError(wav({ format: 3, bits: 16 }))).toBe('WAV audio must be 16-bit PCM')
    expect(ivrAudioFormatError(wav({ format: 7, bits: 16 }))).toBe('WAV audio must be 16-bit PCM')
  })

  it('refuses a truncated or empty WAV', () => {
    const whole = wav({ dataBytes: 160 })
    expect(ivrAudioFormatError(whole.subarray(0, whole.byteLength - 1))).toMatch(/^Truncated WAV/)
    expect(ivrAudioFormatError(whole.subarray(0, 36))).toBe('Malformed WAV: no audio data')
    expect(ivrAudioFormatError(wav({ dataBytes: 0 }))).toBe('WAV file has no audio')
  })

  it('skips other chunks, including an odd-sized one and its pad byte', () => {
    // LIST chunk of 3 bytes + 1 pad byte between fmt and data
    const list = Uint8Array.from([0x4c, 0x49, 0x53, 0x54, 3, 0, 0, 0, 0x61, 0x62, 0x63, 0])
    expect(ivrAudioFormatError(wav({ extraChunk: list }))).toBeNull()
  })
})

describe('IVR prompt path segments', () => {
  it('accepts every prompt type an operator can upload, including camelCase ones', () => {
    // src/client/components/admin-settings/voice-prompts-section.tsx PROMPT_TYPES
    for (const promptType of ['greeting', 'pleaseHold', 'waitMessage', 'rateLimited', 'captchaPrompt']) {
      expect(IVR_PROMPT_TYPE_PATTERN.test(promptType), promptType).toBe(true)
    }
    expect(IVR_PROMPT_TYPE_PATTERN.test('../etc')).toBe(false)
    expect(IVR_LANGUAGE_PATTERN.test('zh-CN')).toBe(true)
    expect(IVR_LANGUAGE_PATTERN.test('en/../x')).toBe(false)
  })
})

describe('/settings/ivr-audio/:promptType/:language', () => {
  function app(settings: Record<string, unknown>, permissions = ['settings:manage-ivr']) {
    const app = new Hono<AppEnv>()
    app.use('*', async (c, next) => {
      c.set('pubkey', 'a'.repeat(64))
      c.set('permissions', permissions)
      c.set('services', { settings, audit: { log: vi.fn() } } as unknown as AppEnv['Variables']['services'])
      c.set('allRoles', [])
      await next()
    })
    app.route('/', settingsRoute)
    return app
  }

  it('stores a PCM WAV upload byte for byte', async () => {
    const uploadIvrAudio = vi.fn().mockResolvedValue({ ok: true })
    const body = encodePcm16Wav(new Float32Array(400), IVR_WAV_SAMPLE_RATE)
    const res = await app({ uploadIvrAudio }).request('/ivr-audio/rateLimited/es', { method: 'PUT', body })
    expect(res.status).toBe(200)
    expect(uploadIvrAudio).toHaveBeenCalledWith('rateLimited', 'es', Buffer.from(body).toString('base64'), body.byteLength)
  })

  it('refuses WebM labelled audio/wav, and stores nothing', async () => {
    const uploadIvrAudio = vi.fn()
    const res = await app({ uploadIvrAudio }).request('/ivr-audio/greeting/en', {
      method: 'PUT',
      headers: { 'Content-Type': 'audio/wav' },
      body: Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Not a WAV file' })
    expect(uploadIvrAudio).not.toHaveBeenCalled()
  })

  it('refuses a language segment that is not a language', async () => {
    const uploadIvrAudio = vi.fn()
    const body = encodePcm16Wav(new Float32Array(80), IVR_WAV_SAMPLE_RATE)
    const res = await app({ uploadIvrAudio }).request('/ivr-audio/greeting/EN_x', { method: 'PUT', body })
    expect(res.status).toBe(400)
    expect(uploadIvrAudio).not.toHaveBeenCalled()
  })

  it('lets the operator listen back to a prompt, with the permission that manages it', async () => {
    const stored = encodePcm16Wav(new Float32Array(80), IVR_WAV_SAMPLE_RATE)
    const getIvrAudio = vi.fn().mockResolvedValue({ audio: Buffer.from(stored).toString('base64'), size: stored.byteLength })
    const res = await app({ getIvrAudio }).request('/ivr-audio/pleaseHold/fr')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/wav')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(stored)
    expect(getIvrAudio).toHaveBeenCalledWith('pleaseHold', 'fr')

    const denied = await app({ getIvrAudio }, ['settings:read']).request('/ivr-audio/pleaseHold/fr')
    expect(denied.status).toBe(403)
  })

  it('answers 404 for a prompt never uploaded', async () => {
    const res = await app({ getIvrAudio: vi.fn().mockResolvedValue(null) }).request('/ivr-audio/greeting/de')
    expect(res.status).toBe(404)
  })
})
