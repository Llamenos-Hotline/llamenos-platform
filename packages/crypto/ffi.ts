/**
 * TypeScript wrapper around the Rust crypto FFI (.so) loaded via bun:ffi.
 *
 * All consumers work with Uint8Array. Buffer marshaling is internal.
 * Error details are read immediately after failure via ffi_last_error().
 */
import { dlopen, FFIType, ptr } from 'bun:ffi'
import { resolve } from 'path'
import { SHAPES, type Shape } from '../shared/crypto-shapes'

// Resolve library path — configurable via LLAMENOS_CRYPTO_LIB env var
const LIB_PATH = process.env.LLAMENOS_CRYPTO_LIB ??
  resolve(import.meta.dir, 'dist/server/libllamenos_core.so')

const lib = dlopen(LIB_PATH, {
  ffi_last_error: {
    args: [FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  ffi_random_bytes: {
    args: [FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  ffi_sha256: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  ffi_hmac_sha256: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  ffi_hkdf_sha256: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  ffi_aes256gcm_encrypt: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  ffi_aes256gcm_decrypt: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  ffi_shape_seal: {
    args: [
      FFIType.u8,               // shape
      FFIType.ptr, FFIType.u64, // recipient X25519 pubkey (32)
      FFIType.ptr, FFIType.u64, // AAD fields (UTF-8 JSON string array, or empty)
      FFIType.ptr, FFIType.u64, // plaintext
      FFIType.ptr, FFIType.u64, // out: enc(32) || ct
    ],
    returns: FFIType.i32,
  },
  ffi_shape_open: {
    args: [
      FFIType.u8,               // shape
      FFIType.ptr, FFIType.u64, // X25519 secret (32)
      FFIType.ptr, FFIType.u64, // AAD fields
      FFIType.ptr, FFIType.u64, // envelope: enc(32) || ct
      FFIType.ptr, FFIType.u64, // out: plaintext
    ],
    returns: FFIType.i32,
  },
  ffi_content_seal: {
    args: [
      FFIType.u8,               // shape
      FFIType.ptr, FFIType.u64, // plaintext
      FFIType.ptr, FFIType.u64, // out key (32)
      FFIType.ptr, FFIType.u64, // out: nonce || ct || tag
    ],
    returns: FFIType.i32,
  },
  ffi_content_seal_under: {
    args: [
      FFIType.u8,               // shape
      FFIType.ptr, FFIType.u64, // key (32)
      FFIType.ptr, FFIType.u64, // plaintext
      FFIType.ptr, FFIType.u64, // out: nonce || ct || tag
    ],
    returns: FFIType.i32,
  },
  ffi_content_open: {
    args: [
      FFIType.u8,               // shape
      FFIType.ptr, FFIType.u64, // key (32)
      FFIType.ptr, FFIType.u64, // nonce || ct || tag
      FFIType.ptr, FFIType.u64, // out: plaintext
    ],
    returns: FFIType.i32,
  },
  ffi_server_event_key: {
    args: [
      FFIType.ptr, FFIType.u64, // SERVER_SECRET
      FFIType.ptr, FFIType.u64, // hub id (UTF-8)
      FFIType.u64,              // epoch
      FFIType.ptr, FFIType.u64, // out (32)
    ],
    returns: FFIType.i32,
  },
  ffi_seal_server_event: {
    args: [
      FFIType.ptr, FFIType.u64, // SERVER_SECRET
      FFIType.ptr, FFIType.u64, // hub id (UTF-8)
      FFIType.u32,              // kind
      FFIType.u64,              // epoch
      FFIType.ptr, FFIType.u64, // event JSON (UTF-8)
      FFIType.ptr, FFIType.u64, // out: nonce || ct || tag
    ],
    returns: FFIType.i32,
  },
  ffi_open_server_event: {
    args: [
      FFIType.ptr, FFIType.u64, // event key (32)
      FFIType.ptr, FFIType.u64, // hub id (UTF-8)
      FFIType.u32,              // kind
      FFIType.u64,              // epoch
      FFIType.ptr, FFIType.u64, // payload (lowercase hex, UTF-8)
      FFIType.ptr, FFIType.u64, // out: JSON
    ],
    returns: FFIType.i32,
  },
  ffi_ed25519_sign: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  ffi_ed25519_verify: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  ffi_recovery_liveness_verify: {
    args: [
      FFIType.ptr, FFIType.u64, // liveness_pubkey (32)
      FFIType.ptr, FFIType.u64, // hub_id (UTF-8)
      FFIType.ptr, FFIType.u64, // holder_pubkey (UTF-8)
      FFIType.ptr, FFIType.u64, // challenge (32)
      FFIType.ptr, FFIType.u64, // signature (64)
    ],
    returns: FFIType.i32,
  },
  ffi_ed25519_pubkey_from_seed: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  ffi_sigchain_verify: {
    args: [
      FFIType.ptr, FFIType.u64, // links (JSON array of SigchainLink)
      FFIType.ptr, FFIType.u64, // out (verified state JSON)
    ],
    returns: FFIType.i32,
  },
  ffi_hub_chain: {
    args: [
      FFIType.ptr, FFIType.u64, // request JSON ({op, ...})
      FFIType.ptr, FFIType.u64, // out (answer JSON)
    ],
    returns: FFIType.i32,
  },
  ffi_build_auth_message: {
    args: [
      FFIType.ptr, FFIType.u64, // pubkey_hex
      FFIType.u64,              // timestamp
      FFIType.ptr, FFIType.u64, // method
      FFIType.ptr, FFIType.u64, // path
      FFIType.ptr, FFIType.u64, // nonce (null = nonce-less shape)
      FFIType.ptr, FFIType.u64, // out
    ],
    returns: FFIType.i32,
  },
  ffi_case_seal: {
    args: [
      FFIType.u8,               // purpose
      FFIType.ptr, FFIType.u64, // plaintext
      FFIType.ptr, FFIType.u64, // readers (n x 32-byte X25519)
      FFIType.ptr, FFIType.u64, // out (JSON)
    ],
    returns: FFIType.i32,
  },
  ffi_case_open: {
    args: [
      FFIType.u8,               // purpose
      FFIType.ptr, FFIType.u64, // secret key
      FFIType.ptr, FFIType.u64, // sealed JSON
      FFIType.ptr, FFIType.u64, // out (plaintext)
    ],
    returns: FFIType.i32,
  },
  ffi_ban_digest_evaluate: {
    args: [
      FFIType.ptr, FFIType.u64, // BAN_HASH_KEY (32)
      FFIType.ptr, FFIType.u64, // scope (UTF-8)
      FFIType.ptr, FFIType.u64, // caller identifier (UTF-8)
      FFIType.ptr, FFIType.u64, // out (64)
    ],
    returns: FFIType.i32,
  },
  ffi_ban_digest_blind_evaluate: {
    args: [
      FFIType.ptr, FFIType.u64, // BAN_HASH_KEY (32)
      FFIType.ptr, FFIType.u64, // scope (UTF-8)
      FFIType.ptr, FFIType.u64, // blinded element (32)
      FFIType.ptr, FFIType.u64, // out (32)
    ],
    returns: FFIType.i32,
  },
})

export class CryptoError extends Error {
  /**
   * The crate's closed rejection code (`CryptoError::code` in Rust —
   * `invalid_format`, `decryption_failed`, `invalid_id`, …) when the failure
   * came from the crate, else `null`. Vectors assert this, never merely a throw.
   */
  readonly reason: string | null
  constructor(public code: number, message: string) {
    super(message)
    this.name = 'CryptoError'
    const m = /^([a-z_]+): /.exec(message)
    this.reason = m ? m[1] : null
  }
}

function getLastError(): string {
  const buf = new Uint8Array(512)
  const len = lib.symbols.ffi_last_error(ptr(buf), 512)
  if (len <= 0) return 'unknown error'
  return new TextDecoder().decode(buf.subarray(0, len))
}

function checkResult(code: number): void {
  if (code !== 0) {
    const msg = getLastError()
    throw new CryptoError(code, msg)
  }
}

export function randomBytes(len: number): Uint8Array {
  const out = new Uint8Array(len)
  checkResult(lib.symbols.ffi_random_bytes(ptr(out), len))
  return out
}

export function sha256(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(32)
  checkResult(lib.symbols.ffi_sha256(ptr(data), data.length, ptr(out), 32))
  return out
}

export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(32)
  checkResult(lib.symbols.ffi_hmac_sha256(
    ptr(key), key.length,
    ptr(data), data.length,
    ptr(out), 32,
  ))
  return out
}

export function hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, len: number): Uint8Array {
  const out = new Uint8Array(len)
  checkResult(lib.symbols.ffi_hkdf_sha256(
    ptr(ikm), ikm.length,
    salt.length > 0 ? ptr(salt) : null, salt.length,
    info.length > 0 ? ptr(info) : null, info.length,
    ptr(out), len,
  ))
  return out
}

export function symmetricEncrypt(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array {
  const outLen = 12 + plaintext.length + 16
  const out = new Uint8Array(outLen)
  checkResult(lib.symbols.ffi_aes256gcm_encrypt(
    ptr(key), key.length,
    plaintext.length > 0 ? ptr(plaintext) : null, plaintext.length,
    aad.length > 0 ? ptr(aad) : null, aad.length,
    ptr(out), outLen,
  ))
  return out
}

export function symmetricDecrypt(key: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array): Uint8Array {
  const ptLen = ciphertext.length - 28
  if (ptLen < 0) throw new CryptoError(-5, 'ciphertext too short')
  const out = new Uint8Array(ptLen)
  checkResult(lib.symbols.ffi_aes256gcm_decrypt(
    ptr(key), key.length,
    ptr(ciphertext), ciphertext.length,
    aad.length > 0 ? ptr(aad) : null, aad.length,
    ptr(out), ptLen,
  ))
  return out
}

// ── HPKE envelopes, by shape (spec D1) ───────────────────────────────

export { SHAPES, type Shape } from '../shared/crypto-shapes'

function shapeByte(shape: Shape): number {
  const i = SHAPES.indexOf(shape)
  if (i < 0) throw new CryptoError(-5, `invalid_input: unknown shape ${shape}`)
  return i
}

function fieldsBytes(fields: readonly string[]): Uint8Array {
  return fields.length ? new TextEncoder().encode(JSON.stringify(fields)) : new Uint8Array(0)
}

/** A sealed HPKE envelope: `enc` and `ct`, both lowercase hex. */
export interface HpkeEnvelope { enc: string; ct: string }

function hexOf(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

/** Strict lowercase hex → bytes; anything else is `invalid_format` (spec D2). */
function bytesOfHex(field: string, hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) {
    throw new CryptoError(-5, `invalid_format: ${field} must be lowercase hex`)
  }
  return Uint8Array.from(Buffer.from(hex, 'hex'))
}

/**
 * Seal `plaintext` as `shape` to a 32-byte X25519 recipient. `fields` are the
 * per-record AAD values the shape binds (empty for most shapes).
 */
export function shapeSeal(
  shape: Shape,
  recipientPk: Uint8Array,
  fields: readonly string[],
  plaintext: Uint8Array,
): HpkeEnvelope {
  const f = fieldsBytes(fields)
  const out = new Uint8Array(32 + plaintext.length + 16)
  checkResult(lib.symbols.ffi_shape_seal(
    shapeByte(shape),
    ptr(recipientPk), recipientPk.length,
    f.length ? ptr(f) : null, f.length,
    plaintext.length ? ptr(plaintext) : null, plaintext.length,
    ptr(out), out.length,
  ))
  return { enc: hexOf(out.subarray(0, 32)), ct: hexOf(out.subarray(32)) }
}

/** Open an envelope of `shape` with a 32-byte X25519 secret. */
export function shapeOpen(
  shape: Shape,
  secretKey: Uint8Array,
  fields: readonly string[],
  envelope: HpkeEnvelope,
): Uint8Array {
  const enc = bytesOfHex('enc', envelope.enc)
  const ct = bytesOfHex('ct', envelope.ct)
  if (enc.length !== 32 || ct.length < 16) {
    throw new CryptoError(-5, 'invalid_format: enc must be 32 bytes and ct at least 16')
  }
  const env = new Uint8Array(enc.length + ct.length)
  env.set(enc)
  env.set(ct, 32)
  const f = fieldsBytes(fields)
  const out = new Uint8Array(env.length - 48)
  checkResult(lib.symbols.ffi_shape_open(
    shapeByte(shape),
    ptr(secretKey), secretKey.length,
    f.length ? ptr(f) : null, f.length,
    ptr(env), env.length,
    out.length ? ptr(out) : ptr(new Uint8Array(1)), out.length,
  ))
  return out
}

/** Seal `plaintext` under a fresh content key with `shape`'s content AAD. */
export function contentSeal(shape: Shape, plaintext: Uint8Array): { packed: Uint8Array; key: Uint8Array } {
  const key = new Uint8Array(32)
  const packed = new Uint8Array(plaintext.length + 28)
  checkResult(lib.symbols.ffi_content_seal(
    shapeByte(shape),
    plaintext.length ? ptr(plaintext) : null, plaintext.length,
    ptr(key), 32,
    ptr(packed), packed.length,
  ))
  return { packed, key }
}

/** Seal under an existing key — only the firehose window shape, whose key seals a whole window. */
export function contentSealUnder(shape: 'firehose-window-key', key: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const packed = new Uint8Array(plaintext.length + 28)
  checkResult(lib.symbols.ffi_content_seal_under(
    shapeByte(shape),
    ptr(key), key.length,
    plaintext.length ? ptr(plaintext) : null, plaintext.length,
    ptr(packed), packed.length,
  ))
  return packed
}

/** Open a content ciphertext of `shape` with its key. */
export function contentOpen(shape: Shape, key: Uint8Array, packed: Uint8Array): Uint8Array {
  if (packed.length < 28) throw new CryptoError(-5, 'invalid_format: ciphertext too short')
  const out = new Uint8Array(packed.length - 28)
  checkResult(lib.symbols.ffi_content_open(
    shapeByte(shape),
    ptr(key), key.length,
    ptr(packed), packed.length,
    out.length ? ptr(out) : ptr(new Uint8Array(1)), out.length,
  ))
  return out
}

// ── Relay events (spec D9, #2999) ────────────────────────────────────

/** The relay-event key of `hubId` for `epoch` — what a member of that hub is handed. */
export function serverEventKey(serverSecret: Uint8Array, hubId: string, epoch: number): Uint8Array {
  const hub = new TextEncoder().encode(hubId)
  const out = new Uint8Array(32)
  checkResult(lib.symbols.ffi_server_event_key(
    ptr(serverSecret), serverSecret.length,
    ptr(hub), hub.length,
    BigInt(epoch),
    ptr(out), 32,
  ))
  return out
}

/** Seal one relay frame; returns the lowercase-hex payload. */
export function sealServerEvent(
  serverSecret: Uint8Array,
  hubId: string,
  kind: number,
  epoch: number,
  json: string,
): string {
  const hub = new TextEncoder().encode(hubId)
  const body = new TextEncoder().encode(json)
  // nonce + the padding bucket (next power of two >= 4 + len, min 512) + tag
  let bucket = 512
  while (bucket < 4 + body.length) bucket *= 2
  const out = new Uint8Array(12 + bucket + 16)
  const written = lib.symbols.ffi_seal_server_event(
    ptr(serverSecret), serverSecret.length,
    ptr(hub), hub.length,
    kind,
    BigInt(epoch),
    ptr(body), body.length,
    ptr(out), out.length,
  )
  if (written < 0) checkResult(written)
  return hexOf(out.subarray(0, written))
}

/**
 * Open one relay frame with its key. The server never needs this; tests and
 * BDD steps use it to read what the relay published, through the same code
 * every client runs.
 */
export function openServerEvent(
  key: Uint8Array,
  hubId: string,
  kind: number,
  epoch: number,
  payloadHex: string,
): string {
  const hub = new TextEncoder().encode(hubId)
  const payload = new TextEncoder().encode(payloadHex)
  const out = new Uint8Array(Math.max(1, payloadHex.length / 2))
  const written = lib.symbols.ffi_open_server_event(
    ptr(key), key.length,
    ptr(hub), hub.length,
    kind,
    BigInt(epoch),
    payload.length ? ptr(payload) : ptr(new Uint8Array(1)), payload.length,
    ptr(out), out.length,
  )
  if (written < 0) checkResult(written)
  return new TextDecoder().decode(out.subarray(0, written))
}

export function ed25519Sign(secretKey: Uint8Array, message: Uint8Array): Uint8Array {
  const out = new Uint8Array(64)
  checkResult(lib.symbols.ffi_ed25519_sign(
    ptr(secretKey), secretKey.length,
    ptr(message), message.length,
    ptr(out), 64,
  ))
  return out
}

export function ed25519Verify(pubkey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  const code = lib.symbols.ffi_ed25519_verify(
    ptr(pubkey), pubkey.length,
    ptr(message), message.length,
    ptr(signature), signature.length,
  )
  if (code === 0) return true
  if (code === -1) return false
  // Other error codes (null pointer, wrong sizes, etc.)
  const msg = getLastError()
  throw new CryptoError(code, msg)
}

/**
 * Verify a recovery-share liveness proof (#2782).
 *
 * Delegates to `packages/crypto/src/recovery_liveness.rs`, which owns the signed
 * message layout. Returns `false` for a proof that does not verify; throws only
 * on malformed input sizes (wrong-length key, challenge or signature), which a
 * caller must validate before it gets here.
 */
export function recoveryLivenessVerify(
  livenessPubkey: Uint8Array,
  hubId: string,
  holderPubkey: string,
  challenge: Uint8Array,
  signature: Uint8Array,
): boolean {
  const hub = new TextEncoder().encode(hubId)
  const holder = new TextEncoder().encode(holderPubkey)
  const code = lib.symbols.ffi_recovery_liveness_verify(
    ptr(livenessPubkey), livenessPubkey.length,
    ptr(hub), hub.length,
    ptr(holder), holder.length,
    ptr(challenge), challenge.length,
    ptr(signature), signature.length,
  )
  if (code === 0) return true
  if (code === -1) return false
  throw new CryptoError(code, getLastError())
}

/** One user-sigchain link as the crate hashes and signs it (`sigchain::SigchainLink`). */
export interface SigchainLink {
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

/** An active device's format-2 (X-Wing) encryption key, as its `user_init` / `device_add` names it. */
export interface ActiveDeviceKey {
  devicePubkey: string
  encryptionPubkey: string
  format: number
}

/** `sigchain::SigchainVerifiedState`. */
export interface SigchainVerifiedState {
  userPubkey: string
  verifiedCount: number
  headSeq: number
  headHash: string
  activeDevicePubkeys: string[]
  activeDeviceKeys: ActiveDeviceKey[]
  namedKeys: string[]
}

import type {
  ChainHead,
  HubChainLink,
  HubChainVerified,
  RecoveryApproval,
  UnsignedHubLink,
  UnsignedRecoveryApproval,
} from '../protocol/schemas/hub-chain'

/** A trusted anchor for a hub other than the one being verified. */
export interface HubAnchor { hub: string; head: ChainHead }

/** `hub_chain::HubChainInput`. */
export interface HubChainInput {
  links: HubChainLink[]
  userChains?: SigchainLink[][]
  hubChains?: HubChainLink[][]
  anchor?: ChainHead
  hubAnchors?: HubAnchor[]
}

/** The request and answer of each `hub_chain::call` op. */
export interface HubChainOps {
  verify: { request: HubChainInput; answer: HubChainVerified }
  signingMessage: { request: { unsigned: UnsignedHubLink; signerDevice: string }; answer: { entryHash: string; message: string } }
  assemble: { request: { unsigned: UnsignedHubLink; signerDevice: string; sig: string }; answer: HubChainLink }
  permsHash: { request: { permissions: string[] }; answer: { permsHash: string } }
  verifySigchain: {
    request: { links: SigchainLink[]; userChains?: SigchainLink[][]; hubChains?: HubChainLink[][]; hubAnchors?: HubAnchor[] }
    answer: SigchainVerifiedState
  }
  approvalMessage: { request: { approval: UnsignedRecoveryApproval; holderDevice: string }; answer: { message: string } }
}
export type { RecoveryApproval }

/** `check_output_size!` in ffi_server.rs: the buffer was too small; the message names the size needed. */
const OUTPUT_TOO_SMALL = -2

/**
 * Verify a whole user sigchain through `packages/crypto` `verify_sigchain` —
 * hash chain, signatures, device set, the `user_init` / `device_add`
 * possession signatures and in-chain key reuse (#2496). A refusal throws a
 * `CryptoError` whose `reason` is the closed rejection code
 * (`chain_device_pop`, `chain_key_reused`, `chain_unauthorised_signer`, …).
 */
export function sigchainVerify(links: readonly SigchainLink[]): SigchainVerifiedState {
  const input = new TextEncoder().encode(JSON.stringify(links))
  // The state repeats keys the links name (each active device's 2432-hex X-Wing
  // key appears in `activeDeviceKeys` and again in `namedKeys`), so no fixed
  // multiple of the input is a safe size. Start at the input's size; when the
  // crate reports the buffer too small, it names the exact size, and the
  // (deterministic) verification runs once more into a buffer of that size.
  let out = new Uint8Array(input.length + 4096)
  let written = lib.symbols.ffi_sigchain_verify(ptr(input), input.length, ptr(out), out.length)
  if (written === OUTPUT_TOO_SMALL) {
    const message = getLastError()
    const need = /need (\d+)/.exec(message)
    if (!need) throw new CryptoError(written, message)
    out = new Uint8Array(Number(need[1]))
    written = lib.symbols.ffi_sigchain_verify(ptr(input), input.length, ptr(out), out.length)
  }
  if (written < 0) checkResult(written)
  return JSON.parse(new TextDecoder().decode(out.subarray(0, written))) as SigchainVerifiedState
}

/**
 * One stateless hub-chain operation through `packages/crypto` `hub_chain::call`
 * (#2963, wire spec §5). JSON in, JSON out; the request and answer shapes are
 * the crate's (see `HubChainOps`). A refusal throws a `CryptoError` whose
 * `reason` is the closed rejection code (`chain_prev_hash`, `chain_fork`,
 * `chain_unauthorised_signer`, `recovery_threshold`, …).
 */
export function hubChainCall<Op extends keyof HubChainOps>(
  op: Op,
  request: HubChainOps[Op]['request'],
): HubChainOps[Op]['answer'] {
  const input = new TextEncoder().encode(JSON.stringify({ op, ...request }))
  // Answers repeat the X-Wing keys the links name; the crate names the exact
  // size when the first buffer is too small, as in sigchainVerify.
  let out = new Uint8Array(input.length * 2 + 65536)
  let written = lib.symbols.ffi_hub_chain(ptr(input), input.length, ptr(out), out.length)
  if (written === OUTPUT_TOO_SMALL) {
    const message = getLastError()
    const need = /need (\d+)/.exec(message)
    if (!need) throw new CryptoError(written, message)
    out = new Uint8Array(Number(need[1]))
    written = lib.symbols.ffi_hub_chain(ptr(input), input.length, ptr(out), out.length)
  }
  if (written < 0) checkResult(written)
  return JSON.parse(new TextDecoder().decode(out.subarray(0, written))) as HubChainOps[Op]['answer']
}

export function ed25519PubkeyFromSeed(seed: Uint8Array): Uint8Array {
  const out = new Uint8Array(32)
  checkResult(lib.symbols.ffi_ed25519_pubkey_from_seed(
    ptr(seed), seed.length,
    ptr(out), 32,
  ))
  return out
}

/**
 * Build the canonical device-auth message — the exact bytes that get signed.
 *
 * Delegates to `packages/crypto/src/auth.rs::build_auth_message`, the single
 * construction path shared by every platform. Omit `nonce` for the nonce-less
 * shape, which carries its own domain-separation label.
 */
export function buildAuthMessage(
  pubkey: string,
  timestamp: number,
  method: string,
  path: string,
  nonce?: string,
): Uint8Array {
  const enc = new TextEncoder()
  const pk = enc.encode(pubkey)
  const m = enc.encode(method)
  const p = enc.encode(path)
  const n = nonce === undefined ? undefined : enc.encode(nonce)
  // label (<= 64) + ':' separators + hex pubkey + digits + method + path + nonce
  const out = new Uint8Array(128 + pk.length + m.length + p.length + (n?.length ?? 0))
  const written = lib.symbols.ffi_build_auth_message(
    ptr(pk), pk.length,
    timestamp,
    ptr(m), m.length,
    ptr(p), p.length,
    n ? ptr(n) : null, n ? n.length : 0,
    ptr(out), out.length,
  )
  if (written < 0) checkResult(written)
  return out.subarray(0, written)
}

// ── Case records + case comments (#2499) ─────────────────────────────

/**
 * What a case ciphertext is — the only choice a caller makes. The byte values
 * are `packages/crypto/src/case_record.rs` `CasePurpose`; the label and AAD for
 * each are decided in Rust, never here.
 */
export const CasePurpose = { summary: 0, fields: 1, comment: 2 } as const
export type CasePurpose = keyof typeof CasePurpose

/** A sealed case ciphertext in wire form (all hex). */
export interface EncryptedCaseCiphertext {
  encryptedContent: string
  readerEnvelopes: { pubkey: string; enc: string; ct: string }[]
}

/**
 * Seal a case record's summary or fields, or a case comment, for
 * `readerPubkeys` (X25519, hex). Delegates to `case_record::seal`.
 */
export function caseSeal(
  purpose: CasePurpose,
  plaintext: string,
  readerPubkeys: readonly string[],
): EncryptedCaseCiphertext {
  const pt = new TextEncoder().encode(plaintext)
  const readers = new Uint8Array(readerPubkeys.length * 32)
  readerPubkeys.forEach((pk, i) => {
    const bytes = Uint8Array.from(Buffer.from(pk, 'hex'))
    if (bytes.length !== 32) throw new CryptoError(-5, `case reader ${i} is not a 32-byte X25519 key`)
    readers.set(bytes, i * 32)
  })
  // hex content (2 x (iv + pt + tag)) + per reader (64 pubkey + 64 enc + 96 ct
  // hex + JSON punctuation) + the wrapper object.
  const out = new Uint8Array(2 * (pt.length + 28) + readerPubkeys.length * 256 + 64)
  const written = lib.symbols.ffi_case_seal(
    CasePurpose[purpose],
    pt.length ? ptr(pt) : null, pt.length,
    ptr(readers), readers.length,
    ptr(out), out.length,
  )
  if (written < 0) checkResult(written)
  return JSON.parse(new TextDecoder().decode(out.subarray(0, written))) as EncryptedCaseCiphertext
}

/**
 * Open a case ciphertext with a reader's X25519 secret. The server holds no
 * reader secret for any case record; this exists so the server-persisted
 * vectors are verified by the same library the clients run.
 */
export function caseOpen(
  purpose: CasePurpose,
  secretKey: Uint8Array,
  sealed: EncryptedCaseCiphertext,
): string {
  const json = new TextEncoder().encode(JSON.stringify(sealed))
  const out = new Uint8Array(json.length)
  const written = lib.symbols.ffi_case_open(
    CasePurpose[purpose],
    ptr(secretKey), secretKey.length,
    ptr(json), json.length,
    ptr(out), out.length,
  )
  if (written < 0) checkResult(written)
  return new TextDecoder().decode(out.subarray(0, written))
}

/**
 * The ban digest (64 bytes) of a caller identifier the server already holds, under one scope's key —
 * RFC 9497 OPRF `Evaluate` (`packages/crypto/src/ban_digest.rs`). Equal to what a client gets
 * from blinding the same number, `banDigestBlindEvaluate`, and finalizing.
 */
export function banDigestEvaluate(banHashKey: Uint8Array, scope: string, identifier: string): Uint8Array {
  const scopeBytes = new TextEncoder().encode(scope)
  const phoneBytes = new TextEncoder().encode(identifier)
  const out = new Uint8Array(64)
  checkResult(lib.symbols.ffi_ban_digest_evaluate(
    ptr(banHashKey), banHashKey.length,
    ptr(scopeBytes), scopeBytes.length,
    ptr(phoneBytes), phoneBytes.length,
    ptr(out), out.length,
  ))
  return out
}

/**
 * Evaluate a client's blinded element (32 bytes) under one scope's key — RFC 9497 OPRF
 * `BlindEvaluate`. The server learns nothing about the number behind it.
 */
export function banDigestBlindEvaluate(banHashKey: Uint8Array, scope: string, blinded: Uint8Array): Uint8Array {
  const scopeBytes = new TextEncoder().encode(scope)
  const out = new Uint8Array(32)
  checkResult(lib.symbols.ffi_ban_digest_blind_evaluate(
    ptr(banHashKey), banHashKey.length,
    ptr(scopeBytes), scopeBytes.length,
    ptr(blinded), blinded.length,
    ptr(out), out.length,
  ))
  return out
}
