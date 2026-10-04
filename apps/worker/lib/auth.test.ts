/**
 * Unit tests for auth utilities.
 *
 * Tests parseAuthHeader, parseSessionHeader, validateToken, verifyAuthToken,
 * and authenticateRequest. The Schnorr/Ed25519 signature paths are exercised
 * using real keys from @noble/curves.
 */

import { describe, it, expect, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { utf8ToBytes } from '@noble/ciphers/utils.js'
import { buildAuthMessage } from '@shared/auth-message'

/** Fixed canonical nonce for deterministic Ed25519 fixtures. */
const ED25519_TEST_NONCE = 'abcdefabcdefabcdefabcdefabcdefab'

import {
  parseAuthHeader,
  parseSessionHeader,
  validateToken,
  verifyAuthToken,
  authenticateRequest,
} from './auth'
import type { AuthPayload } from '../types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSchnorrKeys() {
  const privKey = schnorr.utils.randomSecretKey()
  const pubKey = schnorr.getPublicKey(privKey)
  return { privKey, pubKey, pubkeyHex: bytesToHex(pubKey) }
}

function makeEd25519Keys() {
  const privKey = ed25519.utils.randomSecretKey()
  const pubKey = ed25519.getPublicKey(privKey)
  return { privKey, pubKey, pubkeyHex: bytesToHex(pubKey) }
}

async function makeSchnorrToken(
  privKey: Uint8Array,
  pubkeyHex: string,
  timestamp: number,
  method: string,
  path: string,
): Promise<string> {
  // Schnorr uses the legacy AUTH_PREFIX format with SHA-256 pre-hashing.
  // verifyAuthToken no longer accepts Schnorr — these tokens will be rejected.
  const boundMessage = `llamenos:auth:${pubkeyHex}:${timestamp}:${method}:${path}`
  const hash = sha256(utf8ToBytes(boundMessage))
  const sig = schnorr.sign(hash, privKey)
  return bytesToHex(sig)
}

async function makeEd25519Token(
  privKey: Uint8Array,
  pubkeyHex: string,
  timestamp: number,
  method: string,
  path: string,
): Promise<string> {
  // Built with the canonical shared builder (which mirrors build_auth_message()
  // in auth.rs) and signed directly — no pre-hashing, ed25519 applies SHA-512
  // internally. Header auth is the nonce-bearing domain.
  const message = buildAuthMessage(pubkeyHex, timestamp, method, path, ED25519_TEST_NONCE)
  const sig = ed25519.sign(message, privKey)
  return bytesToHex(sig)
}

// ---------------------------------------------------------------------------
// parseAuthHeader
// ---------------------------------------------------------------------------

