import { describe, it, expect, vi } from 'vitest'
import {
  isValidE164,
  buildAudioUrlMap,
  checkRateLimit,
  uint8ArrayToBase64URL,
} from '@worker/lib/helpers'
import { verifyIvrMediaPath } from '@worker/lib/ivr-media-url'

describe('buildAudioUrlMap', () => {
  const origin = 'https://api.example.com'
  const secret = 'ab'.repeat(32)
  // 2026-09-29T12:00:00Z
  const now = Date.UTC(2026, 8, 29, 12, 0, 0)

  it('builds URL map from getIvrAudioList service', async () => {
    const settings = {
      getIvrAudioList: vi.fn().mockResolvedValue({
        recordings: [
          { promptType: 'welcome', language: 'en' },
          { promptType: 'welcome', language: 'es' },
          { promptType: 'goodbye', language: 'en' },
        ],
      }),
    }

    const map = await buildAudioUrlMap(settings, origin, secret, now)

    expect(settings.getIvrAudioList).toHaveBeenCalledOnce()
    expect(map['welcome:en']).toMatch(/^https:\/\/api\.example\.com\/api\/ivr-audio\/welcome\/en\?exp=\d+&sig=[0-9a-f]{64}$/)
    expect(map['welcome:es']).toMatch(/^https:\/\/api\.example\.com\/api\/ivr-audio\/welcome\/es\?/)
    expect(map['goodbye:en']).toMatch(/^https:\/\/api\.example\.com\/api\/ivr-audio\/goodbye\/en\?/)
  })

  it('signs each URL for its own path, expiring 10–15 minutes out on a 5-minute boundary', async () => {
    const settings = {
      getIvrAudioList: vi.fn().mockResolvedValue({
        recordings: [{ promptType: 'greeting', language: 'fr' }, { promptType: 'greeting', language: 'es' }],
      }),
    }
    const map = await buildAudioUrlMap(settings, origin, secret, now)
    const fr = new URL(map['greeting:fr'])
    const exp = Number(fr.searchParams.get('exp'))
    expect(exp % 300).toBe(0)
    expect(exp * 1000 - now).toBeGreaterThanOrEqual(600_000)
    expect(exp * 1000 - now).toBeLessThan(900_000)

    const opts = { requireExpiry: true, nowMs: now }
    expect(verifyIvrMediaPath(secret, fr.pathname, fr.searchParams, opts)).toBe(true)
    // A signature is bound to its prompt: it does not open another language's.
    expect(verifyIvrMediaPath(secret, '/api/ivr-audio/greeting/es', fr.searchParams, opts)).toBe(false)
    // …nor verify under another secret, nor once expired.
    expect(verifyIvrMediaPath('cd'.repeat(32), fr.pathname, fr.searchParams, opts)).toBe(false)
    expect(verifyIvrMediaPath(secret, fr.pathname, fr.searchParams, { requireExpiry: true, nowMs: exp * 1000 })).toBe(false)
  })

  it('hands every call in the same 5-minute window the same URL, so the PBX cache is hit', async () => {
    const settings = {
      getIvrAudioList: vi.fn().mockResolvedValue({ recordings: [{ promptType: 'greeting', language: 'fr' }] }),
    }
    const first = await buildAudioUrlMap(settings, origin, secret, now + 1_000)
    const later = await buildAudioUrlMap(settings, origin, secret, now + 299_000)
    expect(later['greeting:fr']).toBe(first['greeting:fr'])
  })

  it('builds URL map from fetch-based settings', async () => {
    const settings = {
      fetch: vi.fn().mockResolvedValue(
        Response.json({
          recordings: [
            { promptType: 'hold', language: 'fr' },
          ],
        })
      ),
    }

    const map = await buildAudioUrlMap(settings, origin, secret, now)

    expect(settings.fetch).toHaveBeenCalledOnce()
    expect(map['hold:fr']).toMatch(/^https:\/\/api\.example\.com\/api\/ivr-audio\/hold\/fr\?exp=/)
  })

  it('returns empty map when no recordings', async () => {
    const settings = {
      getIvrAudioList: vi.fn().mockResolvedValue({ recordings: [] }),
    }

    const map = await buildAudioUrlMap(settings, origin, secret, now)
    expect(Object.keys(map)).toHaveLength(0)
  })

  it('uses correct key format: promptType:language', async () => {
    const settings = {
      getIvrAudioList: vi.fn().mockResolvedValue({
        recordings: [
          { promptType: 'captcha_digits', language: 'zh-CN' },
        ],
      }),
    }

    const map = await buildAudioUrlMap(settings, origin, secret, now)
    expect(map).toHaveProperty('captcha_digits:zh-CN')
  })

  it('overwrites duplicate promptType:language combos (last wins)', async () => {
    const settings = {
      getIvrAudioList: vi.fn().mockResolvedValue({
        recordings: [
          { promptType: 'welcome', language: 'en' },
          { promptType: 'welcome', language: 'en' }, // duplicate
        ],
      }),
    }

    const map = await buildAudioUrlMap(settings, origin, secret, now)
    // Should have one entry (last write wins)
    expect(Object.keys(map).filter(k => k === 'welcome:en')).toHaveLength(1)
  })
})

