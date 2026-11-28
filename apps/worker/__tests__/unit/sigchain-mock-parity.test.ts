/**
 * Parity: the Playwright Tauri IPC mock (tests/mocks/sigchain-mock.ts) and the
 * server's `computeEntryHash` against vectors pinned in the Rust crate
 * (packages/crypto/tests/identity_init.rs and sigchain.rs
 * `test_cross_language_vectors`). Ed25519 is deterministic, so a mock that
 * mirrors Rust must reproduce every byte — no field is excluded from the
 * comparison. If one of these fails, desktop E2E is testing a client that does
 * not exist.
 */
import { describe, expect, it } from 'vitest'
import { bytesToHex } from '@noble/hashes/utils.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { ml_kem768_x25519 } from '@noble/post-quantum/hybrid.js'
import { computeEntryHash } from '@worker/services/crypto-keys'
import { hpkeOpenMock } from '../../../../tests/mocks/hpke-mock'
import {
  computeEntryHashMock,
  createInitialPukMock,
  createSigchainLinkMock,
  derivePukSubkeysMock,
  DEVICE_KEM_FORMAT,
  devicePopMessageMock,
  pukWrapAad,
  signDevicePopMock,
  userInitPayloadMock,
  verifyUserSigchainsMock,
  verifySigchainLinkMock,
  verifySigchainMock,
  type MockSigchainLink,
} from '../../../../tests/mocks/sigchain-mock'
import { LABEL_PUK_WRAP_TO_DEVICE } from '@shared/crypto-labels'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hexToBytes } from '@noble/hashes/utils.js'
import { sigchainGenesisPayloadSchema, sigchainPukEpochPayloadSchema } from '@protocol/schemas/sigchain'

// ── packages/crypto/src/sigchain.rs test_cross_language_vectors ──────────
const CROSS_LANGUAGE = [
  {
    seq: 1, prevHash: null, timestamp: '2026-01-01T00:00:00Z',
    payloadJson: '{"type":"user_init","deviceId":"device-001"}',
    hash: '7993a9e36114d2dff4fd882aa7261231beed2d5109aa84e01c8f46ee49e896a4',
  },
  {
    seq: 2, prevHash: 'aa'.repeat(32), timestamp: '2026-01-01T00:01:00Z',
    payloadJson: '{"type":"puk_rotate","generation":2}',
    hash: '2944558cc144bc39d1910a5ac26f5811cacd8678a70f88655e8baa37ecff0c2e',
  },
  {
    seq: 3, prevHash: '2944558cc144bc39d1910a5ac26f5811cacd8678a70f88655e8baa37ecff0c2e', timestamp: '2026-01-01T00:02:00Z',
    payloadJson: '{"type":"device_add","deviceId":"device-002","devicePubkey":"ff00ee11"}',
    hash: '9fa457d087b537494dd0761ff5f5ec1651f844229cccda9f8cbb92342d618e2e',
  },
] as const

// ── packages/crypto/tests/identity_init.rs ────────────────────────────
const DEVICE_SIGNING_SEED = new Uint8Array(32).fill(0x11)
const DEVICE_ENCRYPTION_SEED = new Uint8Array(32).fill(0x22)
const DEVICE_KEM_SEED = new Uint8Array(32).fill(0x44)
const PUK_SEED = new Uint8Array(32).fill(0x33)
const DEVICE_ID = 'device-genesis-001'
const GENESIS_TIMESTAMP = '2026-09-26T00:00:00.000Z'
const PUK_EPOCH_TIMESTAMP = '2026-09-26T00:00:01.000Z'

