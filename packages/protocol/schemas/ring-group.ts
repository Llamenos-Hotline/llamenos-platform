import { z } from 'zod/v4'
import { pubkeySchema } from './common'

export const ringGroupMemberSchema = z.object({
  pubkey: z.string(),
  addedBy: z.string(),
  createdAt: z.string(),
})

export const ringGroupResponseSchema = z.object({
  id: z.string(),
  hubId: z.string(),
  encryptedName: z.string(),
  memberCount: z.number().int(),
  createdAt: z.string(),
})

export const ringGroupDetailResponseSchema = z.object({
  id: z.string(),
  hubId: z.string(),
  encryptedName: z.string(),
  members: z.array(ringGroupMemberSchema),
  createdAt: z.string(),
})
export type RingGroupDetailResponse = z.infer<typeof ringGroupDetailResponseSchema>

export const ringGroupListResponseSchema = z.object({
  ringGroups: z.array(ringGroupResponseSchema),
})
export type RingGroupListResponse = z.infer<typeof ringGroupListResponseSchema>

export const createRingGroupBodySchema = z.object({
  id: z.string().uuid(),
  encryptedName: z.string().min(1),
})
export type CreateRingGroupBody = z.input<typeof createRingGroupBodySchema>

export const updateRingGroupBodySchema = z.object({
  encryptedName: z.string().min(1),
})
export type UpdateRingGroupBody = z.input<typeof updateRingGroupBodySchema>

export const ringGroupMembersBodySchema = z.object({
  pubkeys: z.array(pubkeySchema).min(1),
})
