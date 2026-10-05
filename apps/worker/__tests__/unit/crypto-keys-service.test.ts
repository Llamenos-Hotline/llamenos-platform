import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  CryptoKeysService,
  CryptoKeyError,
  computeEntryHash,
  assertCanonicalSigchainPayload,
  chainHashesEqual,
} from '../../services/crypto-keys'
import { sha256 } from '@noble/hashes/sha2.js'

// Mock ed25519Verify for sigchain signature validation
const mockEd25519Verify = vi.fn().mockReturnValue(true)
vi.mock('@llamenos/crypto/ffi', () => ({
  ed25519Verify: (...args: unknown[]) => mockEd25519Verify(...args),
}))

const mockHexToBytes = vi.fn().mockImplementation((hex: string) =>
  new Uint8Array(hex.match(/.{2}/g)?.map(b => parseInt(b, 16)) ?? [])
)
vi.mock('@shared/encoding', () => ({
  hexToBytes: (...args: unknown[]) => mockHexToBytes(...args),
  bytesToHex: (bytes: Uint8Array) => {
    const HEX = '0123456789abcdef'
    let hex = ''
    for (let i = 0; i < bytes.length; i++) {
      hex += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0x0f]
    }
    return hex
  },
}))

// ---------------------------------------------------------------------------
// Transaction mock — appendSigchainLink now runs inside this.db.transaction()
// so it can hold a transaction-scoped advisory lock across the head-read +
// insert (#1146). Mirrors the txProxy pattern in audit-service.test.ts.
// ---------------------------------------------------------------------------

function withTx<T extends { select?: unknown; insert?: unknown }>(db: T) {
  const txProxy = { select: db.select, insert: db.insert, execute: vi.fn().mockResolvedValue(undefined) }
  return {
    ...db,
    transaction: vi.fn().mockImplementation(async (fn: (tx: typeof txProxy) => unknown) => fn(txProxy)),
  }
}

// ---------------------------------------------------------------------------
// Canonical hash helper — mirrors the service's computeEntryHash exactly
// ---------------------------------------------------------------------------

