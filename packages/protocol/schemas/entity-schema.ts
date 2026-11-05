import { z } from 'zod'

// --- Reusable building blocks ---

export const enumOptionSchema = z.object({
  value: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(50),
  label: z.string().max(200),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  icon: z.string().max(50).optional(),
  order: z.number().int().min(0).optional().default(0),
  isDefault: z.boolean().optional(),
  isClosed: z.boolean().optional(),
  isDeprecated: z.boolean().optional(),
})

export type EnumOption = z.infer<typeof enumOptionSchema>

// --- Conditional visibility rule ---

const showWhenSchema = z.object({
  field: z.string(),
  operator: z.enum(['equals', 'not_equals', 'contains', 'is_set']),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
})

// --- Field option (for select/multiselect) ---

const fieldOptionSchema = z.object({
  key: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(100),
  label: z.string().max(200),
})

// --- Entity Field Definition ---

export const entityFieldDefinitionSchema = z.object({
  id: z.uuid(),
  name: z.string().regex(/^[a-zA-Z0-9_]+$/).max(50),
  label: z.string().max(200),
  type: z.enum([
    'text', 'number', 'select', 'multiselect', 'checkbox',
    'textarea', 'date', 'file', 'location',
  ]),
  required: z.boolean().optional().default(false),
  options: z.array(fieldOptionSchema).max(50).optional(),
  locationOptions: z.object({
    maxPrecision: z.enum(['none', 'city', 'neighborhood', 'block', 'exact']).optional().default('exact'),
    allowGps: z.boolean().optional().default(true),
    allowAutocomplete: z.boolean().optional().default(true),
  }).optional(),
  lookupId: z.string().optional(),
  validation: z.object({
    minLength: z.number().optional(),
    maxLength: z.number().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    pattern: z.string().optional(),
  }).optional(),
  section: z.string().max(100).optional(),
  helpText: z.string().max(500).optional(),
  placeholder: z.string().max(200).optional(),
  defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
  order: z.number().int().min(0).optional().default(0),

  // Blind index configuration
  indexable: z.boolean().optional().default(false),
  indexType: z.enum(['exact', 'date', 'location', 'none']).optional().default('none'),

  // Access control
  accessLevel: z.enum(['all', 'admin', 'assigned', 'custom']).optional().default('all'),
  accessRoles: z.array(z.string()).optional(),

  // Visibility rules
  visibleToUsers: z.boolean().optional().default(true),
  editableByUsers: z.boolean().optional().default(true),

  // Conditional display
  showWhen: showWhenSchema.optional(),

  // Template tracking
  templateId: z.string().optional(),
  hubEditable: z.boolean().optional().default(true),

  // Audit
  createdAt: z.iso.datetime().optional(),
})

export type EntityFieldDefinition = z.infer<typeof entityFieldDefinitionSchema>

// --- Entity category ---

export const entityCategorySchema = z.enum(['contact', 'case', 'event', 'custom'])
export type EntityCategory = z.infer<typeof entityCategorySchema>

// --- Entity Type Definition (full record, stored in SettingsDO) ---

export const entityTypeDefinitionSchema = z.object({
  id: z.uuid(),
  hubId: z.string().optional().default(''),

  name: z.string().regex(/^[a-zA-Z0-9_]+$/).max(100).optional().default(''),
  label: z.string().max(200).optional().default(''),
  labelPlural: z.string().max(200).optional().default(''),
  description: z.string().max(1000).optional().default(''),
  icon: z.string().max(50).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),

  category: entityCategorySchema.optional().default('case'),

  templateId: z.string().optional(),
  templateVersion: z.string().optional(),

  fields: z.array(entityFieldDefinitionSchema).max(100).optional().default([]),

  statuses: z.array(enumOptionSchema).max(50).optional().default([]),
  defaultStatus: z.string().optional().default(''),
  closedStatuses: z.array(z.string()).optional().default([]),

  severities: z.array(enumOptionSchema).max(20).optional(),
  defaultSeverity: z.string().optional(),

  categories: z.array(enumOptionSchema).max(50).optional(),

  contactRoles: z.array(enumOptionSchema).max(20).optional(),

  numberPrefix: z.string().regex(/^[A-Z]{1,5}$/).optional(),
  numberingEnabled: z.boolean().optional().default(false),

  defaultAccessLevel: z.enum(['assigned', 'team', 'hub']).optional().default('assigned'),
  piiFields: z.array(z.string()).optional().default([]),

  allowSubRecords: z.boolean().optional().default(false),
  allowFileAttachments: z.boolean().optional().default(true),
  allowInteractionLinks: z.boolean().optional().default(true),
  showInNavigation: z.boolean().optional().default(true),
  showInDashboard: z.boolean().optional().default(false),

  displayTypes: z.array(z.enum(['table', 'calendar', 'timeline'])).optional(),
  defaultDisplayType: z.enum(['table', 'calendar', 'timeline']).optional(),

  accessRoles: z.array(z.string()).optional(),
  editRoles: z.array(z.string()).optional(),

  isArchived: z.boolean().optional().default(false),
  isSystem: z.boolean().optional().default(false),

  // Assignment intelligence (EP06-A3)
  autoAssign: z.boolean().optional().default(false),
  autoAssignThreshold: z.number().int().min(10).max(50).optional().default(30),
  requiredSpecializations: z.array(z.string().max(100)).max(20).optional().default([]),
  notifyContactsOnStatusChange: z.boolean().optional().default(false),

  createdAt: z.string().optional().default(''),
  updatedAt: z.string().optional().default(''),
})

