import { z } from 'zod/v4'
import { pubkeySchema } from './common'
import { sealedShiftFieldSchema } from './shifts'

const overrideTypeSchema = z.enum(['cancel', 'substitute'])

export const shiftOverrideResponseSchema = z.object({
  id: z.string(),
  hubId: z.string(),
  shiftId: z.string().nullable(),
  date: z.string(),
  type: overrideTypeSchema,
  userPubkeys: z.array(z.string()).nullable(),
  /** The override note, sealed to the hub's admins and its `shifts:manage-overrides` holders. */
  encryptedNote: sealedShiftFieldSchema.nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
})

export const shiftOverrideListResponseSchema = z.object({
  overrides: z.array(shiftOverrideResponseSchema),
})

export const createShiftOverrideBodySchema = z.object({
  id: z.string().uuid(),
  shiftId: z.string().nullable().optional().default(null),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  type: overrideTypeSchema,
  userPubkeys: z.array(pubkeySchema).nullable().optional().default(null),
  encryptedNote: sealedShiftFieldSchema.nullable().optional().default(null),
})

export const overrideQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})

export type ShiftOverride = z.infer<typeof shiftOverrideResponseSchema>
export type ShiftOverrideListResponse = z.infer<typeof shiftOverrideListResponseSchema>
/** What a client sends: defaulted keys may be omitted. */
export type CreateShiftOverrideBody = z.input<typeof createShiftOverrideBodySchema>
