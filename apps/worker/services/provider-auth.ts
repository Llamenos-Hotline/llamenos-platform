/**
 * Provider-webhook rejections, classified (#2330; spec §5.7 and its four
 * amendments). Used by `validateWebhook` in routes/telephony.ts.
 *
 * A rotated signing secret or a moved provider egress range makes every call
 * 403 — a total, silent outage. But a rejection happens BEFORE
 * authentication, so anyone can produce one, and a raw rejection count is both
 * an alert-fatigue weapon and a way to bury a real outage in noise. So a
 * rejection only interrupts somebody on evidence an outsider cannot forge:
 *
 *  - provider egress IP (allowlisted) AND our account id (populated by the
 *    provider) AND a bad signature → our provider, about our account,
 *    mis-authenticating. Neither the id (public by design) nor the IP (shared
 *    by every customer of the provider) carries trust alone: an adversary
 *    with their own account pointing a webhook at us passes the allowlist and
 *    carries THEIR account id.
 *  - a correctly SIGNED request from outside the allowlist → the allowlist is
 *    stale. Only our signing secret makes that signature. The request is still
 *    refused; the signature only names the cause, it never widens acceptance.
 *  - unattributed rejections while the hub's accepted webhooks have stopped
 *    after flowing in the previous window → something broke, cause unknown.
 *
 * Everything else is `record`: visible in the incident panel, wakes nobody.
 *
 * The pre-auth work is bounded (amendment 4): a body cap before any hashing,
 * read with a streaming limit; and per-source damping — one rejection per
 * minute per /24 (IPv4) or /48 (IPv6) source — which, for a source the IP
 * allowlist already refuses, gates the hashing itself.
 *
 * Nothing here stores a source address. The damping table holds a salted
 * digest of the source PREFIX, in memory, for one minute; it is never
 * persisted and never becomes a label, a log field or an incident value.
 *
 * Known limit (spec §5.7 amendment 2): the damping and traffic state are
 * per-process. That is correct at today's `replicas: 1`; scaling out
 * under-counts both, and they must move to a shared store in the same change
 * that raises replicas — the same constraint the caller rate limiter has.
 */
import { createHash, randomBytes } from 'node:crypto'

/**
 * The largest webhook body read before any signature work. Legitimate
 * provider webhooks are small: form-encoded voice callbacks (Twilio,
 * SignalWire, Plivo) are 1–3 KB with every optional parameter present; JSON
 * call events (Telnyx, Bandwidth, the SIP bridge) are 1–4 KB; Vonage signs its
 * query string and sends a small JSON body. The longest legitimate field is a
 * provider transcription callback's text, a few KB for a full voicemail.
 * 64 KiB is over ten times the largest of those — headroom, not a fit — and
 * keeps an HMAC over a refused body in the microseconds. Above it a request is
 * refused unread.
 */
export const WEBHOOK_BODY_LIMIT_BYTES = 64 * 1024

/** One counted rejection per source prefix and class per this window. */
export const REJECTION_DAMPING_MS = 60_000

/**
 * The traffic discriminator's window: a hub whose last accepted webhook is
 * older than one window but not older than two had traffic in the previous
 * comparable window and none in this one.
 */
export const PROVIDER_AUTH_TRAFFIC_WINDOW_MS = 15 * 60_000

/** At most one incident signal per (hub, kind) per this interval — bounds DB writes under a distributed flood. */
export const SIGNAL_MIN_INTERVAL_MS = 1_000

/** Damping entries held before the oldest is evicted. */
const DAMPING_TABLE_LIMIT = 4096

/** The damping classes. `ip` is decided before any hashing, so it covers every kind the IP gate refuses. */
export type DampingClass = 'ip' | 'signature_invalid' | 'own_account_signature_invalid'

/**
 * The /24 (IPv4) or /48 (IPv6) a source address belongs to. A value that is
 * neither (getClientIp's synthetic fingerprint, when no address is known) is
 * its own prefix.
 */
export function sourcePrefix(ip: string): string {
  const v4 = ip.startsWith('::ffff:') && ip.includes('.') ? ip.slice(7) : ip
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) return `${v4.split('.').slice(0, 3).join('.')}.0/24`
  if (ip.includes(':')) {
    const [head = '', tail = ''] = ip.toLowerCase().split('::')
    const headGroups = head ? head.split(':') : []
    const tailGroups = tail ? tail.split(':') : []
    const missing = Math.max(0, 8 - headGroups.length - tailGroups.length)
    const groups = ip.includes('::') ? [...headGroups, ...Array(missing).fill('0'), ...tailGroups] : headGroups
    return `${groups.slice(0, 3).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/48`
  }
  return ip
}

