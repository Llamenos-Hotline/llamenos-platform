/**
 * Test-side identity initialisation — sigchain genesis + first PUK — through
 * the real authenticated API, exactly as src/client/lib/user-identity.ts does
 * it (docs/protocol/PROTOCOL.md §2.11 "Identity initialisation").
 *
 * Link hashing/signing and PUK derivation come from tests/mocks/sigchain-mock.ts,
 * whose output is pinned byte-for-byte against packages/crypto
 * (apps/worker/__tests__/unit/sigchain-mock-parity.test.ts), so a chain built
 * here is one the Rust `verify_sigchain` accepts.
 *
 * Pure of Playwright fixtures: callers pass an APIRequestContext.
 */
import { expect, type APIRequestContext, type Page } from '@playwright/test'
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { LABEL_DEVICE_ENCRYPTION_SEED, LABEL_PUK_WRAP_TO_DEVICE } from '@shared/crypto-labels'
import {
  SIGCHAIN_GENESIS_SEQ,
  sigchainGenesisPayloadSchema,
  sigchainPukEpochPayloadSchema,
  type AppendSigchainLinkBody,
  type PukHpkeEnvelope,
  type SigchainLinkRecord,
  type SigchainLinkType,
  type SigchainResponse,
} from '@protocol/schemas/sigchain'
import { apiGet, apiPost } from './api-helpers'
import {
  createInitialPukMock,
  createSigchainLinkMock,
  pukWrapAad,
  verifySigchainMock,
  type MockPukState,
  type MockSigchainLink,
} from './mocks/sigchain-mock'
import { hpkeSealMock } from './mocks/hpke-mock'

/** One device of a test user: signing key = the user's identity key for the first device. */
export interface TestDevice {
  deviceId: string
  /** Ed25519 signing seed, hex. */
  signingSeedHex: string
  signingPubkeyHex: string
  /** X25519 encryption seed — HKDF(signingSeed, LABEL_DEVICE_ENCRYPTION_SEED), as device_import_and_load derives it. */
  encryptionSeed: Uint8Array
  encryptionPubkeyHex: string
}

/** A device whose keys derive from `signingSeedHex` the way the desktop client imports a seed. */
export function testDevice(signingSeedHex: string, deviceId?: string): TestDevice {
  const signingPubkeyHex = bytesToHex(ed25519.getPublicKey(hexToBytes(signingSeedHex)))
  const encryptionSeed = hkdf(
    sha256,
    hexToBytes(signingSeedHex),
    new Uint8Array(0),
    utf8ToBytes(LABEL_DEVICE_ENCRYPTION_SEED),
    32,
  )
  return {
    deviceId: deviceId ?? `test-device-${signingPubkeyHex.slice(0, 12)}`,
    signingSeedHex,
    signingPubkeyHex,
    encryptionSeed,
    encryptionPubkeyHex: bytesToHex(x25519.getPublicKey(encryptionSeed)),
  }
}

/** A fresh device with random keys (e.g. a second device being authorised). */
export function randomTestDevice(deviceId: string): TestDevice {
  return testDevice(bytesToHex(randomBytes(32)), deviceId)
}

/**
 * Sign `payload` as the link after `head` with `signer`'s key. The signer's
 * key must be the user's identity key — every generic link is verified
 * against it server-side.
 */
export function buildSigchainLink(
  signer: TestDevice,
  head: Pick<SigchainLinkRecord, 'seqNo' | 'hash'> | null,
  linkType: SigchainLinkType,
  payload: Record<string, unknown>,
  timestamp = new Date().toISOString(),
): AppendSigchainLinkBody {
  const seqNo = head ? head.seqNo + 1 : SIGCHAIN_GENESIS_SEQ
  const link = createSigchainLinkMock(
    hexToBytes(signer.signingSeedHex),
    crypto.randomUUID(),
    signer.deviceId,
    seqNo,
    head?.hash ?? null,
    timestamp,
    JSON.stringify(payload),
  )
  return {
    seqNo,
    linkType,
    payload,
    signature: link.signature,
    prevHash: head?.hash ?? '',
    hash: link.entryHash,
    signerDeviceId: link.signerDeviceId,
    signerPubkey: link.signerPubkey,
    timestamp,
  }
}

