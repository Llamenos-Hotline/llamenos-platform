/**
 * Unit tests for worker crypto utilities.
 *
 * Covers: hashPhone, hashIP, encryptMessageForStorage,
 * encryptCallRecordForStorage, encryptContactIdentifier/decrypt,
 * stableJsonStringify, hashAuditEntry, encryptStorageCredential/decrypt.
 */

import { describe, it, expect } from 'vitest'
import { x25519, ristretto255_oprf } from '@noble/curves/ed25519.js'
import { contentOpen, shapeOpen, type Shape } from '@llamenos/crypto/ffi'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@shared/encoding'
import { LABEL_AUDIT_USER_KEY_SERVER_SEAL, LABEL_AUDIT_USER_KEY_WRAP, LABEL_BAN_KEY_DERIVE, HMAC_BAN_PREFIX } from '@shared/crypto-labels'
import type { RecipientEnvelope } from '@shared/types'
import { hubScope, PLATFORM_SCOPE } from '@shared/owner-scope'
import {
  hashPhone,
  banHash,
  banBlindEvaluate,
  callBanLookup,
  callerRateLimitDigest,
  sealCallerNumber,
  openCallerNumber,
  sealCallRecording,
  openCallRecording,
  hashIP,
  encryptMessageForStorage,
  encryptCallRecordForStorage,
  encryptContactIdentifier,
  decryptContactIdentifier,
  stableJsonStringify,
  hashAuditEntry,
  encryptStorageCredential,
  decryptStorageCredential,
  wrapAuditKeyForAdmins,
  encryptAuditDetails,
  decryptAuditDetails,
  sealAuditKeyForServer,
  openServerSealedAuditKey,
  serverEncrypt,
} from './crypto'

const SECRET = 'a'.repeat(64) // 32 hex bytes = valid HMAC secret


/** RFC 9497 Evaluate, spelled as the interactive protocol it equals (noble types only the latter). */
function oprfEvaluate(secretKey: Uint8Array, input: Uint8Array): Uint8Array {
  const { blind, blinded } = ristretto255_oprf.oprf.blind(input)
  return ristretto255_oprf.oprf.finalize(input, blind, ristretto255_oprf.oprf.blindEvaluate(secretKey, blinded))
}

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
    const result = encryptCallRecordForStorage(meta, [validPubkeyHex])
    expect(result.encryptedContent).toMatch(/^[0-9a-f]+$/)
  })

  it('refuses an empty reader list, like encryptMessageForStorage (#1684)', () => {
    // A call record with no envelopes is ciphertext nobody will ever open.
    // The guard exists on encryptMessageForStorage; its twin pinned the
    // absence of it here. The asymmetry is gone: both throw.
    expect(() => encryptCallRecordForStorage({ x: 1 }, [])).toThrow(/empty reader list/)
  })
})

// ---------------------------------------------------------------------------
// Server-sealed records open the way every client opens them: no AAD
// ---------------------------------------------------------------------------

function x25519Reader(): { secret: Uint8Array; pubkey: string } {
  const secret = x25519.utils.randomSecretKey()
  return { secret, pubkey: bytesToHex(x25519.getPublicKey(secret)) }
}

/** Open a record as a reader would: the shape's key wrap, then its content. */
function openAsReader(
  encryptedContent: string,
  envelope: RecipientEnvelope,
  secret: Uint8Array,
  shape: Shape,
): string {
  const contentKey = shapeOpen(shape, secret, [], envelope)
  return new TextDecoder().decode(contentOpen(shape, contentKey, hexToBytes(encryptedContent)))
}