function canonicalizeJson(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map(canonicalizeJson)
  if (typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalizeJson((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}

function computeTestHash(
  seq: number,
  prevHash: string | null,
  timestamp: string,
  signerDeviceId: string,
  signerPubkey: string,
  payload: unknown,
): string {
  const canonical = canonicalizeJson({
    payload,
    prevHash,
    seq,
    signerDeviceId,
    signerPubkey,
    timestamp,
  })
  const bytes = sha256(new TextEncoder().encode(JSON.stringify(canonical)))
  const HEX = '0123456789abcdef'
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0x0f]
  }
  return hex
}

// ---------------------------------------------------------------------------
// DB mock helpers
// ---------------------------------------------------------------------------

interface MockLink {
  id: string
  userPubkey: string
  seqNo: number
  linkType: string
  payload: unknown
  signature: string
  prevHash: string
  hash: string
  signerDeviceId: string
  signerPubkey: string
  linkTimestamp: string
  createdAt: Date
}


function makeLink(overrides: Partial<MockLink> & { seqNo: number; hash: string }): MockLink {
  return {
    id: `link-${overrides.seqNo}`,
    userPubkey: 'user-pk1',
    linkType: 'add_device',
    payload: { devicePubkey: 'dev-pk' },
    signature: 'sig-hex',
    prevHash: '',
    signerDeviceId: 'dev-1',
    signerPubkey: 'aa'.repeat(32),
    linkTimestamp: '2026-01-01T00:00:00Z',
    createdAt: new Date('2026-01-01'),
    ...overrides,
  }
}

// Shorthand for creating a link body with valid hash
const SIGNER_DEVICE_ID = 'dev-1'
const SIGNER_PUBKEY = 'aa'.repeat(32)
const TIMESTAMP = '2026-01-01T00:00:00Z'

function makeLinkBody(overrides: {
  seqNo: number
  linkType: string
  payload: unknown
  prevHash: string | null
  signature?: string
  signerDeviceId?: string
  signerPubkey?: string
  timestamp?: string
}) {
  const signerDeviceId = overrides.signerDeviceId ?? SIGNER_DEVICE_ID
  const signerPubkey = overrides.signerPubkey ?? SIGNER_PUBKEY
  const timestamp = overrides.timestamp ?? TIMESTAMP
  const prevHashForHash = overrides.prevHash === '' ? null : overrides.prevHash
  const hash = computeTestHash(
    overrides.seqNo,
    prevHashForHash,
    timestamp,
    signerDeviceId,
    signerPubkey,
    overrides.payload,
  )
  return {
    seqNo: overrides.seqNo,
    linkType: overrides.linkType,
    payload: overrides.payload,
    signature: overrides.signature ?? 'aa'.repeat(64),
    prevHash: overrides.prevHash,
    hash,
    signerDeviceId,
    signerPubkey,
    timestamp,
  }
}

// ---------------------------------------------------------------------------
// Sigchain tests
// ---------------------------------------------------------------------------

describe('CryptoKeysService — Sigchain', () => {
  beforeEach(() => {
    mockEd25519Verify.mockReset().mockReturnValue(true)
    mockHexToBytes.mockReset().mockImplementation((hex: string) =>
      new Uint8Array(hex.match(/.{2}/g)?.map(b => parseInt(b, 16)) ?? [])
    )
  })

  describe('getSigchain', () => {
    it('returns empty array for user with no sigchain', async () => {
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }
      const svc = new CryptoKeysService(db as never)
      const result = await svc.getSigchain('user-pk1')
      expect(result).toEqual([])
    })

    it('returns links ordered by seqNo ascending, genesis prevHash normalized to null', async () => {
      const links = [
        makeLink({ seqNo: 1, hash: 'h1', prevHash: '' }),
        makeLink({ seqNo: 2, hash: 'h2', prevHash: 'h1' }),
        makeLink({ seqNo: 3, hash: 'h3', prevHash: 'h2' }),
      ]

      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue(links),
            }),
          }),
        }),
      }

      const svc = new CryptoKeysService(db as never)
      const result = await svc.getSigchain('user-pk1')

      expect(result).toHaveLength(3)
      expect(result[0].seqNo).toBe(1)
      expect(result[1].seqNo).toBe(2)
      expect(result[2].seqNo).toBe(3)
      // Genesis prevHash is stored as '' (NOT NULL column) but the wire
      // contract is JSON null (crate verify_sigchain requires prevHash=null
      // on the first link).
      expect(result[0].prevHash).toBeNull()
      expect(result[1].prevHash).toBe('h1')
      expect(typeof result[0].createdAt).toBe('string')
    })
  })

  describe('appendSigchainLink', () => {
    it('appends genesis link (seqNo=1, prevHash=null)', async () => {
      const body = makeLinkBody({
        seqNo: 1,
        linkType: 'genesis',
        payload: { type: 'user_init', deviceId: 'dev-1' },
        prevHash: null,
      })

      // The DB column is NOT NULL — the service persists genesis prevHash as ''
      // and returns it normalized to null.
      const insertedRow = makeLink({
        seqNo: 1,
        hash: body.hash,
        prevHash: '',
      })

      const db = {
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
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([insertedRow]),
          }),
        }),
      }

      const svc = new CryptoKeysService(withTx(db) as never)
      const result = await svc.appendSigchainLink('user-pk1', body)

      expect(result.seqNo).toBe(1)
      expect(result.hash).toBe(body.hash)
      expect(result.prevHash).toBeNull()
      expect(db.insert).toHaveBeenCalled()
    })

    it('accepts legacy genesis prevHash="" as an alias for null', async () => {
      const body = makeLinkBody({
        seqNo: 1,
        linkType: 'genesis',
        payload: { type: 'user_init', deviceId: 'dev-1' },
        prevHash: '',
      })

      const insertedRow = makeLink({
        seqNo: 1,
        hash: body.hash,
        prevHash: '',
      })

      const db = {
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
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([insertedRow]),
          }),
        }),
      }

      const svc = new CryptoKeysService(withTx(db) as never)
      const result = await svc.appendSigchainLink('user-pk1', body)
      expect(result.seqNo).toBe(1)
      expect(result.prevHash).toBeNull()
    })

    it('rejects legacy genesis seqNo=0 with 409', async () => {
      const body = makeLinkBody({
        seqNo: 0, // pre-#1029 genesis shape — the crate verifier requires seq=1
        linkType: 'genesis',
        payload: { type: 'user_init', deviceId: 'dev-1' },
        prevHash: '',
      })

      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        }),
      }

      const svc = new CryptoKeysService(withTx(db) as never)
      try {
        await svc.appendSigchainLink('user-pk1', body)
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(CryptoKeyError)
        expect((err as CryptoKeyError).status).toBe(409)
        expect((err as CryptoKeyError).message).toContain('expected 1, got 0')
      }
    })

    it('appends link with correct seqNo and prevHash', async () => {
      const chainTail = [
        makeLink({ seqNo: 1, hash: 'aa'.repeat(32), prevHash: 'h0' }),
      ]

      const body = makeLinkBody({
        seqNo: 2,
        linkType: 'device_add',
        payload: { devicePubkey: 'new-dev' },
        prevHash: 'aa'.repeat(32),
      })

      const insertedRow = makeLink({
        seqNo: 2,
        hash: body.hash,
        prevHash: 'aa'.repeat(32),
      })

      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue(chainTail),
              }),
            }),
          }),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([insertedRow]),
          }),
        }),
      }

      const svc = new CryptoKeysService(withTx(db) as never)
      const result = await svc.appendSigchainLink('user-pk1', body)

      expect(result.seqNo).toBe(2)
      expect(result.prevHash).toBe('aa'.repeat(32))
    })

    it('rejects seqNo mismatch with 409', async () => {
      const existingLinks = [
        makeLink({ seqNo: 1, hash: 'h1', prevHash: '' }),
      ]

      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue(existingLinks),
              }),
            }),
          }),
        }),
      }

      const body = makeLinkBody({
        seqNo: 5, // should be 2
        linkType: 'device_add',
        payload: {},
        prevHash: 'h1',
      })

      const svc = new CryptoKeysService(withTx(db) as never)
      try {
        await svc.appendSigchainLink('user-pk1', body)
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(CryptoKeyError)
        expect((err as CryptoKeyError).status).toBe(409)
        expect((err as CryptoKeyError).message).toContain('expected 2, got 5')
      }
    })

    it('rejects prevHash mismatch with 409', async () => {
      const existingLinks = [
        makeLink({ seqNo: 1, hash: 'h1', prevHash: '' }),
      ]

      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue(existingLinks),
              }),
            }),
          }),
        }),
      }

      const body = makeLinkBody({
        seqNo: 2,
        linkType: 'device_add',
        payload: {},
        prevHash: 'wrong-hash', // should be 'h1'
      })

      const svc = new CryptoKeysService(withTx(db) as never)
      try {
        await svc.appendSigchainLink('user-pk1', body)
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(CryptoKeyError)
        expect((err as CryptoKeyError).status).toBe(409)
        expect((err as CryptoKeyError).message).toContain('prevHash mismatch')
      }
    })

    it('rejects seqNo=0 when chain already has genesis', async () => {
      const existingLinks = [
        makeLink({ seqNo: 1, hash: 'h1', prevHash: '' }),
      ]

      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue(existingLinks),
              }),
            }),
          }),
        }),
      }

      const body = makeLinkBody({
        seqNo: 0, // should be 2
        linkType: 'genesis',
        payload: {},
        prevHash: '',
      })

      const svc = new CryptoKeysService(withTx(db) as never)
      try {
        await svc.appendSigchainLink('user-pk1', body)
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(CryptoKeyError)
        expect((err as CryptoKeyError).status).toBe(409)
      }
    })
  })

  describe('appendSigchainLink — hash recomputation (security audit P0)', () => {
    function makeGenesisDb() {
      return withTx({
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
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([
              makeLink({ seqNo: 1, hash: 'h1', prevHash: '', createdAt: new Date() }),
            ]),
          }),
        }),
      })
    }

    it('accepts link with correctly computed canonical hash', async () => {
      const body = makeLinkBody({
        seqNo: 1,
        linkType: 'genesis',
        payload: { type: 'user_init', deviceId: 'dev-1' },
        prevHash: null,
      })

      const svc = new CryptoKeysService(makeGenesisDb() as never)
      const result = await svc.appendSigchainLink('user-pk1', body)
      expect(result).toBeDefined()
    })

    it('rejects link with tampered payload (hash mismatch, 400)', async () => {
      const body = makeLinkBody({
        seqNo: 1,
        linkType: 'genesis',
        payload: { type: 'user_init', deviceId: 'dev-1' },
        prevHash: null,
      })
      // Tamper with the payload AFTER the hash was computed
      body.payload = { type: 'user_init', deviceId: 'TAMPERED' }

      const svc = new CryptoKeysService(makeGenesisDb() as never)
      try {
        await svc.appendSigchainLink('user-pk1', body)
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(CryptoKeyError)
        expect((err as CryptoKeyError).status).toBe(400)
        expect((err as CryptoKeyError).message).toContain('hash mismatch')
      }
    })

    it('rejects link with forged hash that does not bind to content', async () => {
      const svc = new CryptoKeysService(makeGenesisDb() as never)
      try {
        await svc.appendSigchainLink('user-pk1', {
          seqNo: 1,
          linkType: 'genesis',
          payload: { type: 'user_init' },
          signature: 'aa'.repeat(64),
          prevHash: null,
          hash: 'bb'.repeat(32), // arbitrary hash, not computed from content
          signerDeviceId: SIGNER_DEVICE_ID,
          signerPubkey: SIGNER_PUBKEY,
          timestamp: TIMESTAMP,
        })
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(CryptoKeyError)
        expect((err as CryptoKeyError).status).toBe(400)
        expect((err as CryptoKeyError).message).toContain('hash mismatch')
      }
    })

    it('canonical hash is deterministic across identical inputs', () => {
      const hash1 = computeTestHash(1, null, TIMESTAMP, SIGNER_DEVICE_ID, SIGNER_PUBKEY, { type: 'user_init' })
      const hash2 = computeTestHash(1, null, TIMESTAMP, SIGNER_DEVICE_ID, SIGNER_PUBKEY, { type: 'user_init' })
      expect(hash1).toBe(hash2)
    })

    it('canonical hash differs when any field changes', () => {
      const base = computeTestHash(1, null, TIMESTAMP, SIGNER_DEVICE_ID, SIGNER_PUBKEY, { type: 'user_init' })
      const diffSeq = computeTestHash(2, null, TIMESTAMP, SIGNER_DEVICE_ID, SIGNER_PUBKEY, { type: 'user_init' })
      const diffTs = computeTestHash(1, null, '2026-02-01T00:00:00Z', SIGNER_DEVICE_ID, SIGNER_PUBKEY, { type: 'user_init' })
      const diffPayload = computeTestHash(1, null, TIMESTAMP, SIGNER_DEVICE_ID, SIGNER_PUBKEY, { type: 'device_add' })

      expect(base).not.toBe(diffSeq)
      expect(base).not.toBe(diffTs)
      expect(base).not.toBe(diffPayload)
    })

    it('canonical hash sorts nested payload keys', () => {
      // {b: 1, a: 2} and {a: 2, b: 1} should produce the same hash
      const hash1 = computeTestHash(1, null, TIMESTAMP, SIGNER_DEVICE_ID, SIGNER_PUBKEY, { b: 1, a: 2 })
      const hash2 = computeTestHash(1, null, TIMESTAMP, SIGNER_DEVICE_ID, SIGNER_PUBKEY, { a: 2, b: 1 })
      expect(hash1).toBe(hash2)
    })
  })

  describe('appendSigchainLink — canonical number rule (#1029)', () => {
    function makeEmptyChainDb(insertedRow: MockLink) {
      return withTx({
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
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([insertedRow]),
          }),
        }),
      })
    }

    function genesisBodyWith(payload: unknown) {
      return makeLinkBody({
        seqNo: 1,
        linkType: 'genesis',
        payload,
        prevHash: null,
      })
    }

    it('accepts payloads whose numbers are all integers ≤ 2^53 (incl. nested)', async () => {
      const body = genesisBodyWith({ type: 'user_init', nested: { counts: [1, 9007199254740991] } })
      const svc = new CryptoKeysService(
        makeEmptyChainDb(makeLink({ seqNo: 1, hash: body.hash, prevHash: '' })) as never,
      )
      const result = await svc.appendSigchainLink('user-pk1', body)
      expect(result.seqNo).toBe(1)
    })

    it('rejects fractional payload numbers with 400', async () => {
      // serde_json serializes 1.5 as "1.5" but collapses vary by platform for
      // other forms (1.0 → "1" in JS) — floats are outside the canonical domain.
      const body = genesisBodyWith({ type: 'user_init', n: 1.5 })
      const svc = new CryptoKeysService(
        makeEmptyChainDb(makeLink({ seqNo: 1, hash: body.hash, prevHash: '' })) as never,
      )
      try {
        await svc.appendSigchainLink('user-pk1', body)
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(CryptoKeyError)
        expect((err as CryptoKeyError).status).toBe(400)
        expect((err as CryptoKeyError).message).toContain('payload.n')
      }
    })

    it('rejects payload integers beyond 2^53 with 400 (issue #1029 repro)', async () => {
      // 12345678901234567890 rounds silently in JS — hashing it would bind
      // bytes no other platform can reproduce (the exact #1029 divergence).
      const body = genesisBodyWith({ type: 'x', n: 12345678901234567890 })
      const svc = new CryptoKeysService(
        makeEmptyChainDb(makeLink({ seqNo: 1, hash: body.hash, prevHash: '' })) as never,
      )
      try {
        await svc.appendSigchainLink('user-pk1', body)
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(CryptoKeyError)
        expect((err as CryptoKeyError).status).toBe(400)
        expect((err as CryptoKeyError).message).toContain('payload.n')
      }
    })

    it('rejects numbers nested in arrays and objects with the JSON path', async () => {
      const body = genesisBodyWith({ type: 'user_init', a: { b: [{ c: 0.1 }] } })
      const svc = new CryptoKeysService(
        makeEmptyChainDb(makeLink({ seqNo: 1, hash: body.hash, prevHash: '' })) as never,
      )
      try {
        await svc.appendSigchainLink('user-pk1', body)
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(CryptoKeyError)
        expect((err as CryptoKeyError).message).toContain('payload.a.b[0].c')
      }
    })

    it('assertCanonicalSigchainPayload passes integer-only payloads', () => {
      expect(() => assertCanonicalSigchainPayload({ a: 1, b: [2, { c: 3 }], d: null })).not.toThrow()
    })

    it('assertCanonicalSigchainPayload rejects non-integer numbers', () => {
      expect(() => assertCanonicalSigchainPayload({ a: 1.5 })).toThrow(CryptoKeyError)
      expect(() => assertCanonicalSigchainPayload({ a: Number.MAX_SAFE_INTEGER + 1 })).toThrow(CryptoKeyError)
    })
  })

  describe('computeEntryHash — cross-language vectors (packages/crypto sigchain.rs)', () => {
    // Pinned by test_cross_language_vectors in packages/crypto/src/sigchain.rs
    // (cargo test -- --nocapture). Any platform implementing sigchain
    // verification MUST produce these hashes.
    const VECTOR_1_GENESIS = '7993a9e36114d2dff4fd882aa7261231beed2d5109aa84e01c8f46ee49e896a4'
    const VECTOR_2_CHAINED = '2944558cc144bc39d1910a5ac26f5811cacd8678a70f88655e8baa37ecff0c2e'
    const VECTOR_3_DEVICE_ADD = '9fa457d087b537494dd0761ff5f5ec1651f844229cccda9f8cbb92342d618e2e'

    function toHex(bytes: Uint8Array): string {
      const HEX = '0123456789abcdef'
      let hex = ''
      for (let i = 0; i < bytes.length; i++) {
        hex += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0x0f]
      }
      return hex
    }

    it('vector 1: genesis entry (seq=1, prevHash=null)', () => {
      const hash = computeEntryHash(
        1,
        null,
        '2026-01-01T00:00:00Z',
        'device-001',
        'ab01cd02',
        JSON.parse('{"type":"user_init","deviceId":"device-001"}'),
      )
      expect(hash).toBe(VECTOR_1_GENESIS)
    })

    it('vector 1 canonical JSON matches the crate-pinned string byte-for-byte', () => {
      // Pinned verbatim in sigchain.rs::test_cross_language_vectors.
      const canonicalJson = '{"payload":{"deviceId":"device-001","type":"user_init"},"prevHash":null,"seq":1,"signerDeviceId":"device-001","signerPubkey":"ab01cd02","timestamp":"2026-01-01T00:00:00Z"}'
      expect(toHex(sha256(new TextEncoder().encode(canonicalJson)))).toBe(VECTOR_1_GENESIS)
    })

    it('vector 2: chained entry (prevHash = 0xaa × 32)', () => {
      const hash = computeEntryHash(
        2,
        'aa'.repeat(32),
        '2026-01-01T00:01:00Z',
        'device-001',
        'ab01cd02',
        JSON.parse('{"type":"puk_rotate","generation":2}'),
      )
      expect(hash).toBe(VECTOR_2_CHAINED)
    })

    it('vector 3: device_add entry chained on vector 2', () => {
      const hash = computeEntryHash(
        3,
        VECTOR_2_CHAINED,
        '2026-01-01T00:02:00Z',
        'device-001',
        'ab01cd02',
        JSON.parse('{"type":"device_add","deviceId":"device-002","devicePubkey":"ff00ee11"}'),
      )
      expect(hash).toBe(VECTOR_3_DEVICE_ADD)
    })
  })

  describe('chainHashesEqual — constant-time chain hash comparison', () => {
    const H1 = 'aa'.repeat(32)

    it('accepts two identical hashes', () => {
      expect(chainHashesEqual(H1, H1)).toBe(true)
    })

    it('rejects two hashes differing in the last nibble', () => {
      expect(chainHashesEqual(H1, 'aa'.repeat(31) + 'ab')).toBe(false)
    })

    it('rejects two hashes differing in the first nibble', () => {
      expect(chainHashesEqual(H1, 'ba' + 'aa'.repeat(31))).toBe(false)
    })

    it('rejects hashes of different lengths', () => {
      expect(chainHashesEqual(H1, 'aa'.repeat(31))).toBe(false)
    })

    it('treats null as equal only to null (genesis prevHash)', () => {
      expect(chainHashesEqual(null, null)).toBe(true)
      expect(chainHashesEqual(null, H1)).toBe(false)
      expect(chainHashesEqual(H1, null)).toBe(false)
    })
  })

  describe('appendSigchainLink — Ed25519 signature verification', () => {
    function makeGenesisDb() {
      return withTx({
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
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([
              makeLink({ seqNo: 1, hash: 'h1', prevHash: '', createdAt: new Date() }),
            ]),
          }),
        }),
      })
    }

    const genesisBody = makeLinkBody({
      seqNo: 1,
      linkType: 'genesis',
      payload: { type: 'user_init', deviceId: 'dev-1' },
      prevHash: null,
    })

    it('accepts entry with valid Ed25519 signature', async () => {
      mockEd25519Verify.mockReturnValue(true)
      const svc = new CryptoKeysService(makeGenesisDb() as never)
      const result = await svc.appendSigchainLink('user-pk1', genesisBody)
      expect(result).toBeDefined()
      expect(mockEd25519Verify).toHaveBeenCalledOnce()
    })

    it('rejects entry with invalid Ed25519 signature (403)', async () => {
      mockEd25519Verify.mockReturnValue(false)
      const svc = new CryptoKeysService(makeGenesisDb() as never)
      try {
        await svc.appendSigchainLink('user-pk1', genesisBody)
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(CryptoKeyError)
        expect((err as CryptoKeyError).status).toBe(403)
        expect((err as CryptoKeyError).message).toContain('signature verification failed')
      }
    })

    it('rejects malformed hex with 400', async () => {
      mockHexToBytes.mockImplementation(() => { throw new Error('invalid hex') })
      const svc = new CryptoKeysService(makeGenesisDb() as never)
      try {
        await svc.appendSigchainLink('user-pk1', genesisBody)
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(CryptoKeyError)
        expect((err as CryptoKeyError).status).toBe(400)
      }
    })

    it('passes correct byte arrays to ed25519Verify', async () => {
      mockEd25519Verify.mockReturnValue(true)
      const svc = new CryptoKeysService(makeGenesisDb() as never)
      await svc.appendSigchainLink('user-pk1', genesisBody)

      expect(mockHexToBytes).toHaveBeenCalledWith(genesisBody.hash)
      expect(mockHexToBytes).toHaveBeenCalledWith(genesisBody.signature)
      expect(mockHexToBytes).toHaveBeenCalledWith('user-pk1')
    })
  })

  describe('FIX: appendSigchainLink uses single optimized query', () => {
    it('makes exactly 1 select query (DESC LIMIT 1) for chain head', async () => {
      const selectSpy = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      })

      const body = makeLinkBody({
        seqNo: 1,
        linkType: 'genesis',
        payload: { type: 'user_init' },
        prevHash: null,
      })

      const db = withTx({
        select: selectSpy,
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([
              makeLink({ seqNo: 1, hash: body.hash, prevHash: '' }),
            ]),
          }),
        }),
      })

      const svc = new CryptoKeysService(db as never)
      await svc.appendSigchainLink('user-pk1', body)

      expect(selectSpy).toHaveBeenCalledTimes(1)
    })
  })
})