export function genesisPayload(device: TestDevice): Record<string, unknown> {
  return {
    type: 'user_init',
    deviceId: device.deviceId,
    devicePubkey: device.signingPubkeyHex,
    deviceEncryptionPubkey: device.encryptionPubkeyHex,
  }
}

export function deviceAddPayload(device: TestDevice): Record<string, unknown> {
  return {
    type: 'device_add',
    deviceId: device.deviceId,
    devicePubkey: device.signingPubkeyHex,
    deviceEncryptionPubkey: device.encryptionPubkeyHex,
  }
}

/** Server sigchain record → packages/crypto `SigchainLink` (mirrors toCryptoSigchainLink in user-identity.ts). */
export function toMockSigchainLink(record: SigchainLinkRecord): MockSigchainLink {
  return {
    id: record.id,
    seq: record.seqNo,
    prevHash: record.prevHash === '' ? null : record.prevHash,
    entryHash: record.hash,
    signerDeviceId: record.signerDeviceId,
    signerPubkey: record.signerPubkey,
    signature: record.signature,
    timestamp: record.timestamp,
    payloadJson: JSON.stringify(record.payload),
  }
}

/** A PUK seed envelope sealed to `device`, as `puk::create_initial_puk` / `rotate_puk` seal it. */
export function sealPukSeed(seed: Uint8Array, device: TestDevice): PukHpkeEnvelope {
  const env = hpkeSealMock(seed, device.encryptionPubkeyHex, LABEL_PUK_WRAP_TO_DEVICE, pukWrapAad(device.deviceId))
  return { v: 3, labelId: env.labelId, enc: env.enc, ct: env.ct }
}

export async function getSigchainViaApi(
  request: APIRequestContext,
  userPubkey: string,
  seedHex: string,
): Promise<SigchainLinkRecord[]> {
  const res = await apiGet<SigchainResponse>(request, `/users/${userPubkey}/sigchain`, seedHex)
  if (res.status !== 200) throw new Error(`GET sigchain failed: ${res.status}`)
  return res.data.links
}

export interface InitializedIdentity {
  device: TestDevice
  links: SigchainLinkRecord[]
  puk: MockPukState
  pukSeed: Uint8Array
}

/**
 * Identity initialisation for a user whose identity key is `device`'s signing
 * key: genesis (seq 1) → PUK gen 1 envelope → puk_epoch (seq 2). Same order
 * as the client: the envelope is stored before the chain claims the PUK.
 */
export async function initializeIdentityViaApi(
  request: APIRequestContext,
  userPubkey: string,
  device: TestDevice,
): Promise<InitializedIdentity> {
  if (device.signingPubkeyHex !== userPubkey) {
    throw new Error('identity initialisation must be signed by the user\'s identity key')
  }
  const post = async (body: AppendSigchainLinkBody): Promise<SigchainLinkRecord> => {
    const res = await apiPost<SigchainLinkRecord>(request, `/users/${userPubkey}/sigchain`, body, device.signingSeedHex)
    if (res.status !== 201) throw new Error(`append ${body.linkType} failed: ${res.status} ${JSON.stringify(res.data)}`)
    return res.data
  }

  const genesis = await post(buildSigchainLink(device, null, 'genesis', genesisPayload(device)))

  const { state, seed, envelope } = createInitialPukMock(device.encryptionPubkeyHex, device.deviceId)
  const envRes = await apiPost(request, '/puk/envelopes', {
    envelopes: [{ deviceId: device.deviceId, generation: state.generation, envelope }],
  }, device.signingSeedHex)
  if (envRes.status !== 201) throw new Error(`PUK envelope failed: ${envRes.status} ${JSON.stringify(envRes.data)}`)

  const epoch = await post(buildSigchainLink(device, genesis, 'puk_epoch', {
    type: 'puk_epoch',
    generation: state.generation,
    signPubkey: state.signPubkeyHex,
    dhPubkey: state.dhPubkeyHex,
  }))

  return { device, links: [genesis, epoch], puk: state, pukSeed: seed }
}

