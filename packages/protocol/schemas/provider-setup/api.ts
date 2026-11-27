import { z } from 'zod'
import { telephonyProviderTypeSchema } from '@protocol/schemas/settings'
import { providerStatusSchema } from './provider-types'

export const startOAuthRequestSchema = z.object({
  provider: telephonyProviderTypeSchema,
  redirectUrl: z.string(),
  hubId: z.string().optional(),
})
export type StartOAuthRequest = z.infer<typeof startOAuthRequestSchema>

export const startOAuthResponseSchema = z.object({
  authUrl: z.string(),
  stateId: z.string(),
  expiresAt: z.string(),
})
export type StartOAuthResponse = z.infer<typeof startOAuthResponseSchema>

export const configureProviderRequestSchema = z.object({
  provider: telephonyProviderTypeSchema,
  credentials: z.record(z.string(), z.string()).optional(),
  hubId: z.string().optional(),
  /** The hub's hotline number — replaces its primary number. */
  phoneNumber: z.string().optional(),
  /**
   * Every number the operator declares for the hub (a self-hosted PBX's DIDs).
   * Replaces the hub's declared set; takes precedence over `phoneNumber`.
   */
  phoneNumbers: z.array(z.string().min(1).max(32)).max(50).optional(),
})
export type ConfigureProviderRequest = z.infer<typeof configureProviderRequestSchema>

export const listNumbersRequestSchema = z.object({
  provider: telephonyProviderTypeSchema,
  hubId: z.string().optional(),
})
export type ListNumbersRequest = z.infer<typeof listNumbersRequestSchema>

export const providerStatusResponseSchema = z.object({
  provider: telephonyProviderTypeSchema,
  status: providerStatusSchema,
  capabilities: z.array(z.string()),
  phoneNumbers: z.array(z.string()).optional(),
  error: z.string().optional(),
  lastCheckedAt: z.string().optional(),
})
export type ProviderStatusResponse = z.infer<typeof providerStatusResponseSchema>
