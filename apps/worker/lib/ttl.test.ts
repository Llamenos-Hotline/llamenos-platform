/**
 * Unit tests for TTL constants and helpers.
 *
 * Covers: resolveTTL, validateTTLOverrides, emptyCleanupMetrics,
 * and the default TTL constant values.
 */

import { describe, it, expect } from 'vitest'
import {
  resolveTTL,
  validateTTLOverrides,
  emptyCleanupMetrics,
  TTL_OVERRIDE_KEYS,
  TTL_CAPTCHA_CHALLENGE_MS,
  TTL_RATE_LIMIT_MS,
  TTL_PROVISION_ROOM_MS,
  TTL_WEBAUTHN_CHALLENGE_MS,
  TTL_REDEEMED_INVITE_MS,
  TTL_EXPIRED_INVITE_MS,
  CLEANUP_ALARM_INTERVAL_MS,
} from './ttl'

// ---------------------------------------------------------------------------
// Default TTL constants
// ---------------------------------------------------------------------------

describe('TTL constants', () => {
  it('CAPTCHA challenge TTL is 5 minutes', () => {
    expect(TTL_CAPTCHA_CHALLENGE_MS).toBe(5 * 60 * 1000)
  })

  it('rate limit TTL is 2 minutes', () => {
    expect(TTL_RATE_LIMIT_MS).toBe(2 * 60 * 1000)
  })

  it('provision room TTL is 5 minutes', () => {
    expect(TTL_PROVISION_ROOM_MS).toBe(5 * 60 * 1000)
  })

  it('WebAuthn challenge TTL is 5 minutes', () => {
    expect(TTL_WEBAUTHN_CHALLENGE_MS).toBe(5 * 60 * 1000)
  })

  it('redeemed invite TTL is 30 days', () => {
    expect(TTL_REDEEMED_INVITE_MS).toBe(30 * 24 * 60 * 60 * 1000)
  })

  it('expired invite TTL is 7 days', () => {
    expect(TTL_EXPIRED_INVITE_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })

  it('cleanup alarm interval is 15 minutes', () => {
    expect(CLEANUP_ALARM_INTERVAL_MS).toBe(15 * 60 * 1000)
  })

  it('all TTL_OVERRIDE_KEYS have positive defaults', () => {
    for (const [, value] of Object.entries(TTL_OVERRIDE_KEYS)) {
      expect(value).toBeGreaterThanOrEqual(0)
    }
  })
})

// ---------------------------------------------------------------------------
// resolveTTL
// ---------------------------------------------------------------------------

describe('resolveTTL', () => {
  it('returns default when no overrides', () => {
    expect(resolveTTL('captchaChallenge')).toBe(TTL_CAPTCHA_CHALLENGE_MS)
    expect(resolveTTL('webauthnChallenge')).toBe(TTL_WEBAUTHN_CHALLENGE_MS)
  })

  it('returns override when set', () => {
    expect(resolveTTL('captchaChallenge', { captchaChallenge: 99_999 })).toBe(99_999)
  })

  it('returns override of 0 (immediate deletion)', () => {
    expect(resolveTTL('rateLimit', { rateLimit: 0 })).toBe(0)
  })

  it('returns default when override is missing for that key', () => {
    const overrides = { captchaChallenge: 1000 }
    expect(resolveTTL('rateLimit', overrides)).toBe(TTL_RATE_LIMIT_MS)
  })

  it('returns default when override value is not a number', () => {
    const overrides = { captchaChallenge: 'invalid' as unknown as number }
    expect(resolveTTL('captchaChallenge', overrides)).toBe(TTL_CAPTCHA_CHALLENGE_MS)
  })

  it('returns default when override is undefined', () => {
    expect(resolveTTL('captchaChallenge', undefined)).toBe(TTL_CAPTCHA_CHALLENGE_MS)
  })
})

// ---------------------------------------------------------------------------
// validateTTLOverrides
// ---------------------------------------------------------------------------

describe('validateTTLOverrides', () => {
  it('returns null for valid overrides', () => {
    expect(validateTTLOverrides({ captchaChallenge: 60_000, rateLimit: 120_000 })).toBeNull()
  })

  it('returns null for empty object', () => {
    expect(validateTTLOverrides({})).toBeNull()
  })

  it('returns error for unknown key', () => {
    const result = validateTTLOverrides({ unknownKey: 5000 })
    expect(result).not.toBeNull()
    expect(result).toContain('unknownKey')
  })

  it('returns error for non-number value', () => {
    const result = validateTTLOverrides({ captchaChallenge: 'long' as unknown as number })
    expect(result).not.toBeNull()
  })

  it('returns error for negative number', () => {
    const result = validateTTLOverrides({ captchaChallenge: -1 })
    expect(result).not.toBeNull()
  })

  it('returns error for Infinity', () => {
    const result = validateTTLOverrides({ captchaChallenge: Infinity })
    expect(result).not.toBeNull()
  })

  it('returns error for NaN', () => {
    const result = validateTTLOverrides({ captchaChallenge: NaN })
    expect(result).not.toBeNull()
  })

  it('returns error for value exceeding 365 days', () => {
    const tooLong = 366 * 24 * 60 * 60 * 1000
    const result = validateTTLOverrides({ captchaChallenge: tooLong })
    expect(result).not.toBeNull()
  })

  it('accepts exactly 365 days', () => {
    const max = 365 * 24 * 60 * 60 * 1000
    expect(validateTTLOverrides({ captchaChallenge: max })).toBeNull()
  })

  it('accepts 0 (immediate deletion)', () => {
    expect(validateTTLOverrides({ captchaChallenge: 0 })).toBeNull()
  })

  it('error message includes the offending key', () => {
    const result = validateTTLOverrides({ captchaChallenge: -100 })
    expect(result).toContain('captchaChallenge')
  })
})

// ---------------------------------------------------------------------------
// emptyCleanupMetrics
// ---------------------------------------------------------------------------

describe('emptyCleanupMetrics', () => {
  it('returns an object with all counters at 0', () => {
    const m = emptyCleanupMetrics()
    expect(m.captchaChallengesDeleted).toBe(0)
    expect(m.rateLimitEntriesDeleted).toBe(0)
    expect(m.expiredSessionsDeleted).toBe(0)
    expect(m.provisionRoomsDeleted).toBe(0)
    expect(m.expiredInvitesCleaned).toBe(0)
    expect(m.webauthnChallengesDeleted).toBe(0)
    expect(m.staleFileUploadsDeleted).toBe(0)
    expect(m.completedBlastQueuesDeleted).toBe(0)
  })

  it('lastCleanupAt is null', () => {
    expect(emptyCleanupMetrics().lastCleanupAt).toBeNull()
  })

  it('returns a new object each call (no shared reference)', () => {
    const a = emptyCleanupMetrics()
    const b = emptyCleanupMetrics()
    a.captchaChallengesDeleted = 5
    expect(b.captchaChallengesDeleted).toBe(0)
  })
})
