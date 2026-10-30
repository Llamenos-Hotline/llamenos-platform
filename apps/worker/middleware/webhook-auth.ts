import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../types'
import { createLogger } from '../lib/logger'
import { checkWebhookReplay } from '../services/webhook-replay'
import { isIpInCidrs } from './webhook-ip-allowlist'
import { getDb } from '../db'
import { getClientIp } from '../lib/client-ip'

const logger = createLogger('webhook-auth')

interface WebhookAuthOptions {
  provider: string
  allowedContentTypes?: string[]
  replayWindowSeconds?: number
  skipReplay?: boolean
  /**
   * Leave the IP allowlist to the route. The telephony webhooks do, because a
   * refused source's signature is still evaluated there to CLASSIFY the
   * refusal (#2330) — the request is refused either way.
   */
  skipIpAllowlist?: boolean
}

export function webhookAuth(options: WebhookAuthOptions) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const { provider, allowedContentTypes, replayWindowSeconds = 300, skipReplay = false, skipIpAllowlist = false } = options

    // 1. Content-Type enforcement
    if (allowedContentTypes) {
      const contentType = c.req.header('content-type')?.split(';')[0]?.trim()
      if (contentType && !allowedContentTypes.includes(contentType)) {
        return c.text('Unsupported Media Type', 415)
      }
    }

    // 2. IP allowlist (configured via env var)
    const cidrKey = `${provider.toUpperCase()}_WEBHOOK_IPS`
    const cidrs = (c.env as unknown as Record<string, string | undefined>)[cidrKey]
    if (cidrs && !skipIpAllowlist) {
      const cidrList = cidrs.split(',').map(s => s.trim()).filter(Boolean)
      const clientIp = getClientIp(c.req.raw)
      if (!clientIp || !isIpInCidrs(clientIp, cidrList)) {
        logger.warn('Webhook IP not in allowlist', { provider })
        await onIpRejected?.(c.req.raw)
        return c.text('Forbidden', 403)
      }
    }

    // 3. Replay protection
    if (!skipReplay) {
      // Clone the raw request before reading so downstream handlers can still consume c.req.raw
      const bodyText = await c.req.raw.clone().text()
      const isFirst = await checkWebhookReplay(getDb(), provider, bodyText, replayWindowSeconds)
      if (!isFirst) {
        return c.text('OK', 200)
      }
    }

    return next()
  })
}
