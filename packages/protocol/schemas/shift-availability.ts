import { z } from 'zod/v4'
import { sealedShiftFieldSchema } from './shifts'

export const availabilityBlockResponseSchema = z.object({
  id: z.string(),
  hubId: z.string(),
  userPubkey: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  /** The volunteer's reason, sealed to them, the hub's admins and its `shifts:manage` holders. */
  encryptedReason: sealedShiftFieldSchema.nullable(),
  createdAt: z.string(),
})

export const availabilityBlockListResponseSchema = z.object({
  blocks: z.array(availabilityBlockResponseSchema),
})

export const createAvailabilityBlockBodySchema = z.object({
  id: z.string().uuid(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  encryptedReason: sealedShiftFieldSchema.nullable().optional().default(null),
})

export type AvailabilityBlock = z.infer<typeof availabilityBlockResponseSchema>
export type AvailabilityBlockListResponse = z.infer<typeof availabilityBlockListResponseSchema>
/** What a client sends: defaulted keys may be omitted. */
export type CreateAvailabilityBlockBody = z.input<typeof createAvailabilityBlockBodySchema>