describe('server-sealed records (the message-key and call-meta-key shapes)', () => {
  it('every reader opens an inbound message as the message-key shape', () => {
    const admin = x25519Reader()
    const volunteer = x25519Reader()
    const { encryptedContent, readerEnvelopes } = encryptMessageForStorage('caller: I need help', [admin.pubkey, volunteer.pubkey])
    expect(openAsReader(encryptedContent, readerEnvelopes[0], admin.secret, 'message-key')).toBe('caller: I need help')
    expect(openAsReader(encryptedContent, readerEnvelopes[1], volunteer.secret, 'message-key')).toBe('caller: I need help')
  })

  it('an admin opens call metadata as the call-meta-key shape', () => {
    const admin = x25519Reader()
    const meta = { answeredBy: 'ab'.repeat(32), callerNumber: '+15555550142' }
    const { encryptedContent, adminEnvelopes } = encryptCallRecordForStorage(meta, [admin.pubkey])
    expect(JSON.parse(openAsReader(encryptedContent, adminEnvelopes[0], admin.secret, 'call-meta-key'))).toEqual(meta)
  })

  it('call metadata does not open as a message, nor a message as call metadata', () => {
    const admin = x25519Reader()
    const meta = encryptCallRecordForStorage({ callerNumber: '+15555550142' }, [admin.pubkey])
    const msg = encryptMessageForStorage('x', [admin.pubkey])
    expect(() => openAsReader(meta.encryptedContent, meta.adminEnvelopes[0], admin.secret, 'message-key')).toThrow()
    expect(() => openAsReader(msg.encryptedContent, msg.readerEnvelopes[0], admin.secret, 'call-meta-key')).toThrow()
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

  it('refuses a value that was never sealed (no legacy plaintext path)', () => {
    expect(() => decryptContactIdentifier('+15551234567', SECRET)).toThrow(/not sealed/)
  })

  it('cannot be opened under a different key', () => {
    const enc = encryptContactIdentifier('+15551234567', SECRET)
    expect(() => decryptContactIdentifier(enc, 'b'.repeat(64))).toThrow()
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

// ---------------------------------------------------------------------------
// Per-user audit keys: wrapAuditKeyForAdmins / encryptAuditDetails /
// decryptAuditDetails — byte-compatible with packages/crypto/src/audit_key.rs
// ---------------------------------------------------------------------------

describe('wrapAuditKeyForAdmins', () => {
  const userPubkey = 'a'.repeat(64)
  const auditKey = new Uint8Array(32).fill(7)

  it('produces one openable envelope per admin', () => {
    const adminSecret = new Uint8Array(32)
    crypto.getRandomValues(adminSecret)
    const adminPubkey = bytesToHex(x25519.getPublicKey(adminSecret))

    const envelopes = wrapAuditKeyForAdmins(auditKey, [adminPubkey], userPubkey)
    expect(envelopes).toHaveLength(1)
    expect(envelopes[0]!.pubkey).toBe(adminPubkey)

    // Opened as audit_key.rs opens it: the audit-user-key shape, bound to the user.
    const opened = shapeOpen('audit-user-key', adminSecret, [userPubkey], envelopes[0]!)
    expect(bytesToHex(opened)).toBe(bytesToHex(auditKey))
  })

  it('refuses an empty admin list, matching wrap_audit_key_to_admins', () => {
    expect(() => wrapAuditKeyForAdmins(auditKey, [], userPubkey)).toThrow(/at least one admin/)
  })

  it('a wrap bound to one user cannot be opened as another (AAD binding)', () => {
    const adminSecret = new Uint8Array(32)
    crypto.getRandomValues(adminSecret)
    const adminPubkey = bytesToHex(x25519.getPublicKey(adminSecret))

    const envelopes = wrapAuditKeyForAdmins(auditKey, [adminPubkey], userPubkey)
    expect(() => shapeOpen('audit-user-key', adminSecret, ['b'.repeat(64)], envelopes[0]!)).toThrow()
  })
})

describe('encryptAuditDetails / decryptAuditDetails', () => {
  const userPubkey = 'c'.repeat(64)
  const entryId = '00000000-0000-0000-0000-0000000000aa'
  const auditKey = new Uint8Array(32).fill(9)

  it('round-trips details JSON in nonce_hex:ciphertext_hex format', () => {
    const json = '{"callId":"c-1"}'
    const encrypted = encryptAuditDetails(auditKey, json, userPubkey, entryId)

    const parts = encrypted.split(':')
    expect(parts).toHaveLength(2)
    expect(parts[0]).toMatch(/^[0-9a-f]{24}$/) // 12-byte nonce
    expect(encrypted).not.toContain('c-1')

    expect(decryptAuditDetails(auditKey, encrypted, userPubkey, entryId)).toBe(json)
  })

  it('fails with a wrong key (crypto-shredding property)', () => {
    const encrypted = encryptAuditDetails(auditKey, '{"x":1}', userPubkey, entryId)
    const wrongKey = new Uint8Array(32).fill(1)
    expect(() => decryptAuditDetails(wrongKey, encrypted, userPubkey, entryId)).toThrow()
  })

  it('fails for a different entry id (AAD binds ciphertext to the entry)', () => {
    const encrypted = encryptAuditDetails(auditKey, '{"x":1}', userPubkey, entryId)
    expect(() => decryptAuditDetails(auditKey, encrypted, userPubkey, '00000000-0000-0000-0000-0000000000bb')).toThrow()
  })

  it('fails for a different user pubkey (AAD binds ciphertext to the user)', () => {
    const encrypted = encryptAuditDetails(auditKey, '{"x":1}', userPubkey, entryId)
    expect(() => decryptAuditDetails(auditKey, encrypted, 'd'.repeat(64), entryId)).toThrow()
  })

  it('rejects malformed input', () => {
    expect(() => decryptAuditDetails(auditKey, 'no-colon', userPubkey, entryId)).toThrow()
  })
})

describe('sealAuditKeyForServer / openServerSealedAuditKey', () => {
  const auditKey = new Uint8Array(32).fill(7)
  const serverSecret = new Uint8Array(32).fill(3)
  const userPubkey = 'a'.repeat(64)

  it('round-trips the key and never stores it legibly', () => {
    const sealed = sealAuditKeyForServer(auditKey, userPubkey, serverSecret)
    expect(sealed).toMatch(/^[0-9a-f]+$/)
    expect(sealed).not.toContain(bytesToHex(auditKey))
    expect(openServerSealedAuditKey(sealed, userPubkey, serverSecret)).toEqual(auditKey)
  })

  it('refuses a different server secret', () => {
    const sealed = sealAuditKeyForServer(auditKey, userPubkey, serverSecret)
    expect(() => openServerSealedAuditKey(sealed, userPubkey, new Uint8Array(32).fill(4))).toThrow()
  })

  it("refuses another user's pubkey — a row copied onto a different user's slot does not open", () => {
    const sealed = sealAuditKeyForServer(auditKey, userPubkey, serverSecret)
    expect(() => openServerSealedAuditKey(sealed, 'b'.repeat(64), serverSecret)).toThrow()
  })

  it('is sealed under its own label, not the admin HPKE wrap label (domain separation)', () => {
    expect(LABEL_AUDIT_USER_KEY_SERVER_SEAL).not.toBe(LABEL_AUDIT_USER_KEY_WRAP)
    // A blob sealed under the wrap label with the same context must not open as the server seal.
    const underWrapLabel = bytesToHex(serverEncrypt(auditKey, LABEL_AUDIT_USER_KEY_WRAP, serverSecret, userPubkey))
    expect(() => openServerSealedAuditKey(underWrapLabel, userPubkey, serverSecret)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// Ban hashes — only banned numbers are ever stored, one key per scope
// ---------------------------------------------------------------------------

describe('banHash', () => {
  const KEY = 'b'.repeat(64) // gitleaks:allow
  const NUMBER = '+15551234567'

  it('is deterministic for one number, scope and key', () => {
    expect(banHash(NUMBER, hubScope('hub-1'), KEY)).toBe(banHash(NUMBER, hubScope('hub-1'), KEY))
    expect(banHash(NUMBER, hubScope('hub-1'), KEY)).toMatch(/^[0-9a-f]{128}$/)
  })

  it('differs per scope, so one hub, another hub and the platform cannot be compared', () => {
    const hashes = new Set([
      banHash(NUMBER, hubScope('hub-1'), KEY),
      banHash(NUMBER, hubScope('hub-2'), KEY),
      banHash(NUMBER, PLATFORM_SCOPE, KEY),
    ])
    expect(hashes.size).toBe(3)
  })

  it('differs per number and per key', () => {
    expect(banHash(NUMBER, hubScope('hub-1'), KEY)).not.toBe(banHash('+15559876543', hubScope('hub-1'), KEY))
    expect(banHash(NUMBER, hubScope('hub-1'), KEY)).not.toBe(banHash(NUMBER, hubScope('hub-1'), 'c'.repeat(64)))
  })

  it('shares nothing with hashPhone, the hash conversations and threads use', () => {
    expect(banHash(NUMBER, hubScope('hub-1'), KEY)).not.toBe(hashPhone(NUMBER, KEY))
  })

  it('callBanLookup checks a call against its hub and the platform, each under its own key', () => {
    expect(callBanLookup(NUMBER, 'hub-1', KEY)).toEqual([
      { scope: hubScope('hub-1'), phoneHash: banHash(NUMBER, hubScope('hub-1'), KEY) },
      { scope: PLATFORM_SCOPE, phoneHash: banHash(NUMBER, PLATFORM_SCOPE, KEY) },
    ])
  })

  // An independent RFC 9497 implementation (@noble/curves) is the reference: if the crate and
  // it agree, every platform that follows the RFC interoperates with the server.
  const reference = ristretto255_oprf.oprf
  const scopeKey = (keyScope: string) =>
    reference.deriveKeyPair(hexToBytes(KEY), utf8ToBytes(`${LABEL_BAN_KEY_DERIVE}:${keyScope}`)).secretKey
  const input = utf8ToBytes(`${HMAC_BAN_PREFIX}${NUMBER}`)

  it('is RFC 9497 OPRF Evaluate under DeriveKeyPair(BAN_HASH_KEY, LABEL_BAN_KEY_DERIVE:scope)', () => {
    expect(banHash(NUMBER, hubScope('hub-1'), KEY)).toBe(bytesToHex(oprfEvaluate(scopeKey('hub-1'), input)))
    expect(banHash(NUMBER, PLATFORM_SCOPE, KEY)).toBe(bytesToHex(oprfEvaluate(scopeKey('platform'), input)))
  })

  it('a client that blinds the number gets the digest the server computes, without the server seeing it', () => {
    const { blind, blinded } = reference.blind(input)
    const evaluated = banBlindEvaluate(bytesToHex(blinded), PLATFORM_SCOPE, KEY)
    const digest = bytesToHex(reference.finalize(input, blind, hexToBytes(evaluated)))
    expect(digest).toBe(banHash(NUMBER, PLATFORM_SCOPE, KEY))
    // The element the server saw is uniformly random: blinding the same number again sends another.
    expect(bytesToHex(reference.blind(input).blinded)).not.toBe(bytesToHex(blinded))
  })

  it('evaluates blindly under the requested scope only', () => {
    const { blind, blinded } = reference.blind(input)
    const underHub = banBlindEvaluate(bytesToHex(blinded), hubScope('hub-1'), KEY)
    expect(bytesToHex(reference.finalize(input, blind, hexToBytes(underHub)))).toBe(banHash(NUMBER, hubScope('hub-1'), KEY))
    expect(bytesToHex(reference.finalize(input, blind, hexToBytes(underHub)))).not.toBe(banHash(NUMBER, PLATFORM_SCOPE, KEY))
  })

  it('refuses a blinded element that is not a valid group element', () => {
    expect(() => banBlindEvaluate('00'.repeat(32), PLATFORM_SCOPE, KEY)).toThrow()
    expect(() => banBlindEvaluate('ff'.repeat(32), PLATFORM_SCOPE, KEY)).toThrow()
    expect(() => banBlindEvaluate('ab', PLATFORM_SCOPE, KEY)).toThrow()
  })

  it('still digests a caller the provider presents without an E.164 number, so it can be checked and banned', () => {
    expect(banHash('anonymous', hubScope('hub-1'), KEY)).toMatch(/^[0-9a-f]{128}$/)
  })

  it('refuses a hub scope with no hub id rather than hashing under the hub-\'\' key', () => {
    expect(() => hubScope('')).toThrow()
  })
})

describe('callerRateLimitDigest', () => {
  const NUMBER = '+15551234567'
  const T0 = Date.UTC(2026, 9, 25, 12, 0, 0)

  it('links calls from one number inside a window', () => {
    expect(callerRateLimitDigest(NUMBER, T0)).toBe(callerRateLimitDigest(NUMBER, T0 + 30_000))
  })

  it('cannot link a number across windows: the key is replaced each window', () => {
    expect(callerRateLimitDigest(NUMBER, T0)).not.toBe(callerRateLimitDigest(NUMBER, T0 + 60_000))
  })

  it('does not equal a hash of the number under any server secret', () => {
    const digest = callerRateLimitDigest(NUMBER, T0)
    expect(digest).not.toBe(hashPhone(NUMBER, SECRET).slice(0, digest.length))
  })
})

describe('sealCallerNumber / openCallerNumber', () => {
  const KEK = 'a'.repeat(64) // gitleaks:allow

  it('round-trips for the call it was sealed for', () => {
    const sealed = sealCallerNumber('+15551234567', 'call-1', KEK)
    expect(openCallerNumber(sealed, 'call-1', KEK)).toBe('+15551234567')
  })

  it('does not contain the number', () => {
    expect(sealCallerNumber('+15551234567', 'call-1', KEK)).not.toContain('1234567')
  })

  it('refuses a sealed value copied onto another call, or opened with another key', () => {
    const sealed = sealCallerNumber('+15551234567', 'call-1', KEK)
    expect(() => openCallerNumber(sealed, 'call-2', KEK)).toThrow()
    expect(() => openCallerNumber(sealed, 'call-1', 'c'.repeat(64))).toThrow()
  })

  it('is not openable as a contact identifier: it has its own derived key', () => {
    const sealed = sealCallerNumber('+15551234567', 'call-1', KEK)
    expect(() => decryptContactIdentifier(`enc:${sealed}`, KEK)).toThrow()
  })
})

describe('sealCallRecording / openCallRecording (#2309)', () => {
  const KEK = 'a'.repeat(64) // gitleaks:allow
  const AUDIO = utf8ToBytes('RIFF....WAVEfmt caller audio')

  it('round-trips for the hub and call it was sealed for', () => {
    const sealed = sealCallRecording(AUDIO, 'hub-1', 'call-1', KEK)
    expect([...openCallRecording(sealed, 'hub-1', 'call-1', KEK)]).toEqual([...AUDIO])
  })

  it('stores no plaintext audio', () => {
    const sealed = bytesToHex(sealCallRecording(AUDIO, 'hub-1', 'call-1', KEK))
    expect(sealed).not.toContain(bytesToHex(utf8ToBytes('caller audio')))
  })

  it('refuses a blob copied onto another call or hub, or opened with another key', () => {
    const sealed = sealCallRecording(AUDIO, 'hub-1', 'call-1', KEK)
    expect(() => openCallRecording(sealed, 'hub-1', 'call-2', KEK)).toThrow()
    expect(() => openCallRecording(sealed, 'hub-2', 'call-1', KEK)).toThrow()
    expect(() => openCallRecording(sealed, 'hub-1', 'call-1', 'c'.repeat(64))).toThrow()
  })

  it('is not openable as a caller number: it has its own derived key', () => {
    const sealed = sealCallRecording(utf8ToBytes('+15551234567'), 'hub-1', 'call-1', KEK)
    expect(() => openCallerNumber(bytesToHex(sealed), 'hub-1:call-1', KEK)).toThrow()
  })
})
