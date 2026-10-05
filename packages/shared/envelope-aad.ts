/**
 * The one definition of an envelope's additional authenticated data (AAD).
 *
 * Two AAD conventions coexist, adjudicated on main (#1393):
 *
 *   Canonical (notes, files, contact identifiers):
 *     content  (AES-256-GCM) : aad = UTF-8(label)
 *     key wrap (HPKE)        : aad = UTF-8(`${label}:key-wrap`)
 *     with the label additionally bound as the HPKE `info` (the Albrecht
 *     defense, enforced at open by `packages/crypto/src/hpke_envelope.rs`).
 *     Rust `encrypt_note` / `hpke_wrap_key` and the mobile FFI exports bind
 *     exactly this — a call site passing empty AAD beside one of those labels
 *     is the #1517-family defect.
 *
 *   Stored records (conversation messages, call metadata): NO AAD on either
 *     layer, label as HPKE `info` only. Client-sealed and server-sealed
 *     messages share a conversation with no format marker, so a reader cannot
 *     tell which AAD to supply — the reader's only viable AAD is empty. This
 *     is implemented canonically in `apps/worker/lib/crypto.ts` (`NO_AAD`),
 *     Rust `open_record_for_reader`, and the mobile `mobile_decrypt_message`.
 *     Do NOT derive an AAD from this module for LABEL_MESSAGE or
 *     LABEL_CALL_META.
 *
 * Before this module the canonical rule was written out by hand on each side,
 * and the two hands disagreed: the server derived both AADs while the desktop
 * passed empty for both, so every message the server wrote was undecryptable
 * by every desktop client (#1456, `[Encrypted]`). Two implementations of a
 * wire format is the defect. There is now one, and every party imports it.
 * Anything that needs a canonical AAD must call these functions — never
 * re-spell `${label}:key-wrap` at a call site.
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
