import { describe, expect, it } from 'vitest'
import {
  IVR_AUDIO_URL_BUCKET_SECONDS,
  IVR_AUDIO_URL_TTL_SECONDS,
  ivrAudioUrlExpiry,
  signIvrMediaPath,
  verifyIvrMediaPath,
} from '@worker/lib/ivr-media-url'

const SECRET = '5e'.repeat(32)
const NOW = Date.UTC(2026, 8, 29, 12, 0, 7)
const PATH = '/api/ivr-audio/greeting/fr'

function split(signed: string): { path: string; query: URLSearchParams } {
  const [path, query] = signed.split('?')
  return { path, query: new URLSearchParams(query) }
}

describe('IVR media URL signing', () => {
  it('verifies the path it signed, until it expires', () => {
    const exp = Math.floor(NOW / 1000) + 60
    const { path, query } = split(signIvrMediaPath(SECRET, PATH, exp))
    expect(path).toBe(PATH)
    expect(verifyIvrMediaPath(SECRET, path, query, { requireExpiry: true, nowMs: NOW })).toBe(true)
    expect(verifyIvrMediaPath(SECRET, path, query, { requireExpiry: true, nowMs: exp * 1000 })).toBe(false)
  })

  it('refuses another path, another secret, a moved expiry, or a missing signature', () => {
    const exp = Math.floor(NOW / 1000) + 60
    const { query } = split(signIvrMediaPath(SECRET, PATH, exp))
    const opts = { requireExpiry: true, nowMs: NOW }
    expect(verifyIvrMediaPath(SECRET, '/api/ivr-audio/greeting/es', query, opts)).toBe(false)
    expect(verifyIvrMediaPath('77'.repeat(32), PATH, query, opts)).toBe(false)

    const extended = new URLSearchParams(query)
    extended.set('exp', String(exp + 3600))
    expect(verifyIvrMediaPath(SECRET, PATH, extended, opts)).toBe(false)

    const unsigned = new URLSearchParams(query)
    unsigned.delete('sig')
    expect(verifyIvrMediaPath(SECRET, PATH, unsigned, opts)).toBe(false)
    expect(verifyIvrMediaPath(SECRET, PATH, new URLSearchParams({ exp: String(exp), sig: 'x' }), opts)).toBe(false)
    expect(verifyIvrMediaPath(SECRET, PATH, new URLSearchParams({ exp: '1e12', sig: query.get('sig')! }), opts)).toBe(false)
  })

  it('an unexpiring signature verifies only where expiry is optional (content-addressed media)', () => {
    const { query } = split(signIvrMediaPath(SECRET, PATH))
    expect(query.has('exp')).toBe(false)
    expect(verifyIvrMediaPath(SECRET, PATH, query, { requireExpiry: false, nowMs: NOW })).toBe(true)
    expect(verifyIvrMediaPath(SECRET, PATH, query, { requireExpiry: true, nowMs: NOW })).toBe(false)
  })

  it('never verifies without a secret', () => {
    const { query } = split(signIvrMediaPath('', PATH))
    expect(verifyIvrMediaPath('', PATH, query, { requireExpiry: false, nowMs: NOW })).toBe(false)
  })

  it('expires an uploaded prompt 1–2 days out, on a day boundary', () => {
    const exp = ivrAudioUrlExpiry(NOW)
    expect(exp % IVR_AUDIO_URL_BUCKET_SECONDS).toBe(0)
    expect(exp - NOW / 1000).toBeGreaterThanOrEqual(IVR_AUDIO_URL_TTL_SECONDS)
    expect(exp - NOW / 1000).toBeLessThan(IVR_AUDIO_URL_TTL_SECONDS + IVR_AUDIO_URL_BUCKET_SECONDS)
  })
})
