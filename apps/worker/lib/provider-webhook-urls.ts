import type { MessagingChannelType } from '@protocol/schemas/settings'
import type { WebhookUrlsResponse } from '@protocol/schemas/provider-setup'

/**
 * The provider-facing webhook URLs, from one table (#2068).
 *
 * These URLs are registered with a telephony or messaging provider, either by
 * the server itself (`ProviderSetup.configureWebhooks`) or by an admin pasting
 * what an admin screen shows. A wrong one does not fail loudly: the provider
 * POSTs every call and every inbound message to a 404, and nothing reaches a
 * volunteer. Before this table the paths were hand-written in four places and
 * three of them were wrong — `/telephony/incoming` without `/api`, a
 * `/telephony/status` route that was never mounted, and
 * `/api/messaging/incoming`, ditto.
 *
 * `__tests__/unit/provider-webhook-urls.test.ts` holds every URL built here
 * against the real Hono route table, so a renamed route fails a test instead
 * of silently orphaning every number configured with the old URL.
 */
export const TELEPHONY_WEBHOOK_PATHS = {
  /** Inbound call. The hub is resolved from the dialled number, so no `?hub=`. */
  voiceIncoming: '/api/telephony/incoming',
  /** Call status callback (completed, busy, no-answer, failed). */
  voiceStatus: '/api/telephony/call-status',
} as const

/** Every messaging channel that has an inbound webhook. */
export const MESSAGING_WEBHOOK_CHANNELS = ['sms', 'whatsapp', 'signal', 'rcs', 'telegram'] as const satisfies readonly MessagingChannelType[]

/** Inbound messages AND delivery-status updates for a channel arrive here. */
export function messagingWebhookPath(channel: MessagingChannelType): string {
  return `/api/messaging/${channel}/webhook`
}

/**
 * The public origin providers deliver webhooks to.
 *
 * `WEBHOOK_BASE_URL` first: it is also the origin `buildWebhookUrl` substitutes
 * when it checks a provider's HMAC signature, so a URL registered on any other
 * origin would be delivered and then fail its signature check. `DOMAIN` is the
 * fallback for deployments that have not set it (it is required in production
 * — see `lib/config.ts`).
 */
export function webhookOrigin(env: { WEBHOOK_BASE_URL?: string; DOMAIN?: string }): string {
  const configured = env.WEBHOOK_BASE_URL?.trim()
  if (configured) return new URL(configured).origin
  return `https://${env.DOMAIN?.trim() || 'localhost'}`
}

/**
 * The full set of webhook URLs for a hub. Messaging URLs carry `?hub=` because
 * the messaging router reads the hub from it (`messaging/router.ts`); voice
 * URLs do not, because `/incoming` resolves the hub from the dialled number
 * and `/call-status` from the call record.
 */
export function buildProviderWebhookUrls(origin: string, hubId?: string): WebhookUrlsResponse {
  const hubQuery = hubId ? `?hub=${encodeURIComponent(hubId)}` : ''
  const messaging = Object.fromEntries(
    MESSAGING_WEBHOOK_CHANNELS.map(channel => [channel, `${origin}${messagingWebhookPath(channel)}${hubQuery}`]),
  ) as WebhookUrlsResponse['messaging']
  return {
    voiceIncoming: `${origin}${TELEPHONY_WEBHOOK_PATHS.voiceIncoming}`,
    voiceStatus: `${origin}${TELEPHONY_WEBHOOK_PATHS.voiceStatus}`,
    messaging,
  }
}
