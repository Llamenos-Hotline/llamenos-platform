/**
 * The one definition of an envelope's additional authenticated data (AAD).
 *
 * `docs/protocol/PROTOCOL.md` §2.4 specifies two distinct, non-empty AAD
 * values for every envelope-pattern ciphertext:
 *
 *   content  (AES-256-GCM) : aad = UTF-8(label)
 *   key wrap (HPKE)        : aad = UTF-8(`${label}:key-wrap`)
 *
 * with the label additionally bound as the HPKE `info` (the Albrecht defense,
 * enforced at open by `packages/crypto/src/hpke_envelope.rs`). The two AADs
 * must differ: `hpkeSeal` is used both to carry content directly and to wrap a
 * content key under the *same* label, and only the AAD separates those two
 * meanings.
 *
 * Before this module the rule was written out by hand on each side, and the
 * two hands disagreed: the server derived both AADs (`apps/worker/lib/crypto.ts`),
 * the desktop passed empty for both (`src/client/lib/platform.ts`). Every
 * message the server wrote was therefore undecryptable by every desktop
 * client, failing the HPKE tag check first and the AES-GCM tag check second.
 *
 * Two implementations of a wire format is the defect. There is now one, and
 * both sides import it. Anything that needs an AAD must call these functions —
 * never re-spell `${label}:key-wrap` at a call site.
 */
import { utf8ToBytes, bytesToHex } from './encoding'

/** The suffix that distinguishes a key-wrap envelope from a content envelope. */
export const KEY_WRAP_AAD_SUFFIX = ':key-wrap'

/**
 * AAD for the AES-256-GCM encryption of an envelope's *content*.
 *
 * @param label a domain separation label from `@shared/crypto-labels`
 */
export function contentAad(label: string): Uint8Array {
  return utf8ToBytes(label)
}

/**
 * AAD for the HPKE seal that *wraps the content key* for one reader.
 *
 * @param label a domain separation label from `@shared/crypto-labels`
 */
export function keyWrapAad(label: string): Uint8Array {
  return utf8ToBytes(`${label}${KEY_WRAP_AAD_SUFFIX}`)
}

/**
 * `contentAad` as hex, for the crypto entry points that take `aadHex`
 * (the Tauri IPC commands and the UniFFI `mobile_*` functions).
 */
export function contentAadHex(label: string): string {
  return bytesToHex(contentAad(label))
}

/**
 * `keyWrapAad` as hex, for the crypto entry points that take `aadHex`.
 */
export function keyWrapAadHex(label: string): string {
  return bytesToHex(keyWrapAad(label))
}
