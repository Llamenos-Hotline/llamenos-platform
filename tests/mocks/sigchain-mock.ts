/**
 * Mock sigchain + PUK primitives for the Playwright Tauri IPC mock.
 *
 * A line-for-line mirror of packages/crypto `sigchain.rs` and `puk.rs`, so that
 * a desktop client under Playwright produces and accepts exactly the chains the
 * real Rust CryptoState does. Pinned against the Rust crate's own vectors in
 * apps/worker/__tests__/unit/sigchain-mock-parity.test.ts
 * (packages/crypto/tests/identity_init.rs, sigchain.rs test_cross_language_vectors).
 *
 * The one intentional difference: PUK seed envelopes are sealed with the shared
 * mock HPKE primitive (hpke-mock.ts), because every envelope the Playwright
 * client opens is opened by that same mock (see hpke-mock.ts, issue #796).
 * Everything the envelope binds — label, AAD, recipient — matches Rust.
 *
 * Pure module: no `window`, no Tauri imports, safe to load from Node/Bun.
 */
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hmac } from '@noble/hashes/hmac.js'
import { gcm } from '@noble/ciphers/aes.js'
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import {
  LABEL_PUK_DH,
  LABEL_PUK_PREVIOUS_GEN,
  LABEL_PUK_SECRETBOX,
  LABEL_PUK_SIGN,
  LABEL_PUK_WRAP_TO_DEVICE,
} from '@shared/crypto-labels'
import { hpkeSealMock, type MockHpkeEnvelope } from './hpke-mock'

// ── Types (serde camelCase shapes of the Rust structs) ─────────────────

/** packages/crypto `sigchain::SigchainLink`. */
export interface MockSigchainLink {
  id: string
  seq: number
  prevHash: string | null
  entryHash: string
  signerDeviceId: string
  signerPubkey: string
  signature: string
  timestamp: string
  payloadJson: string
}

/** packages/crypto `sigchain::SigchainVerifiedState`. */
export interface MockSigchainVerifiedState {
  verifiedCount: number
  headSeq: number
  headHash: string
  activeDevicePubkeys: string[]
}

/** packages/crypto `puk::PukState`. */
export interface MockPukState {
  generation: number
  signPubkeyHex: string
  dhPubkeyHex: string
}

// ── Canonical JSON (serde_json without `preserve_order`) ──────────────

const utf8 = new TextEncoder()

/**
 * serde_json's `Map` is a `BTreeMap<String, Value>`, which orders keys by
 * their UTF-8 bytes. `Array.prototype.sort()` orders by UTF-16 code units,
 * which disagrees for keys mixing astral and U+E000..U+FFFF characters.
 */
function compareUtf8(a: string, b: string): number {
  const ab = utf8.encode(a)
  const bb = utf8.encode(b)
  const len = Math.min(ab.length, bb.length)
  for (let i = 0; i < len; i++) {
    if (ab[i] !== bb[i]) return ab[i] - bb[i]
  }
  return ab.length - bb.length
}

/** Deep-sort object keys the way serde_json's BTreeMap serialises them. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(obj).sort(compareUtf8)) sorted[key] = sortKeysDeep(obj[key])
    return sorted
  }
  return value
}

/**
 * Mirror of `sigchain::compute_entry_hash`: the payload JSON is parsed (a
 * parse failure is an error, as in Rust), then the six-key canonical object
 * is serialised compactly with keys sorted at every level and SHA-256'd.
 */
export function computeEntryHashMock(
  seq: number,
  prevHash: string | null,
  timestamp: string,
  signerDeviceId: string,
  signerPubkey: string,
  payloadJson: string,
): string {
  const payload: unknown = JSON.parse(payloadJson)
  const canonical = sortKeysDeep({
    payload,
    prevHash,
    seq,
    signerDeviceId,
    signerPubkey,
    timestamp,
  })
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify(canonical))))
}

// ── Hex comparison (mirror of `ct_hex_eq`) ─────────────────────────────

function decodeHex(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null
  return hexToBytes(hex.toLowerCase())
}

/** Mirror of `ct_hex_eq`: equal decoded bytes; malformed hex is never equal. */
function hexEq(a: string, b: string): boolean {
  const ab = decodeHex(a)
  const bb = decodeHex(b)
  if (!ab || !bb || ab.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i]
  return diff === 0
}

// ── Sigchain ───────────────────────────────────────────────────────────

