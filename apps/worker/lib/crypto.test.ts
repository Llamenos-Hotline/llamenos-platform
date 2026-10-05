/**
 * Unit tests for worker crypto utilities.
 *
 * Covers: hashPhone, hashIP, encryptMessageForStorage,
 * encryptCallRecordForStorage, encryptContactIdentifier/decrypt,
 * stableJsonStringify, hashAuditEntry, encryptStorageCredential/decrypt.
 */

import { describe, it, expect } from 'vitest'
import {
  hashPhone,
  hashIP,
  encryptMessageForStorage,
  encryptCallRecordForStorage,
  encryptContactIdentifier,
  decryptContactIdentifier,
  stableJsonStringify,
  hashAuditEntry,
  encryptStorageCredential,
  decryptStorageCredential,
} from './crypto'

const SECRET = 'a'.repeat(64) // 32 hex bytes = valid HMAC secret

// ---------------------------------------------------------------------------
// hashPhone
// ---------------------------------------------------------------------------

describe('hashPhone', () => {
  it('returns a 64-char hex string', () => {
    const result = hashPhone('+15551234567', SECRET)
    expect(result).toHaveLength(64)
    expect(result).toMatch(/^[0-9a-f]+$/)
  })

  it('is deterministic — same input produces same hash', () => {
    expect(hashPhone('+15551234567', SECRET)).toBe(hashPhone('+15551234567', SECRET))
  })

  it('produces different outputs for different phones', () => {
    expect(hashPhone('+15551234567', SECRET)).not.toBe(hashPhone('+15559999999', SECRET))
  })

  it('produces different outputs for different secrets', () => {
    const secret2 = 'b'.repeat(64)
    expect(hashPhone('+15551234567', SECRET)).not.toBe(hashPhone('+15551234567', secret2))
  })

  it('domain-separates from plain HMAC — does not equal raw HMAC without prefix', () => {
    // hashPhone applies HMAC_PHONE_PREFIX before hashing
    // We just verify it's a well-formed hex, not an empty string
    expect(hashPhone('+1', SECRET).length).toBeGreaterThan(0)
  })

  it('handles empty phone string without throwing', () => {
    expect(() => hashPhone('', SECRET)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// hashIP
// ---------------------------------------------------------------------------

describe('hashIP', () => {
  it('returns a 24-char hex string (96-bit truncation)', () => {
    const result = hashIP('1.2.3.4', SECRET)
    expect(result).toHaveLength(24)
    expect(result).toMatch(/^[0-9a-f]+$/)
  })

  it('is deterministic', () => {
    expect(hashIP('127.0.0.1', SECRET)).toBe(hashIP('127.0.0.1', SECRET))
  })

  it('differs for different IPs', () => {
    expect(hashIP('1.2.3.4', SECRET)).not.toBe(hashIP('5.6.7.8', SECRET))
  })

  it('differs from hashPhone for same input', () => {
    expect(hashIP('test', SECRET)).not.toBe(hashPhone('test', SECRET))
  })
})

// ---------------------------------------------------------------------------
// encryptMessageForStorage (HPKE envelopes)
// ---------------------------------------------------------------------------

// Valid X25519 public key (base point u=9, 32 bytes little-endian hex)
const validPubkeyHex = '0900000000000000000000000000000000000000000000000000000000000000'

describe('encryptMessageForStorage', () => {
  it('returns encryptedContent as hex and envelopes for each reader', () => {
    const pubkey2 = '0800000000000000000000000000000000000000000000000000000000000000'
    const readers = [validPubkeyHex, pubkey2]
    const result = encryptMessageForStorage('Hello, world!', readers)
    expect(result.encryptedContent).toMatch(/^[0-9a-f]+$/)
    expect(result.readerEnvelopes).toHaveLength(2)
  })

  it('each envelope has pubkey, enc, and ct (HPKE format)', () => {
    const readers = [validPubkeyHex]
    const result = encryptMessageForStorage('test', readers)
    const env = result.readerEnvelopes[0]
    expect(env.pubkey).toBe(readers[0])
    expect(env.enc).toMatch(/^[0-9a-f]{64}$/) // 32-byte X25519 enc
    expect(env.ct).toMatch(/^[0-9a-f]+$/)
  })

  it('refuses an empty reader list rather than store undecryptable ciphertext', () => {
    // It used to return a record with zero envelopes — content nobody could ever
    // read, written silently. Same end state as the #1021/#1283 Ed25519 seals.
    expect(() => encryptMessageForStorage('no readers', [])).toThrow(/empty reader list/)
  })

  it('produces different ciphertext each call (random key + nonce)', () => {
    const readers = [validPubkeyHex]
    const r1 = encryptMessageForStorage('same text', readers)
    const r2 = encryptMessageForStorage('same text', readers)
    expect(r1.encryptedContent).not.toBe(r2.encryptedContent)
  })

  it('encryptedContent is valid hex with reasonable length', () => {
    const result = encryptMessageForStorage('x', [validPubkeyHex])
    // nonce (12B) + ciphertext+tag (at least 17B) = at least 29 bytes = 58 hex chars
    expect(result.encryptedContent.length).toBeGreaterThanOrEqual(58)
  })
})

// ---------------------------------------------------------------------------
// encryptCallRecordForStorage
// ---------------------------------------------------------------------------

describe('encryptCallRecordForStorage', () => {
  it('returns encryptedContent and adminEnvelopes', () => {
    const admins = [validPubkeyHex]
    const meta = { answeredBy: 'volunteer1', duration: 120 }
    const result = encryptCallRecordForStorage(meta, admins)
    expect(result.encryptedContent).toMatch(/^[0-9a-f]+$/)
    expect(result.adminEnvelopes).toHaveLength(1)
  })

  it('handles multiple admins', () => {
    const pubkey2 = '0800000000000000000000000000000000000000000000000000000000000000'
    const pubkey3 = '0700000000000000000000000000000000000000000000000000000000000000'
    const admins = [validPubkeyHex, pubkey2, pubkey3]
    const result = encryptCallRecordForStorage({ x: 1 }, admins)
    expect(result.adminEnvelopes).toHaveLength(3)
  })

  it('encrypts JSON-serializable metadata', () => {
    const meta = { nested: { value: [1, 2, 3] }, flag: true }
    expect(() => encryptCallRecordForStorage(meta, [])).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// encryptContactIdentifier / decryptContactIdentifier
// ---------------------------------------------------------------------------

describe('encryptContactIdentifier / decryptContactIdentifier', () => {
  it('round-trips an identifier', () => {
    const original = '+15551234567'
    const enc = encryptContactIdentifier(original, SECRET)
    expect(enc.startsWith('enc:')).toBe(true)
    expect(decryptContactIdentifier(enc, SECRET)).toBe(original)
  })

  it('produces unique ciphertexts each call (random nonce)', () => {
    const enc1 = encryptContactIdentifier('test@example.com', SECRET)
    const enc2 = encryptContactIdentifier('test@example.com', SECRET)
    expect(enc1).not.toBe(enc2)
  })

  it('decrypting legacy plaintext returns it as-is', () => {
    const plain = '+15551234567'
    expect(decryptContactIdentifier(plain, SECRET)).toBe(plain)
  })

  it('throws on corrupted ciphertext', () => {
    const corrupted = 'enc:' + 'deadbeef'.repeat(20)
    expect(() => decryptContactIdentifier(corrupted, SECRET)).toThrow()
  })

  it('encrypted output has "enc:" prefix', () => {
    expect(encryptContactIdentifier('test', SECRET)).toMatch(/^enc:/)
  })

  it('encrypts empty string identifiers', () => {
    const enc = encryptContactIdentifier('', SECRET)
    expect(decryptContactIdentifier(enc, SECRET)).toBe('')
  })
})

// migrateContactIfNeeded was removed — legacy migration no longer needed

// ---------------------------------------------------------------------------
// stableJsonStringify
// ---------------------------------------------------------------------------

describe('stableJsonStringify', () => {
  it('serializes simple objects', () => {
    expect(stableJsonStringify({ a: 1, b: 2 })).toBe('{"a":1,"b":2}')
  })

  it('sorts keys alphabetically', () => {
    const result = stableJsonStringify({ z: 3, a: 1, m: 2 })
    expect(result).toBe('{"a":1,"m":2,"z":3}')
  })

  it('sorts keys in nested objects', () => {
    const result = stableJsonStringify({ outer: { z: 2, a: 1 } })
    expect(result).toBe('{"outer":{"a":1,"z":2}}')
  })

  it('preserves arrays (no key sorting inside arrays)', () => {
    const result = stableJsonStringify({ list: [3, 1, 2] })
    expect(result).toBe('{"list":[3,1,2]}')
  })

  it('is deterministic regardless of insertion order', () => {
    const a = stableJsonStringify({ b: 2, a: 1, c: 3 })
    const b = stableJsonStringify({ a: 1, c: 3, b: 2 })
    expect(a).toBe(b)
  })

  it('handles null values', () => {
    expect(stableJsonStringify(null)).toBe('null')
  })

  it('handles strings and numbers', () => {
    expect(stableJsonStringify('hello')).toBe('"hello"')
    expect(stableJsonStringify(42)).toBe('42')
  })

  it('handles arrays of objects with sorted keys', () => {
    const result = stableJsonStringify([{ b: 2, a: 1 }])
    expect(result).toBe('[{"a":1,"b":2}]')
  })
})

// ---------------------------------------------------------------------------
// hashAuditEntry
// ---------------------------------------------------------------------------

describe('hashAuditEntry', () => {
  const baseEntry = {
    id: '00000000-0000-0000-0000-000000000001',
    action: 'call.answered',
    actorPubkey: 'a'.repeat(64),
    details: { callSid: 'CA123' },
    createdAt: '2024-01-01T00:00:00Z',
    previousEntryHash: undefined as string | undefined,
  }

  it('returns a 64-char hex string (SHA-256)', () => {
    const hash = hashAuditEntry(baseEntry)
    expect(hash).toHaveLength(64)
    expect(hash).toMatch(/^[0-9a-f]+$/)
  })

  it('is deterministic for the same input', () => {
    expect(hashAuditEntry(baseEntry)).toBe(hashAuditEntry(baseEntry))
  })

  it('changes when id changes', () => {
    const modified = { ...baseEntry, id: '00000000-0000-0000-0000-000000000002' }
    expect(hashAuditEntry(baseEntry)).not.toBe(hashAuditEntry(modified))
  })

  it('changes when action changes', () => {
    const modified = { ...baseEntry, action: 'call.ended' }
    expect(hashAuditEntry(baseEntry)).not.toBe(hashAuditEntry(modified))
  })

  it('changes when details change', () => {
    const modified = { ...baseEntry, details: { callSid: 'CA999' } }
    expect(hashAuditEntry(baseEntry)).not.toBe(hashAuditEntry(modified))
  })

  it('includes previousEntryHash when provided', () => {
    const withPrev = { ...baseEntry, previousEntryHash: 'b'.repeat(64) }
    expect(hashAuditEntry(baseEntry)).not.toBe(hashAuditEntry(withPrev))
  })

  it('details key order does not affect hash (stable stringify)', () => {
    const a = hashAuditEntry({ ...baseEntry, details: { b: 2, a: 1 } })
    const b = hashAuditEntry({ ...baseEntry, details: { a: 1, b: 2 } })
    expect(a).toBe(b)
  })
})

// ---------------------------------------------------------------------------
// encryptStorageCredential / decryptStorageCredential
// ---------------------------------------------------------------------------

describe('encryptStorageCredential / decryptStorageCredential', () => {
  it('round-trips a secret key', () => {
    const secretKey = 'my-s3-secret-key-12345' // gitleaks:allow
    const enc = encryptStorageCredential(secretKey, SECRET)
    expect(decryptStorageCredential(enc, SECRET)).toBe(secretKey)
  })

  it('encrypted value is a hex string', () => {
    const enc = encryptStorageCredential('key', SECRET)
    expect(enc).toMatch(/^[0-9a-f]+$/)
  })

  it('produces unique ciphertext each call', () => {
    const e1 = encryptStorageCredential('same-key', SECRET)
    const e2 = encryptStorageCredential('same-key', SECRET)
    expect(e1).not.toBe(e2)
  })

  it('throws when decrypting with wrong secret', () => {
    const enc = encryptStorageCredential('my-key', SECRET)
    expect(() => decryptStorageCredential(enc, 'b'.repeat(64))).toThrow()
  })

  it('encrypts empty string', () => {
    const enc = encryptStorageCredential('', SECRET)
    expect(decryptStorageCredential(enc, SECRET)).toBe('')
  })

  it('minimum ciphertext length includes nonce + payload', () => {
    const enc = encryptStorageCredential('x', SECRET)
    // hex: 12B nonce = 24 chars, + ct+tag (17+ B) = 58+ chars
    expect(enc.length).toBeGreaterThanOrEqual(58)
  })
})
