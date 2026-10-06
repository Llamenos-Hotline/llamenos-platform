/**
 * Tests for metadata reduction fixes (Gap 2 from security gaps analysis):
 *   1. callerNumber stored as HMAC-SHA256 hash, not plaintext
 *   2. User-Agent stored as SHA-256 hash, not plaintext
 *   3. Country field removed from audit logs
 */
import { describe, it, expect, vi } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { utf8ToBytes } from '@noble/ciphers/utils.js'
import { hashPhone } from '../../lib/crypto'
import { AuditService, audit } from '../../services/audit'

// ---------------------------------------------------------------------------
// Shared HMAC secret for tests
// ---------------------------------------------------------------------------

const TEST_HMAC_SECRET = 'a'.repeat(64) // 32 zero bytes as hex

// ---------------------------------------------------------------------------
// 1. hashPhone produces consistent HMAC hashes
// ---------------------------------------------------------------------------

describe('hashPhone', () => {
  it('produces a 64-char hex hash', () => {
    const hash = hashPhone('+15551234567', TEST_HMAC_SECRET)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('same input produces same hash (deterministic)', () => {
    const h1 = hashPhone('+15551234567', TEST_HMAC_SECRET)
    const h2 = hashPhone('+15551234567', TEST_HMAC_SECRET)
    expect(h1).toBe(h2)
  })

  it('different numbers produce different hashes', () => {
    const h1 = hashPhone('+15551234567', TEST_HMAC_SECRET)
    const h2 = hashPhone('+15559999999', TEST_HMAC_SECRET)
    expect(h1).not.toBe(h2)
  })

  it('hash does not contain the raw phone number', () => {
    const phone = '+15551234567'
    const hash = hashPhone(phone, TEST_HMAC_SECRET)
    expect(hash).not.toContain(phone)
    expect(hash).not.toContain('5551234567')
  })

  it('different HMAC secrets produce different hashes (key binding)', () => {
    const secret2 = 'b'.repeat(64)
    const h1 = hashPhone('+15551234567', TEST_HMAC_SECRET)
    const h2 = hashPhone('+15551234567', secret2)
    expect(h1).not.toBe(h2)
  })
})

// ---------------------------------------------------------------------------
// 2. Audit log: no country, User-Agent is SHA-256 hash
// ---------------------------------------------------------------------------

function makeAuditService() {
  const rows: Array<{ action: string; details: Record<string, unknown> | null }> = []

  const db = {
    transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        // per-chain advisory lock taken before the tip is read
        execute: vi.fn().mockResolvedValue([]),
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
            rows.push({ action: vals.action as string, details: vals.details as Record<string, unknown> | null })
            return {
              returning: vi.fn().mockResolvedValue([vals]),
            }
          }),
        }),
      }
      return fn(tx)
    }),
  }

  return { svc: new AuditService(db as never), rows }
}

