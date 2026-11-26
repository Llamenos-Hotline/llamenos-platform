import { z } from 'zod'

/** Hex-encoded 32-byte Nostr public key (x-only, 64 hex chars) */
export const pubkeySchema = z.string().regex(/^[0-9a-f]{64}$/, 'Must be a 64-character hex string')

/**
 * Exactly `n` bytes as lowercase hex (spec D2). Uppercase, base64url and any
 * other length are refused, never normalised — the same rule the crate
 * enforces at its boundary (`hpke_envelope::decode_hex_exact`).
 */
export function hexBytes(n: number) {
  return z.string().regex(
    new RegExp(`^[0-9a-f]{${2 * n}}$`),
    `Must be ${n} bytes of lowercase hex (${2 * n} characters)`,
  )
}

/** At least `n` bytes as lowercase hex, even length (spec D2). */
export function hexBytesMin(n: number) {
  return z.string().regex(
    new RegExp(`^(?:[0-9a-f]{2}){${n},}$`),
    `Must be at least ${n} bytes of lowercase hex`,
  )
}

/** The HPKE encapsulated key of the X25519 suite: 32 bytes, lowercase hex. */
export const hpkeEncSchema = hexBytes(32)

/** A 32-byte key HPKE-wrapped: the key plus the 16-byte AES-GCM tag, lowercase hex. */
export const hpkeKeyWrapCtSchema = hexBytes(48)

/** @deprecated Use hpkeEncSchema — kept only for schema migration references */
export const eciesPubkeySchema = hpkeEncSchema

/** UUID v4 */
export const uuidSchema = z.uuid()

/**
 * IANA time zone identifier (`America/New_York`, `Europe/Berlin`, `UTC`).
 *
 * Validated against the runtime's own tz database via `Intl.DateTimeFormat`,
 * the same facility that later evaluates it — so a value this accepts is a value
 * the shift roster can compute a wall-clock time in. A fixed UTC offset is NOT a
 * time zone: it is wrong for half the year wherever DST applies.
 */
export const ianaTimezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz })
        return true
      } catch {
        return false
      }
    },
    'Must be an IANA time zone identifier (e.g. America/New_York)',
  )

/** The zone a hub gets when none is given — and what every pre-existing hub was implicitly evaluated in. */
export const DEFAULT_HUB_TIMEZONE = 'UTC'

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

/**
 * The machine-readable `code` of the one answer that means "this hub does not
 * exist" (#2872). It is what a client may act on by forgetting the hub; the
 * `error` prose beside it is for people and may be reworded or translated freely.
 *
 * Only a lookup of the hub row by its id that finds nothing may carry it. A 403
 * (you cannot see this hub), a 404 for something inside a hub, and an update that
 * matched no rows all lack it — and a client must require status 404 AND this code,
 * so an authorization change can never be read as the hub being gone.
 */
export const HUB_NOT_FOUND_CODE = 'HUB_NOT_FOUND' as const

/** The one value of `code` that means the hub is gone — a named type so mobile codegen names it. */
export const hubNotFoundCodeSchema = z.enum([HUB_NOT_FOUND_CODE])

/** `errorResponseSchema` narrowed to the hub-is-gone answer; its `code` is mandatory. */
export const hubNotFoundResponseSchema = errorResponseSchema.extend({
  code: hubNotFoundCodeSchema,
})
export type HubNotFoundResponse = z.infer<typeof hubNotFoundResponseSchema>

/** Paginated response metadata — used across domains */
export const paginatedMeta = {
  total: z.number(),
  page: z.number(),
  limit: z.number(),
}

/** Generic success response */
export const okResponseSchema = z.object({ ok: z.boolean() })
export type OkResponse = z.infer<typeof okResponseSchema>

/**
 * The one HPKE envelope (spec D1): `{enc, ct}`, lowercase hex, no `v` and no
 * `labelId` — the label is the shape's, supplied by the crate. This is a 32-byte
 * key wrap, so `ct` is exactly 48 bytes.
 */
export const keyEnvelopeSchema = z.object({
  enc: hpkeEncSchema,
  ct: hpkeKeyWrapCtSchema,
})

/** A key envelope addressed to one reader — used across notes, messages, files. */
export const recipientEnvelopeSchema = z.object({
  pubkey: pubkeySchema,
  enc: hpkeEncSchema,
  ct: hpkeKeyWrapCtSchema,
})

/** File key envelope — used for file uploads */
export const fileKeyEnvelopeSchema = z.object({
  pubkey: pubkeySchema,
  enc: hpkeEncSchema,
  ct: hpkeKeyWrapCtSchema,
})

/** Encrypted metadata entry — used for file uploads */
export const encryptedMetadataEntrySchema = z.object({
  pubkey: z.string().min(1),
  encryptedContent: hexBytesMin(28).max(4096),
  enc: hpkeEncSchema,
  ct: hpkeKeyWrapCtSchema,
})

// --- Inferred types (canonical source of truth for envelope types) ---

/** HPKE-wrapped symmetric key for one recipient. */
export type RecipientEnvelope = z.infer<typeof recipientEnvelopeSchema>

/** The one HPKE envelope: `{enc, ct}` (spec D1). */
export type KeyEnvelope = z.infer<typeof keyEnvelopeSchema>

/** @deprecated Use RecipientEnvelope instead. */
export type RecipientKeyEnvelope = RecipientEnvelope

/** HPKE-wrapped file encryption key for one recipient. */
export type FileKeyEnvelope = z.infer<typeof fileKeyEnvelopeSchema>
