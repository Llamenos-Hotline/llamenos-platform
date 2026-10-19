import { z } from 'zod'

/** Hex-encoded 32-byte Nostr public key (x-only, 64 hex chars) */
export const pubkeySchema = z.string().regex(/^[0-9a-f]{64}$/, 'Must be a 64-character hex string')

/** Hex-encoded X25519 ephemeral public key (32 bytes → 64 lowercase hex chars). Hex is the sole wire encoding. */
export const hpkeEncSchema = z.string().regex(
  /^[0-9a-f]{64}$/,
  'Must be a 64-character lowercase hex string',
)

/** @deprecated Use hpkeEncSchema — kept only for schema migration references */
export const eciesPubkeySchema = hpkeEncSchema

/** UUID v4 */
export const uuidSchema = z.uuid()

/** E.164 phone number */
export const e164PhoneSchema = z.string().regex(/^\+\d{7,15}$/, 'Must be E.164 format (+XXXXXXXXXXX)')

/** Pagination parameters — bounded and defaulted */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).optional().default(1),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
})

/** Cursor-based pagination */
export const cursorPaginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
})

/** ISO 8601 date string */
export const isoDateSchema = z.iso.datetime().or(
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format')
)

/** Standard error response envelope */
export const errorResponseSchema = z.object({
  error: z.string(),
  /** Machine-readable error code clients branch on (e.g. WEBAUTHN_REQUIRED) */
  code: z.string().optional(),
  details: z.array(z.object({
    field: z.string(),
    message: z.string(),
    code: z.string().optional(),
  })).optional(),
  requestId: z.string().optional(),
})

export type ErrorResponse = z.infer<typeof errorResponseSchema>

/** Paginated response metadata — used across domains */
export const paginatedMeta = {
  total: z.number(),
  page: z.number(),
  limit: z.number(),
}

/** Generic success response */
export const okResponseSchema = z.object({ ok: z.boolean() })
export type OkResponse = z.infer<typeof okResponseSchema>

/** HPKE recipient envelope — used across notes, messages, files */
export const recipientEnvelopeSchema = z.object({
  pubkey: pubkeySchema,
  enc: hpkeEncSchema,
  // HPKE-wrapped 32-byte symmetric key: 48 bytes ciphertext + base64 overhead ≤ 512 chars
  ct: z.string().min(1).max(512),
})

/** Key envelope — used for note author copies (no pubkey) */
export const keyEnvelopeSchema = z.object({
  enc: hpkeEncSchema,
  ct: z.string().min(1).max(512),
})

/** File key envelope — used for file uploads */
export const fileKeyEnvelopeSchema = z.object({
  pubkey: pubkeySchema,
  enc: hpkeEncSchema,
  ct: z.string().min(1).max(512),
})

/** Encrypted metadata entry — used for file uploads */
export const encryptedMetadataEntrySchema = z.object({
  pubkey: z.string().min(1),
  encryptedContent: z.string().min(1).max(4096),
  enc: hpkeEncSchema,
  ct: z.string().min(1).max(512),
})

// --- Inferred types (canonical source of truth for envelope types) ---

/** HPKE-wrapped symmetric key for one recipient. */
export type RecipientEnvelope = z.infer<typeof recipientEnvelopeSchema>

/** Key envelope — note author copies (no pubkey). @deprecated Use RecipientEnvelope. */
export type KeyEnvelope = z.infer<typeof keyEnvelopeSchema>

/** @deprecated Use RecipientEnvelope instead. */
export type RecipientKeyEnvelope = RecipientEnvelope

/** HPKE-wrapped file encryption key for one recipient. */
export type FileKeyEnvelope = z.infer<typeof fileKeyEnvelopeSchema>
