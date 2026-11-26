import { z } from 'zod'
import { pubkeySchema, paginationSchema, recipientEnvelopeSchema } from './common'
import { conversationResponseSchema, conversationMetadataSchema } from './conversations'
import { fileRecordSchema } from './files'

// --- Response schemas ---

export const reportResponseSchema = z.object({
  id: z.string(),
  title: z.string(),
  category: z.string().optional(),
  reportTypeId: z.string().optional(),
  status: z.enum(['waiting', 'active', 'closed']),
  encryptedContent: z.string(),
  readerEnvelopes: z.array(recipientEnvelopeSchema),
  createdBy: z.string(),
  assignedTo: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messageCount: z.number().optional(),
})

export const reportMessageResponseSchema = z.object({
  id: z.string(),
  reportId: z.string(),
  encryptedContent: z.string(),
  readerEnvelopes: z.array(recipientEnvelopeSchema),
  authorPubkey: z.string(),
  attachmentIds: z.array(z.string()).optional(),
  createdAt: z.string(),
})

export const conversionStatusEnum = z.enum(['pending', 'in_progress', 'completed'])

// --- List/wrapper response schemas ---

/**
 * A report is a conversation whose metadata is stamped `type: 'report'`; every
 * `/reports` route 404s a conversation that is not one, so on this surface
 * `metadata` is never absent.
 */
export const reportConversationSchema = conversationResponseSchema.extend({
  metadata: conversationMetadataSchema.extend({ type: z.literal('report') }),
})
export type Report = z.infer<typeof reportConversationSchema>

export const reportListResponseSchema = z.object({
  // The route returns full conversation rows (services.conversations.list) —
  // the reports list IS the report-type conversation list.
  conversations: z.array(reportConversationSchema),
  total: z.number(),
})
export type ReportListResponse = z.infer<typeof reportListResponseSchema>

export const reportCategoriesResponseSchema = z.object({
  categories: z.array(z.string()),
})
export type ReportCategoriesResponse = z.infer<typeof reportCategoriesResponseSchema>

/** A report's completed attachments — the file rows themselves (names stay encrypted). */
export const reportFilesResponseSchema = z.object({
  files: z.array(fileRecordSchema),
})
export type ReportFilesResponse = z.infer<typeof reportFilesResponseSchema>

export const reportLinkedCasesResponseSchema = z.object({
  records: z.array(z.object({
    reportId: z.string(),
    caseId: z.string(),
    linkedAt: z.string(),
    linkedBy: z.string(),
    encryptedNotes: z.string().optional(),
  })),
  total: z.number(),
})
export type ReportLinkedCasesResponse = z.infer<typeof reportLinkedCasesResponseSchema>

// --- Input schemas ---

export const listReportsQuerySchema = paginationSchema.extend({
  status: z.string().optional(),
  category: z.string().optional(),
  conversionEnabled: z.coerce.boolean().optional(),
  conversionStatus: conversionStatusEnum.optional(),
})

export const createReportBodySchema = z.object({
  title: z.string().min(1).max(500),
  category: z.string().optional(),
  reportTypeId: z.string().optional(),
  encryptedContent: z.string().min(1, 'Report content is required').max(131072),
  readerEnvelopes: z.array(recipientEnvelopeSchema).min(1, 'At least one reader envelope required'),
})
export type CreateReportBody = z.input<typeof createReportBodySchema>

export const reportMessageBodySchema = z.object({
  encryptedContent: z.string().min(1, 'encryptedContent is required').max(65536),
  readerEnvelopes: z.array(recipientEnvelopeSchema).min(1, 'At least one reader envelope required'),
  attachmentIds: z.array(z.string()).optional(),
})
export type ReportMessageBody = z.input<typeof reportMessageBodySchema>

export const assignReportBodySchema = z.object({
  assignedTo: pubkeySchema,
})

export const updateReportBodySchema = z.object({
  status: z.enum(['waiting', 'active', 'closed']).optional(),
  conversionStatus: conversionStatusEnum.optional(),
})
export type UpdateReportBody = z.input<typeof updateReportBodySchema>