// ── Desktop E2E: read the identity the in-browser client created ─────────

export interface PageIdentity {
  pubkey: string
  deviceId: string
  links: SigchainLinkRecord[]
  /** Latest PUK envelope addressed to this device, or null if none. */
  pukEnvelope: { generation: number; envelope: PukHpkeEnvelope } | null
  /** Whether this device's CryptoState opened that envelope (label + AAD bound to its deviceId). */
  pukEnvelopeOpens: boolean
}

/**
 * Read, as the logged-in desktop client itself, the sigchain and PUK envelope
 * its onboarding produced. Requests are signed in-page by the client's own
 * CryptoState (window.__TEST_PLATFORM), and the envelope is opened by that
 * CryptoState — nothing here holds the device's private keys.
 */
export async function readIdentityFromPage(page: Page): Promise<PageIdentity> {
  await page.waitForFunction(() => !!window.__TEST_PLATFORM, { timeout: 30_000 })
  return page.evaluate(async ({ pukLabel }) => {
    const platform = window.__TEST_PLATFORM
    if (!platform) throw new Error('__TEST_PLATFORM not available')
    const device = await platform.getDevicePubkeys()
    if (!device) throw new Error('device keys are not unlocked')

    const authedGet = async (path: string) => {
      const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('')
      const token = await platform.createAuthToken(Date.now(), 'GET', `/api${path}`, nonce)
      return fetch(`/api${path}`, { headers: { Authorization: `Bearer ${token}` } })
    }

    const chainRes = await authedGet(`/users/${device.signingPubkeyHex}/sigchain`)
    if (!chainRes.ok) throw new Error(`GET sigchain: ${chainRes.status}`)
    const { links } = await chainRes.json()

    const envRes = await authedGet(`/puk/envelopes/${encodeURIComponent(device.deviceId)}`)
    let pukEnvelope = null
    let pukEnvelopeOpens = false
    if (envRes.ok) {
      const body = await envRes.json()
      pukEnvelope = { generation: body.generation, envelope: body.envelope }
      const aad = new TextEncoder().encode(`${pukLabel}:${device.deviceId}`)
      const aadHex = Array.from(aad, b => b.toString(16).padStart(2, '0')).join('')
      try {
        await platform.pukUnwrapSeedFromState(body.envelope, pukLabel, aadHex)
        pukEnvelopeOpens = true
      } catch {
        pukEnvelopeOpens = false
      }
    }
    return { pubkey: device.signingPubkeyHex, deviceId: device.deviceId, links, pukEnvelope, pukEnvelopeOpens }
  }, { pukLabel: LABEL_PUK_WRAP_TO_DEVICE })
}

/**
 * Assert the desktop client in `page` initialised its user's identity
 * (PROTOCOL.md §2.11): the stored chain is exactly genesis + puk_epoch, it
 * verifies under the packages/crypto `verify_sigchain` rules, it authorises
 * this device and only this device, the genesis names this device's keys, and
 * this device's CryptoState opens its generation-1 PUK envelope.
 */
export async function expectInitialisedIdentity(page: Page): Promise<PageIdentity> {
  const identity = await readIdentityFromPage(page)

  expect(identity.links.map(l => `${l.seqNo}:${l.linkType}`)).toEqual(['1:genesis', '2:puk_epoch'])
  const verified = verifySigchainMock(identity.links.map(toMockSigchainLink))
  expect(verified.activeDevicePubkeys).toEqual([identity.pubkey])
  expect(verified.headHash).toBe(identity.links[1].hash)

  const genesis = sigchainGenesisPayloadSchema.parse(identity.links[0].payload)
  expect(genesis.deviceId).toBe(identity.deviceId)
  expect(genesis.devicePubkey).toBe(identity.pubkey)
  const epoch = sigchainPukEpochPayloadSchema.parse(identity.links[1].payload)
  expect(epoch.generation).toBe(1)

  expect(identity.pukEnvelope?.generation).toBe(1)
  expect(identity.pukEnvelopeOpens).toBe(true)
  return identity
}
