/**
 * A sealed free-text shift field (#2777, #2778) between its wire shape and its
 * two columns.
 *
 * On the wire the field is one object — the ciphertext and the envelopes that
 * open it — so "ciphertext with no reader" cannot be expressed. In the table it
 * is two nullable columns (`encrypted_*` text, `*_envelopes` jsonb), written and
 * cleared together here and nowhere else.
 */
import type { SealedShiftField } from '@protocol/schemas/shifts'
import type { RecipientEnvelope } from '@protocol/schemas/common'

export type SealedColumns = { ciphertext: string | null; envelopes: RecipientEnvelope[] | null }

/** The wire object as its two column values; `null` clears both. */
export function sealedFieldColumns(field: SealedShiftField | null | undefined): SealedColumns {
  return field
    ? { ciphertext: field.encryptedContent, envelopes: field.envelopes }
    : { ciphertext: null, envelopes: null }
}

/**
 * The two column values as the wire object. A row with only one of the two
 * (no write path produces one; the migration scrubbed every pre-envelope row)
 * reads as no field: a ciphertext nobody can open is not shown as one.
 */
export function sealedFieldFromColumns(ciphertext: string | null, envelopes: RecipientEnvelope[] | null): SealedShiftField | null {
  if (!ciphertext || !envelopes || envelopes.length === 0) return null
  return { encryptedContent: ciphertext, envelopes }
}
