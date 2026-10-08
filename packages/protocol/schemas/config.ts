import { z } from 'zod'

// --- Response schemas ---

/**
 * The UNAUTHENTICATED pre-login payload. Every field here is readable by anyone
 * who can reach the host, so the shape is the security boundary — see the
 * contract comment on the route itself (`apps/worker/routes/config.ts`).
 *
 * The hub roster and `defaultHubId` were removed (#1710): hub names, slugs,
 * descriptions and `createdBy` are organisational structure, and the only
 * client that read them pre-login was choosing an active hub from an
 * instance-wide list instead of the user's own memberships (#1708). Hubs are
 * served by the authenticated `GET /api/hubs`, filtered to the caller's
 * memberships.
 */
export const configResponseSchema = z.object({
  hotlineName: z.string(),
  hotlineNumber: z.string(),
  channels: z.record(z.string(), z.boolean()),
  setupCompleted: z.boolean(),
  demoMode: z.boolean(),
  demoResetSchedule: z.string().nullable(),
  needsBootstrap: z.boolean(),
  serverPubkey: z.string().optional(),
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
