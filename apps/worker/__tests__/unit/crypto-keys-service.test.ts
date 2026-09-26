import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CryptoKeysService, CryptoKeyError } from '../../services/crypto-keys'
import { sha256 } from '@noble/hashes/sha2.js'
import type { PukHpkeEnvelope, SigchainLinkType } from '@protocol/schemas/sigchain'

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
    userPubkey: 'aa'.repeat(32),
    linkType: 'device_add',
    payload: { type: 'device_add', deviceId: 'dev-2', devicePubkey: 'cc'.repeat(32), deviceEncryptionPubkey: 'dd'.repeat(32) },
    signature: 'sig-hex',
    prevHash: '',
    signerDeviceId: 'dev-1',
    signerPubkey: 'aa'.repeat(32),
    linkTimestamp: '2026-01-01T00:00:00Z',
    createdAt: new Date('2026-01-01'),
    ...overrides,
  }
}

// Shorthand for creating a link body with valid hash. Every generic link is
// signed by the user's identity key, so the signer IS the user.
const SIGNER_DEVICE_ID = 'dev-1'
const SIGNER_PUBKEY = 'aa'.repeat(32)
const USER_PUBKEY = SIGNER_PUBKEY
const TIMESTAMP = '2026-01-01T00:00:00Z'

const GENESIS_PAYLOAD = {
  type: 'user_init',
  deviceId: SIGNER_DEVICE_ID,
  devicePubkey: SIGNER_PUBKEY,
  deviceEncryptionPubkey: 'bb'.repeat(32),
}
const DEVICE_ADD_PAYLOAD = {
  type: 'device_add',
  deviceId: 'dev-2',
  devicePubkey: 'cc'.repeat(32),
  deviceEncryptionPubkey: 'dd'.repeat(32),
}

