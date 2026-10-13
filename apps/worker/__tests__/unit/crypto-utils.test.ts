import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { hashPhone, hashIP, hashAuditEntry, stableJsonStringify, encryptMessageForStorage, encryptCallRecordForStorage, getClientIp } from '@worker/lib/crypto'
import { bytesToHex } from '@noble/hashes/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/ciphers/utils.js'

// Test HMAC secret (64 hex chars = 32 bytes)
const TEST_SECRET = 'a'.repeat(64)

describe('hashPhone', () => {
  it('returns a hex string', () => {
    const hash = hashPhone('+15551234567', TEST_SECRET)
    expect(hash).toMatch(/^[0-9a-f]+$/)
  })

  it('produces consistent output for same input', () => {
    const hash1 = hashPhone('+15551234567', TEST_SECRET)
    const hash2 = hashPhone('+15551234567', TEST_SECRET)
    expect(hash1).toBe(hash2)
  })

  it('produces different output for different phones', () => {
    const hash1 = hashPhone('+15551234567', TEST_SECRET)
    const hash2 = hashPhone('+15559876543', TEST_SECRET)
    expect(hash1).not.toBe(hash2)
  })

  it('produces different output for different secrets', () => {
    const hash1 = hashPhone('+15551234567', TEST_SECRET)
    const hash2 = hashPhone('+15551234567', 'b'.repeat(64))
    expect(hash1).not.toBe(hash2)
  })

  it('returns 64-character hex (SHA-256)', () => {
    const hash = hashPhone('+15551234567', TEST_SECRET)
    expect(hash.length).toBe(64)
  })

  it('uses the phone prefix for domain separation', () => {
    // Different from hashIP output for same raw value
    const phoneHash = hashPhone('127.0.0.1', TEST_SECRET)
    const ipHash = hashIP('127.0.0.1', TEST_SECRET)
    expect(phoneHash).not.toBe(ipHash)
  })
})

describe('hashIP', () => {
  it('returns a hex string', () => {
    const hash = hashIP('192.168.1.1', TEST_SECRET)
    expect(hash).toMatch(/^[0-9a-f]+$/)
  })

  it('truncates to 24 hex chars (96 bits)', () => {
    const hash = hashIP('192.168.1.1', TEST_SECRET)
    expect(hash.length).toBe(24)
  })

  it('produces consistent output for same input', () => {
    const hash1 = hashIP('10.0.0.1', TEST_SECRET)
    const hash2 = hashIP('10.0.0.1', TEST_SECRET)
    expect(hash1).toBe(hash2)
  })

  it('produces different output for different IPs', () => {
    const hash1 = hashIP('10.0.0.1', TEST_SECRET)
    const hash2 = hashIP('10.0.0.2', TEST_SECRET)
    expect(hash1).not.toBe(hash2)
  })

  it('handles IPv6 addresses', () => {
    const hash = hashIP('2001:db8::1', TEST_SECRET)
    expect(hash).toMatch(/^[0-9a-f]+$/)
    expect(hash.length).toBe(24)
  })
})

