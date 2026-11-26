/**
 * TEST-SIDE ONLY: the format-1 envelope AAD bytes, for the JS mirrors and the
 * format-1 fixture generators that cannot load the crate.
 *
 * Production hosts never build an envelope AAD. Every client and the server name
 * a SHAPE (`@shared/crypto-shapes`) and `packages/crypto/src/shape.rs` supplies
 * the label and AAD (spec D1). `packages/crypto/tests/envelope_aad_cross_platform.rs`
 * fails if any production source imports this module.
 *
 * The bytes (format 1):
 *   canonical shapes (notes, files, contacts, hub key, firehose):
 *     content  (AES-256-GCM) : aad = UTF-8(label)
 *     key wrap (HPKE)        : aad = UTF-8(`${label}:key-wrap`)
 *   stored records (messages, call metadata): no AAD on either layer.
 * The label is bound as HPKE `info` in both.
 */
import { utf8ToBytes, bytesToHex } from './encoding'

/** The suffix that distinguishes a key-wrap envelope from a content envelope. */
export const KEY_WRAP_AAD_SUFFIX = ':key-wrap'

/**
 * The AAD of a *stored record*: none, on either layer (#1393).
 *
 * The second of the two conventions this module's docblock adjudicates, and
 * until now the only one with no name — so every party that reads a
 * server-sealed record spelled `new Uint8Array(0)` out by hand
 * (`apps/worker/lib/crypto.ts`, the mobile decrypt paths, each BDD reader).
 * A convention that has a value but no symbol is a convention that drifts,
 * which is the whole reason this module exists.
 *
 * Which of the two conventions applies is a property of the **writer**, not of
 * the label. `apps/worker/lib/crypto.ts` seals LABEL_CALL_META as a stored
 * record, while `apps/worker/lib/sample-crypto.ts` seals that same label
 * canonically. So never branch on a label to pick an
 * AAD — take the convention from whoever wrote the record, and say which one
 * you mean at the call site.
 */
export const NO_AAD: Uint8Array = new Uint8Array(0)

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
