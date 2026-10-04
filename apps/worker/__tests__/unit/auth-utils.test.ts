import { describe, it, expect } from 'vitest'
import { parseAuthHeader, parseSessionHeader, validateToken, verifyAuthToken, buildAuthMessage } from '@worker/lib/auth'
import { ed25519 } from '@noble/curves/ed25519.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { LABEL_DEVICE_AUTH, LABEL_DEVICE_AUTH_NO_NONCE } from '@shared/crypto-labels'

describe('parseAuthHeader', () => {
  it('returns null for null header', () => {
    expect(parseAuthHeader(null)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseAuthHeader('')).toBeNull()
  })

  it('returns null for non-Bearer header', () => {
    expect(parseAuthHeader('Basic dXNlcjpwYXNz')).toBeNull()
  })

  it('returns null for "Bearer " without payload', () => {
    expect(parseAuthHeader('Bearer ')).toBeNull()
  })

  it('returns null for invalid JSON after Bearer', () => {
    expect(parseAuthHeader('Bearer not-json')).toBeNull()
  })

  it('parses valid Bearer JSON payload', () => {
    const payload = { pubkey: 'abc', timestamp: 1234, token: 'def' }
    const result = parseAuthHeader(`Bearer ${JSON.stringify(payload)}`)
    expect(result).toEqual(payload)
  })

  it('preserves all fields in the payload', () => {
    const payload = {
      pubkey: '1234567890abcdef',
      timestamp: Date.now(),
      token: 'fedcba0987654321',
    }
    const result = parseAuthHeader(`Bearer ${JSON.stringify(payload)}`)
    expect(result?.pubkey).toBe(payload.pubkey)
    expect(result?.timestamp).toBe(payload.timestamp)
    expect(result?.token).toBe(payload.token)
  })
})

describe('parseSessionHeader', () => {
  it('returns null for null header', () => {
    expect(parseSessionHeader(null)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseSessionHeader('')).toBeNull()
  })

  it('returns null for non-Session header', () => {
    expect(parseSessionHeader('Bearer token')).toBeNull()
  })

  it('parses valid Session header', () => {
    expect(parseSessionHeader('Session abc123')).toBe('abc123')
  })

  it('trims whitespace from session token', () => {
    expect(parseSessionHeader('Session   abc123  ')).toBe('abc123')
  })
})

describe('validateToken', () => {
  it('returns false when pubkey is missing', () => {
    expect(validateToken({ pubkey: '', timestamp: Date.now(), token: 'abc' })).toBe(false)
  })

  it('returns false when timestamp is missing (0)', () => {
    expect(validateToken({ pubkey: 'abc', timestamp: 0, token: 'def' })).toBe(false)
  })

  it('returns false when token is missing', () => {
    expect(validateToken({ pubkey: 'abc', timestamp: Date.now(), token: '' })).toBe(false)
  })

  it('returns false when token is expired (> 5 minutes old)', () => {
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000 - 1
    expect(validateToken({
      pubkey: 'abc',
      timestamp: fiveMinutesAgo,
      token: 'def',
    })).toBe(false)
  })

  it('returns false when token timestamp is in the far future', () => {
    const sixMinutesAhead = Date.now() + 6 * 60 * 1000
    expect(validateToken({
      pubkey: 'abc',
      timestamp: sixMinutesAhead,
      token: 'def',
    })).toBe(false)
  })

  it('returns true for valid, fresh token', () => {
    expect(validateToken({
      pubkey: 'abc',
      timestamp: Date.now(),
      token: 'def',
    })).toBe(true)
  })

  it('returns true for token at the edge of 5-minute window', () => {
    const justUnder5Min = Date.now() - 4 * 60 * 1000
    expect(validateToken({
      pubkey: 'abc',
      timestamp: justUnder5Min,
      token: 'def',
    })).toBe(true)
  })

  it('allows slightly future timestamps within window', () => {
    const slightFuture = Date.now() + 60 * 1000 // 1 minute ahead
    expect(validateToken({
      pubkey: 'abc',
      timestamp: slightFuture,
      token: 'def',
    })).toBe(true)
  })
})