describe('getClientIp', () => {
  const originalTrustProxyHeaders = process.env.TRUST_PROXY_HEADERS

  beforeEach(() => {
    delete process.env.TRUST_PROXY_HEADERS
  })

  afterEach(() => {
    if (originalTrustProxyHeaders === undefined) {
      delete process.env.TRUST_PROXY_HEADERS
    } else {
      process.env.TRUST_PROXY_HEADERS = originalTrustProxyHeaders
    }
  })

  it('ignores spoofable forwarding headers by default (no trusted proxy configured)', () => {
    const req = new Request('http://localhost/', {
      headers: {
        'CF-Connecting-IP': '1.2.3.4',
        'X-Forwarded-For': '9.9.9.9',
        'X-Real-IP': '8.8.8.8',
        'User-Agent': 'test-agent',
      },
    })
    const ip = getClientIp(req)
    expect(ip).not.toBe('1.2.3.4')
    expect(ip).not.toBe('9.9.9.9')
    expect(ip).not.toBe('8.8.8.8')
    expect(ip).toMatch(/^fingerprint:/)
  })

  it('trusts X-Forwarded-For only when TRUST_PROXY_HEADERS=true', () => {
    process.env.TRUST_PROXY_HEADERS = 'true'
    const req = new Request('http://localhost/', {
      headers: { 'X-Forwarded-For': '1.2.3.4' },
    })
    expect(getClientIp(req)).toBe('1.2.3.4')
  })

  // #1606: this assertion is the INVERSE of the one it replaced. CF-Connecting-IP
  // used to be preferred over X-Forwarded-For once proxy headers were trusted.
  // Nothing in this architecture is ever behind Cloudflare (the Android client
  // pins ISRG Root X1/X2, so TLS terminates on the origin), which makes the
  // header purely client-supplied here — a free choice of rate-limit bucket.
  it('never honors CF-Connecting-IP, even when TRUST_PROXY_HEADERS=true', () => {
    process.env.TRUST_PROXY_HEADERS = 'true'
    const spoofed = new Request('http://localhost/', {
      headers: { 'CF-Connecting-IP': '1.2.3.4', 'User-Agent': 'test-agent' },
    })
    expect(getClientIp(spoofed)).not.toBe('1.2.3.4')
    expect(getClientIp(spoofed)).toMatch(/^fingerprint:/)

    // And it cannot override the address the trusted proxy actually set.
    const alongsideXff = new Request('http://localhost/', {
      headers: { 'CF-Connecting-IP': '1.2.3.4', 'X-Forwarded-For': '203.0.113.7' },
    })
    expect(getClientIp(alongsideXff)).toBe('203.0.113.7')
  })

  it('takes the right-most X-Forwarded-For entry when trusted (nearest hop, not client-controlled left-most)', () => {
    process.env.TRUST_PROXY_HEADERS = 'true'
    const req = new Request('http://localhost/', {
      headers: { 'X-Forwarded-For': '9.9.9.9, 10.0.0.5' },
    })
    expect(getClientIp(req)).toBe('10.0.0.5')
  })

  it('falls back to a per-client fingerprint when no headers or socket address are available', () => {
    const req = new Request('http://localhost/', {
      headers: { 'User-Agent': 'agent-a', 'Accept-Language': 'en-US' },
    })
    const req2 = new Request('http://localhost/', {
      headers: { 'User-Agent': 'agent-b', 'Accept-Language': 'en-US' },
    })
    expect(getClientIp(req)).not.toBe(getClientIp(req2))
  })
})

describe('hashAuditEntry', () => {
  const baseEntry = {
    id: 'audit-001',
    action: 'volunteer.login',
    actorPubkey: 'abc123',
    details: { ip: 'hashed-ip' },
    createdAt: '2024-01-01T00:00:00Z',
  }

  it('returns a hex string', () => {
    const hash = hashAuditEntry(baseEntry)
    expect(hash).toMatch(/^[0-9a-f]+$/)
  })

  it('returns 64-character hex (SHA-256)', () => {
    const hash = hashAuditEntry(baseEntry)
    expect(hash.length).toBe(64)
  })

  it('produces consistent output for same input', () => {
    const hash1 = hashAuditEntry(baseEntry)
    const hash2 = hashAuditEntry(baseEntry)
    expect(hash1).toBe(hash2)
  })

  it('changes when any field changes', () => {
    const hashOriginal = hashAuditEntry(baseEntry)

    const hashDiffId = hashAuditEntry({ ...baseEntry, id: 'audit-002' })
    expect(hashDiffId).not.toBe(hashOriginal)

    const hashDiffAction = hashAuditEntry({ ...baseEntry, action: 'volunteer.logout' })
    expect(hashDiffAction).not.toBe(hashOriginal)

    const hashDiffActor = hashAuditEntry({ ...baseEntry, actorPubkey: 'def456' })
    expect(hashDiffActor).not.toBe(hashOriginal)

    const hashDiffTime = hashAuditEntry({ ...baseEntry, createdAt: '2024-01-02T00:00:00Z' })
    expect(hashDiffTime).not.toBe(hashOriginal)
  })

  it('includes previousEntryHash in computation when present', () => {
    const hashWithout = hashAuditEntry(baseEntry)
    const hashWith = hashAuditEntry({ ...baseEntry, previousEntryHash: 'abc' })
    expect(hashWithout).not.toBe(hashWith)
  })

  it('treats missing previousEntryHash as empty string', () => {
    const hashUndefined = hashAuditEntry(baseEntry)
    const hashEmpty = hashAuditEntry({ ...baseEntry, previousEntryHash: '' })
    expect(hashUndefined).toBe(hashEmpty)
  })

  it('matches manual SHA-256 computation', () => {
    const entry = baseEntry
    const content = `${entry.id}:${entry.action}:${entry.actorPubkey}:${entry.createdAt}:${stableJsonStringify(entry.details ?? {})}:`
    const expected = bytesToHex(sha256(utf8ToBytes(content)))
    expect(hashAuditEntry(entry)).toBe(expected)
  })

  it('produces same hash regardless of key insertion order in details', () => {
    const entry1 = { ...baseEntry, details: { z: 1, a: 2, m: 3 } }
    const entry2 = { ...baseEntry, details: { a: 2, m: 3, z: 1 } }
    const entry3 = { ...baseEntry, details: { m: 3, z: 1, a: 2 } }
    const hash1 = hashAuditEntry(entry1)
    const hash2 = hashAuditEntry(entry2)
    const hash3 = hashAuditEntry(entry3)
    expect(hash1).toBe(hash2)
    expect(hash2).toBe(hash3)
  })
})

