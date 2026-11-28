import { z } from 'zod'
import { recipientEnvelopeSchema } from './common'

export const bulkContactActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('add-tags'),
    contactIds: z.array(z.uuid()).min(1).max(100),
    payload: z.object({
      tags: z.array(z.string().max(50)).min(1).max(20),
      updatedBlindIndexes: z.array(z.object({
        contactId: z.uuid(),
        tagHashes: z.array(z.string()),
      })).optional().default([]),
    }),
  }),
  z.object({
    action: z.literal('remove-tags'),
    contactIds: z.array(z.uuid()).min(1).max(100),
    payload: z.object({
      tags: z.array(z.string().max(50)).min(1).max(20),
      updatedBlindIndexes: z.array(z.object({
        contactId: z.uuid(),
        tagHashes: z.array(z.string()),
      })).optional().default([]),
    }),
  }),
  z.object({
    action: z.literal('add-to-group'),
    contactIds: z.array(z.uuid()).min(1).max(100),
    payload: z.object({ groupId: z.uuid() }),
  }),
  z.object({
    action: z.literal('remove-from-group'),
    contactIds: z.array(z.uuid()).min(1).max(100),
    payload: z.object({ groupId: z.uuid() }),
  }),
  z.object({
    action: z.literal('set-risk-level'),
    contactIds: z.array(z.uuid()).min(1).max(100),
    payload: z.object({ riskLevel: z.enum(['low', 'medium', 'high', 'critical']) }),
  }),
  z.object({
    action: z.literal('delete'),
    contactIds: z.array(z.uuid()).min(1).max(100),
    payload: z.object({}),
  }),
])

export const bulkContactActionResponseSchema = z.object({
  affected: z.number().int(),
  action: z.string(),
})

export const bulkCreateContactBodySchema = z.object({
  contacts: z.array(z.object({
    encryptedSummary: z.string(),
    // Stored verbatim as the contact's summaryEnvelopes: the same {pubkey, enc, ct}
    // envelope the single-contact create carries.
    summaryEnvelopes: z.array(recipientEnvelopeSchema),
    blindIndexes: z.object({
      identifierHashes: z.array(z.string()).optional().default([]),
      tagHashes: z.array(z.string()).optional().default([]),
    }).strict(),
    trigramTokens: z.array(z.string()).optional().default([]),
    nameHash: z.string().optional(),
  })).min(1).max(100),
})

export const bulkCreateContactResponseSchema = z.object({
  created: z.number().int(),
  contactIds: z.array(z.uuid()),
})

export type BulkContactAction = z.infer<typeof bulkContactActionSchema>
export type BulkContactActionResponse = z.infer<typeof bulkContactActionResponseSchema>
export type BulkCreateContactBody = z.infer<typeof bulkCreateContactBodySchema>
export type BulkCreateContactResponse = z.infer<typeof bulkCreateContactResponseSchema>
