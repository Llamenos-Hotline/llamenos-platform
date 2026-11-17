import { z } from 'zod'
import { e164PhoneSchema } from './common'

// --- Response schemas ---

// A ban list entry carries no number, masked or otherwise: the server keeps only a
// keyed hash of a banned number. `phoneHash` is an opaque handle for unbanning.
export const banResponseSchema = z.object({
  phoneHash: z.string(),
  reason: z.string(),
  bannedBy: z.string(),
  bannedAt: z.string(),
})

export type BanEntry = z.infer<typeof banResponseSchema>

// --- List/wrapper response schemas ---

export const banListResponseSchema = z.object({
  bans: z.array(banResponseSchema),
})

/** `POST /bans` answers with the ban it created — the desktop reads it back from `ban`. */
export const createBanResponseSchema = z.object({
  ban: banResponseSchema,
})

export const bulkBanResponseSchema = z.object({
  count: z.number(),
})

// --- Input schemas ---

export const createBanBodySchema = z.object({
  phone: e164PhoneSchema,
  reason: z.string().max(500).optional(),
})

export const bulkBanBodySchema = z.object({
  phones: z.array(e164PhoneSchema).min(1).max(500),
  reason: z.string().max(500).optional(),
})

export const platformBanResponseSchema = z.object({
  id: z.string(),
  phoneHash: z.string(),
  reason: z.string().nullable(),
  bannedBy: z.string().nullable(),
  bannedAt: z.string(),
})

export type PlatformBan = z.infer<typeof platformBanResponseSchema>

export const platformBanListResponseSchema = z.object({
  bans: z.array(platformBanResponseSchema),
  total: z.number(),
})

// --- Ban digests (#2759) ---
//
// A platform ban never carries the number. An admin's client blinds the E.164 number it was
// given, the server evaluates the blinded element under the scope's ban key without learning
// the number (`POST /admin/bans/evaluate`), and the client finalizes that into the number's
// ban digest — RFC 9497 OPRF, ristretto255-SHA512, implemented once in
// `packages/crypto/src/ban_digest.rs`. The server computes the same digest from an inbound
// caller's number to match the call in real time. No client ever holds the key, so a stored
// digest cannot be reversed by enumerating the (small) phone-number space offline.

/** A number's ban digest under one scope: the RFC 9497 `Finalize` output, 64 bytes as hex. */
export const banDigestSchema = z.string().regex(/^[0-9a-f]{128}$/, 'Must be a 128-hex-char ban digest')

/** One ristretto255 group element (a blinded or an evaluated element), 32 bytes as hex. */
export const banDigestElementSchema = z.string().regex(/^[0-9a-f]{64}$/, 'Must be a 64-hex-char group element')

/** `POST /admin/bans/evaluate`: blinded numbers to evaluate under the platform's ban key. */
export const banDigestEvaluateBodySchema = z.object({
  blindedElements: z.array(banDigestElementSchema).min(1).max(500),
})

/** The evaluated elements, in request order. */
export const banDigestEvaluateResponseSchema = z.object({
  evaluatedElements: z.array(banDigestElementSchema),
})

export const createPlatformBanBodySchema = z.object({
  /** The number's platform ban digest (see `banDigestSchema`). Never the number. */
  phoneHash: banDigestSchema,
  reason: z.string().max(500).optional(),
})

export const bulkPlatformBanBodySchema = z.object({
  phoneHashes: z.array(banDigestSchema).min(1).max(500),
  reason: z.string().max(500).optional(),
})

export const promoteBanBodySchema = z.object({
  banId: z.string().min(1),
  /**
   * The number's digest under the source ban's hub. It must equal the stored hub ban, so a
   * number mistyped on re-entry cannot ban someone else.
   */
  sourcePhoneHash: banDigestSchema,
  /** The same number's platform digest: what the new platform ban stores. */
  phoneHash: banDigestSchema,
})

/** `POST /admin/bans/search/evaluate`: one blinded number, evaluated under every scope's key. */
export const searchBansEvaluateBodySchema = z.object({
  blindedElement: banDigestElementSchema,
})

export const searchBansEvaluateResponseSchema = z.object({
  /** One evaluation per scope: `hubId` names a hub, `null` the platform. */
  evaluations: z.array(
    z.object({
      hubId: z.string().nullable(),
      evaluatedElement: banDigestElementSchema,
    }),
  ),
})

/** `POST /admin/bans/search`: the number's digest per scope, from the finalized evaluations. */
export const searchBansBodySchema = z.object({
  lookups: z
    .array(
      z.object({
        hubId: z.string().min(1).nullable(),
        phoneHash: banDigestSchema,
      }),
    )
    .min(1)
    .max(1000),
})

export const searchBansResponseSchema = z.object({
  bans: z.array(
    z.object({
      id: z.string(),
      hubId: z.string().nullable(),
      phoneHash: z.string(),
      reason: z.string().nullable(),
      bannedBy: z.string().nullable(),
      bannedAt: z.string(),
    }),
  ),
})