describe('buildAuthMessage', () => {
  const pubkey = 'aabbcc'
  const timestamp = 1700000000000
  const nonce = 'f'.repeat(32)

  it('produces the canonical nonce-bearing message', () => {
    const msg = buildAuthMessage(pubkey, timestamp, 'GET', '/api/calls', nonce)
    expect(new TextDecoder().decode(msg)).toBe(
      `${LABEL_DEVICE_AUTH}:${pubkey}:${timestamp}:GET:/api/calls:${nonce}`,
    )
  })

  it('switches domain-separation label for the nonce-less shape', () => {
    const msg = buildAuthMessage(pubkey, timestamp, 'GET', '/api/calls')
    expect(new TextDecoder().decode(msg)).toBe(
      `${LABEL_DEVICE_AUTH_NO_NONCE}:${pubkey}:${timestamp}:GET:/api/calls`,
    )
  })

  /**
   * One label covering two layouts is the hazard the nonce-less label exists to
   * close: a URL path may legally contain ':', so under a shared label these
   * two distinct requests would be the same signed bytes.
   */
  it('cannot collide the two shapes through a colon in the path', () => {
    const noncelessLongPath = buildAuthMessage(pubkey, timestamp, 'GET', `/api/calls:${nonce}`)
    const noncedShortPath = buildAuthMessage(pubkey, timestamp, 'GET', '/api/calls', nonce)
    expect(new TextDecoder().decode(noncelessLongPath)).not.toBe(
      new TextDecoder().decode(noncedShortPath),
    )
  })
})

