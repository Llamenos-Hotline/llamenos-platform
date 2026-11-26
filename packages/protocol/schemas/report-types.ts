import { z } from 'zod'
import { entityFieldDefinitionSchema, enumOptionSchema } from './entity-schema'

// --- CMS Report Type Definition (template-defined structured reports) ---

/**
 * Extends the entity field schema with report-specific properties.
 * `supportAudioInput` enables speech-to-text dictation on textarea fields.
 */
export const reportFieldDefinitionSchema = entityFieldDefinitionSchema.extend({
  supportAudioInput: z.boolean().optional().default(false),
})

export type ReportFieldDefinition = z.infer<typeof reportFieldDefinitionSchema>

/**
 * Report Type Definition — stored in SettingsDO, created by templates or admin UI.
 *
 * Report types define structured forms for field reports (LO arrest reports,
 * misconduct reports, ICE sighting reports, etc.). Unlike entity types (which
 * are for cases/contacts/events), report types feed into the report queue for
 * triage by coordinators.
 */
export const reportTypeDefinitionSchema = z.object({
  id: z.uuid(),
  hubId: z.string(),

  name: z.string().regex(/^[a-zA-Z0-9_]+$/).max(100),
  label: z.string().max(200),
  labelPlural: z.string().max(200),
  description: z.string().max(1000).optional().default(''),
  icon: z.string().max(50).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),

  category: z.literal('report'),

  templateId: z.string().optional(),
  templateVersion: z.string().optional(),

  fields: z.array(reportFieldDefinitionSchema).max(100).optional().default([]),

  statuses: z.array(enumOptionSchema).min(1).max(50),
  defaultStatus: z.string(),
  closedStatuses: z.array(z.string()).optional().default([]),

  numberPrefix: z.string().regex(/^[A-Z]{1,5}$/).optional(),
  numberingEnabled: z.boolean().optional().default(false),

  allowFileAttachments: z.boolean().optional().default(true),
  allowCaseConversion: z.boolean().optional().default(false),
  mobileOptimized: z.boolean().optional().default(false),

  isArchived: z.boolean().optional().default(false),
  isSystem: z.boolean().optional().default(false),

  createdAt: z.string(),
  updatedAt: z.string(),
})

export type ReportTypeDefinition = z.infer<typeof reportTypeDefinitionSchema>

// --- List/wrapper response schemas ---

export const cmsReportTypeListResponseSchema = z.object({
  reportTypes: z.array(reportTypeDefinitionSchema),
})
export type CmsReportTypeListResponse = z.infer<typeof cmsReportTypeListResponseSchema>

// --- Input schemas for CRUD ---

export const createCmsReportTypeBodySchema = z.object({
  hubId: z.string().optional().default(''),
  name: z.string().regex(/^[a-zA-Z0-9_]+$/).max(100),
  label: z.string().min(1).max(200),
  labelPlural: z.string().min(1).max(200),
  description: z.string().max(1000).optional().default(''),
  icon: z.string().max(50).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),

  fields: z.array(reportFieldDefinitionSchema.omit({ id: true }).extend({
    id: z.uuid().optional(),
  })).max(100).optional().default([]),

  statuses: z.array(enumOptionSchema).min(1).max(50),
  defaultStatus: z.string(),
  closedStatuses: z.array(z.string()).optional().default([]),

  numberPrefix: z.string().regex(/^[A-Z]{1,5}$/).optional(),
  numberingEnabled: z.boolean().optional().default(false),

  allowFileAttachments: z.boolean().optional().default(true),
  allowCaseConversion: z.boolean().optional().default(false),
  mobileOptimized: z.boolean().optional().default(false),

  templateId: z.string().optional(),
  templateVersion: z.string().optional(),
})
export type CreateCmsReportTypeBody = z.input<typeof createCmsReportTypeBodySchema>

export const updateCmsReportTypeBodySchema = z.object({
  label: z.string().min(1).max(200).optional(),
  labelPlural: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  icon: z.string().max(50).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),

  fields: z.array(reportFieldDefinitionSchema.omit({ id: true }).extend({
    id: z.uuid().optional(),
  })).max(100).optional(),

  statuses: z.array(enumOptionSchema).min(1).max(50).optional(),
  defaultStatus: z.string().optional(),
  closedStatuses: z.array(z.string()).optional(),

  numberPrefix: z.string().regex(/^[A-Z]{1,5}$/).optional(),
  numberingEnabled: z.boolean().optional(),

  allowFileAttachments: z.boolean().optional(),
  allowCaseConversion: z.boolean().optional(),
  mobileOptimized: z.boolean().optional(),

  isArchived: z.boolean().optional(),
})
export type UpdateCmsReportTypeBody = z.input<typeof updateCmsReportTypeBodySchema>