describe('audit() metadata', () => {
  it('does not store raw User-Agent in audit details', async () => {
    const { svc, rows } = makeAuditService()

    const rawUa = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
    const req = new Request('https://example.com/', {
      headers: { 'User-Agent': rawUa, 'X-Forwarded-For': '1.2.3.4' },
    })

    await audit(svc, 'login', 'system', {}, { request: req, hmacSecret: TEST_HMAC_SECRET }, null)

    expect(rows).toHaveLength(1)
    const details = rows[0].details as Record<string, unknown>
    expect(details.ua).toBeDefined()
    expect(details.ua).not.toBe(rawUa)
    expect(details.ua).not.toContain('Mozilla')
    expect(details.ua).not.toContain('Linux')
  })

  it('stores UA as 64-char SHA-256 hex', async () => {
    const { svc, rows } = makeAuditService()

    const rawUa = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)'
    const expectedHash = bytesToHex(sha256(utf8ToBytes(rawUa)))
    const req = new Request('https://example.com/', {
      headers: { 'User-Agent': rawUa },
    })

    await audit(svc, 'login', 'system', {}, { request: req, hmacSecret: TEST_HMAC_SECRET }, null)

    const details = rows[0].details as Record<string, unknown>
    expect(details.ua).toBe(expectedHash)
  })

  it('same UA produces same hash (pattern detection preserved)', async () => {
    const rawUa = 'some-bot/1.0'

    const { svc: svc1, rows: rows1 } = makeAuditService()
    const req1 = new Request('https://example.com/', { headers: { 'User-Agent': rawUa } })
    await audit(svc1, 'login', 'system', {}, { request: req1, hmacSecret: TEST_HMAC_SECRET }, null)

    const { svc: svc2, rows: rows2 } = makeAuditService()
    const req2 = new Request('https://example.com/', { headers: { 'User-Agent': rawUa } })
    await audit(svc2, 'login', 'system', {}, { request: req2, hmacSecret: TEST_HMAC_SECRET }, null)

    const ua1 = (rows1[0].details as Record<string, unknown>).ua
    const ua2 = (rows2[0].details as Record<string, unknown>).ua
    expect(ua1).toBe(ua2)
  })

  it('different UAs produce different hashes', async () => {
    const { svc: svc1, rows: rows1 } = makeAuditService()
    const req1 = new Request('https://example.com/', { headers: { 'User-Agent': 'BotA/1.0' } })
    await audit(svc1, 'login', 'system', {}, { request: req1, hmacSecret: TEST_HMAC_SECRET }, null)

    const { svc: svc2, rows: rows2 } = makeAuditService()
    const req2 = new Request('https://example.com/', { headers: { 'User-Agent': 'BotB/2.0' } })
    await audit(svc2, 'login', 'system', {}, { request: req2, hmacSecret: TEST_HMAC_SECRET }, null)

    const ua1 = (rows1[0].details as Record<string, unknown>).ua
    const ua2 = (rows2[0].details as Record<string, unknown>).ua
    expect(ua1).not.toBe(ua2)
  })

  it('stores null ua when no User-Agent header is present', async () => {
    const { svc, rows } = makeAuditService()
    const req = new Request('https://example.com/')
    await audit(svc, 'login', 'system', {}, { request: req, hmacSecret: TEST_HMAC_SECRET }, null)
    const details = rows[0].details as Record<string, unknown>
    expect(details.ua).toBeNull()
  })

  it('does NOT store country field', async () => {
    const { svc, rows } = makeAuditService()
    const req = new Request('https://example.com/', {
      headers: { 'CF-IPCountry': 'US', 'User-Agent': 'test/1.0' },
    })
    await audit(svc, 'login', 'system', {}, { request: req, hmacSecret: TEST_HMAC_SECRET }, null)
    const details = rows[0].details as Record<string, unknown>
    expect(details).not.toHaveProperty('country')
  })

  it('still stores hashed IP alongside the hashed UA', async () => {
    const { svc, rows } = makeAuditService()
    const req = new Request('https://example.com/', {
      headers: { 'X-Forwarded-For': '203.0.113.5', 'User-Agent': 'test/1.0' },
    })
    // getClientIp only honors forwarded-for headers behind a declared trusted
    // proxy (#1606); without this the audit entry records no address at all,
    // and `toBeDefined()` would pass on a null.
    const originalTrust = process.env.TRUST_PROXY_HEADERS
    process.env.TRUST_PROXY_HEADERS = 'true'
    try {
      await audit(svc, 'login', 'system', {}, { request: req, hmacSecret: TEST_HMAC_SECRET }, null)
    } finally {
      if (originalTrust === undefined) delete process.env.TRUST_PROXY_HEADERS
      else process.env.TRUST_PROXY_HEADERS = originalTrust
    }
    const details = rows[0].details as Record<string, unknown>
    expect(typeof details.ip).toBe('string')
    expect(details.ip).not.toBe('203.0.113.5')
    expect(details.ua).toBeDefined()
  })

  it('stores no metadata when ctx is not provided', async () => {
    const { svc, rows } = makeAuditService()
    await audit(svc, 'settingsUpdated', 'system', { key: 'val' }, undefined, null)
    const details = rows[0].details as Record<string, unknown>
    expect(details).not.toHaveProperty('ip')
    expect(details).not.toHaveProperty('ua')
    expect(details).not.toHaveProperty('country')
    expect(details.key).toBe('val')
  })
})

// ---------------------------------------------------------------------------
// 3. Ban matching works with hashed callerNumber
// ---------------------------------------------------------------------------

describe('ban matching with hashed phone', () => {
  it('same phone produces same hash — ban check works across call sites', () => {
    const rawPhone = '+15551234567'
    const hashAtStorage = hashPhone(rawPhone, TEST_HMAC_SECRET)
    const hashAtLookup = hashPhone(rawPhone, TEST_HMAC_SECRET)
    // If stored hash equals lookup hash, the ban check will correctly fire
    expect(hashAtStorage).toBe(hashAtLookup)
  })

  it('different phones never collide', () => {
    const phones = ['+15551234567', '+15559876543', '+441234567890']
    const hashes = phones.map(p => hashPhone(p, TEST_HMAC_SECRET))
    const unique = new Set(hashes)
    expect(unique.size).toBe(phones.length)
  })

  it('hash stored in active_calls matches hash used in ban check', () => {
    // This simulates the flow:
    // 1. startParallelRinging hashes callerNumber before addCall
    // 2. telephony.ts hashes callerNumber before checkBan
    // Both use hashPhone with the same secret → consistent
    const incomingNumber = '+447911123456'
    const storedInActiveCalls = hashPhone(incomingNumber, TEST_HMAC_SECRET)
    const usedInBanCheck = hashPhone(incomingNumber, TEST_HMAC_SECRET)
    expect(storedInActiveCalls).toBe(usedInBanCheck)
  })

  it('raw phone number is not stored in callerNumber hash', () => {
    const rawPhone = '+15551234567'
    const hash = hashPhone(rawPhone, TEST_HMAC_SECRET)
    // The hash must not leak any digits of the phone number
    expect(hash).not.toContain(rawPhone.replace('+', ''))
    expect(hash).not.toContain('555')
    expect(hash).not.toContain('1234567')
  })
})
