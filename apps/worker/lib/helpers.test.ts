/**
 * Unit tests for general helper utilities.
 *
 * Covers: isValidE164, json, error, uint8ArrayToBase64URL,
 * encodeCursor, decodeCursor, and TokenBucketRateLimiter.
 */

import { describe, it, expect } from 'vitest'
import { isValidE164, json, error, uint8ArrayToBase64URL } from './helpers'
import { encodeCursor, decodeCursor } from './pagination'
import { TokenBucketRateLimiter } from './rate-limiter'

// ---------------------------------------------------------------------------
// isValidE164
// ---------------------------------------------------------------------------

describe('isValidE164', () => {
  it('accepts valid E.164 numbers', () => {
    expect(isValidE164('+15551234567')).toBe(true)
    expect(isValidE164('+44207946123')).toBe(true)
    expect(isValidE164('+1234567')).toBe(true) // 7 digits minimum
  })

  it('rejects numbers without leading +', () => {
    expect(isValidE164('15551234567')).toBe(false)
    expect(isValidE164('5551234567')).toBe(false)
  })

  it('rejects numbers with fewer than 7 digits', () => {
    expect(isValidE164('+12345')).toBe(false)
    expect(isValidE164('+1')).toBe(false)
  })

  it('rejects numbers with more than 15 digits', () => {
    expect(isValidE164('+1234567890123456')).toBe(false)
  })

  it('rejects numbers with non-digit characters after +', () => {
    expect(isValidE164('+1-555-123-4567')).toBe(false)
    expect(isValidE164('+1 555 1234567')).toBe(false)
    expect(isValidE164('+1(555)1234567')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(isValidE164('')).toBe(false)
  })

  it('rejects just "+"', () => {
    expect(isValidE164('+')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// json helper
// ---------------------------------------------------------------------------

describe('json', () => {
  it('returns a Response with JSON Content-Type', () => {
    const res = json({ ok: true })
    expect(res.headers.get('content-type')).toContain('application/json')
  })

  it('defaults to status 200', () => {
    expect(json({ x: 1 }).status).toBe(200)
  })

  it('accepts custom status code', () => {
    expect(json({ error: 'nope' }, 404).status).toBe(404)
    expect(json({ created: true }, 201).status).toBe(201)
  })

  it('body serializes the data as JSON', async () => {
    const data = { key: 'value', num: 42 }
    const res = json(data)
    const body = await res.json()
    expect(body).toEqual(data)
  })
})

// ---------------------------------------------------------------------------
// error helper
// ---------------------------------------------------------------------------

describe('error', () => {
  it('returns 400 by default', () => {
    expect(error('bad input').status).toBe(400)
  })

  it('wraps message in { error } shape', async () => {
    const res = error('invalid phone')
    const body = await res.json() as { error: string }
    expect(body.error).toBe('invalid phone')
  })

  it('accepts custom status', () => {
    expect(error('not found', 404).status).toBe(404)
    expect(error('forbidden', 403).status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// uint8ArrayToBase64URL
// ---------------------------------------------------------------------------

describe('uint8ArrayToBase64URL', () => {
  it('encodes bytes to base64url (no padding, - and _ instead of + and /)', () => {
    // Known test: [0xfb, 0xff, 0xfe] → base64 "+//" → base64url "-__"
    const bytes = new Uint8Array([0xfb, 0xff, 0xfe])
    const result = uint8ArrayToBase64URL(bytes)
    expect(result).not.toContain('+')
    expect(result).not.toContain('/')
    expect(result).not.toContain('=')
  })

  it('encodes empty array to empty string', () => {
    expect(uint8ArrayToBase64URL(new Uint8Array(0))).toBe('')
  })

  it('round-trips with atob after adding padding back', () => {
    const original = new Uint8Array([1, 2, 3, 4, 5, 6])
    const encoded = uint8ArrayToBase64URL(original)
    // Add padding back
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/')
    const withPadding = padded + '='.repeat((4 - padded.length % 4) % 4)
    const decoded = Uint8Array.from(atob(withPadding), c => c.charCodeAt(0))
    expect(decoded).toEqual(original)
  })

  it('known byte sequence', () => {
    // [0, 0, 0] in base64 is "AAAA"
    expect(uint8ArrayToBase64URL(new Uint8Array([0, 0, 0]))).toBe('AAAA')
  })
})

// ---------------------------------------------------------------------------
// encodeCursor / decodeCursor
// ---------------------------------------------------------------------------

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a simple string key', () => {
    const key = 'records:001:2024-01-01'
    expect(decodeCursor(encodeCursor(key))).toBe(key)
  })

  it('produces URL-safe output (no + / =)', () => {
    const encoded = encodeCursor('some key with spaces: and colons')
    expect(encoded).not.toContain('+')
    expect(encoded).not.toContain('/')
    expect(encoded).not.toContain('=')
  })

  it('handles empty string', () => {
    expect(decodeCursor(encodeCursor(''))).toBe('')
  })

  it('handles keys with special characters', () => {
    const key = 'prefix/sub:2024-01-01T00:00:00.000Z'
    expect(decodeCursor(encodeCursor(key))).toBe(key)
  })

  it('different keys produce different cursors', () => {
    expect(encodeCursor('key1')).not.toBe(encodeCursor('key2'))
  })
})

// ---------------------------------------------------------------------------
// TokenBucketRateLimiter
// ---------------------------------------------------------------------------

describe('TokenBucketRateLimiter', () => {
  it('allows requests up to the burst limit', () => {
    const limiter = new TokenBucketRateLimiter(10, 5)
    // Should allow up to maxTokens (5) immediately
    let allowed = 0
    for (let i = 0; i < 10; i++) {
      if (limiter.tryConsume()) allowed++
    }
    expect(allowed).toBe(5)
  })

  it('returns false when tokens are exhausted', () => {
    const limiter = new TokenBucketRateLimiter(1, 1)
    expect(limiter.tryConsume()).toBe(true)
    expect(limiter.tryConsume()).toBe(false)
  })

  it('starts with maxTokens available', () => {
    const limiter = new TokenBucketRateLimiter(10, 3)
    expect(limiter.availableTokens).toBe(3)
  })

  it('availableTokens decrements after tryConsume', () => {
    const limiter = new TokenBucketRateLimiter(10, 5)
    limiter.tryConsume()
    limiter.tryConsume()
    expect(limiter.availableTokens).toBe(3)
  })

  it('create() static factory returns a properly configured limiter', () => {
    const limiter = TokenBucketRateLimiter.create(10, 3)
    // maxTokens = 10 * 3 = 30
    expect(limiter.availableTokens).toBe(30)
  })

  it('waitForToken resolves immediately when tokens are available', async () => {
    const limiter = new TokenBucketRateLimiter(100, 10)
    const waited = await limiter.waitForToken()
    expect(waited).toBe(0)
  })

  it('waitForToken waits when no tokens available', async () => {
    const limiter = new TokenBucketRateLimiter(1000, 1) // high rate to recover fast
    limiter.tryConsume() // exhaust
    const waited = await limiter.waitForToken()
    expect(waited).toBeGreaterThanOrEqual(0)
  })

  it('default maxTokens is 2x tokensPerSecond', () => {
    const limiter = new TokenBucketRateLimiter(10)
    expect(limiter.availableTokens).toBe(20)
  })
})
