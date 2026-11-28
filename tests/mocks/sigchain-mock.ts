/**
 * Mock sigchain + PUK primitives for the Playwright Tauri IPC mock.
 *
 * A line-for-line mirror of packages/crypto `sigchain.rs` and `puk.rs`, so that
 * a desktop client under Playwright produces and accepts exactly the chains the
 * real Rust CryptoState does. Pinned against the Rust crate's own vectors in
 * apps/worker/__tests__/unit/sigchain-mock-parity.test.ts
 * (packages/crypto/tests/identity_init.rs, sigchain.rs test_cross_language_vectors).
 *
 * PUK seed envelopes are sealed with the shared RFC 9180 mock (hpke-mock.ts),
 * the same primitive every envelope the Playwright client opens goes through.
 * Everything the envelope binds — label, AAD, recipient — matches Rust, so the
 * mock's envelopes open under the same AAD the crate uses (and are therefore
 * async, like the HPKE primitive).
 *
 * Pure module: no `window`, no Tauri imports, safe to load from Node/Bun.
 */
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hmac } from '@noble/hashes/hmac.js'
import { gcm } from '@noble/ciphers/aes.js'
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import {
  LABEL_DEVICE_POP,
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

/** packages/crypto `sigchain::ActiveDeviceKey`. */
export interface MockActiveDeviceKey {
  devicePubkey: string
  encryptionPubkey: string
  format: number
}

/** packages/crypto `sigchain::SigchainVerifiedState`. */
export interface MockSigchainVerifiedState {
  userPubkey: string
  verifiedCount: number
  headSeq: number
  headHash: string
  activeDevicePubkeys: string[]
  activeDeviceKeys: MockActiveDeviceKey[]
  namedKeys: string[]
}

// ── Device key binding (#2496; mirrors sigchain.rs device_pop_message etc.) ──

/** `sigchain::DEVICE_KEM_FORMAT`: format 2, X-Wing. */
export const DEVICE_KEM_FORMAT = 2
/** `device_keys::XWING_PUBLIC_KEY_LEN`. */
const XWING_PUBLIC_KEY_LEN = 1216

/** A crate refusal, carried as `"{code}: {detail}"` like the desktop's `crypto_err`. */
function rejected(code: string, detail: string): Error {
  return new Error(`${code}: ${detail}`)
}

function lp(b: Uint8Array): Uint8Array {
  if (b.length > 0xffff) throw new Error('invalid_input: lp field longer than 65535 bytes')
  const out = new Uint8Array(2 + b.length)
  new DataView(out.buffer).setUint16(0, b.length, false)
  out.set(b, 2)
  return out
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** Mirror of `sigchain::device_pop_message`. */
export function devicePopMessageMock(user: string, signingPk: Uint8Array, encryptionPk: Uint8Array, format: number): Uint8Array {
  const fmt = new Uint8Array(2)
  new DataView(fmt.buffer).setUint16(0, format, false)
  const digest = sha256(concat(lp(utf8ToBytes(user)), lp(signingPk), lp(encryptionPk), fmt))
  return concat(utf8ToBytes(LABEL_DEVICE_POP), new Uint8Array([0]), digest)
}

function decodeKeyHex(hex: string, len: number, what: string): Uint8Array {
  if (hex.length !== len * 2 || !/^[0-9a-f]*$/.test(hex)) {
    throw rejected('invalid_format', `${what} must be ${len} bytes of lowercase hex`)
  }
  return hexToBytes(hex)
}

function decodeKemPublicKey(hex: string, format: number): Uint8Array {
  if (format !== DEVICE_KEM_FORMAT) throw rejected('unknown_format', `no KEM suite for crypto_format ${format}`)
  // The crate also parses the key as an X-Wing key; the mock checks shape only.
  return decodeKeyHex(hex, XWING_PUBLIC_KEY_LEN, 'encryptionPubkey')
}

/** Mirror of `sigchain::sign_device_pop`. */
export function signDevicePopMock(signingSeed: Uint8Array, user: string, encryptionPkHex: string, format: number): string {
  const enc = decodeKemPublicKey(encryptionPkHex, format)
  const pk = ed25519.getPublicKey(signingSeed)
  return bytesToHex(ed25519.sign(devicePopMessageMock(user, pk, enc, format), signingSeed))
}

/** Mirror of `sigchain::verify_device_pop`. */
export function verifyDevicePopMock(user: string, signingPkHex: string, encryptionPkHex: string, format: number, popHex: string): void {
  const signingPk = decodeKeyHex(signingPkHex, 32, 'devicePubkey')
  const enc = decodeKemPublicKey(encryptionPkHex, format)
  if (popHex.length !== 128 || !/^[0-9a-f]*$/.test(popHex)) {
    throw rejected('chain_device_pop', 'pop must be a 64-byte signature in lowercase hex')
  }
  let ok = false
  try {
    ok = ed25519.verify(hexToBytes(popHex), devicePopMessageMock(user, signingPk, enc, format), signingPk, { zip215: false })
  } catch {
    ok = false
  }
  if (!ok) throw rejected('chain_device_pop', 'possession signature does not verify for this device, key and user')
}

/**
 * Mirror of `sigchain::user_init_payload`: the genesis payload naming the first
 * device's Ed25519, X25519 and X-Wing keys, `format: 2` and its possession
 * signature, serialised with sorted keys as serde_json writes it.
 */
export function userInitPayloadMock(
  signingSeed: Uint8Array,
  deviceId: string,
  x25519PubkeyHex: string,
  kemPubkeyHex: string,
): string {
  const user = bytesToHex(ed25519.getPublicKey(signingSeed))
  return JSON.stringify(sortKeysDeep({
    type: 'user_init',
    deviceId,
    devicePubkey: user,
    deviceEncryptionPubkey: x25519PubkeyHex,
    encryptionPubkey: kemPubkeyHex,
    format: DEVICE_KEM_FORMAT,
    pop: signDevicePopMock(signingSeed, user, kemPubkeyHex, DEVICE_KEM_FORMAT),
  }))
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
  if (first.seq !== 1) throw rejected('chain_seq', 'first sigchain link must have seq=1')
  if (first.prevHash !== null) throw rejected('chain_prev_hash', 'first sigchain link must have prevHash=null')

  const firstPayload: unknown = JSON.parse(first.payloadJson)
  if (payloadType(firstPayload) !== 'user_init') {
    throw new Error('invalid_input: first sigchain link must have type=user_init')
  }

  if (!verifySigchainLinkMock(first, first.signerPubkey)) {
    throw new Error('invalid_input: signature verification failed')
  }

  const userPubkey = first.signerPubkey.toLowerCase()
  // The genesis names its own signer and binds its X-Wing key with a pop.
  const genesisDevice = requiredField(firstPayload, 'devicePubkey', first.seq)
  if (!hexEq(genesisDevice, first.signerPubkey)) {
    throw rejected('chain_unauthorised_signer', 'user_init must name the device that signs it')
  }
  const genesisEnc = requiredField(firstPayload, 'encryptionPubkey', first.seq)
  const genesisFormat = requiredFormat(firstPayload, first.seq)
  verifyDevicePopMock(userPubkey, genesisDevice, genesisEnc, genesisFormat, requiredField(firstPayload, 'pop', first.seq))

  // Genesis authorises exactly its signer.
  const activePubkeys: string[] = [first.signerPubkey]
  const deviceKeys = new Map<string, MockActiveDeviceKey>()
  deviceKeys.set(first.signerPubkey, { devicePubkey: first.signerPubkey, encryptionPubkey: genesisEnc, format: genesisFormat })
  const named = new Map<string, string>()
  const claim = (key: string, device: string, seq: number) => {
    const k = key.toLowerCase()
    const owner = named.get(k)
    if (owner !== undefined && owner !== device) {
      throw rejected('chain_key_reused', `key ${k} at seq ${seq} already belongs to device ${owner}`)
    }
    named.set(k, device)
  }
  claim(first.signerPubkey, first.signerPubkey, first.seq)
  claim(genesisEnc, first.signerPubkey, first.seq)
  const firstEnc = field(firstPayload, 'deviceEncryptionPubkey')
  if (firstEnc !== undefined) claim(firstEnc, first.signerPubkey, first.seq)

  let prevHash = first.entryHash
  let prevSeq = first.seq

  for (const link of links.slice(1)) {
    if (link.seq !== prevSeq + 1) {
      throw rejected('chain_seq', `sequence gap: expected ${prevSeq + 1} but got ${link.seq}`)
    }
    if (link.prevHash === null || !hexEq(link.prevHash, prevHash)) {
      throw rejected('chain_prev_hash', `prevHash mismatch at seq ${link.seq}`)
    }
    // Exact string membership, as Rust's Vec<String>::contains.
    if (!activePubkeys.includes(link.signerPubkey)) {
      throw rejected('chain_unauthorised_signer', `signer ${link.signerPubkey} not in active device set at seq ${link.seq}`)
    }
    if (!verifySigchainLinkMock(link, link.signerPubkey)) {
      throw new Error('invalid_input: signature verification failed')
    }

    const payload: unknown = JSON.parse(link.payloadJson)
    const type = payloadType(payload)
    const req = (key: string): string => requiredField(payload, key, link.seq)
    const reqFormat = (): number => requiredFormat(payload, link.seq)
    if (type === 'device_add') {
      const device = req('devicePubkey')
      const enc = req('encryptionPubkey')
      const format = reqFormat()
      verifyDevicePopMock(userPubkey, device, enc, format, req('pop'))
      if (named.has(device.toLowerCase())) {
        throw rejected('chain_key_reused', `device_add at seq ${link.seq} names device ${device}, already in this chain`)
      }
      claim(device, device, link.seq)
      claim(enc, device, link.seq)
      const x25519Key = field(payload, 'deviceEncryptionPubkey')
      if (x25519Key !== undefined) claim(x25519Key, device, link.seq)
      if (!activePubkeys.includes(device)) activePubkeys.push(device)
      deviceKeys.set(device, { devicePubkey: device, encryptionPubkey: enc, format })
    } else if (type === 'device_remove') {
      const devicePubkey = payloadDevicePubkey(payload)
      if (devicePubkey !== undefined) {
        for (let i = activePubkeys.length - 1; i >= 0; i--) {
          if (activePubkeys[i] === devicePubkey) activePubkeys.splice(i, 1)
        }
        deviceKeys.delete(devicePubkey)
      }
    }

    prevHash = link.entryHash
    prevSeq = link.seq
  }

  return {
    userPubkey,
    verifiedCount: links.length,
    headSeq: prevSeq,
    headHash: prevHash,
    activeDevicePubkeys: activePubkeys,
    activeDeviceKeys: activePubkeys.flatMap(p => deviceKeys.get(p) ?? []),
    // BTreeMap key order: byte-wise, which for lowercase hex is string order.
    namedKeys: [...named.keys()].sort(),
  }
}

function field(payload: unknown, key: string): string | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const v = (payload as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : undefined
}

/** Mirror of `required_str`. */
function requiredField(payload: unknown, key: string, seq: number): string {
  const v = field(payload, key)
  if (v === undefined) throw rejected('invalid_format', `link at seq ${seq} is missing \`${key}\``)
  return v
}

/** Mirror of `required_format`. */
function requiredFormat(payload: unknown, seq: number): number {
  const f = payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>).format : undefined
  if (typeof f !== 'number' || !Number.isInteger(f) || f < 0 || f > 0xffff) {
    throw rejected('invalid_format', `link at seq ${seq} is missing \`format\``)
  }
  return f
}

/** Mirror of `sigchain::verify_user_sigchains`. */
export function verifyUserSigchainsMock(chains: MockSigchainLink[][]): MockSigchainVerifiedState[] {
  const states = chains.map(verifySigchainMock)
  const owner = new Map<string, string>()
  for (const state of states) {
    for (const key of state.namedKeys) {
      const other = owner.get(key)
      if (other !== undefined && other !== state.userPubkey) {
        throw rejected('chain_key_reused', `key ${key} is named by the chains of users ${other} and ${state.userPubkey}`)
      }
      if (other !== undefined) throw rejected('chain_key_reused', `the chain of user ${state.userPubkey} is listed twice`)
      owner.set(key, state.userPubkey)
    }
  }
  return states
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
export async function createInitialPukMock(
  deviceEncryptionPubkeyHex: string,
  deviceId: string,
  seed: Uint8Array = randomBytes(32),
): Promise<{ state: MockPukState; seed: Uint8Array; envelope: MockHpkeEnvelope }> {
  const state = derivePukSubkeysMock(seed, 1)
  const envelope = await hpkeSealMock(seed, deviceEncryptionPubkeyHex, LABEL_PUK_WRAP_TO_DEVICE, pukWrapAad(deviceId))
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
export async function rotatePukMock(
  oldSeed: Uint8Array,
  oldGen: number,
  remainingDevices: Array<[string, string]>,
): Promise<{
  state: MockPukState
  deviceEnvelopes: Array<{ deviceId: string; envelope: MockHpkeEnvelope }>
  clkrChainLinkHex: string
}> {
  const newGen = oldGen + 1
  const newSeed = randomBytes(32)
  const state = derivePukSubkeysMock(newSeed, newGen)
  const clkrChainLinkHex = encryptClkrLink(oldSeed, deriveSecretboxKeyMock(newSeed, newGen), newGen)
  const deviceEnvelopes = await Promise.all(
    remainingDevices.map(async ([deviceId, pubkeyHex]) => ({
      deviceId,
      envelope: await hpkeSealMock(newSeed, pubkeyHex, LABEL_PUK_WRAP_TO_DEVICE, pukWrapAad(deviceId)),
    })),
  )
  return { state, deviceEnvelopes, clkrChainLinkHex }
}
