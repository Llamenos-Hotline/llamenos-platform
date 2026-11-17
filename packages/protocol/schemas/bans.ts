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

/**
 * A ban that stopped enforcing and has to be entered again (#2829): the digest scheme changed
 * or the server's ban key was replaced, and the server cannot recompute a digest from a number
 * it never kept. It carries no number and no digest — only when it was banned, by whom, and
 * the admin's note, so re-entering it is deliberate. `id` dismisses it once it is re-entered.
 */
export const banReentryResponseSchema = z.object({
  id: z.string(),
  reason: z.string().nullable(),
  bannedBy: z.string().nullable(),
  bannedAt: z.string(),
  cause: z.enum(['digest-scheme', 'key-replaced']),
  retiredAt: z.string(),
})

export type BanReentry = z.infer<typeof banReentryResponseSchema>

export const banListResponseSchema = z.object({
  bans: z.array(banResponseSchema),
  /** Bans that no longer enforce and must be re-entered. Empty when every ban in `bans` enforces. */
  reentries: z.array(banReentryResponseSchema).optional().default([]),
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
  /** Platform bans that no longer enforce and must be re-entered (see `banReentryResponseSchema`). */
  reentries: z.array(banReentryResponseSchema).optional().default([]),
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

/** The most blinded numbers one evaluate request may carry; clients send larger sets in chunks. */
export const BAN_DIGEST_EVALUATE_BATCH_MAX = 100

/** `POST /admin/bans/evaluate`: blinded numbers to evaluate under the platform's ban key. */
export const banDigestEvaluateBodySchema = z.object({
  blindedElements: z.array(banDigestElementSchema).min(1).max(BAN_DIGEST_EVALUATE_BATCH_MAX),
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

/** A number evaluated under one scope's key. `hubId` names a hub; it is absent for the platform. */
export const banScopeEvaluationSchema = z.object({
  hubId: z.string().min(1).optional(),
  evaluatedElement: banDigestElementSchema,
})

export const searchBansEvaluateResponseSchema = z.object({
  /** One evaluation per scope: the platform's and every hub's. */
  evaluations: z.array(banScopeEvaluationSchema),
})

/** A number's digest under one scope. `hubId` names a hub; it is absent for the platform. */
export const banLookupSchema = z.object({
  hubId: z.string().min(1).optional(),
  phoneHash: banDigestSchema,
})

/** `POST /admin/bans/search`: the number's digest per scope, from the finalized evaluations. */
export const searchBansBodySchema = z.object({
  lookups: z.array(banLookupSchema).min(1).max(1000),
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

export type BanLookup = z.infer<typeof banLookupSchema>
export type BanDigestEvaluateResponse = z.infer<typeof banDigestEvaluateResponseSchema>
export type SearchBansEvaluateResponse = z.infer<typeof searchBansEvaluateResponseSchema>
export type SearchBansResponse = z.infer<typeof searchBansResponseSchema>
export type BulkBanResponse = z.infer<typeof bulkBanResponseSchema>
