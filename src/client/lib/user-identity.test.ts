/**
 * Identity initialisation resumes a chain that stopped part-way (#3051).
 *
 * The `puk_epoch` link binds the PUK's public keys into the user's chain; a
 * genesis-only chain leaves the generation-1 envelope with nothing to verify
 * it against. So a chain holding genesis but no `puk_epoch` is an unfinished
 * initialisation, and the signed-in start (`ensureDeviceIdentity`) must finish
 * it — not verify it as if it were done.
 *
 * The server is an in-memory chain that refuses an append off its head, as the
 * real route does. Links are signed and verified by tests/mocks/sigchain-mock.ts,
 * which is pinned byte-for-byte to packages/crypto
 * (apps/worker/__tests__/unit/sigchain-mock-parity.test.ts), so the chain these
 * tests assert on is one the Rust verifier accepts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { ml_kem768_x25519 } from '@noble/post-quantum/hybrid.js'
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js'
import type {
  AppendSigchainLinkBody,
  DistributePukEnvelopesBody,
  SigchainLinkRecord,
  SigchainPukEpochPayload,
} from '@protocol/schemas'
import {
  createInitialPukMock,
  createSigchainLinkMock,
  userInitPayloadMock,
  verifySigchainMock,
  type MockPukState,
} from '../../../tests/mocks/sigchain-mock'
import type { DeviceKeyState, PukCreateResult, VerifiedSigchainHead } from './platform'
import { ApiError } from './api/client'

interface Device {
  signingSeed: Uint8Array
  keys: DeviceKeyState
}

function newDevice(deviceId: string): Device {
  const signingSeed = randomBytes(32)
  return {
    signingSeed,
    keys: {
      deviceId,
      signingPubkeyHex: bytesToHex(ed25519.getPublicKey(signingSeed)),
      encryptionPubkeyHex: bytesToHex(x25519.getPublicKey(randomBytes(32))),
      kemPubkeyHex: bytesToHex(ml_kem768_x25519.keygen(randomBytes(32)).publicKey),
    },
  }
}

/** The server: one user's chain, refusing an append that is not off its head. */
const server = {
  links: [] as SigchainLinkRecord[],
  envelopes: [] as DistributePukEnvelopesBody['envelopes'],
}
/** This device: its unlocked keys, the head it recorded, the PUK states Rust created. */
const local = {
  device: null as Device | null,
  head: null as VerifiedSigchainHead | null,
  puks: [] as MockPukState[],
}

vi.mock('./api/identity', () => ({
  getSigchain: vi.fn(async () => ({ links: [...server.links] })),
  appendSigchainLink: vi.fn(async (userPubkey: string, body: AppendSigchainLinkBody) => {
    const head = server.links.at(-1)
    if (body.seqNo !== (head ? head.seqNo + 1 : 1)) throw new ApiError(409, 'sequence mismatch')
    if ((body.prevHash ?? null) !== (head?.hash ?? null)) throw new ApiError(409, 'prevHash mismatch')
    const record: SigchainLinkRecord = {
      ...body,
      id: crypto.randomUUID(),
      userPubkey,
      prevHash: body.prevHash ?? null,
      createdAt: new Date().toISOString(),
    }
    server.links.push(record)
    return record
  }),
  distributePukEnvelopes: vi.fn(async (body: DistributePukEnvelopesBody) => {
    // The route upserts on (user, device, generation).
    for (const e of body.envelopes) {
      server.envelopes = server.envelopes.filter(x => x.deviceId !== e.deviceId || x.generation !== e.generation)
      server.envelopes.push(e)
    }
    return { distributed: body.envelopes.length }
  }),
}))

