/**
 * RecoveryGroupService.completeRecovery — sigchain append wiring (#1146).
 *
 * completeRecovery used to hand-roll its own continuity check, canonical
 * hash recompute, and signature verification inline. It now delegates all
 * three to appendValidatedSigchainLink — the single validated-append path
 * every sigchain write funnels through — inside a transaction that takes
 * the same per-user advisory lock appendSigchainLink does (sigchainLockKey),
 * so a recovery completion can never fork the chain by racing a concurrent
 * device_add/device_remove/another-recovery append.
 *
 * These tests exercise the wiring, not the cryptography (that's covered by
 * crypto-keys-service.test.ts's hash-recomputation/signature suites and the
 * real-Postgres concurrency test in __tests__/integration/sigchain-concurrency):
 *   - the transaction takes the advisory lock before anything else
 *   - a successful completion returns the inserted sigchain link and marks
 *     the session completed, in the SAME transaction
 *   - a CryptoKeyError thrown by appendValidatedSigchainLink (continuity,
 *     hash, or signature failure) surfaces as a RecoveryGroupError with the
 *     same status code — the route layer only ever checks
 *     `instanceof RecoveryGroupError`
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RecoveryGroupService, RecoveryGroupError } from '../../services/recovery-group'
import { computeEntryHash } from '../../services/crypto-keys'

const mockEd25519Verify = vi.fn().mockReturnValue(true)
vi.mock('@llamenos/crypto/ffi', () => ({
  ed25519Verify: (...args: unknown[]) => mockEd25519Verify(...args),
}))

const mockHexToBytes = vi.fn().mockImplementation((hex: string) =>
  new Uint8Array(hex.match(/.{2}/g)?.map((b) => parseInt(b, 16)) ?? []),
)
vi.mock('@shared/encoding', () => ({
  hexToBytes: (...args: unknown[]) => mockHexToBytes(...args),
  bytesToHex: (bytes: Uint8Array) => {
    const HEX = '0123456789abcdef'
    let hex = ''
    for (let i = 0; i < bytes.length; i++) hex += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0x0f]
    return hex
  },
  utf8ToBytes: (s: string) => new TextEncoder().encode(s),
}))

const SESSION_ID = 'session-1'
const USER_PUBKEY = 'u'.repeat(64)
const NEW_DEVICE_PUBKEY = 'd'.repeat(64)
const SIGNER_DEVICE_ID = 'recovered-device-1'
const TIMESTAMP = '2026-01-01T00:00:00Z'

function makeSessionRow(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION_ID,
    hubId: 'hub-1',
    userPubkey: USER_PUBKEY,
    newDevicePubkey: NEW_DEVICE_PUBKEY,
    status: 'active',
    expiresAt: new Date(Date.now() - 1000), // delay already elapsed
    completedAt: null,
    ...overrides,
  }
}

/**
 * Chainable AND awaitable: some callers chain `.from().where().limit()`,
 * others resolve straight off `.where()` (recoverySessionContributions has
 * no limit). Mirrors `makeSelectChain` in audit-service.test.ts.
 */
function makeSelectChain(result: unknown[]) {
  const terminal = Promise.resolve(result) as Promise<unknown[]> & Record<string, () => unknown>
  for (const m of ['from', 'where', 'orderBy', 'limit']) {
    terminal[m] = () => terminal
  }
  return terminal
}

/** Queue of results returned by successive top-level `this.db.select()` calls. */
function makeSequencedSelect(results: unknown[][]) {
  let i = 0
  return vi.fn().mockImplementation(() => {
    const result = results[i] ?? []
    i++
    return makeSelectChain(result)
  })
}