export type EntityTypeDefinition = z.infer<typeof entityTypeDefinitionSchema>

// --- Relationship Type Definition ---

export const relationshipTypeDefinitionSchema = z.object({
  id: z.uuid(),
  hubId: z.string(),

  sourceEntityTypeId: z.string(),
  targetEntityTypeId: z.string(),

  cardinality: z.enum(['1:1', '1:N', 'M:N']),

  label: z.string().max(200),
  reverseLabel: z.string().max(200),
  sourceLabel: z.string().max(200),
  targetLabel: z.string().max(200),

  roles: z.array(enumOptionSchema).max(20).optional(),
  defaultRole: z.string().optional(),

  joinFields: z.array(entityFieldDefinitionSchema).max(20).optional(),

  cascadeDelete: z.boolean().optional().default(false),
  required: z.boolean().optional().default(false),

  templateId: z.string().optional(),
  isSystem: z.boolean().optional().default(false),

  createdAt: z.string(),
  updatedAt: z.string(),
})

export type RelationshipTypeDefinition = z.infer<typeof relationshipTypeDefinitionSchema>

// --- Input schemas for CRUD ---

export const createEntityTypeBodySchema = z.object({
  hubId: z.string().optional().default(''),
  name: z.string().regex(/^[a-zA-Z0-9_]+$/).max(100),
  label: z.string().min(1).max(200),
  labelPlural: z.string().min(1).max(200),
  description: z.string().max(1000).optional().default(''),
  icon: z.string().max(50).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),

  category: entityCategorySchema,

  fields: z.array(entityFieldDefinitionSchema.omit({ id: true }).extend({
    id: z.uuid().optional(),
  })).max(100).optional().default([]),

  statuses: z.array(enumOptionSchema).min(1).max(50),
  defaultStatus: z.string(),
  closedStatuses: z.array(z.string()).optional().default([]),

  severities: z.array(enumOptionSchema).max(20).optional(),
  defaultSeverity: z.string().optional(),

  categories: z.array(enumOptionSchema).max(50).optional(),
  contactRoles: z.array(enumOptionSchema).max(20).optional(),

  numberPrefix: z.string().regex(/^[A-Z]{1,5}$/).optional(),
  numberingEnabled: z.boolean().optional().default(false),

  defaultAccessLevel: z.enum(['assigned', 'team', 'hub']).optional().default('assigned'),
  piiFields: z.array(z.string()).optional().default([]),

  allowSubRecords: z.boolean().optional().default(false),
  allowFileAttachments: z.boolean().optional().default(true),
  allowInteractionLinks: z.boolean().optional().default(true),
  showInNavigation: z.boolean().optional().default(true),
  showInDashboard: z.boolean().optional().default(false),

  accessRoles: z.array(z.string()).optional(),
  editRoles: z.array(z.string()).optional(),

  templateId: z.string().optional(),
  templateVersion: z.string().optional(),

  autoAssign: z.boolean().optional().default(false),
  autoAssignThreshold: z.number().int().min(10).max(50).optional().default(30),
  requiredSpecializations: z.array(z.string().max(100)).max(20).optional().default([]),
  notifyContactsOnStatusChange: z.boolean().optional().default(false),
})

export type CreateEntityTypeBody = z.input<typeof createEntityTypeBodySchema>

export const updateEntityTypeBodySchema = z.object({
  label: z.string().min(1).max(200).optional(),
  labelPlural: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  icon: z.string().max(50).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),

  fields: z.array(entityFieldDefinitionSchema.omit({ id: true }).extend({
    id: z.uuid().optional(),
  })).max(100).optional(),

  statuses: z.array(enumOptionSchema).min(1).max(50).optional(),
  defaultStatus: z.string().optional(),
  closedStatuses: z.array(z.string()).optional(),

  severities: z.array(enumOptionSchema).max(20).optional(),
  defaultSeverity: z.string().optional(),

  categories: z.array(enumOptionSchema).max(50).optional(),
  contactRoles: z.array(enumOptionSchema).max(20).optional(),

  numberPrefix: z.string().regex(/^[A-Z]{1,5}$/).optional(),
  numberingEnabled: z.boolean().optional(),

  defaultAccessLevel: z.enum(['assigned', 'team', 'hub']).optional(),
  piiFields: z.array(z.string()).optional(),

  allowSubRecords: z.boolean().optional(),
  allowFileAttachments: z.boolean().optional(),
  allowInteractionLinks: z.boolean().optional(),
  showInNavigation: z.boolean().optional(),
  showInDashboard: z.boolean().optional(),

  accessRoles: z.array(z.string()).optional(),
  editRoles: z.array(z.string()).optional(),

  isArchived: z.boolean().optional(),

  autoAssign: z.boolean().optional(),
  autoAssignThreshold: z.number().int().min(10).max(50).optional(),
  requiredSpecializations: z.array(z.string().max(100)).max(20).optional(),
  notifyContactsOnStatusChange: z.boolean().optional(),
})

