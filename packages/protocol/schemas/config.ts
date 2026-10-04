import { z } from 'zod'

// --- Response schemas ---

export const configResponseSchema = z.object({
  hotlineName: z.string(),
  hotlineNumber: z.string(),
  channels: z.record(z.string(), z.boolean()),
  setupCompleted: z.boolean(),
  demoMode: z.boolean(),
  demoResetSchedule: z.string().nullable(),
  needsBootstrap: z.boolean(),
  hubs: z.array(z.object({ id: z.string(), name: z.string(), slug: z.string(), status: z.string() })),
  defaultHubId: z.string().optional(),
  serverPubkey: z.string().optional(),
  wsRelayUrl: z.string().optional(),
  apiVersion: z.number(),
  minApiVersion: z.number(),
  sentryDsn: z.string().optional(),
})

export const configVerifyResponseSchema = z.object({
  version: z.string(),
  commit: z.string(),
  buildTime: z.string(),
  verificationUrl: z.string(),
  trustAnchor: z.string(),
})

// --- Certificate pinning schemas ---

export const pinEntrySchema = z.object({
  algorithm: z.string(),
  hash: z.string(),
  label: z.string(),
})

export const configPinsResponseSchema = z.object({
  pins: z.array(pinEntrySchema),
  notBefore: z.string(),
  notAfter: z.string(),
  signature: z.string(),
})