const DEVICE_SIGNING_PUBKEY = 'd04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737'
const DEVICE_ENCRYPTION_PUBKEY = '0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20'
const PUK_SIGN_PUBKEY = 'a4ed4a7ec643c741dbba79154761afa9eefd736e41de49cbe7eca73f45c10372'
const PUK_DH_PUBKEY = '9022243e22195ddbe4e0953be4bb6e7dab8f9b39b45a910e8b038e177add7949'
const DEVICE_KEM_PUBKEY_SHA256 = '0d952cc4e7f6d0c663756af1e9bd03f3df4112f62909eb8e8ea575703a130809'
const GENESIS_POP = '646c84c3c43ffb8d14614e72b17e3eb2ddd736ce0c10c065f5c3c1dad7fed617e735b05aa3defc088e7409790ad0443697871fcd185dd74611777eeb46a3b704'
const GENESIS_ENTRY_HASH = '7dfa75be549821b49ad6ee398762b708ab107a73c4d316cb4d424db2e018ee22'
const GENESIS_SIGNATURE = '52754e1361a6003f963c2ac48ab9646c3285ebc52836b785c589326a65bbe01271616406b60c35a5674f91a3e6914b988e1cb9e5f6f386145c09842ada80060f'
const PUK_EPOCH_ENTRY_HASH = 'cc2a325f75a1d8bd8fb51817e1d1fc3a90f78c40fc6de71498977e251169ea93'
const PUK_EPOCH_SIGNATURE = 'ff725cfdaa519bd2a17468ad1d49b74b823d554d28fe354651231bad6276478a1fee2be8752dbe22e66ebafc791a6ea8aea17574546f16c06130bad739b1d804'

/** The device's X-Wing public key, as `device_keys::xwing_public_key` derives it from its seed. */
const DEVICE_KEM_PUBKEY = bytesToHex(ml_kem768_x25519.keygen(DEVICE_KEM_SEED).publicKey)

/** The identity-init chain exactly as identity_init.rs builds it (same payload key order). */
function buildIdentityInitChain(): MockSigchainLink[] {
  const devicePubkey = DEVICE_SIGNING_PUBKEY
  const deviceEncryptionPubkey = bytesToHex(x25519.getPublicKey(DEVICE_ENCRYPTION_SEED))
  const pop = signDevicePopMock(DEVICE_SIGNING_SEED, devicePubkey, DEVICE_KEM_PUBKEY, DEVICE_KEM_FORMAT)
  const genesis = createSigchainLinkMock(
    DEVICE_SIGNING_SEED, 'link-genesis', DEVICE_ID, 1, null, GENESIS_TIMESTAMP,
    JSON.stringify({
      type: 'user_init', deviceId: DEVICE_ID, devicePubkey, deviceEncryptionPubkey,
      encryptionPubkey: DEVICE_KEM_PUBKEY, format: DEVICE_KEM_FORMAT, pop,
    }),
  )
  const puk = derivePukSubkeysMock(PUK_SEED, 1)
  const epoch = createSigchainLinkMock(
    DEVICE_SIGNING_SEED, 'link-puk-epoch', DEVICE_ID, 2, genesis.entryHash, PUK_EPOCH_TIMESTAMP,
    JSON.stringify({ type: 'puk_epoch', generation: 1, signPubkey: puk.signPubkeyHex, dhPubkey: puk.dhPubkeyHex }),
  )
  return [genesis, epoch]
}

describe('sigchain entry hash — Rust cross-language vectors', () => {
  it.each(CROSS_LANGUAGE)('mock reproduces seq $seq', (v) => {
    expect(computeEntryHashMock(v.seq, v.prevHash, v.timestamp, 'device-001', 'ab01cd02', v.payloadJson)).toBe(v.hash)
  })

  it.each(CROSS_LANGUAGE)('server computeEntryHash reproduces seq $seq', (v) => {
    expect(computeEntryHash(v.seq, v.prevHash, v.timestamp, 'device-001', 'ab01cd02', JSON.parse(v.payloadJson))).toBe(v.hash)
  })
})

