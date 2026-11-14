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
  /**
   * Inbound call. The call's hub is the one owning the dialled number; a hub's
   * own URL also names it in `?hub=`, so the webhook is checked against that
   * hub's provider account rather than the platform's (#1052).
   */
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
 * the messaging router reads the hub from it (`messaging/router.ts`).
 * `voiceIncoming` carries it too: the call's hub is still the one owning the
 * dialled number, but the signature must be checked with the provider account
 * that signed it, and a hub with its own account signs with that account — the
 * platform's credentials would refuse every call to it (#1052). `/incoming`
 * refuses a call whose `?hub=` does not own the dialled number. `voiceStatus`
 * does not: `/call-status` resolves its hub from the call record.
 */
export function buildProviderWebhookUrls(origin: string, hubId?: string): WebhookUrlsResponse {
  const hubQuery = hubId ? `?hub=${encodeURIComponent(hubId)}` : ''
  const messaging = Object.fromEntries(
    MESSAGING_WEBHOOK_CHANNELS.map(channel => [channel, `${origin}${messagingWebhookPath(channel)}${hubQuery}`]),
  ) as WebhookUrlsResponse['messaging']
  return {
    voiceIncoming: `${origin}${TELEPHONY_WEBHOOK_PATHS.voiceIncoming}${hubQuery}`,
    voiceStatus: `${origin}${TELEPHONY_WEBHOOK_PATHS.voiceStatus}`,
    messaging,
  }
}
