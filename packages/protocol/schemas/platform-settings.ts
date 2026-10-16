import { z } from 'zod'
import { forPatch } from './patch'

export const featureFlagsSchema = z.object({
  mlsEnabled: z.boolean().optional().default(false),
  transcriptionEnabled: z.boolean().optional().default(true),
  caseManagementEnabled: z.boolean().optional().default(false),
  crossHubSharingEnabled: z.boolean().optional().default(false),
})

export const brandingSchema = z.object({
  instanceName: z.string().max(200).optional().default('Llamenos'),
  supportEmail: z.string().email().max(254).optional().default(''),
  privacyPolicyUrl: z.string().url().max(2000).optional().default(''),
})

export const sessionPolicySchema = z.object({
  maxSessionDurationHours: z.number().int().min(1).max(8760).optional().default(720),
  maxInactiveHours: z.number().int().min(1).max(8760).optional().default(168),
})

export const erasurePlatformFloorSchema = z.object({
  minDelayHours: z.number().int().min(4).max(168).optional().default(24),
})

export const retentionPurgeScheduleSchema = z.object({
  cronHourUtc: z.number().int().min(0).max(23).optional().default(3),
  enabled: z.boolean().optional().default(true),
})

export const platformSettingsSchema = z.object({
  featureFlags: featureFlagsSchema.optional().default({ mlsEnabled: false, transcriptionEnabled: true, caseManagementEnabled: false, crossHubSharingEnabled: false }),
  branding: brandingSchema.optional().default({ instanceName: 'Llamenos', supportEmail: '', privacyPolicyUrl: '' }),
  sessionPolicy: sessionPolicySchema.optional().default({ maxSessionDurationHours: 720, maxInactiveHours: 168 }),
  erasurePlatformFloor: erasurePlatformFloorSchema.optional().default({ minDelayHours: 24 }),
  retentionPurge: retentionPurgeScheduleSchema.optional().default({ cronHourUtc: 3, enabled: true }),
})

export type PlatformSettings = z.infer<typeof platformSettingsSchema>

export const updatePlatformSettingsBodySchema = z.object({
  featureFlags: forPatch(featureFlagsSchema).optional(),
  branding: forPatch(brandingSchema).optional(),
  sessionPolicy: forPatch(sessionPolicySchema).optional(),
  erasurePlatformFloor: forPatch(erasurePlatformFloorSchema).optional(),
  retentionPurge: forPatch(retentionPurgeScheduleSchema).optional(),
})

export const platformSettingsResponseSchema = z.object({
  settings: platformSettingsSchema,
})