describe('identity initialisation — Rust identity_init.rs vectors', () => {
  it('derives the same device and PUK public keys', () => {
    expect(bytesToHex(x25519.getPublicKey(DEVICE_ENCRYPTION_SEED))).toBe(DEVICE_ENCRYPTION_PUBKEY)
    // noble's X-Wing keygen from a 32-byte seed is the crate's.
    expect(bytesToHex(sha256(hexToBytes(DEVICE_KEM_PUBKEY)))).toBe(DEVICE_KEM_PUBKEY_SHA256)
    expect(derivePukSubkeysMock(PUK_SEED, 1)).toEqual({
      generation: 1,
      signPubkeyHex: PUK_SIGN_PUBKEY,
      dhPubkeyHex: PUK_DH_PUBKEY,
    })
  })

  it('produces byte-identical genesis and puk_epoch links', () => {
    const [genesis, epoch] = buildIdentityInitChain()
    expect(genesis).toMatchObject({
      seq: 1, prevHash: null, signerDeviceId: DEVICE_ID, signerPubkey: DEVICE_SIGNING_PUBKEY,
      entryHash: GENESIS_ENTRY_HASH, signature: GENESIS_SIGNATURE,
    })
    expect(epoch).toMatchObject({
      seq: 2, prevHash: GENESIS_ENTRY_HASH, signerDeviceId: DEVICE_ID, signerPubkey: DEVICE_SIGNING_PUBKEY,
      entryHash: PUK_EPOCH_ENTRY_HASH, signature: PUK_EPOCH_SIGNATURE,
    })
  })

  it('signs the same genesis pop, and builds the same user_init as the crate', () => {
    expect(signDevicePopMock(DEVICE_SIGNING_SEED, DEVICE_SIGNING_PUBKEY, DEVICE_KEM_PUBKEY, DEVICE_KEM_FORMAT)).toBe(GENESIS_POP)
    const [genesis] = buildIdentityInitChain()
    expect(JSON.parse(userInitPayloadMock(DEVICE_SIGNING_SEED, DEVICE_ID, DEVICE_ENCRYPTION_PUBKEY, DEVICE_KEM_PUBKEY)))
      .toEqual(JSON.parse(genesis.payloadJson))
  })

  it('payloads match the protocol wire schemas', () => {
    const [genesis, epoch] = buildIdentityInitChain()
    expect(sigchainGenesisPayloadSchema.safeParse(JSON.parse(genesis.payloadJson)).success).toBe(true)
    expect(sigchainPukEpochPayloadSchema.safeParse(JSON.parse(epoch.payloadJson)).success).toBe(true)
  })

  it('server recomputes the same entry hashes from the stored payload objects', () => {
    for (const link of buildIdentityInitChain()) {
      expect(computeEntryHash(link.seq, link.prevHash, link.timestamp, link.signerDeviceId, link.signerPubkey, JSON.parse(link.payloadJson)))
        .toBe(link.entryHash)
    }
  })

  it('verifies like Rust verify_sigchain', () => {
    const chain = buildIdentityInitChain()
    expect(verifySigchainMock(chain)).toEqual({
      userPubkey: DEVICE_SIGNING_PUBKEY,
      verifiedCount: 2,
      headSeq: 2,
      headHash: PUK_EPOCH_ENTRY_HASH,
      activeDevicePubkeys: [DEVICE_SIGNING_PUBKEY],
      activeDeviceKeys: [{ devicePubkey: DEVICE_SIGNING_PUBKEY, encryptionPubkey: DEVICE_KEM_PUBKEY, format: DEVICE_KEM_FORMAT }],
      namedKeys: [DEVICE_SIGNING_PUBKEY, DEVICE_ENCRYPTION_PUBKEY, DEVICE_KEM_PUBKEY].sort(),
    })
    // Same rejections identity_init.rs asserts.
    expect(() => verifySigchainMock([chain[1]])).toThrow('first sigchain link must have seq=1')
    expect(() => verifySigchainMock([chain[1], chain[0]])).toThrow()
  })
})