describe('checkRateLimit', () => {
  it('returns true when rate limited', async () => {
    const settings = {
      checkRateLimit: vi.fn().mockResolvedValue({ limited: true }),
    }

    const result = await checkRateLimit(settings, 'login:user1', 5)

    expect(result).toBe(true)
    expect(settings.checkRateLimit).toHaveBeenCalledWith({ key: 'login:user1', maxPerMinute: 5 })
  })

  it('returns false when not rate limited', async () => {
    const settings = {
      checkRateLimit: vi.fn().mockResolvedValue({ limited: false }),
    }

    const result = await checkRateLimit(settings, 'api:general', 100)

    expect(result).toBe(false)
    expect(settings.checkRateLimit).toHaveBeenCalledWith({ key: 'api:general', maxPerMinute: 100 })
  })

  it('passes through the key and maxPerMinute correctly', async () => {
    const settings = {
      checkRateLimit: vi.fn().mockResolvedValue({ limited: false }),
    }

    await checkRateLimit(settings, 'webhook:callback', 60)

    expect(settings.checkRateLimit).toHaveBeenCalledWith({
      key: 'webhook:callback',
      maxPerMinute: 60,
    })
  })
})

describe('isValidE164 — additional edge cases', () => {
  it('rejects only a plus sign with no digits', () => {
    expect(isValidE164('+')).toBe(false)
  })

  it('rejects numbers with leading/trailing whitespace', () => {
    expect(isValidE164(' +15551234567')).toBe(false)
    expect(isValidE164('+15551234567 ')).toBe(false)
  })

  it('rejects numbers with internal whitespace', () => {
    expect(isValidE164('+1 555 1234567')).toBe(false)
  })

  it('rejects hex-like strings', () => {
    expect(isValidE164('+1a2b3c4d5e6')).toBe(false)
  })

  it('accepts exactly 7-digit minimum', () => {
    expect(isValidE164('+1234567')).toBe(true)
    expect(isValidE164('+123456')).toBe(false) // 6 digits
  })

  it('accepts exactly 15-digit maximum', () => {
    expect(isValidE164('+123456789012345')).toBe(true)
    expect(isValidE164('+1234567890123456')).toBe(false) // 16 digits
  })
})

describe('uint8ArrayToBase64URL — roundtrip correctness', () => {
  it('encodes known value correctly', () => {
    // "Hello" = [72, 101, 108, 108, 111]
    // Base64 = "SGVsbG8=" → Base64URL = "SGVsbG8"
    const result = uint8ArrayToBase64URL(new Uint8Array([72, 101, 108, 108, 111]))
    expect(result).toBe('SGVsbG8')
  })

  it('encodes single byte correctly', () => {
    // [0] → Base64 "AA==" → Base64URL "AA"
    const result = uint8ArrayToBase64URL(new Uint8Array([0]))
    expect(result).toBe('AA')
  })

  it('encodes two bytes correctly', () => {
    // [0, 0] → Base64 "AAA=" → Base64URL "AAA"
    const result = uint8ArrayToBase64URL(new Uint8Array([0, 0]))
    expect(result).toBe('AAA')
  })

  it('encodes three bytes correctly (no padding)', () => {
    // [0, 0, 0] → Base64 "AAAA" → Base64URL "AAAA"
    const result = uint8ArrayToBase64URL(new Uint8Array([0, 0, 0]))
    expect(result).toBe('AAAA')
  })

  it('handles 32-byte key material', () => {
    const key = new Uint8Array(32)
    key.fill(0xab)
    const result = uint8ArrayToBase64URL(key)
    expect(result.length).toBeGreaterThan(0)
    expect(result).not.toContain('=')
    expect(result).not.toContain('+')
    expect(result).not.toContain('/')
  })
})