vi.mock('./platform', async importOriginal => {
  const unlocked = (): Device => {
    if (!local.device) throw new Error('locked')
    return local.device
  }
  return {
    ...(await importOriginal<typeof import('./platform')>()),
    getDevicePubkeys: vi.fn(async () => local.device?.keys ?? null),
    getVerifiedSigchainHead: vi.fn(async () => local.head),
    setVerifiedSigchainHead: vi.fn(async (head: VerifiedSigchainHead) => { local.head = head }),
    userInitPayloadFromState: vi.fn(async () => {
      const d = unlocked()
      return userInitPayloadMock(d.signingSeed, d.keys.deviceId, d.keys.encryptionPubkeyHex, d.keys.kemPubkeyHex)
    }),
    pukCreateFromState: vi.fn(async (): Promise<PukCreateResult> => {
      const d = unlocked()
      const { state, envelope } = await createInitialPukMock(d.keys.encryptionPubkeyHex, d.keys.deviceId)
      local.puks.push(state)
      return { pukState: state, envelope }
    }),
    sigchainCreateLinkFromState: vi.fn(async (id: string, seq: number, prevHash: string | null, timestamp: string, payloadJson: string) => {
      const d = unlocked()
      return createSigchainLinkMock(d.signingSeed, id, d.keys.deviceId, seq, prevHash, timestamp, payloadJson)
    }),
    sigchainVerify: vi.fn(async (links: Parameters<typeof verifySigchainMock>[0]) => verifySigchainMock(links)),
  }
})

const { ensureDeviceIdentity, initializeUserIdentity, toCryptoSigchainLink } = await import('./user-identity')
const { distributePukEnvelopes, appendSigchainLink, getSigchain } = await import('./api/identity')

/** Stop an initialisation after its genesis: the PUK envelope POST fails. */
async function strandAfterGenesis(user: string): Promise<void> {
  vi.mocked(distributePukEnvelopes).mockRejectedValueOnce(new ApiError(503, 'unavailable'))
  await expect(initializeUserIdentity(user)).rejects.toThrow('503')
  expect(server.links.map(l => l.linkType)).toEqual(['genesis'])
}

/**
 * The chain the server now holds is complete: it verifies, its seq 2 is a
 * `puk_epoch` for generation 1 naming the PUK whose seed this device sealed,
 * and that seed's envelope is stored for this device.
 */
function expectCompleteChain(device: Device): void {
  expect(server.links.map(l => l.linkType)).toEqual(['genesis', 'puk_epoch'])
  const verified = verifySigchainMock(server.links.map(toCryptoSigchainLink))
  expect(verified.userPubkey).toBe(device.keys.signingPubkeyHex)
  expect(verified.headSeq).toBe(2)

  const epoch = server.links[1].payload as SigchainPukEpochPayload
  const puk = local.puks.at(-1)
  expect(puk).toBeDefined()
  expect(epoch).toEqual({ type: 'puk_epoch', generation: 1, signPubkey: puk?.signPubkeyHex, dhPubkey: puk?.dhPubkeyHex })
  expect(server.envelopes.map(e => [e.deviceId, e.generation])).toEqual([[device.keys.deviceId, 1]])
  expect(local.head).toEqual({ userPubkey: device.keys.signingPubkeyHex, seq: 2, hash: server.links[1].hash })
}

beforeEach(() => {
  server.links = []
  server.envelopes = []
  local.device = null
  local.head = null
  local.puks = []
})