export interface ProviderAuthMonitorOpts {
  /** Injected clock, for tests. */
  now?: () => number
}

/**
 * In-memory rejection damping and per-hub accepted-traffic tracking. One
 * instance per process (`providerAuthMonitor`).
 */
export class ProviderAuthMonitor {
  private readonly salt = randomBytes(16)
  private readonly damping = new Map<string, number>()
  private readonly signals = new Map<string, number>()
  private readonly lastAccepted = new Map<string, number>()
  private readonly now: () => number

  constructor(opts: ProviderAuthMonitorOpts = {}) {
    this.now = opts.now ?? (() => Date.now())
  }

  /**
   * True for the first rejection of `cls` from `sourceIp`'s prefix in a
   * {@link REJECTION_DAMPING_MS} window; false for every later one, which the
   * caller must neither count nor — when the IP gate already refused it — hash.
   *
   * A full table evicts its oldest entry rather than refusing: refusing would
   * let a flood across many prefixes silence a real diagnosis, and the body
   * cap already bounds what an admitted rejection costs.
   */
  admit(sourceIp: string, cls: DampingClass): boolean {
    const now = this.now()
    const key = createHash('sha256').update(this.salt).update(`${cls}|${sourcePrefix(sourceIp)}`).digest('base64')
    const last = this.damping.get(key)
    if (last !== undefined && now - last < REJECTION_DAMPING_MS) return false
    this.damping.delete(key)
    if (this.damping.size >= DAMPING_TABLE_LIMIT) this.sweep(now)
    if (this.damping.size >= DAMPING_TABLE_LIMIT) {
      const oldest = this.damping.keys().next().value
      if (oldest !== undefined) this.damping.delete(oldest)
    }
    this.damping.set(key, now)
    return true
  }

  /** True when no signal of `kind` was recorded for `hubId` in the last {@link SIGNAL_MIN_INTERVAL_MS}. */
  admitSignal(hubId: string, kind: string): boolean {
    const now = this.now()
    const key = `${hubId}|${kind}`
    const last = this.signals.get(key)
    if (last !== undefined && now - last < SIGNAL_MIN_INTERVAL_MS) return false
    this.signals.set(key, now)
    return true
  }

  /** A webhook for `hubId` passed authentication. */
  recordAccepted(hubId: string): void {
    this.lastAccepted.set(hubId, this.now())
  }

  /**
   * The traffic discriminator (amendment 2): accepted webhooks for `hubId` =
   * 0 in the current window AND some in the previous comparable window. A
   * hub never seen accepting since this process started has no previous
   * window to compare, so it reads false — a fresh process cannot tell a
   * flatline from a quiet line.
   */
  trafficStopped(hubId: string): boolean {
    const last = this.lastAccepted.get(hubId)
    if (last === undefined) return false
    const age = this.now() - last
    return age >= PROVIDER_AUTH_TRAFFIC_WINDOW_MS && age < 2 * PROVIDER_AUTH_TRAFFIC_WINDOW_MS
  }

  /** Forget everything (tests). */
  reset(): void {
    this.damping.clear()
    this.signals.clear()
    this.lastAccepted.clear()
  }

  private sweep(now: number): void {
    for (const [key, at] of this.damping) {
      if (now - at >= REJECTION_DAMPING_MS) this.damping.delete(key)
    }
  }
}

export const providerAuthMonitor = new ProviderAuthMonitor()

/**
 * Is `request`'s body within `limit` bytes? Decided without buffering more
 * than `limit` (plus one transport chunk): a declared Content-Length over the
 * limit is refused before a byte is read; otherwise a CLONE of the body is
 * read with a running count and cancelled the moment it passes the limit. The
 * original stream is left for the adapter and handler, which only ever read it
 * once this has returned `true` — so they too read at most `limit` bytes.
 */
export async function bodyWithinLimit(request: Request, limit = WEBHOOK_BODY_LIMIT_BYTES): Promise<boolean> {
  const declared = request.headers.get('content-length')
  if (declared !== null) {
    const length = Number(declared)
    if (!Number.isFinite(length) || length < 0 || length > limit) return false
  }
  if (!request.body) return true
  const reader = request.clone().body?.getReader()
  if (!reader) return true
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return true
      total += value.byteLength
      if (total > limit) {
        await reader.cancel().catch(() => {})
        return false
      }
    }
  } finally {
    reader.releaseLock()
  }
}
