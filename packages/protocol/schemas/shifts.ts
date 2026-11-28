import { z } from 'zod'
import { pubkeySchema, recipientEnvelopeSchema } from './common'

// --- Sealed free-text shift fields (#2777, #2778) ---

/**
 * A free-text shift field sealed on the client: an availability block's
 * reason, or a shift override's note. The server never sees the text.
 *
 * `encryptedContent` is `hex(iv(12) || AES-256-GCM(content key) || tag(16))`
 * and `envelopes` wrap the content key for each reader, exactly as
 * `packages/crypto/src/shift_record.rs` produces them (PROTOCOL §2.19): the
 * label (`LABEL_AVAILABILITY_REASON` / `LABEL_SHIFT_OVERRIDE_NOTE`) and the AAD
 * are fixed by the purpose, never by a client. A bare string is refused — that
 * is how both columns came to hold the typed text.
 *
 * At least one envelope must be addressed to an admin of the hub; the server
 * refuses the write otherwise (`assertAdminCanRead`).
 */
export const sealedShiftFieldSchema = z.object({
  // 56 hex = iv + tag over an empty plaintext; 8192 hex ≈ 4 KB of text.
  encryptedContent: z.string().regex(/^[0-9a-f]+$/, 'Must be lowercase hex').min(56).max(8192),
  envelopes: z.array(recipientEnvelopeSchema).min(1),
})

export type SealedShiftField = z.infer<typeof sealedShiftFieldSchema>

// --- Response schemas ---

export const shiftResponseSchema = z.object({
  id: z.string(),
  encryptedName: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  days: z.array(z.number()),
  ringGroupId: z.string().nullable(),
  userPubkeys: z.array(z.string()),
  createdAt: z.string(),
})

export type Shift = z.infer<typeof shiftResponseSchema>

export const myStatusResponseSchema = z.object({
  /** On the schedule NOW (an admin put them on a shift covering this moment). Not the same as being a ring target. */
  onShift: z.boolean(),
  /**
   * Has an `active_shifts` row for this hub — the volunteer's own consent to receive calls.
   * Ringing requires `onShift` AND `clockedIn`; neither alone makes the volunteer a ring target.
   */
  clockedIn: z.boolean().optional().default(false),
  /** When they clocked in (ISO 8601); null when not clocked in. */
  clockedInAt: z.string().nullable().optional().default(null),
  currentShift: z.object({ id: z.string(), encryptedName: z.string(), startTime: z.string(), endTime: z.string() }).nullable(),
  nextShift: z.object({ id: z.string(), encryptedName: z.string(), startTime: z.string(), endTime: z.string(), day: z.number() }).nullable(),
})

export type ShiftStatus = z.infer<typeof myStatusResponseSchema>

export const clockStatusResponseSchema = z.object({
  users: z.array(z.object({
    pubkey: z.string(),
    startedAt: z.string(),
    lastHeartbeat: z.string(),
  })),
})

// --- List/wrapper response schemas ---

export const shiftListResponseSchema = z.object({
  shifts: z.array(shiftResponseSchema),
})
export type ShiftListResponse = z.infer<typeof shiftListResponseSchema>

// --- Input schemas ---

export const createShiftBodySchema = z.object({
  id: z.string().uuid(),
  encryptedName: z.string().min(1).max(200),
  startTime: z.string(),
  endTime: z.string(),
  days: z.array(z.number().int().min(0).max(6)),
  ringGroupId: z.string().nullable().optional().default(null),
  userPubkeys: z.array(pubkeySchema),
})

export type CreateShiftBody = z.infer<typeof createShiftBodySchema>

export const updateShiftBodySchema = z.object({
  encryptedName: z.string().min(1).max(200).optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  days: z.array(z.number().int().min(0).max(6)).optional(),
  ringGroupId: z.string().nullable().optional(),
  userPubkeys: z.array(pubkeySchema).optional(),
})
export type UpdateShiftBody = z.input<typeof updateShiftBodySchema>

export const fallbackGroupSchema = z.object({
  userPubkeys: z.array(pubkeySchema),
})

export type FallbackGroup = z.infer<typeof fallbackGroupSchema>