describe('ensureDeviceIdentity resumes a genesis-only chain (#3051)', () => {
  it('appends the puk_epoch an initialisation stopped before', async () => {
    const device = newDevice('device-identity')
    local.device = device
    await strandAfterGenesis(device.keys.signingPubkeyHex)

    await ensureDeviceIdentity(device.keys.signingPubkeyHex)

    expectCompleteChain(device)
  })

  it('resumes after the envelope was stored but the puk_epoch append was refused', async () => {
    const device = newDevice('device-identity')
    local.device = device
    vi.mocked(appendSigchainLink).mockImplementationOnce(vi.mocked(appendSigchainLink).getMockImplementation()!)
      .mockRejectedValueOnce(new ApiError(503, 'unavailable'))
    await expect(initializeUserIdentity(device.keys.signingPubkeyHex)).rejects.toThrow('503')
    expect(server.links.map(l => l.linkType)).toEqual(['genesis'])
    expect(server.envelopes).toHaveLength(1)

    await ensureDeviceIdentity(device.keys.signingPubkeyHex)

    expectCompleteChain(device)
  })

  it('resumes a genesis-only chain this device already recorded as its verified head', async () => {
    const device = newDevice('device-identity')
    local.device = device
    await strandAfterGenesis(device.keys.signingPubkeyHex)
    // A build that took the stranded chain as initialised verified it and kept its head.
    local.head = { userPubkey: device.keys.signingPubkeyHex, seq: 1, hash: server.links[0].hash }

    await ensureDeviceIdentity(device.keys.signingPubkeyHex)

    expectCompleteChain(device)
  })

  it('a chain rolled back between the guard and the initialisation is refused, and nothing is signed', async () => {
    const device = newDevice('device-identity')
    local.device = device
    await strandAfterGenesis(device.keys.signingPubkeyHex)
    local.head = { userPubkey: device.keys.signingPubkeyHex, seq: 1, hash: server.links[0].hash }
    const genesis = server.links[0]
    vi.mocked(appendSigchainLink).mockClear()
    // The first read serves the chain this device verified; the read the
    // initialisation acts on serves it empty, inviting a second genesis.
    vi.mocked(getSigchain)
      .mockResolvedValueOnce({ links: [genesis], integrityBreak: null })
      .mockImplementationOnce(async () => { server.links = []; return { links: [], integrityBreak: null } })

    await expect(ensureDeviceIdentity(device.keys.signingPubkeyHex)).rejects.toThrow(
      'does not extend the head this device verified',
    )

    expect(vi.mocked(appendSigchainLink)).not.toHaveBeenCalled()
    expect(server.links).toEqual([])
    expect(server.envelopes).toEqual([])
  })

  it('a served genesis that does not verify is not extended, and no PUK is created for it', async () => {
    const device = newDevice('device-identity')
    local.device = device
    await strandAfterGenesis(device.keys.signingPubkeyHex)
    // The server now serves a genesis naming another X-Wing key: its hash no longer matches.
    const forged = { ...server.links[0], payload: { ...(server.links[0].payload as object), encryptionPubkey: newDevice('x').keys.kemPubkeyHex } }
    server.links = [forged]
    const puksBefore = local.puks.length

    await expect(ensureDeviceIdentity(device.keys.signingPubkeyHex)).rejects.toThrow('signature verification failed')

    expect(server.links).toEqual([forged])
    expect(server.envelopes).toEqual([])
    expect(local.puks).toHaveLength(puksBefore)
  })

  it('a device that did not create the chain reports it and appends nothing', async () => {
    const identity = newDevice('device-identity')
    local.device = identity
    await strandAfterGenesis(identity.keys.signingPubkeyHex)
    const genesis = server.links[0]

    local.device = newDevice('device-other')
    await expect(ensureDeviceIdentity(identity.keys.signingPubkeyHex)).rejects.toThrow(
      'Identity initialisation must run on the device that created the user',
    )

    expect(server.links).toEqual([genesis])
    expect(server.envelopes).toEqual([])
  })
})

describe('initializeUserIdentity keeps the rollback guard (#3051)', () => {
  it('refuses to sign a genesis over an empty chain when this device verified a head', async () => {
    const device = newDevice('device-identity')
    local.device = device
    await initializeUserIdentity(device.keys.signingPubkeyHex)
    expectCompleteChain(device)
    // The server rolls the chain back; the device kept its head (a re-import of
    // the same identity keeps it, platform.ts persistAndUnlockDeviceKeys).
    server.links = []
    vi.mocked(appendSigchainLink).mockClear()

    await expect(initializeUserIdentity(device.keys.signingPubkeyHex)).rejects.toThrow(
      'does not extend the head this device verified',
    )

    expect(vi.mocked(appendSigchainLink)).not.toHaveBeenCalled()
    expect(server.links).toEqual([])
  })
})