function makeTx(opts: {
  currentHead: unknown[]
  insertedRow?: Record<string, unknown>
  insertShouldThrow?: () => never
}) {
  const execute = vi.fn().mockResolvedValue(undefined)
  const txSelect = vi.fn().mockReturnValue({
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: () => Promise.resolve(opts.currentHead),
        }),
      }),
    }),
  })
  const insert = vi.fn().mockImplementation(() => {
    if (opts.insertShouldThrow) opts.insertShouldThrow()
    return {
      values: () => ({
        returning: () => Promise.resolve([opts.insertedRow]),
      }),
    }
  })
  const update = vi.fn().mockReturnValue({
    set: () => ({ where: () => Promise.resolve(undefined) }),
  })
  return { execute, select: txSelect, insert, update }
}

function buildLink(seqNo: number, prevHash: string, payload: unknown) {
  const hash = computeEntryHash(
    seqNo,
    prevHash === '' ? null : prevHash,
    TIMESTAMP,
    SIGNER_DEVICE_ID,
    NEW_DEVICE_PUBKEY,
    payload,
  )
  return { hash, signature: 'aa'.repeat(64) }
}

beforeEach(() => {
  mockEd25519Verify.mockReset().mockReturnValue(true)
  mockHexToBytes.mockReset().mockImplementation((hex: string) =>
    new Uint8Array(hex.match(/.{2}/g)?.map((b) => parseInt(b, 16)) ?? []),
  )
})