describe('mock verifier rejects what Rust rejects', () => {
  it('rejects a tampered payload', () => {
    const [genesis, epoch] = buildIdentityInitChain()
    const tampered = { ...epoch, payloadJson: epoch.payloadJson.replace('"generation":1', '"generation":2') }
    expect(verifySigchainLinkMock(tampered, DEVICE_SIGNING_PUBKEY)).toBe(false)
    expect(() => verifySigchainMock([genesis, tampered])).toThrow('signature verification failed')
  })

  it('rejects a link signed by a key outside the active device set', () => {
    const [genesis] = buildIdentityInitChain()
    const outsider = createSigchainLinkMock(
      new Uint8Array(32).fill(0x44), 'l2', 'other', 2, genesis.entryHash, PUK_EPOCH_TIMESTAMP, '{"type":"puk_epoch"}',
    )
    expect(() => verifySigchainMock([genesis, outsider])).toThrow('not in active device set')
  })

  it('a genesis naming a device other than its signer is refused', () => {
    const payload = JSON.parse(userInitPayloadMock(DEVICE_SIGNING_SEED, DEVICE_ID, DEVICE_ENCRYPTION_PUBKEY, DEVICE_KEM_PUBKEY)) as Record<string, unknown>
    const genesis = createSigchainLinkMock(
      DEVICE_SIGNING_SEED, 'g', DEVICE_ID, 1, null, GENESIS_TIMESTAMP,
      JSON.stringify({ ...payload, devicePubkey: 'ff'.repeat(32) }),
    )
    expect(() => verifySigchainMock([genesis])).toThrow(/^chain_unauthorised_signer: /)
  })

  it('rejects a first link that is not user_init', () => {
    const link = createSigchainLinkMock(DEVICE_SIGNING_SEED, 'g', DEVICE_ID, 1, null, GENESIS_TIMESTAMP, '{"type":"device_add"}')
    expect(() => verifySigchainMock([link])).toThrow('first sigchain link must have type=user_init')
  })

  it('a signer-pubkey mismatch is false, not an error', () => {
    const [genesis] = buildIdentityInitChain()
    expect(verifySigchainLinkMock(genesis, 'ab'.repeat(32))).toBe(false)
  })
})

describe('PUK seed envelope', () => {
  it('is sealed to the device under LABEL_PUK_WRAP_TO_DEVICE with AAD "<label>:<deviceId>"', async () => {
    const { state, envelope } = await createInitialPukMock(DEVICE_ENCRYPTION_PUBKEY, DEVICE_ID, PUK_SEED)
    expect(state).toEqual({ generation: 1, signPubkeyHex: PUK_SIGN_PUBKEY, dhPubkeyHex: PUK_DH_PUBKEY })
    const opened = await hpkeOpenMock(envelope, bytesToHex(DEVICE_ENCRYPTION_SEED), LABEL_PUK_WRAP_TO_DEVICE, pukWrapAad(DEVICE_ID))
    expect(bytesToHex(opened)).toBe(bytesToHex(PUK_SEED))
    // Bound to the device ID: opening with another device's AAD fails.
    await expect(hpkeOpenMock(envelope, bytesToHex(DEVICE_ENCRYPTION_SEED), LABEL_PUK_WRAP_TO_DEVICE, pukWrapAad('other-device')))
      .rejects.toThrow()
  })
})

// ── packages/crypto/tests/fixtures/v2/device-binding.json (#2496) ─────────
describe('device binding: the mock against the crate\'s vectors', () => {
  const f = JSON.parse(
    readFileSync(join(__dirname, '../../../../packages/crypto/tests/fixtures/v2/device-binding.json'), 'utf8'),
  ) as {
    popMessage: { user: string; signingPk: string; encryptionPk: string; format: number; messageHex: string }
    positives: Array<{ name: string; chains: MockSigchainLink[][]; expect: unknown }>
    negatives: Array<{ name: string; chains: MockSigchainLink[][]; expect: string }>
  }

  it('builds the pop message byte for byte', () => {
    const m = f.popMessage
    expect(bytesToHex(devicePopMessageMock(m.user, hexToBytes(m.signingPk), hexToBytes(m.encryptionPk), m.format))).toBe(m.messageHex)
  })

  it.each(f.positives.map(p => [p.name, p] as const))('accepts %s with the same active device keys', (_n, p) => {
    expect(verifyUserSigchainsMock(p.chains).map(st => st.activeDeviceKeys)).toEqual(p.expect)
  })

  it.each(f.negatives.map(n => [n.name, n] as const))('refuses %s with the same code', (_n, n) => {
    expect(() => verifyUserSigchainsMock(n.chains)).toThrow(new RegExp(`^${n.expect}: `))
  })

  it('covers every vector', () => {
    expect(f.positives).toHaveLength(3)
    expect(f.negatives).toHaveLength(9)
  })
})
