/**
 * The canonical device-auth message — the exact bytes an Ed25519 auth token
 * signs, and the ONLY place TypeScript builds them.
 *
 * Mirrors `packages/crypto/src/auth.rs::build_auth_message`, which is itself
 * the only place Rust builds them (and, via its UniFFI export
 * `mobileBuildAuthMessage`, the only place Kotlin and Swift build them).
 * `packages/crypto/tests/interop.rs` emits vectors for both shapes and
 * `tests/crypto-interop.spec.ts` asserts these functions reproduce them byte
 * for byte — so the two implementations cannot drift apart silently.
 *
 * This module is browser-safe on purpose: the Tauri IPC mock in
 * `tests/mocks/` imports it too, so the Playwright signer cannot diverge from
 * the real Rust signer (the divergence that hid #1389).
 */
import { LABEL_DEVICE_AUTH, LABEL_DEVICE_AUTH_NO_NONCE } from './crypto-labels'
import { utf8ToBytes } from './encoding'

/**
 * Canonical nonce format: exactly 32 lowercase hex characters (16 bytes),
 * matching Rust's `generate_nonce()`.
 *
 * Enforced at verify. A nonce is attacker-supplied data, and one containing
 * `:` could otherwise shift the path/nonce boundary inside the nonce-bearing
 * message shape.
 */
const CANONICAL_NONCE = /^[0-9a-f]{32}$/

export function isCanonicalAuthNonce(nonce: string): boolean {
  return CANONICAL_NONCE.test(nonce)
}

/** Generate a canonical 16-byte hex auth nonce. */
export function randomAuthNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Build the canonical auth message bytes (UTF-8, signed directly — Ed25519
 * applies SHA-512 internally, so there is no pre-hash).
 *
 * | nonce | message |
 * |---|---|
 * | given   | `{LABEL_DEVICE_AUTH}:{pubkey}:{timestamp}:{METHOD}:{path}:{nonce}` |
 * | omitted | `{LABEL_DEVICE_AUTH_NO_NONCE}:{pubkey}:{timestamp}:{METHOD}:{path}` |
 *
 * The nonce-less shape has its own domain-separation label rather than simply
 * one fewer field. A URL path may legally contain `:`, so under a single label
 * a five-field message for path `/x:abcd…` and a six-field message for path
 * `/x` with nonce `abcd…` would be identical bytes — one label covering two
 * layouts, which is exactly what domain separation exists to prevent. With two
 * labels the shapes are disjoint: a nonce-less token can never be replayed as
 * a nonce-bearing request, and a nonce-bearing token whose nonce is dropped in
 * transit fails verification instead of silently downgrading.
 */
export function buildAuthMessage(
  pubkey: string,
  timestamp: number,
  method: string,
  path: string,
  nonce?: string,
): Uint8Array {
  return utf8ToBytes(
    nonce === undefined
      ? `${LABEL_DEVICE_AUTH_NO_NONCE}:${pubkey}:${timestamp}:${method}:${path}`
      : `${LABEL_DEVICE_AUTH}:${pubkey}:${timestamp}:${method}:${path}:${nonce}`,
  )
}
