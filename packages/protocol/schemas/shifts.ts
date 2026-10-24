import { z } from 'zod'
import { pubkeySchema } from './common'

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

export const fallbackGroupSchema = z.object({
  userPubkeys: z.array(pubkeySchema),
})
