import { z } from 'zod'

export const webhookConfigStateSchema = z.object({
  voiceIncoming: z.string().optional(),
  voiceStatus: z.string().optional(),
  sms: z.string().optional(),
  configured: z.boolean(),
})
export type WebhookConfigState = z.infer<typeof webhookConfigStateSchema>

/**
 * `GET /api/provider-setup/webhook-urls` (and its hub-scoped mount): the URLs
 * a provider must be configured to call. Built by the server from the same
 * table its own `configureWebhooks` registers, on the origin it verifies
 * provider signatures against — so what an admin is shown to paste is exactly
 * what auto-configuration registers (#2068). A client never assembles these
 * itself: it cannot know the server's public webhook origin.
 */
export const webhookUrlsResponseSchema = z.object({
  voiceIncoming: z.string(),
  voiceStatus: z.string(),
  messaging: z.object({
    sms: z.string(),
    whatsapp: z.string(),
    signal: z.string(),
    rcs: z.string(),
    telegram: z.string(),
  }),
})
export type WebhookUrlsResponse = z.infer<typeof webhookUrlsResponseSchema>
