import { z } from 'zod'

// --- Response schemas ---

export const tagResponseSchema = z.object({
  id: z.string(),
  hubId: z.string(),
  name: z.string(),
  encryptedLabel: z.string(),
  color: z.string(),
  encryptedCategory: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
})

export type TagResponse = z.infer<typeof tagResponseSchema>

export const tagListResponseSchema = z.object({
  tags: z.array(tagResponseSchema),
})
export type TagListResponse = z.infer<typeof tagListResponseSchema>

export const tagDeleteResponseSchema = z.object({
  removedFromContacts: z.number(),
})
export type TagDeleteResponse = z.infer<typeof tagDeleteResponseSchema>

// --- Input schemas ---

export const createTagBodySchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  encryptedLabel: z.string().min(1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().default('#6b7280'),
  encryptedCategory: z.string().optional(),
})

export type CreateTagBody = z.input<typeof createTagBodySchema>

export const updateTagBodySchema = z.object({
  encryptedLabel: z.string().min(1).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  encryptedCategory: z.string().nullable().optional(),
})

export type UpdateTagBody = z.infer<typeof updateTagBodySchema>