describe('parseAuthHeader', () => {
  it('returns null for null input', () => {
    expect(parseAuthHeader(null)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseAuthHeader('')).toBeNull()
  })

  it('returns null when not Bearer prefix', () => {
    expect(parseAuthHeader('Session abc')).toBeNull()
    expect(parseAuthHeader('Basic abc')).toBeNull()
    expect(parseAuthHeader('bearer abc')).toBeNull() // case-sensitive
  })

  it('returns null when JSON is invalid', () => {
    expect(parseAuthHeader('Bearer not-json')).toBeNull()
    expect(parseAuthHeader('Bearer {broken')).toBeNull()
  })

  it('parses valid JSON AuthPayload', () => {
    const payload: AuthPayload = { pubkey: 'aabb', timestamp: 1000, token: 'ccdd' }
    const header = `Bearer ${JSON.stringify(payload)}`
    expect(parseAuthHeader(header)).toEqual(payload)
  })

  it('returns parsed object for any valid JSON (even non-AuthPayload shape)', () => {
    const header = 'Bearer {"x":1}'
    expect(parseAuthHeader(header)).toEqual({ x: 1 })
  })

  it('strips exactly "Bearer " prefix (7 chars)', () => {
    const raw = JSON.stringify({ pubkey: 'aa', timestamp: 1, token: 'bb' })
    expect(parseAuthHeader(`Bearer ${raw}`)).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// parseSessionHeader
// ---------------------------------------------------------------------------

describe('parseSessionHeader', () => {
  it('returns null for null', () => {
    expect(parseSessionHeader(null)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseSessionHeader('')).toBeNull()
  })

  it('returns null when prefix is not "Session "', () => {
    expect(parseSessionHeader('Bearer abc')).toBeNull()
    expect(parseSessionHeader('session abc')).toBeNull()
  })

  it('extracts token after "Session " prefix', () => {
    expect(parseSessionHeader('Session mytoken123')).toBe('mytoken123')
  })

  it('trims surrounding whitespace from the token', () => {
    expect(parseSessionHeader('Session   trimmed   ')).toBe('trimmed')
  })

  it('handles opaque token strings with hyphens, underscores, dots', () => {
    const token = 'abc-def_ghi.123' // gitleaks:allow
    expect(parseSessionHeader(`Session ${token}`)).toBe(token)
  })
})

// ---------------------------------------------------------------------------
// validateToken
// ---------------------------------------------------------------------------

describe('validateToken', () => {
  const base: AuthPayload = {
    pubkey: 'a'.repeat(64),
    timestamp: Date.now(),
    token: 'b'.repeat(128),
  }

  it('returns true for a fresh, well-formed token', () => {
    expect(validateToken(base)).toBe(true)
  })

  it('returns false when pubkey is missing', () => {
    expect(validateToken({ ...base, pubkey: '' })).toBe(false)
  })

  it('returns false when timestamp is 0', () => {
    expect(validateToken({ ...base, timestamp: 0 })).toBe(false)
  })

  it('returns false when token is empty', () => {
    expect(validateToken({ ...base, token: '' })).toBe(false)
  })

  it('returns false for a token older than 5 minutes', () => {
    const stale = Date.now() - 6 * 60 * 1000
    expect(validateToken({ ...base, timestamp: stale })).toBe(false)
  })

  it('returns false for a token with future timestamp beyond 5 minutes', () => {
    const future = Date.now() + 6 * 60 * 1000
    expect(validateToken({ ...base, timestamp: future })).toBe(false)
  })

  it('accepts a token exactly at the boundary (just under 5 min old)', () => {
    const almostStale = Date.now() - 4 * 60 * 1000
    expect(validateToken({ ...base, timestamp: almostStale })).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// verifyAuthToken — Schnorr
// ---------------------------------------------------------------------------

describe('verifyAuthToken (Schnorr)', () => {
  it('rejects Schnorr-signed tokens — Ed25519-only after auth purge', async () => {
    // Schnorr tokens used the old AUTH_PREFIX + SHA-256-hashed format.
    // verifyAuthToken now only accepts Ed25519 signatures over the LABEL_DEVICE_AUTH message.
    const { privKey, pubkeyHex } = makeSchnorrKeys()
    const ts = Date.now()
    const token = await makeSchnorrToken(privKey, pubkeyHex, ts, 'GET', '/api/me')
    const auth: AuthPayload = { pubkey: pubkeyHex, timestamp: ts, token, nonce: ED25519_TEST_NONCE }
    expect(await verifyAuthToken(auth, 'GET', '/api/me')).toBe(false)
  })

  it('rejects Schnorr token with wrong method', async () => {
    const { privKey, pubkeyHex } = makeSchnorrKeys()
    const ts = Date.now()
    const token = await makeSchnorrToken(privKey, pubkeyHex, ts, 'GET', '/api/me')
    const auth: AuthPayload = { pubkey: pubkeyHex, timestamp: ts, token, nonce: ED25519_TEST_NONCE }
    expect(await verifyAuthToken(auth, 'POST', '/api/me')).toBe(false)
  })

  it('rejects Schnorr token with wrong path', async () => {
    const { privKey, pubkeyHex } = makeSchnorrKeys()
    const ts = Date.now()
    const token = await makeSchnorrToken(privKey, pubkeyHex, ts, 'GET', '/api/me')
    const auth: AuthPayload = { pubkey: pubkeyHex, timestamp: ts, token, nonce: ED25519_TEST_NONCE }
    expect(await verifyAuthToken(auth, 'GET', '/api/other')).toBe(false)
  })

  it('rejects tampered token bytes', async () => {
    const { privKey, pubkeyHex } = makeSchnorrKeys()
    const ts = Date.now()
    const token = await makeSchnorrToken(privKey, pubkeyHex, ts, 'GET', '/api/me')
    const tampered = token.slice(0, -2) + '00'
    const auth: AuthPayload = { pubkey: pubkeyHex, timestamp: ts, token: tampered }
    expect(await verifyAuthToken(auth, 'GET', '/api/me')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// verifyAuthToken — Ed25519
// ---------------------------------------------------------------------------

describe('verifyAuthToken (Ed25519)', () => {
  it('verifies a valid Ed25519-signed token', async () => {
    const { privKey, pubkeyHex } = makeEd25519Keys()
    const ts = Date.now()
    const token = await makeEd25519Token(privKey, pubkeyHex, ts, 'POST', '/api/notes')
    const auth: AuthPayload = { pubkey: pubkeyHex, timestamp: ts, token, nonce: ED25519_TEST_NONCE }
    expect(await verifyAuthToken(auth, 'POST', '/api/notes')).toBe(true)
  })

  it('rejects Ed25519 token signed for a different path', async () => {
    const { privKey, pubkeyHex } = makeEd25519Keys()
    const ts = Date.now()
    const token = await makeEd25519Token(privKey, pubkeyHex, ts, 'POST', '/api/notes')
    const auth: AuthPayload = { pubkey: pubkeyHex, timestamp: ts, token, nonce: ED25519_TEST_NONCE }
    expect(await verifyAuthToken(auth, 'POST', '/api/other')).toBe(false)
  })

  it('rejects Ed25519 token with stale timestamp', async () => {
    const { privKey, pubkeyHex } = makeEd25519Keys()
    const staleTs = Date.now() - 10 * 60 * 1000
    const token = await makeEd25519Token(privKey, pubkeyHex, staleTs, 'GET', '/api/me')
    const auth: AuthPayload = { pubkey: pubkeyHex, timestamp: staleTs, token, nonce: ED25519_TEST_NONCE }
    expect(await verifyAuthToken(auth, 'GET', '/api/me')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// verifyAuthToken — missing method/path
// ---------------------------------------------------------------------------

describe('verifyAuthToken — missing binding parameters', () => {
  it('returns false when method is missing', async () => {
    const auth: AuthPayload = { pubkey: 'a'.repeat(64), timestamp: Date.now(), token: 'b'.repeat(128) }
    expect(await verifyAuthToken(auth, undefined, '/api/me')).toBe(false)
  })

  it('returns false when path is missing', async () => {
    const auth: AuthPayload = { pubkey: 'a'.repeat(64), timestamp: Date.now(), token: 'b'.repeat(128) }
    expect(await verifyAuthToken(auth, 'GET', undefined)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// authenticateRequest
// ---------------------------------------------------------------------------

describe('authenticateRequest', () => {
  const makeRequest = (headers: Record<string, string>) =>
    new Request('http://localhost/api/me', { headers })

  const makeIdentityService = (overrides?: {
    validateSession?: (token: string) => Promise<{ pubkey: string; newToken?: string }>
    getUserInternal?: (pubkey: string) => Promise<{ pubkey: string; active: boolean } | null>
    checkAndMarkAuthNonce?: (hash: string, pubkey: string, expiresAt: Date) => Promise<boolean>
  }) => ({
    validateSession: overrides?.validateSession ?? vi.fn(),
    getUserInternal: overrides?.getUserInternal ?? vi.fn(),
    // Default: nonce is fresh (first use). Tests for replay override this.
    checkAndMarkAuthNonce: overrides?.checkAndMarkAuthNonce ?? vi.fn().mockResolvedValue(true),
  })

  it('returns null when no Authorization header', async () => {
    const svc = makeIdentityService()
    const req = makeRequest({})
    expect(await authenticateRequest(req, svc as never)).toBeNull()
  })

  it('authenticates via session token when valid', async () => {
    const pubkey = 'a'.repeat(64)
    const svc = makeIdentityService({
      validateSession: vi.fn().mockResolvedValue({ pubkey }),
      getUserInternal: vi.fn().mockResolvedValue({ pubkey, active: true }),
    })
    const req = makeRequest({ Authorization: 'Session validtoken' })
    const result = await authenticateRequest(req, svc as never)
    expect(result).not.toBeNull()
    expect(result?.pubkey).toBe(pubkey)
  })

  it('returns null when session token validation fails', async () => {
    const svc = makeIdentityService({
      validateSession: vi.fn().mockRejectedValue(new Error('invalid')),
    })
    const req = makeRequest({ Authorization: 'Session badtoken' })
    expect(await authenticateRequest(req, svc as never)).toBeNull()
  })

  it('returns null when session user is inactive', async () => {
    const pubkey = 'a'.repeat(64)
    const svc = makeIdentityService({
      validateSession: vi.fn().mockResolvedValue({ pubkey }),
      getUserInternal: vi.fn().mockResolvedValue({ pubkey, active: false }),
    })
    const req = makeRequest({ Authorization: 'Session token' })
    expect(await authenticateRequest(req, svc as never)).toBeNull()
  })

  it('returns null when session user not found', async () => {
    const pubkey = 'a'.repeat(64)
    const svc = makeIdentityService({
      validateSession: vi.fn().mockResolvedValue({ pubkey }),
      getUserInternal: vi.fn().mockResolvedValue(null),
    })
    const req = makeRequest({ Authorization: 'Session token' })
    expect(await authenticateRequest(req, svc as never)).toBeNull()
  })

  it('authenticates via valid Ed25519 signature', async () => {
    const { privKey, pubkeyHex } = makeEd25519Keys()
    const ts = Date.now()
    const token = await makeEd25519Token(privKey, pubkeyHex, ts, 'GET', '/api/me')
    const payload: AuthPayload = { pubkey: pubkeyHex, timestamp: ts, token, nonce: ED25519_TEST_NONCE }
    const svc = makeIdentityService({
      getUserInternal: vi.fn().mockResolvedValue({ pubkey: pubkeyHex, active: true }),
    })
    const req = new Request('http://localhost/api/me', {
      headers: { Authorization: `Bearer ${JSON.stringify(payload)}` },
    })
    const result = await authenticateRequest(req, svc as never)
    expect(result?.pubkey).toBe(pubkeyHex)
  })

  it('returns null when Ed25519 user is inactive', async () => {
    const { privKey, pubkeyHex } = makeEd25519Keys()
    const ts = Date.now()
    const token = await makeEd25519Token(privKey, pubkeyHex, ts, 'GET', '/api/me')
    const payload: AuthPayload = { pubkey: pubkeyHex, timestamp: ts, token, nonce: ED25519_TEST_NONCE }
    const svc = makeIdentityService({
      getUserInternal: vi.fn().mockResolvedValue({ pubkey: pubkeyHex, active: false }),
    })
    const req = new Request('http://localhost/api/me', {
      headers: { Authorization: `Bearer ${JSON.stringify(payload)}` },
    })
    expect(await authenticateRequest(req, svc as never)).toBeNull()
  })

  it('returns null when Bearer payload is malformed JSON', async () => {
    const svc = makeIdentityService()
    const req = makeRequest({ Authorization: 'Bearer not-json' })
    expect(await authenticateRequest(req, svc as never)).toBeNull()
  })

  it('returns null when Ed25519 token is replayed (nonce already used)', async () => {
    const { privKey, pubkeyHex } = makeEd25519Keys()
    const ts = Date.now()
    const token = await makeEd25519Token(privKey, pubkeyHex, ts, 'GET', '/api/me')
    const payload: AuthPayload = { pubkey: pubkeyHex, timestamp: ts, token, nonce: ED25519_TEST_NONCE }
    const svc = makeIdentityService({
      // Simulate: nonce already in DB (replay)
      checkAndMarkAuthNonce: vi.fn().mockResolvedValue(false),
      getUserInternal: vi.fn().mockResolvedValue({ pubkey: pubkeyHex, active: true }),
    })
    const req = new Request('http://localhost/api/me', {
      headers: { Authorization: `Bearer ${JSON.stringify(payload)}` },
    })
    expect(await authenticateRequest(req, svc as never)).toBeNull()
  })

  it('calls checkAndMarkAuthNonce with SHA-256 hash of the token signature', async () => {
    const { privKey, pubkeyHex } = makeEd25519Keys()
    const ts = Date.now()
    const token = await makeEd25519Token(privKey, pubkeyHex, ts, 'GET', '/api/me')
    const payload: AuthPayload = { pubkey: pubkeyHex, timestamp: ts, token, nonce: ED25519_TEST_NONCE }
    const checkNonce = vi.fn().mockResolvedValue(true)
    const svc = makeIdentityService({
      checkAndMarkAuthNonce: checkNonce,
      getUserInternal: vi.fn().mockResolvedValue({ pubkey: pubkeyHex, active: true }),
    })
    const req = new Request('http://localhost/api/me', {
      headers: { Authorization: `Bearer ${JSON.stringify(payload)}` },
    })
    await authenticateRequest(req, svc as never)
    expect(checkNonce).toHaveBeenCalledOnce()
    const [nonceHash, calledPubkey] = checkNonce.mock.calls[0]
    expect(calledPubkey).toBe(pubkeyHex)
    // nonceHash is SHA-256 of the signature hex — just verify it's a 64-char hex string
    expect(nonceHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('propagates newSessionToken when session token is rotated', async () => {
    const pubkey = 'a'.repeat(64)
    const newToken = 'b'.repeat(64) // gitleaks:allow
    const svc = makeIdentityService({
      validateSession: vi.fn().mockResolvedValue({ pubkey, newToken }),
      getUserInternal: vi.fn().mockResolvedValue({ pubkey, active: true }),
    })
    const req = makeRequest({ Authorization: 'Session validtoken' })
    const result = await authenticateRequest(req, svc as never)
    expect(result?.newSessionToken).toBe(newToken)
  })

  it('does not set newSessionToken when session is valid without rotation', async () => {
    const pubkey = 'a'.repeat(64)
    const svc = makeIdentityService({
      validateSession: vi.fn().mockResolvedValue({ pubkey }),
      getUserInternal: vi.fn().mockResolvedValue({ pubkey, active: true }),
    })
    const req = makeRequest({ Authorization: 'Session validtoken' })
    const result = await authenticateRequest(req, svc as never)
    expect(result?.newSessionToken).toBeUndefined()
  })
})