/** Mirror of `sigchain::create_sigchain_link`. */
export function createSigchainLinkMock(
  signingSeed: Uint8Array,
  id: string,
  deviceId: string,
  seq: number,
  prevHash: string | null,
  timestamp: string,
  payloadJson: string,
): MockSigchainLink {
  const signerPubkey = bytesToHex(ed25519.getPublicKey(signingSeed))
  const entryHash = computeEntryHashMock(seq, prevHash, timestamp, deviceId, signerPubkey, payloadJson)
  const signature = bytesToHex(ed25519.sign(hexToBytes(entryHash), signingSeed))
  return {
    id,
    seq,
    prevHash,
    entryHash,
    signerDeviceId: deviceId,
    signerPubkey,
    signature,
    timestamp,
    payloadJson,
  }
}

/**
 * Mirror of `sigchain::verify_sigchain_link`: `false` for a signer mismatch,
 * a wrong entry hash or a bad signature; throws (Rust `Err`) for malformed
 * payload JSON, a non-32-byte pubkey or a non-64-byte signature.
 */
export function verifySigchainLinkMock(link: MockSigchainLink, expectedSignerPubkey: string): boolean {
  if (!hexEq(link.signerPubkey, expectedSignerPubkey)) return false

  const expectedHash = computeEntryHashMock(
    link.seq,
    link.prevHash,
    link.timestamp,
    link.signerDeviceId,
    link.signerPubkey,
    link.payloadJson,
  )
  if (!hexEq(expectedHash, link.entryHash)) return false

  const pubkey = decodeHex(link.signerPubkey)
  if (!pubkey) throw new Error('hex decode error: signerPubkey')
  if (pubkey.length !== 32) throw new Error('invalid public key')
  const hashBytes = decodeHex(link.entryHash)
  if (!hashBytes) throw new Error('hex decode error: entryHash')
  const sig = decodeHex(link.signature)
  if (!sig) throw new Error('hex decode error: signature')
  if (sig.length !== 64) throw new Error('signature verification failed')

  try {
    return ed25519.verify(sig, hashBytes, pubkey)
  } catch {
    // Rust: VerifyingKey::from_bytes rejects a point that does not decode.
    throw new Error('invalid public key')
  }
}

function payloadType(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const t = (payload as Record<string, unknown>).type
  return typeof t === 'string' ? t : undefined
}

function payloadDevicePubkey(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const k = (payload as Record<string, unknown>).devicePubkey
  return typeof k === 'string' ? k : undefined
}

/** Mirror of `sigchain::verify_sigchain`, including its error order and device-set walk. */
export function verifySigchainMock(links: MockSigchainLink[]): MockSigchainVerifiedState {
  if (links.length === 0) throw new Error('sigchain must have at least one link')

  const first = links[0]
  if (first.seq !== 1) throw new Error('first sigchain link must have seq=1')
  if (first.prevHash !== null) throw new Error('first sigchain link must have prevHash=null')

  const firstPayload: unknown = JSON.parse(first.payloadJson)
  if (payloadType(firstPayload) !== 'user_init') {
    throw new Error('first sigchain link must have type=user_init')
  }

  // Genesis authorises exactly its signer — NOT payload.devicePubkey.
  const activePubkeys: string[] = [first.signerPubkey]

  if (!verifySigchainLinkMock(first, first.signerPubkey)) {
    throw new Error('signature verification failed')
  }

  let prevHash = first.entryHash
  let prevSeq = first.seq

  for (const link of links.slice(1)) {
    if (link.seq !== prevSeq + 1) {
      throw new Error(`sequence gap: expected ${prevSeq + 1} but got ${link.seq}`)
    }
    if (link.prevHash === null || !hexEq(link.prevHash, prevHash)) {
      throw new Error(`prevHash mismatch at seq ${link.seq}`)
    }
    // Exact string membership, as Rust's Vec<String>::contains.
    if (!activePubkeys.includes(link.signerPubkey)) {
      throw new Error(`signer ${link.signerPubkey} not in active device set at seq ${link.seq}`)
    }
    if (!verifySigchainLinkMock(link, link.signerPubkey)) {
      throw new Error('signature verification failed')
    }

    // Rust ignores an unparseable payload here (`if let Ok(..)`).
    let payload: unknown
    try {
      payload = JSON.parse(link.payloadJson)
    } catch {
      payload = undefined
    }
    const type = payloadType(payload)
    const devicePubkey = payloadDevicePubkey(payload)
    if (type === 'device_add' && devicePubkey !== undefined) {
      if (!activePubkeys.includes(devicePubkey)) activePubkeys.push(devicePubkey)
    } else if (type === 'device_remove' && devicePubkey !== undefined) {
      for (let i = activePubkeys.length - 1; i >= 0; i--) {
        if (activePubkeys[i] === devicePubkey) activePubkeys.splice(i, 1)
      }
    }

    prevHash = link.entryHash
    prevSeq = link.seq
  }

  return {
    verifiedCount: links.length,
    headSeq: prevSeq,
    headHash: prevHash,
    activeDevicePubkeys: activePubkeys,
  }
}

