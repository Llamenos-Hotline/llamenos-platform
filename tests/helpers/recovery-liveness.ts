/**
 * Reference implementation of the recovery-share liveness proof (#2782) for the
 * test harness — the backend BDD signer and the desktop Tauri IPC mock both use
 * it, so there is one TS copy.
 *
 * Deliberately independent of `packages/crypto/src/recovery_liveness.rs` (noble
 * here, ed25519-dalek + hkdf there): the server verifies through the Rust crate,
 * so a proof made here verifying there pins the wire format. If either side's
 * derivation or message layout drifts, every positive liveness scenario fails.
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { LABEL_RECOVERY_LIVENESS_PROOF } from '@shared/crypto-labels'

/** A Shamir share as a holder's device has it after opening its envelope. */
export interface LivenessShare {
  x: number
  y: Uint8Array
}

/** seed = HKDF-SHA256(ikm = x || y, salt = none, info = LABEL_RECOVERY_LIVENESS_PROOF, 32). */
function livenessSeed(share: LivenessShare): Uint8Array {
  if (share.x === 0 || share.y.length === 0) throw new Error('Invalid Shamir share')
  const ikm = new Uint8Array(1 + share.y.length)
  ikm[0] = share.x
  ikm.set(share.y, 1)
  return hkdf(sha256, ikm, undefined, utf8ToBytes(LABEL_RECOVERY_LIVENESS_PROOF), 32)
}

/** Hex Ed25519 public key derived from the share — the holder's enrolled `livenessPublicKey`. */
export function livenessPublicKey(share: LivenessShare): string {
  return bytesToHex(ed25519.getPublicKey(livenessSeed(share)))
}

function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n)
  return b
}

/** LABEL || 0x00 || u32be(len) hubId || u32be(len) holderPubkey || challenge (32 bytes). */
export function livenessMessage(hubId: string, holderPubkey: string, challengeHex: string): Uint8Array {
  const challenge = hexToBytes(challengeHex)
  if (challenge.length !== 32) throw new Error('Liveness challenge must be 32 bytes')
  const hub = utf8ToBytes(hubId)
  const holder = utf8ToBytes(holderPubkey)
  const parts = [
    utf8ToBytes(LABEL_RECOVERY_LIVENESS_PROOF),
    new Uint8Array([0]),
    u32be(hub.length),
    hub,
    u32be(holder.length),
    holder,
    challenge,
  ]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** The 64-byte proof (hex) for `POST /api/recovery-group/shares/liveness`. */
export function signLivenessProof(
  share: LivenessShare,
  hubId: string,
  holderPubkey: string,
  challengeHex: string,
): string {
  return bytesToHex(ed25519.sign(livenessMessage(hubId, holderPubkey, challengeHex), livenessSeed(share)))
}