describe('RecoveryGroupService.completeRecovery', () => {
  it('takes the per-user advisory lock before reading the chain head', async () => {
    const payload = { sessionId: SESSION_ID, contributingHolderPubkeys: ['holder-1', 'holder-2'] }
    const { hash, signature } = buildLink(0, '', payload)

    const tx = makeTx({
      currentHead: [],
      insertedRow: {
        id: 'link-1', userPubkey: USER_PUBKEY, seqNo: 0, linkType: 'recovery-device-add',
        payload, signature, prevHash: '', hash, signerDeviceId: SIGNER_DEVICE_ID,
        signerPubkey: NEW_DEVICE_PUBKEY, createdAt: new Date(),
      },
    })

    const db = {
      select: makeSequencedSelect([
        [makeSessionRow()],
        [{ contributorPubkey: 'holder-1' }, { contributorPubkey: 'holder-2' }],
        [{ threshold: 2 }],
      ]),
      transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    }

    const svc = new RecoveryGroupService(db as never)
    await svc.completeRecovery({
      sessionId: SESSION_ID,
      sigchainSeqNo: 0,
      sigchainPayload: payload,
      signature,
      prevHash: '',
      hash,
      signerDeviceId: SIGNER_DEVICE_ID,
      timestamp: TIMESTAMP,
    })

    expect(db.transaction).toHaveBeenCalledOnce()
    expect(tx.execute).toHaveBeenCalledOnce()
    // The lock must be taken before the head is read.
    expect(tx.execute.mock.invocationCallOrder[0]).toBeLessThan(tx.select.mock.invocationCallOrder[0])
  })

  it('returns the inserted sigchain link and completes the session atomically', async () => {
    const payload = { sessionId: SESSION_ID, contributingHolderPubkeys: ['holder-1', 'holder-2'] }
    const { hash, signature } = buildLink(0, '', payload)
    const insertedRow = {
      id: 'link-1', userPubkey: USER_PUBKEY, seqNo: 0, linkType: 'recovery-device-add',
      payload, signature, prevHash: '', hash, signerDeviceId: SIGNER_DEVICE_ID,
      signerPubkey: NEW_DEVICE_PUBKEY, createdAt: new Date(),
    }
    const tx = makeTx({ currentHead: [], insertedRow })

    const db = {
      select: makeSequencedSelect([
        [makeSessionRow()],
        [{ contributorPubkey: 'holder-1' }, { contributorPubkey: 'holder-2' }],
        [{ threshold: 2 }],
      ]),
      transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    }

    const svc = new RecoveryGroupService(db as never)
    const result = await svc.completeRecovery({
      sessionId: SESSION_ID,
      sigchainSeqNo: 0,
      sigchainPayload: payload,
      signature,
      prevHash: '',
      hash,
      signerDeviceId: SIGNER_DEVICE_ID,
      timestamp: TIMESTAMP,
    })

    expect(result.sigchainLink.linkType).toBe('recovery-device-add')
    expect(result.sigchainLink.signerPubkey).toBe(NEW_DEVICE_PUBKEY)
    expect(tx.update).toHaveBeenCalledOnce()
  })

  it('maps a continuity conflict (seqNo mismatch) to a 409 RecoveryGroupError', async () => {
    const payload = { sessionId: SESSION_ID, contributingHolderPubkeys: ['holder-1', 'holder-2'] }
    const { hash, signature } = buildLink(0, '', payload)
    // The chain already has a link at seqNo 0 — the claimed seqNo=0 is stale.
    const tx = makeTx({ currentHead: [{ seqNo: 0, hash: 'existing-hash' }] })

    const db = {
      select: makeSequencedSelect([
        [makeSessionRow()],
        [{ contributorPubkey: 'holder-1' }, { contributorPubkey: 'holder-2' }],
        [{ threshold: 2 }],
      ]),
      transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    }

    const svc = new RecoveryGroupService(db as never)
    await expect(
      svc.completeRecovery({
        sessionId: SESSION_ID,
        sigchainSeqNo: 0,
        sigchainPayload: payload,
        signature,
        prevHash: '',
        hash,
        signerDeviceId: SIGNER_DEVICE_ID,
        timestamp: TIMESTAMP,
      }),
    ).rejects.toMatchObject({ status: 409 })
    await expect(
      svc.completeRecovery({
        sessionId: SESSION_ID,
        sigchainSeqNo: 0,
        sigchainPayload: payload,
        signature,
        prevHash: '',
        hash,
        signerDeviceId: SIGNER_DEVICE_ID,
        timestamp: TIMESTAMP,
      }),
    ).rejects.toBeInstanceOf(RecoveryGroupError)
    // Never a raw CryptoKeyError leaking past the service boundary — the
    // route layer only checks `instanceof RecoveryGroupError`.
    expect(tx.insert).not.toHaveBeenCalled()
  })

  it('maps an invalid self-authorizing signature to a 403 RecoveryGroupError', async () => {
    mockEd25519Verify.mockReturnValue(false)
    const payload = { sessionId: SESSION_ID, contributingHolderPubkeys: ['holder-1', 'holder-2'] }
    const { hash, signature } = buildLink(0, '', payload)
    const tx = makeTx({ currentHead: [] })

    const db = {
      select: makeSequencedSelect([
        [makeSessionRow()],
        [{ contributorPubkey: 'holder-1' }, { contributorPubkey: 'holder-2' }],
        [{ threshold: 2 }],
      ]),
      transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    }

    const svc = new RecoveryGroupService(db as never)
    await expect(
      svc.completeRecovery({
        sessionId: SESSION_ID,
        sigchainSeqNo: 0,
        sigchainPayload: payload,
        signature,
        prevHash: '',
        hash,
        signerDeviceId: SIGNER_DEVICE_ID,
        timestamp: TIMESTAMP,
      }),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('rejects when sigchain payload sessionId does not match (before the transaction ever opens)', async () => {
    const db = {
      select: makeSequencedSelect([
        [makeSessionRow()],
        [{ contributorPubkey: 'holder-1' }, { contributorPubkey: 'holder-2' }],
        [{ threshold: 2 }],
      ]),
      transaction: vi.fn(),
    }

    const svc = new RecoveryGroupService(db as never)
    await expect(
      svc.completeRecovery({
        sessionId: SESSION_ID,
        sigchainSeqNo: 0,
        sigchainPayload: { sessionId: 'wrong-session', contributingHolderPubkeys: ['holder-1', 'holder-2'] },
        signature: 'aa'.repeat(64),
        prevHash: '',
        hash: 'bb'.repeat(32),
        signerDeviceId: SIGNER_DEVICE_ID,
        timestamp: TIMESTAMP,
      }),
    ).rejects.toMatchObject({ status: 400 })
    expect(db.transaction).not.toHaveBeenCalled()
  })
})
