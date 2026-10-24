import { z } from 'zod'

// --- Response schemas ---

export const checkResultSchema = z.object({
  status: z.enum(['ok', 'failing']),
  latencyMs: z.number().optional(),
  detail: z.string().optional(),
})

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  checks: z.record(z.string(), checkResultSchema),
  version: z.string().optional(),
  uptime: z.number().optional(),
})

export const livenessResponseSchema = z.object({
  status: z.literal('ok'),
})

export const readinessResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  checks: z.record(z.string(), checkResultSchema),
  version: z.string().optional(),
})
