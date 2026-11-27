import { z } from 'zod'
import { telephonyProviderTypeSchema } from '@protocol/schemas/settings'

export const ownedNumberSchema = z.object({
  id: z.string(),
  phoneNumber: z.string(),
  providerType: telephonyProviderTypeSchema,
  hubId: z.string().optional(),
  friendlyName: z.string().optional(),
  capabilities: z.array(z.string()),
  voiceUrl: z.string().optional(),
  statusUrl: z.string().optional(),
  smsUrl: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type OwnedNumber = z.infer<typeof ownedNumberSchema>

export const availableNumberSchema = z.object({
  phoneNumber: z.string(),
  providerType: telephonyProviderTypeSchema,
  friendlyName: z.string().optional(),
  capabilities: z.array(z.string()),
  locality: z.string().optional(),
  region: z.string().optional(),
  monthlyPrice: z.string().optional(),
})
export type AvailableNumber = z.infer<typeof availableNumberSchema>

export const numberSearchQuerySchema = z.object({
  providerType: telephonyProviderTypeSchema,
  countryCode: z.string().optional().default('US'),
  areaCode: z.string().optional(),
  contains: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(50).optional().default(20),
})
export type NumberSearchQuery = z.infer<typeof numberSearchQuerySchema>

export const numberProvisionRequestSchema = z.object({
  phoneNumber: z.string(),
  providerType: telephonyProviderTypeSchema,
  friendlyName: z.string().optional(),
  hubId: z.string().optional(),
  autoConfigureWebhooks: z.boolean().optional().default(true),
})
export type NumberProvisionRequest = z.infer<typeof numberProvisionRequestSchema>

/**
 * A number a hub answers on (`hub_numbers`, #1331). `declared` numbers were
 * stated by an operator — on a self-hosted PBX the carrier delivers DIDs and no
 * API lists them; `provisioned` ones were bought through a provider's number API.
 */
export const hubNumberSchema = z.object({
  id: z.string(),
  /** E.164. */
  number: z.string(),
  source: z.enum(['declared', 'provisioned']),
  providerConfigId: z.string().nullable(),
})
export type HubNumberResponse = z.infer<typeof hubNumberSchema>

export const hubNumberListSchema = z.object({ numbers: z.array(hubNumberSchema) })

/**
 * Replace the numbers an operator declares for a hub. Each is E.164, or a
 * national-format number when the server has a default country
 * (`DEFAULT_PHONE_COUNTRY`). Numbers bought through a provider are not affected.
 */
export const declareHubNumbersRequestSchema = z.object({
  hubId: z.string().optional(),
  numbers: z.array(z.string().min(1).max(32)).max(50),
})
export type DeclareHubNumbersRequest = z.infer<typeof declareHubNumbersRequestSchema>
