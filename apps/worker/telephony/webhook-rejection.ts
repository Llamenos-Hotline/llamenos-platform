/**
 * Instance-level accounting for refused provider webhooks (#2330).
 *
 * A refusal happens BEFORE authentication, so anyone who can reach the
 * endpoint can cause one. The counter therefore never stands alone as an
 * alarm: the Prometheus rules page on `attribution="own_account"` (a request
 * that only our provider, speaking for our account, could have produced) or on
 * a refusal together with inbound traffic going flat. Nothing here stores or
 * labels an address, a hub or a caller.
 */
import { getClientIp } from '../lib/client-ip'
import { recordWebhookRejected, type WebhookAttribution, type WebhookRejectReason } from '../routes/metrics'
import type { TelephonyAdapter } from './adapter'

/** One counted refusal per source prefix per minute (a /24 for IPv4, a /48 for IPv6). */
const SOURCE_WINDOW_MS = 60_000
/** Bound on the in-memory table; past it, expired entries go first, then everything. */
const MAX_TRACKED_SOURCES = 4096

const lastCountedAt = new Map<string, number>()

/**
 * The /24 (IPv4) or /48 (IPv6) a source address belongs to, as a bucket key.
 * Anything that is not an address (the rate limiter's synthetic fingerprint)
 * is its own bucket.
 */
export function sourcePrefix(ip: string): string {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip.split('.').slice(0, 3).join('.')
  if (ip.includes(':') && !ip.startsWith('fingerprint:')) {
    const [head, tail = ''] = ip.split('::')
    const headGroups = head ? head.split(':') : []
    const tailGroups = tail ? tail.split(':') : []
    const groups = ip.includes('::')
      ? [...headGroups, ...Array<string>(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill('0'), ...tailGroups]
      : headGroups
    return groups.slice(0, 3).map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':')
  }
  return ip
}

/** Whether this source prefix may add to the counter now; admitting it starts its minute. */
function admitSource(prefix: string, now: number): boolean {
  const last = lastCountedAt.get(prefix)
  if (last !== undefined && now - last < SOURCE_WINDOW_MS) return false
  if (lastCountedAt.size >= MAX_TRACKED_SOURCES) {
    for (const [key, at] of lastCountedAt) {
      if (now - at >= SOURCE_WINDOW_MS) lastCountedAt.delete(key)
    }
    if (lastCountedAt.size >= MAX_TRACKED_SOURCES) lastCountedAt.clear()
  }
  lastCountedAt.set(prefix, now)
  return true
}

/** Test seam: forget every source's window. */
export function resetWebhookRejectionDamping(): void {
  lastCountedAt.clear()
}

export interface WebhookRejection {
  reason: WebhookRejectReason
  /**
   * The adapter whose signature check refused the request. Absent when no
   * provider was configured.
   */
  adapter?: Pick<TelephonyAdapter, 'webhookNamesOwnAccount'>
  /**
   * Whether a provider-address allowlist is configured AND this request passed
   * it. Without that there is no evidence the request came from our provider,
   * so it cannot be attributed to it.
   */
  providerAddressVerified: boolean
}

/**
 * Count one refused telephony webhook.
 *
 * `own_account` needs ALL of: the provider's own address (allowlist passed),
 * our account identifier in the provider-populated part of the request, and a
 * failed signature. Our adversaries hold provider accounts and the provider's
 * egress is shared by every customer, so any one or two of those proves
 * nothing; every other combination is `unattributed`.
 */
export async function recordTelephonyWebhookRejection(req: Request, rejection: WebhookRejection): Promise<void> {
  if (!admitSource(sourcePrefix(getClientIp(req)), Date.now())) return

  let attribution: WebhookAttribution = 'unattributed'
  if (rejection.reason === 'signature_invalid' && rejection.providerAddressVerified && rejection.adapter?.webhookNamesOwnAccount) {
    // Classification is observability: it must never turn a 403 into a 500.
    attribution = (await rejection.adapter.webhookNamesOwnAccount(req).catch(() => false)) ? 'own_account' : 'unattributed'
  }
  recordWebhookRejected(rejection.reason, attribution)
}
