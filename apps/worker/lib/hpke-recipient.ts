/**
 * The two public keys a Llámenos user has, as two incompatible TypeScript types.
 *
 * A user's device holds an Ed25519 signing key AND an X25519 encryption key,
 * both 32 bytes, both carried as 64 lowercase hex characters. Nothing about
 * the representation distinguishes them, and DHKEM(X25519) — the KEM half of
 * the HPKE suite this project uses everywhere (RFC 9180,
 * X25519-HKDF-SHA256-AES256-GCM) — accepts *any* 32 bytes as a recipient
 * public key. So sealing to an Ed25519 key does not throw, does not warn, and
 * does not fail: it produces a well-formed envelope for which no secret key
 * exists anywhere in the world.
 *
 * That is how #1283 happened. `ADMIN_DECRYPTION_PUBKEY || ADMIN_PUBKEY`
 * type-checked, because both sides are `string`. Every note a volunteer wrote
 * on such a deployment was wrapped to the admin's *signing* key and became
 * permanently unreadable — no error at write time, none at read time.
 *
 * These brands make that substitution a compile error instead of a silent
 * data loss. They are phantom types: at runtime both are plain hex strings, so
 * a branded value flows freely into anything typed `string`. Only the reverse
 * is blocked — a bare `string`, or an `Ed25519AuthPubkey`, cannot be passed
 * where an `HpkeRecipientPubkey` is required. The single way to obtain one is
 * `hpkeRecipientPubkey()` below, which validates the encoding.
 */

declare const hpkeRecipientBrand: unique symbol
declare const ed25519AuthBrand: unique symbol

/**
 * A 64-hex X25519 public key, valid as an HPKE (DHKEM-X25519) recipient.
 *
 * Required by every parameter that ends up at `hpkeSeal`. Obtain one only from
 * `hpkeRecipientPubkey()` or `adminHpkeRecipient()`.
 */
export type HpkeRecipientPubkey = string & { readonly [hpkeRecipientBrand]: 'x25519' }

/**
 * A 64-hex Ed25519 public key, used to verify request signatures
 * (`apps/worker/lib/auth.ts`) and to identify a user.
 *
 * NOT a key anything can encrypt to. It is deliberately unassignable to
 * `HpkeRecipientPubkey`.
 */
export type Ed25519AuthPubkey = string & { readonly [ed25519AuthBrand]: 'ed25519' }

const HEX64_RE = /^[0-9a-f]{64}$/

/**
 * Accept a hex string as an HPKE recipient key, or return `undefined`.
 *
 * Returning `undefined` rather than throwing is deliberate: callers must decide
 * what "no recipient" means for them. The one thing none of them may do is
 * substitute a different key, which the return type now prevents.
 *
 * Validation is of the encoding only. No 32-byte string can be recognised as
 * "the X25519 one" by inspection — that is precisely the problem this type
 * exists to solve, and it is solved by controlling where the value comes from,
 * not by examining it.
 */
export function hpkeRecipientPubkey(hex: string | undefined | null): HpkeRecipientPubkey | undefined {
  const trimmed = hex?.trim()
  if (!trimmed || !HEX64_RE.test(trimmed)) return undefined
  return trimmed as HpkeRecipientPubkey
}

/** Accept a hex string as an Ed25519 auth/identity key, or return `undefined`. */
export function ed25519AuthPubkey(hex: string | undefined | null): Ed25519AuthPubkey | undefined {
  const trimmed = hex?.trim()
  if (!trimmed || !HEX64_RE.test(trimmed)) return undefined
  return trimmed as Ed25519AuthPubkey
}

/** The subset of the environment that carries the platform admin's keys. */
export interface AdminKeyEnv {
  ADMIN_PUBKEY?: Ed25519AuthPubkey | string
  ADMIN_DECRYPTION_PUBKEY?: HpkeRecipientPubkey | string
}

/**
 * The platform admin's HPKE recipient key, or `undefined` when the deployment
 * has not configured one.
 *
 * There is no fallback to `ADMIN_PUBKEY`. `validateConfig()` refuses to start a
 * server whose `ADMIN_PUBKEY` is set without a valid, distinct
 * `ADMIN_DECRYPTION_PUBKEY`, so on a running server this returns `undefined`
 * only when there is no env-configured platform admin at all — the
 * bootstrap-via-desktop path, where no admin recipient key exists yet. Callers
 * then seal to the readers they do have and omit the admin envelope; they must
 * never invent one.
 */
export function adminHpkeRecipient(env: AdminKeyEnv): HpkeRecipientPubkey | undefined {
  return hpkeRecipientPubkey(env.ADMIN_DECRYPTION_PUBKEY)
}