// ── PUK ────────────────────────────────────────────────────────────────

function be32(n: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, n, false)
  return out
}

/** Mirror of `puk::derive_subkey`: HMAC-SHA256(seed, label || BE32(generation)). */
function deriveSubkey(seed: Uint8Array, label: string, generation: number): Uint8Array {
  const labelBytes = utf8ToBytes(label)
  const msg = new Uint8Array(labelBytes.length + 4)
  msg.set(labelBytes, 0)
  msg.set(be32(generation), labelBytes.length)
  return hmac(sha256, seed, msg)
}

/** Mirror of `puk::derive_puk_subkeys`. */
export function derivePukSubkeysMock(seed: Uint8Array, generation: number): MockPukState {
  return {
    generation,
    signPubkeyHex: bytesToHex(ed25519.getPublicKey(deriveSubkey(seed, LABEL_PUK_SIGN, generation))),
    dhPubkeyHex: bytesToHex(x25519.getPublicKey(deriveSubkey(seed, LABEL_PUK_DH, generation))),
  }
}

/** AAD binding a PUK seed envelope to its device — `"<LABEL_PUK_WRAP_TO_DEVICE>:<deviceId>"`. */
export function pukWrapAad(deviceId: string): Uint8Array {
  return utf8ToBytes(`${LABEL_PUK_WRAP_TO_DEVICE}:${deviceId}`)
}

/** Mirror of `puk::create_initial_puk`. `seed` is injectable for vector tests only. */
export function createInitialPukMock(
  deviceEncryptionPubkeyHex: string,
  deviceId: string,
  seed: Uint8Array = randomBytes(32),
): { state: MockPukState; seed: Uint8Array; envelope: MockHpkeEnvelope } {
  const state = derivePukSubkeysMock(seed, 1)
  const envelope = hpkeSealMock(seed, deviceEncryptionPubkeyHex, LABEL_PUK_WRAP_TO_DEVICE, pukWrapAad(deviceId))
  return { state, seed, envelope }
}

/** Mirror of `puk::encrypt_clkr_link`: hex(nonce_12 || AES-256-GCM(old_seed, aad)). */
function encryptClkrLink(oldSeed: Uint8Array, secretboxKey: Uint8Array, generation: number): string {
  const nonce = randomBytes(12)
  const aad = utf8ToBytes(`${LABEL_PUK_PREVIOUS_GEN}:${generation}`)
  const ct = gcm(secretboxKey, nonce, aad).encrypt(oldSeed)
  const packed = new Uint8Array(12 + ct.length)
  packed.set(nonce, 0)
  packed.set(ct, 12)
  return bytesToHex(packed)
}

/** Mirror of `puk::decrypt_clkr_link`. */
export function decryptClkrLinkMock(chainLinkHex: string, secretboxKey: Uint8Array, generation: number): Uint8Array {
  const data = hexToBytes(chainLinkHex)
  if (data.length < 12) throw new Error('invalid ciphertext')
  const aad = utf8ToBytes(`${LABEL_PUK_PREVIOUS_GEN}:${generation}`)
  const seed = gcm(secretboxKey, data.slice(0, 12), aad).decrypt(data.slice(12))
  if (seed.length !== 32) throw new Error('CLKR chain link must decrypt to 32 bytes')
  return seed
}

/** Mirror of `puk::derive_secretbox_key`. */
export function deriveSecretboxKeyMock(seed: Uint8Array, generation: number): Uint8Array {
  return deriveSubkey(seed, LABEL_PUK_SECRETBOX, generation)
}

/** Mirror of `puk::rotate_puk`. */
export function rotatePukMock(
  oldSeed: Uint8Array,
  oldGen: number,
  remainingDevices: Array<[string, string]>,
): {
  state: MockPukState
  deviceEnvelopes: Array<{ deviceId: string; envelope: MockHpkeEnvelope }>
  clkrChainLinkHex: string
} {
  const newGen = oldGen + 1
  const newSeed = randomBytes(32)
  const state = derivePukSubkeysMock(newSeed, newGen)
  const clkrChainLinkHex = encryptClkrLink(oldSeed, deriveSecretboxKeyMock(newSeed, newGen), newGen)
  const deviceEnvelopes = remainingDevices.map(([deviceId, pubkeyHex]) => ({
    deviceId,
    envelope: hpkeSealMock(newSeed, pubkeyHex, LABEL_PUK_WRAP_TO_DEVICE, pukWrapAad(deviceId)),
  }))
  return { state, deviceEnvelopes, clkrChainLinkHex }
}
