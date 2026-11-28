import { z } from 'zod'
import { noteResponseSchema } from './notes'
import { conversationResponseSchema } from './conversations'

// --- Contact Timeline schemas (aggregated interaction view) ---
// These serve the "Contacts" tab — aggregated counts and timeline.
// Distinct from contacts-v2.ts which serves the CMS directory (encrypted profiles).

export const contactTimelineSummarySchema = z.object({
  contactHash: z.string(),
  firstSeen: z.string(),
  lastSeen: z.string(),
  callCount: z.number(),
  conversationCount: z.number(),
  noteCount: z.number(),
  reportCount: z.number(),
})

export type ContactTimelineSummary = z.infer<typeof contactTimelineSummarySchema>

export const contactTimelineListResponseSchema = z.object({
  contacts: z.array(contactTimelineSummarySchema),
  total: z.number(),
})
export type ContactTimelineListResponse = z.infer<typeof contactTimelineListResponseSchema>

export const contactTimelineDetailResponseSchema = z.object({
  notes: z.array(noteResponseSchema),
  conversations: z.array(conversationResponseSchema),
})
export type ContactTimelineDetailResponse = z.infer<typeof contactTimelineDetailResponseSchema>

export const contactTimelineResponseSchema = z.object({
  contact: contactTimelineSummarySchema,
  calls: z.array(z.record(z.string(), z.unknown())),
  conversations: z.array(z.record(z.string(), z.unknown())),
  notes: z.array(z.record(z.string(), z.unknown())),
})