export const createRelationshipTypeBodySchema = z.object({
  hubId: z.string().optional().default(''),
  sourceEntityTypeId: z.string(),
  targetEntityTypeId: z.string(),
  cardinality: z.enum(['1:1', '1:N', 'M:N']),
  label: z.string().min(1).max(200),
  reverseLabel: z.string().min(1).max(200),
  sourceLabel: z.string().min(1).max(200),
  targetLabel: z.string().min(1).max(200),
  roles: z.array(enumOptionSchema).max(20).optional(),
  defaultRole: z.string().optional(),
  joinFields: z.array(entityFieldDefinitionSchema.omit({ id: true }).extend({
    id: z.uuid().optional(),
  })).max(20).optional(),
  cascadeDelete: z.boolean().optional().default(false),
  required: z.boolean().optional().default(false),
  templateId: z.string().optional(),
})

export const updateRelationshipTypeBodySchema = z.object({
  label: z.string().min(1).max(200).optional(),
  reverseLabel: z.string().min(1).max(200).optional(),
  sourceLabel: z.string().min(1).max(200).optional(),
  targetLabel: z.string().min(1).max(200).optional(),
  roles: z.array(enumOptionSchema).max(20).optional(),
  defaultRole: z.string().optional(),
  cascadeDelete: z.boolean().optional(),
  required: z.boolean().optional(),
})

export const caseNumberBodySchema = z.object({
  prefix: z.string().regex(/^[A-Z]{1,5}$/),
  year: z.number().int().min(2020).max(2099).optional(),
  hubId: z.string().optional(),
})

// --- Create roles from template suggestions (Epic 321) ---

// --- List/wrapper response schemas ---

export const entityTypeListResponseSchema = z.object({
  entityTypes: z.array(entityTypeDefinitionSchema),
})

export const relationshipTypeListResponseSchema = z.object({
  relationshipTypes: z.array(relationshipTypeDefinitionSchema),
})

export const caseNumberResponseSchema = z.object({
  number: z.string(),
  prefix: z.string(),
})

export const templateSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  icon: z.string().optional(),
  version: z.string(),
  entityTypeCount: z.number(),
  totalFieldCount: z.number(),
  suggestedRoleCount: z.number(),
  tags: z.array(z.string()),
  comingSoon: z.boolean().optional(),
})

export type TemplateSummary = z.infer<typeof templateSummarySchema>

export const templateListResponseSchema = z.object({
  templates: z.array(templateSummarySchema),
  appliedTemplateIds: z.array(z.string()),
})

export const templateApplyResponseSchema = z.object({
  applied: z.boolean(),
  entityTypeId: z.string().optional(),
  entityTypes: z.number(),
  relationshipTypes: z.number(),
  reportTypes: z.number(),
  suggestedRoles: z.array(z.string()).optional(),
})

export const templateUpdateItemSchema = z.object({
  entityTypeId: z.string(),
  field: z.string(),
  action: z.string(),
  description: z.string().optional(),
})

export const templateUpdatesResponseSchema = z.object({
  updates: z.array(templateUpdateItemSchema),
})

export const rolesFromTemplateResponseSchema = z.object({
  created: z.array(z.object({ id: z.string(), name: z.string() })),
  count: z.number(),
})

export const enabledResponseSchema = z.object({
  enabled: z.boolean(),
})

// --- Create roles from template suggestions (Epic 321) ---

export const createRolesFromTemplateBodySchema = z.object({
  roles: z.array(z.object({
    name: z.string().min(1).max(100),
    slug: z.string().regex(/^[a-z0-9_-]+$/, 'Slug must be lowercase alphanumeric with hyphens/underscores'),
    description: z.string().min(1).max(500),
    permissions: z.array(z.string()).min(1),
  })).min(1).max(50),
})

// --- Entity field file value (EP06-A2) ---

export const fileFieldValueSchema = z.object({
  fileId: z.uuid(),
  encryptedName: z.string(),
  encryptedMimeType: z.string(),
  encryptedSize: z.string(),
  recipientEnvelopes: z.array(z.object({
    recipientPubkey: z.string(),
    encryptedKey: z.string(),
  })),
  uploadedAt: z.iso.datetime(),
})
export type FileFieldValue = z.infer<typeof fileFieldValueSchema>

// --- Template customization (EP06-A2) ---

export const entityTemplateCustomizeBodySchema = z.object({
  label: z.string().min(1).max(200).optional(),
  labelPlural: z.string().min(1).max(200).optional(),
  icon: z.string().max(50).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  showInNavigation: z.boolean().optional(),
  showInDashboard: z.boolean().optional(),
  isArchived: z.boolean().optional(),
})
export type EntityTemplateCustomizeBody = z.infer<typeof entityTemplateCustomizeBodySchema>