describe('encryptMessageForStorage', () => {
  // Use a known valid X25519 pubkey for real crypto ops:
  const validPubkey = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

  it('returns encrypted content as hex', () => {
    const result = encryptMessageForStorage('Hello world', [validPubkey])
    expect(result.encryptedContent).toMatch(/^[0-9a-f]+$/)
  })

  it('returns one envelope per reader', () => {
    const result = encryptMessageForStorage('Hello world', [validPubkey])
    expect(result.readerEnvelopes.length).toBe(1)
    expect(result.readerEnvelopes[0].pubkey).toBe(validPubkey)
  })

  it('each envelope has enc and ct fields (HPKE format)', () => {
    const result = encryptMessageForStorage('Test', [validPubkey])
    const envelope = result.readerEnvelopes[0]
    expect(envelope.enc).toMatch(/^[0-9a-f]{64}$/) // 32-byte X25519 enc
    expect(envelope.ct).toMatch(/^[0-9a-f]+$/)
  })

  it('produces different ciphertext for same plaintext (random key)', () => {
    const result1 = encryptMessageForStorage('Same message', [validPubkey])
    const result2 = encryptMessageForStorage('Same message', [validPubkey])
    expect(result1.encryptedContent).not.toBe(result2.encryptedContent)
  })

  it('handles multiple readers', () => {
    // Generator point and another valid point (2 * G)
    const pubkey2 = 'c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'
    const result = encryptMessageForStorage('Multi-reader', [validPubkey, pubkey2])
    expect(result.readerEnvelopes.length).toBe(2)
    expect(result.readerEnvelopes[0].pubkey).toBe(validPubkey)
    expect(result.readerEnvelopes[1].pubkey).toBe(pubkey2)
  })

  it('each reader gets a unique wrapped key (different enc values)', () => {
    const pubkey2 = 'c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'
    const result = encryptMessageForStorage('Test', [validPubkey, pubkey2])
    expect(result.readerEnvelopes[0].enc).not.toBe(result.readerEnvelopes[1].enc)
  })
})

describe('encryptCallRecordForStorage', () => {
  const validPubkey = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

  it('returns encrypted content as hex', () => {
    const result = encryptCallRecordForStorage(
      { answeredBy: 'pubkey123', callerNumber: 'hash123' },
      [validPubkey],
    )
    expect(result.encryptedContent).toMatch(/^[0-9a-f]+$/)
  })

  it('returns admin envelopes with HPKE fields', () => {
    const result = encryptCallRecordForStorage(
      { answeredBy: 'pubkey123', callerNumber: 'hash123' },
      [validPubkey],
    )
    expect(result.adminEnvelopes.length).toBe(1)
    expect(result.adminEnvelopes[0].pubkey).toBe(validPubkey)
    expect(result.adminEnvelopes[0].enc).toMatch(/^[0-9a-f]{64}$/)
    expect(result.adminEnvelopes[0].ct).toMatch(/^[0-9a-f]+$/)
  })

  it('produces different ciphertext each time (random key)', () => {
    const metadata = { answeredBy: 'pk1', callerNumber: 'hash' }
    const result1 = encryptCallRecordForStorage(metadata, [validPubkey])
    const result2 = encryptCallRecordForStorage(metadata, [validPubkey])
    expect(result1.encryptedContent).not.toBe(result2.encryptedContent)
  })

  it('handles multiple admin pubkeys', () => {
    const pubkey2 = 'c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'
    const result = encryptCallRecordForStorage(
      { answeredBy: 'pk1' },
      [validPubkey, pubkey2],
    )
    expect(result.adminEnvelopes.length).toBe(2)
  })
})
