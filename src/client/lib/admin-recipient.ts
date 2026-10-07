/**
 * The admin's HPKE recipient key, as a type a volunteer's own key cannot
 * impersonate.
 *
 * `apps/worker/lib/hpke-recipient.ts` carries the full explanation; the short
 * version is that an Ed25519 signing key and an X25519 encryption key are both
 * 32 bytes carried as 64 hex characters, and DHKEM(X25519) — the KEM half of
 * the HPKE suite used everywhere here — accepts *any* 32 bytes as a recipient.
 * So substituting one key for another does not throw, does not warn, and does
 * not fail: it writes an envelope that is either unopenable by anyone, or
 * opened by the wrong person.
 *
 * This client had the second shape of that bug (#1468). Five note call sites
 * read:
 *
 *     const adminPub = adminDecryptionPubkey || authorPub
 *
 * When the server supplies no admin decryption key — a hub bootstrapped from
 * the desktop, where no `ADMIN_DECRYPTION_PUBKEY` exists yet — the note was
 * wrapped twice to the author's own key. It saved, it showed as saved, it
 * appeared normally in the author's own history, and **no admin could read it
 * at all**. The product requirement is that admins can read every note; for a
 * crisis hotline the loss surfaces during an escalation or an audit, long
 * after the call.
 *
 * `||` type-checked because both sides are `string`. The brand below is the
 * same remedy #1466 applied on the server: the only way to obtain an
 * `AdminHpkeRecipient` is `adminHpkeRecipient()`, so a bare string — the
 * author's key included — can no longer reach `encryptNote`'s admin
 * parameter. Callers must handle `undefined` by refusing to write, not by
 * substituting.
 */

declare const adminHpkeRecipientBrand: unique symbol

/** A 64-hex X25519 key belonging to an admin, valid as an HPKE recipient. */
export type AdminHpkeRecipient = string & { readonly [adminHpkeRecipientBrand]: 'x25519-admin' }

const HEX64_RE = /^[0-9a-f]{64}$/

/**
 * Accept the server-supplied admin decryption pubkey as an HPKE recipient, or
 * return `undefined` when the deployment has none.
 *
 * Validation is of the encoding only. No 32-byte string can be recognised as
 * "the X25519 one" by inspection — that is exactly the problem this type
 * exists to solve, and it is solved by controlling where the value comes from.
 */
export function adminHpkeRecipient(hex: string | null | undefined): AdminHpkeRecipient | undefined {
  const trimmed = hex?.trim().toLowerCase()
  if (!trimmed || !HEX64_RE.test(trimmed)) return undefined
  return trimmed as AdminHpkeRecipient
}
