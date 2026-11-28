import { z } from 'zod'
import { recipientEnvelopeSchema } from './common'

export const mergeContactsBodySchema = z.object({
  primaryId: z.uuid(),
  secondaryId: z.uuid(),
  mergedEncryptedSummary: z.string(),
  // Stored verbatim as the contact's summaryEnvelopes, so it is the same
  // {pubkey, enc, ct} envelope every reader of that column opens a summary with.
  mergedSummaryEnvelopes: z.array(recipientEnvelopeSchema),
  mergedBlindIndexes: z.object({
    identifierHashes: z.array(z.string()).optional().default([]),
    tagHashes: z.array(z.string()).optional().default([]),
  }).strict(),
  mergedTrigramTokens: z.array(z.string()).optional().default([]),
  mergedNameHash: z.string().optional(),
})

export const mergeContactsResponseSchema = z.object({
  primaryId: z.uuid(),
  secondaryId: z.uuid(),
  mergedAt: z.iso.datetime(),
})

export type MergeContactsBody = z.infer<typeof mergeContactsBodySchema>
export type MergeContactsResponse = z.infer<typeof mergeContactsResponseSchema>