// ---------------------------------------------------------------------------
// PUK Envelopes
// ---------------------------------------------------------------------------

describe('CryptoKeysService — PUK Envelopes', () => {
  describe('distributePukEnvelopes', () => {
    it('returns empty array when no envelopes provided', async () => {
      const db = {
        insert: vi.fn(),
      }
      const svc = new CryptoKeysService(db as never)
      const result = await svc.distributePukEnvelopes('user-pk1', [])
      expect(result).toEqual([])
      expect(db.insert).not.toHaveBeenCalled()
    })

    it('inserts and returns envelope records', async () => {
      const now = new Date()
      const insertedRows = [
        {
          id: 'env-1',
          userPubkey: 'user-pk1',
          deviceId: 'dev-1',
          generation: 1,
          envelope: 'hpke-blob-1',
          createdAt: now,
        },
        {
          id: 'env-2',
          userPubkey: 'user-pk1',
          deviceId: 'dev-2',
          generation: 1,
          envelope: 'hpke-blob-2',
          createdAt: now,
        },
      ]

      const returning = vi.fn().mockResolvedValue(insertedRows)
      const onConflictDoUpdate = vi.fn().mockReturnValue({ returning })
      const db = {
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({ onConflictDoUpdate }),
        }),
      }

      const svc = new CryptoKeysService(db as never)
      const result = await svc.distributePukEnvelopes('user-pk1', [
        { deviceId: 'dev-1', generation: 1, envelope: 'hpke-blob-1' },
        { deviceId: 'dev-2', generation: 1, envelope: 'hpke-blob-2' },
      ])

      expect(result).toHaveLength(2)
      expect(result[0].deviceId).toBe('dev-1')
      expect(result[1].deviceId).toBe('dev-2')
      expect(typeof result[0].createdAt).toBe('string')
    })
  })

  describe('getPukEnvelopeForDevice', () => {
    it('returns null when no envelope exists', async () => {
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        }),
      }

      const svc = new CryptoKeysService(db as never)
      const result = await svc.getPukEnvelopeForDevice('user-pk1', 'dev-1')
      expect(result).toBeNull()
    })

    it('returns the latest generation envelope', async () => {
      const envRow = {
        id: 'env-latest',
        userPubkey: 'user-pk1',
        deviceId: 'dev-1',
        generation: 3,
        envelope: 'latest-hpke-blob',
        createdAt: new Date(),
      }

      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([envRow]),
              }),
            }),
          }),
        }),
      }

      const svc = new CryptoKeysService(db as never)
      const result = await svc.getPukEnvelopeForDevice('user-pk1', 'dev-1')

      expect(result).toBeTruthy()
      expect(result!.generation).toBe(3)
      expect(result!.envelope).toBe('latest-hpke-blob')
    })
  })
})