function makeLinkBody(overrides: {
  seqNo: number
  linkType: SigchainLinkType
  payload: Record<string, unknown>
  prevHash: string
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

  /** DB whose chain head query returns `head` (empty = no chain yet). */
  function makeAppendDb(head: MockLink[], inserted?: MockLink | Error) {
    return {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(head),
            }),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: inserted instanceof Error
            ? vi.fn().mockRejectedValue(inserted)
            : vi.fn().mockResolvedValue([inserted ?? makeLink({ seqNo: 1, hash: 'h1', prevHash: '' })]),
        }),
      }),
    }
  }

  async function expectCryptoKeyError(p: Promise<unknown>, status: number, message?: string) {
    try {
      await p
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(CryptoKeyError)
      expect((err as CryptoKeyError).status).toBe(status)
      if (message) expect((err as CryptoKeyError).message).toContain(message)
    }
  }

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
      const result = await svc.getSigchain(USER_PUBKEY)
      expect(result).toEqual([])
    })

    it('returns links ordered by seqNo ascending, with the hashed timestamp', async () => {
      const links = [
        makeLink({ seqNo: 1, hash: 'h1', prevHash: '', linkType: 'genesis', payload: GENESIS_PAYLOAD }),
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
      const result = await svc.getSigchain(USER_PUBKEY)

      expect(result.map(l => l.seqNo)).toEqual([1, 2, 3])
      expect(typeof result[0].createdAt).toBe('string')
      // Without the link timestamp no client could recompute the entry hash.
      expect(result[0].timestamp).toBe(TIMESTAMP)
    })
  })

  describe('appendSigchainLink', () => {
    it('appends genesis link (seqNo=1, prevHash="")', async () => {
      const body = makeLinkBody({ seqNo: 1, linkType: 'genesis', payload: GENESIS_PAYLOAD, prevHash: '' })
      const db = makeAppendDb([], makeLink({ seqNo: 1, hash: body.hash, prevHash: '', linkType: 'genesis', payload: GENESIS_PAYLOAD }))

      const svc = new CryptoKeysService(db as never)
      const result = await svc.appendSigchainLink(USER_PUBKEY, body)

      expect(result.seqNo).toBe(1)
      expect(result.hash).toBe(body.hash)
      expect(result.prevHash).toBe('')
      expect(db.insert).toHaveBeenCalled()
    })

    it('appends link with correct seqNo and prevHash', async () => {
      const head = [makeLink({ seqNo: 1, hash: 'ab'.repeat(32), prevHash: '' })]
      const body = makeLinkBody({ seqNo: 2, linkType: 'device_add', payload: DEVICE_ADD_PAYLOAD, prevHash: 'ab'.repeat(32) })
      const db = makeAppendDb(head, makeLink({ seqNo: 2, hash: body.hash, prevHash: 'ab'.repeat(32) }))

      const svc = new CryptoKeysService(db as never)
      const result = await svc.appendSigchainLink(USER_PUBKEY, body)

      expect(result.seqNo).toBe(2)
      expect(result.prevHash).toBe('ab'.repeat(32))
    })

    it('rejects seqNo mismatch with 409', async () => {
      const db = makeAppendDb([makeLink({ seqNo: 1, hash: 'h1', prevHash: '' })])
      const body = makeLinkBody({ seqNo: 5, linkType: 'device_add', payload: DEVICE_ADD_PAYLOAD, prevHash: 'h1' })
      const svc = new CryptoKeysService(db as never)
      await expectCryptoKeyError(svc.appendSigchainLink(USER_PUBKEY, body), 409, 'expected 2, got 5')
    })

    it('rejects prevHash mismatch with 409', async () => {
      const db = makeAppendDb([makeLink({ seqNo: 1, hash: 'h1', prevHash: '' })])
      const body = makeLinkBody({ seqNo: 2, linkType: 'device_add', payload: DEVICE_ADD_PAYLOAD, prevHash: 'wrong-hash' })
      const svc = new CryptoKeysService(db as never)
      await expectCryptoKeyError(svc.appendSigchainLink(USER_PUBKEY, body), 409, 'prevHash mismatch')
    })

    it('rejects a second genesis when the chain already has one (409)', async () => {
      const db = makeAppendDb([makeLink({ seqNo: 1, hash: 'h1', prevHash: '' })])
      const body = makeLinkBody({ seqNo: 1, linkType: 'genesis', payload: GENESIS_PAYLOAD, prevHash: '' })
      const svc = new CryptoKeysService(db as never)
      await expectCryptoKeyError(svc.appendSigchainLink(USER_PUBKEY, body), 409)
    })

    it('maps a concurrent append (unique violation on user+seq) to 409', async () => {
      const body = makeLinkBody({ seqNo: 1, linkType: 'genesis', payload: GENESIS_PAYLOAD, prevHash: '' })
      const uniqueViolation = Object.assign(new Error('insert failed'), { cause: { code: '23505' } })
      const db = makeAppendDb([], uniqueViolation)
      const svc = new CryptoKeysService(db as never)
      await expectCryptoKeyError(svc.appendSigchainLink(USER_PUBKEY, body), 409, 'concurrent')
    })

    it('rethrows other insert failures', async () => {
      const body = makeLinkBody({ seqNo: 1, linkType: 'genesis', payload: GENESIS_PAYLOAD, prevHash: '' })
      const db = makeAppendDb([], new Error('connection reset'))
      const svc = new CryptoKeysService(db as never)
      await expect(svc.appendSigchainLink(USER_PUBKEY, body)).rejects.toThrow('connection reset')
    })
  })

  describe('appendSigchainLink — link semantics (#1050)', () => {
    it('rejects a non-genesis link at seq 1', async () => {
      const body = makeLinkBody({ seqNo: 1, linkType: 'device_add', payload: DEVICE_ADD_PAYLOAD, prevHash: '' })
      const svc = new CryptoKeysService(makeAppendDb([]) as never)
      await expectCryptoKeyError(svc.appendSigchainLink(USER_PUBKEY, body), 400, 'must be a genesis link')
    })

    it('rejects a genesis link anywhere but seq 1', async () => {
      const body = makeLinkBody({ seqNo: 2, linkType: 'genesis', payload: GENESIS_PAYLOAD, prevHash: 'h1' })
      const svc = new CryptoKeysService(makeAppendDb([makeLink({ seqNo: 1, hash: 'h1' })]) as never)
      await expectCryptoKeyError(svc.appendSigchainLink(USER_PUBKEY, body), 400, 'only valid as the first')
    })

    it('rejects a payload.type that disagrees with linkType', async () => {
      const body = makeLinkBody({ seqNo: 2, linkType: 'device_remove', payload: DEVICE_ADD_PAYLOAD, prevHash: 'h1' })
      const svc = new CryptoKeysService(makeAppendDb([makeLink({ seqNo: 1, hash: 'h1' })]) as never)
      await expectCryptoKeyError(svc.appendSigchainLink(USER_PUBKEY, body), 400, 'payload.type must be "device_remove"')
    })

    it('rejects a signerPubkey other than the user\'s identity key', async () => {
      const other = 'ee'.repeat(32)
      const body = makeLinkBody({
        seqNo: 1, linkType: 'genesis', prevHash: '', signerPubkey: other,
        payload: { ...GENESIS_PAYLOAD, devicePubkey: other },
      })
      const svc = new CryptoKeysService(makeAppendDb([]) as never)
      await expectCryptoKeyError(svc.appendSigchainLink(USER_PUBKEY, body), 400, 'identity key')
    })

    it('rejects a malformed genesis payload', async () => {
      const body = makeLinkBody({ seqNo: 1, linkType: 'genesis', payload: { type: 'user_init', deviceId: SIGNER_DEVICE_ID }, prevHash: '' })
      const svc = new CryptoKeysService(makeAppendDb([]) as never)
      await expectCryptoKeyError(svc.appendSigchainLink(USER_PUBKEY, body), 400, 'invalid genesis payload')
    })

    it('rejects a genesis payload naming a device other than the signer', async () => {
      const body = makeLinkBody({ seqNo: 1, linkType: 'genesis', payload: { ...GENESIS_PAYLOAD, deviceId: 'dev-other' }, prevHash: '' })
      const svc = new CryptoKeysService(makeAppendDb([]) as never)
      await expectCryptoKeyError(svc.appendSigchainLink(USER_PUBKEY, body), 400, 'must name the signing device')
    })

    it('accepts a puk_epoch link binding PUK public keys', async () => {
      const body = makeLinkBody({
        seqNo: 2, linkType: 'puk_epoch', prevHash: 'h1',
        payload: { type: 'puk_epoch', generation: 1, signPubkey: '11'.repeat(32), dhPubkey: '22'.repeat(32) },
      })
      const svc = new CryptoKeysService(makeAppendDb([makeLink({ seqNo: 1, hash: 'h1' })], makeLink({ seqNo: 2, hash: body.hash, prevHash: 'h1' })) as never)
      await expect(svc.appendSigchainLink(USER_PUBKEY, body)).resolves.toMatchObject({ seqNo: 2 })
    })
  })

  describe('appendSigchainLink — hash recomputation (security audit P0)', () => {
    it('accepts link with correctly computed canonical hash', async () => {
      const body = makeLinkBody({ seqNo: 1, linkType: 'genesis', payload: GENESIS_PAYLOAD, prevHash: '' })
      const svc = new CryptoKeysService(makeAppendDb([]) as never)
      const result = await svc.appendSigchainLink(USER_PUBKEY, body)
      expect(result).toBeDefined()
    })

    it('rejects link with tampered payload (hash mismatch, 400)', async () => {
      const body = makeLinkBody({ seqNo: 1, linkType: 'genesis', payload: GENESIS_PAYLOAD, prevHash: '' })
      // Tamper with the payload AFTER the hash was computed
      body.payload = { ...GENESIS_PAYLOAD, deviceEncryptionPubkey: 'ee'.repeat(32) }

      const svc = new CryptoKeysService(makeAppendDb([]) as never)
      await expectCryptoKeyError(svc.appendSigchainLink(USER_PUBKEY, body), 400, 'hash mismatch')
    })

    it('rejects link with forged hash that does not bind to content', async () => {
      const svc = new CryptoKeysService(makeAppendDb([]) as never)
      await expectCryptoKeyError(svc.appendSigchainLink(USER_PUBKEY, {
        seqNo: 1,
        linkType: 'genesis',
        payload: GENESIS_PAYLOAD,
        signature: 'aa'.repeat(64),
        prevHash: '',
        hash: 'bb'.repeat(32), // arbitrary hash, not computed from content
        signerDeviceId: SIGNER_DEVICE_ID,
        signerPubkey: SIGNER_PUBKEY,
        timestamp: TIMESTAMP,
      }), 400, 'hash mismatch')
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

  describe('appendSigchainLink — Ed25519 signature verification', () => {
    const genesisBody = makeLinkBody({ seqNo: 1, linkType: 'genesis', payload: GENESIS_PAYLOAD, prevHash: '' })

    it('accepts entry with valid Ed25519 signature', async () => {
      mockEd25519Verify.mockReturnValue(true)
      const svc = new CryptoKeysService(makeAppendDb([]) as never)
      const result = await svc.appendSigchainLink(USER_PUBKEY, genesisBody)
      expect(result).toBeDefined()
      expect(mockEd25519Verify).toHaveBeenCalledOnce()
    })

    it('rejects entry with invalid Ed25519 signature (403)', async () => {
      mockEd25519Verify.mockReturnValue(false)
      const svc = new CryptoKeysService(makeAppendDb([]) as never)
      await expectCryptoKeyError(svc.appendSigchainLink(USER_PUBKEY, genesisBody), 403, 'signature verification failed')
    })

    it('rejects malformed hex with 400', async () => {
      mockHexToBytes.mockImplementation(() => { throw new Error('invalid hex') })
      const svc = new CryptoKeysService(makeAppendDb([]) as never)
      await expectCryptoKeyError(svc.appendSigchainLink(USER_PUBKEY, genesisBody), 400)
    })

    it('passes correct byte arrays to ed25519Verify', async () => {
      mockEd25519Verify.mockReturnValue(true)
      const svc = new CryptoKeysService(makeAppendDb([]) as never)
      await svc.appendSigchainLink(USER_PUBKEY, genesisBody)

      expect(mockHexToBytes).toHaveBeenCalledWith(genesisBody.hash)
      expect(mockHexToBytes).toHaveBeenCalledWith(genesisBody.signature)
      expect(mockHexToBytes).toHaveBeenCalledWith(USER_PUBKEY)
    })
  })

  describe('FIX: appendSigchainLink uses single optimized query', () => {
    it('makes exactly 1 select query (DESC LIMIT 1) for chain head', async () => {
      const body = makeLinkBody({ seqNo: 1, linkType: 'genesis', payload: GENESIS_PAYLOAD, prevHash: '' })
      const db = makeAppendDb([], makeLink({ seqNo: 1, hash: body.hash, prevHash: '' }))
      const svc = new CryptoKeysService(db as never)
      await svc.appendSigchainLink(USER_PUBKEY, body)
      expect(db.select).toHaveBeenCalledTimes(1)
    })
  })
})

// ---------------------------------------------------------------------------
// PUK Envelopes
// ---------------------------------------------------------------------------

const ENVELOPE_1: PukHpkeEnvelope = { v: 3, labelId: 44, enc: 'enc-1', ct: 'ct-1' }
const ENVELOPE_2: PukHpkeEnvelope = { v: 3, labelId: 44, enc: 'enc-2', ct: 'ct-2' }

describe('CryptoKeysService — PUK Envelopes', () => {
  /** DB whose sigchain query returns `chain` and whose upsert returns `inserted`. */
  function makePukDb(chain: MockLink[], inserted: unknown[] = []) {
    const returning = vi.fn().mockResolvedValue(inserted)
    const onConflictDoUpdate = vi.fn().mockReturnValue({ returning })
    return {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue(chain),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({ onConflictDoUpdate }),
      }),
      onConflictDoUpdate,
    }
  }

  const genesisLink = makeLink({ seqNo: 1, hash: 'h1', linkType: 'genesis', payload: GENESIS_PAYLOAD })
  const deviceAddLink = makeLink({ seqNo: 2, hash: 'h2', prevHash: 'h1', linkType: 'device_add', payload: DEVICE_ADD_PAYLOAD })

  describe('distributePukEnvelopes', () => {
    it('returns empty array when no envelopes provided', async () => {
      const db = { insert: vi.fn() }
      const svc = new CryptoKeysService(db as never)
      const result = await svc.distributePukEnvelopes(USER_PUBKEY, [])
      expect(result).toEqual([])
      expect(db.insert).not.toHaveBeenCalled()
    })

    it('stores envelopes addressed to devices the sigchain authorises', async () => {
      const now = new Date()
      const db = makePukDb([genesisLink, deviceAddLink], [
        { id: 'env-1', userPubkey: USER_PUBKEY, deviceId: 'dev-1', generation: 1, envelope: ENVELOPE_1, createdAt: now },
        { id: 'env-2', userPubkey: USER_PUBKEY, deviceId: 'dev-2', generation: 1, envelope: ENVELOPE_2, createdAt: now },
      ])

      const svc = new CryptoKeysService(db as never)
      const result = await svc.distributePukEnvelopes(USER_PUBKEY, [
        { deviceId: 'dev-1', generation: 1, envelope: ENVELOPE_1 },
        { deviceId: 'dev-2', generation: 1, envelope: ENVELOPE_2 },
      ])

      expect(result.map(r => r.deviceId)).toEqual(['dev-1', 'dev-2'])
      expect(result[0].envelope).toEqual(ENVELOPE_1)
      expect(typeof result[0].createdAt).toBe('string')
    })

    it('rejects an envelope for a device the sigchain never authorised, before any write', async () => {
      const db = makePukDb([genesisLink])
      const svc = new CryptoKeysService(db as never)
      try {
        await svc.distributePukEnvelopes(USER_PUBKEY, [
          { deviceId: 'dev-1', generation: 1, envelope: ENVELOPE_1 },
          { deviceId: 'dev-2', generation: 1, envelope: ENVELOPE_2 },
        ])
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(CryptoKeyError)
        expect((err as CryptoKeyError).status).toBe(400)
        expect((err as CryptoKeyError).message).toContain('dev-2')
      }
      expect(db.insert).not.toHaveBeenCalled()
    })

    it('rejects every envelope for a user with no sigchain', async () => {
      const db = makePukDb([])
      const svc = new CryptoKeysService(db as never)
      await expect(svc.distributePukEnvelopes(USER_PUBKEY, [{ deviceId: 'dev-1', generation: 1, envelope: ENVELOPE_1 }]))
        .rejects.toBeInstanceOf(CryptoKeyError)
      expect(db.insert).not.toHaveBeenCalled()
    })

    it('rejects an envelope for a removed device', async () => {
      const removeLink = makeLink({
        seqNo: 3, hash: 'h3', prevHash: 'h2', linkType: 'device_remove',
        payload: { type: 'device_remove', deviceId: 'dev-2', devicePubkey: 'cc'.repeat(32) },
      })
      const db = makePukDb([genesisLink, deviceAddLink, removeLink])
      const svc = new CryptoKeysService(db as never)
      await expect(svc.distributePukEnvelopes(USER_PUBKEY, [{ deviceId: 'dev-2', generation: 2, envelope: ENVELOPE_2 }]))
        .rejects.toThrow('does not authorise')
    })

    it('upserts on (userPubkey, deviceId, generation) so users cannot collide', async () => {
      const db = makePukDb([genesisLink], [
        { id: 'env-1', userPubkey: USER_PUBKEY, deviceId: 'dev-1', generation: 1, envelope: ENVELOPE_1, createdAt: new Date() },
      ])
      const svc = new CryptoKeysService(db as never)
      await svc.distributePukEnvelopes(USER_PUBKEY, [{ deviceId: 'dev-1', generation: 1, envelope: ENVELOPE_1 }])
      const target = db.onConflictDoUpdate.mock.calls[0][0].target as Array<{ name: string }>
      expect(target.map(c => c.name)).toEqual(['user_pubkey', 'device_id', 'generation'])
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
      const result = await svc.getPukEnvelopeForDevice(USER_PUBKEY, 'dev-1')
      expect(result).toBeNull()
    })

    it('returns the latest generation envelope', async () => {
      const envRow = {
        id: 'env-latest',
        userPubkey: USER_PUBKEY,
        deviceId: 'dev-1',
        generation: 3,
        envelope: ENVELOPE_2,
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
      const result = await svc.getPukEnvelopeForDevice(USER_PUBKEY, 'dev-1')

      expect(result).toBeTruthy()
      expect(result!.generation).toBe(3)
      expect(result!.envelope).toEqual(ENVELOPE_2)
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