describe('verifyAuthToken', () => {
  // Ed25519 test keypair — deterministic seed
  const seed = new Uint8Array(32).fill(0x42)
  const pubkeyBytes = ed25519.getPublicKey(seed)
  const pubkeyHex = bytesToHex(pubkeyBytes)

  // Header auth is the nonce-bearing domain, so these fixtures carry a nonce.
  const nonce = '1234567890abcdef1234567890abcdef'

  function createSignedToken(timestamp: number, method: string, path: string): string {
    const message = buildAuthMessage(pubkeyHex, timestamp, method, path, nonce)
    const sig = ed25519.sign(message, seed)
    return bytesToHex(sig)
  }

  function createNoncelessToken(timestamp: number, method: string, path: string): string {
    return bytesToHex(ed25519.sign(buildAuthMessage(pubkeyHex, timestamp, method, path), seed))
  }

  it('returns true for valid Ed25519 token bound to GET /api/notes', () => {
    const timestamp = Date.now()
    const token = createSignedToken(timestamp, 'GET', '/api/notes')
    expect(verifyAuthToken({ pubkey: pubkeyHex, timestamp, token, nonce }, 'GET', '/api/notes')).toBe(true)
  })

  it('returns false when method/path are omitted', () => {
    const timestamp = Date.now()
    const token = createSignedToken(timestamp, 'GET', '/api/notes')
    expect(verifyAuthToken({ pubkey: pubkeyHex, timestamp, token, nonce })).toBe(false)
  })

  it('returns false for expired token', () => {
    const timestamp = Date.now() - 6 * 60 * 1000
    const token = createSignedToken(timestamp, 'GET', '/api/notes')
    expect(verifyAuthToken({ pubkey: pubkeyHex, timestamp, token, nonce }, 'GET', '/api/notes')).toBe(false)
  })

  it('returns false for wrong pubkey', () => {
    const timestamp = Date.now()
    const token = createSignedToken(timestamp, 'GET', '/api/notes')
    const wrongPubkey = '00'.repeat(32)
    expect(verifyAuthToken({ pubkey: wrongPubkey, timestamp, token, nonce }, 'GET', '/api/notes')).toBe(false)
  })

  it('returns false for tampered token', () => {
    const timestamp = Date.now()
    const token = createSignedToken(timestamp, 'GET', '/api/notes')
    const lastByte = parseInt(token.slice(-2), 16)
    const tampered = token.slice(0, -2) + ((lastByte ^ 0xff).toString(16).padStart(2, '0'))
    expect(verifyAuthToken({ pubkey: pubkeyHex, timestamp, token: tampered, nonce }, 'GET', '/api/notes')).toBe(false)
  })

  it('returns false for missing pubkey', () => {
    expect(verifyAuthToken({ pubkey: '', timestamp: Date.now(), token: 'abc' }, 'GET', '/api/test')).toBe(false)
  })

  it('returns false when token is bound to different endpoint (cross-endpoint replay)', () => {
    const timestamp = Date.now()
    const token = createSignedToken(timestamp, 'POST', '/api/notes')
    expect(verifyAuthToken({ pubkey: pubkeyHex, timestamp, token, nonce }, 'GET', '/api/notes')).toBe(false)
  })

  it('rejects token signed by key A when presented with pubkey B', () => {
    const timestamp = Date.now()
    const tokenFromA = createSignedToken(timestamp, 'GET', '/api/notes')
    const seedB = new Uint8Array(32).fill(0x77)
    const pubkeyB = bytesToHex(ed25519.getPublicKey(seedB))
    expect(verifyAuthToken({ pubkey: pubkeyB, timestamp, token: tokenFromA, nonce }, 'GET', '/api/notes')).toBe(false)
  })

  it('returns false for completely invalid token hex', () => {
    expect(verifyAuthToken({
      pubkey: pubkeyHex,
      timestamp: Date.now(),
      token: 'not-hex',
      nonce,
    }, 'GET', '/api/test')).toBe(false)
  })

  // ── Nonce policy ────────────────────────────────────────────────
  //
  // #1389: a client that signs a nonce and then drops it in transit must fail
  // loudly. Two independent barriers make that so — the nonce-less shape is a
  // different label domain (so the signature cannot verify), and a nonce-less
  // token is refused outright on any route that has not opted in.

  it('rejects a nonce-bearing token whose nonce was dropped in transit', () => {
    const timestamp = Date.now()
    const token = createSignedToken(timestamp, 'POST', '/api/invites/redeem')
    expect(verifyAuthToken({ pubkey: pubkeyHex, timestamp, token }, 'POST', '/api/invites/redeem', { allowMissingNonce: true })).toBe(false)
  })

  it('rejects a nonce-less token on a route that has not opted in', () => {
    const timestamp = Date.now()
    const token = createNoncelessToken(timestamp, 'GET', '/api/notes')
    expect(verifyAuthToken({ pubkey: pubkeyHex, timestamp, token }, 'GET', '/api/notes')).toBe(false)
  })

  it('accepts a nonce-less token only where the route opts in', () => {
    const timestamp = Date.now()
    const token = createNoncelessToken(timestamp, 'POST', '/api/invites/redeem')
    expect(verifyAuthToken({ pubkey: pubkeyHex, timestamp, token }, 'POST', '/api/invites/redeem', { allowMissingNonce: true })).toBe(true)
  })

  it('does not let a nonce-less token reach a nonce-bearing route by opting in', () => {
    // Even with the flag set, the label differs, so the signature fails.
    const timestamp = Date.now()
    const token = createNoncelessToken(timestamp, 'GET', '/api/notes')
    const noncedMessageRoute = verifyAuthToken(
      { pubkey: pubkeyHex, timestamp, token, nonce },
      'GET', '/api/notes',
    )
    expect(noncedMessageRoute).toBe(false)
  })

  it('rejects a non-canonical nonce (a colon could shift the path boundary)', () => {
    const timestamp = Date.now()
    const evil = 'ab:defabcdefabcdefabcdefabcdefabc'
    const token = bytesToHex(ed25519.sign(buildAuthMessage(pubkeyHex, timestamp, 'GET', '/api/notes', evil), seed))
    expect(verifyAuthToken({ pubkey: pubkeyHex, timestamp, token, nonce: evil }, 'GET', '/api/notes')).toBe(false)
  })
})