// ---------------------------------------------------------------------------
// MLS Messages
// ---------------------------------------------------------------------------

describe('CryptoKeysService — MLS Messages', () => {
  describe('enqueueMlsMessages', () => {
    it('does nothing for empty message array', async () => {
      const db = { insert: vi.fn() }
      const svc = new CryptoKeysService(db as never)
      await svc.enqueueMlsMessages('hub-1', [])
      expect(db.insert).not.toHaveBeenCalled()
    })

    it('inserts messages for multiple recipients', async () => {
      const insertValues = vi.fn().mockReturnValue({})
      const db = {
        insert: vi.fn().mockReturnValue({
          values: insertValues,
        }),
      }

      const svc = new CryptoKeysService(db as never)
      await svc.enqueueMlsMessages('hub-1', [
        { recipientDeviceId: 'dev-1', messageType: 'welcome', payload: { data: 1 } },
        { recipientDeviceId: 'dev-2', messageType: 'commit', payload: { data: 2 } },
      ])

      expect(insertValues).toHaveBeenCalledWith([
        { hubId: 'hub-1', recipientDeviceId: 'dev-1', messageType: 'welcome', payload: { data: 1 } },
        { hubId: 'hub-1', recipientDeviceId: 'dev-2', messageType: 'commit', payload: { data: 2 } },
      ])
    })
  })

  describe('fetchAndClearMlsMessages', () => {
    it('returns empty array when no messages pending', async () => {
      const db = {
        delete: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      }

      const svc = new CryptoKeysService(db as never)
      const result = await svc.fetchAndClearMlsMessages('hub-1', 'dev-1')
      expect(result).toEqual([])
    })

    it('returns and deletes pending messages', async () => {
      const messages = [
        {
          id: 'msg-1',
          hubId: 'hub-1',
          recipientDeviceId: 'dev-1',
          messageType: 'welcome',
          payload: { data: 1 },
          createdAt: new Date(),
        },
      ]

      const deleteMock = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue(messages),
        }),
      })

      const db = {
        delete: deleteMock,
      }

      const svc = new CryptoKeysService(db as never)
      const result = await svc.fetchAndClearMlsMessages('hub-1', 'dev-1')

      expect(result).toHaveLength(1)
      expect(result[0].messageType).toBe('welcome')
      expect(typeof result[0].createdAt).toBe('string')
      expect(deleteMock).toHaveBeenCalled()
    })
  })

  describe('uploadKeyPackage', () => {
    it('stores key package as a pending message', async () => {
      const insertValues = vi.fn().mockReturnValue({})
      const db = {
        insert: vi.fn().mockReturnValue({ values: insertValues }),
      }

      const svc = new CryptoKeysService(db as never)
      await svc.uploadKeyPackage('hub-1', 'dev-1', { keyPackageData: 'binary' })

      expect(insertValues).toHaveBeenCalledWith({
        hubId: 'hub-1',
        recipientDeviceId: 'dev-1',
        messageType: 'key_package',
        payload: { keyPackageData: 'binary' },
      })
    })
  })
})

// ---------------------------------------------------------------------------
// CryptoKeyError
// ---------------------------------------------------------------------------

describe('CryptoKeyError', () => {
  it('has correct name and status defaults', () => {
    const err = new CryptoKeyError('test error')
    expect(err.name).toBe('CryptoKeyError')
    expect(err.message).toBe('test error')
    expect(err.status).toBe(500)
  })

  it('accepts custom status codes', () => {
    const err = new CryptoKeyError('conflict', 409)
    expect(err.status).toBe(409)
  })

  it('extends Error', () => {
    const err = new CryptoKeyError('test')
    expect(err).toBeInstanceOf(Error)
  })
})
