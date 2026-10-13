/**
 * Client IP extraction — deliberately dependency-free (no FFI, no crypto).
 *
 * Split out of lib/crypto.ts (issue #1127): that module pulls in
 * `@llamenos/crypto/ffi`, which imports `bun:ffi` at module load time.
 * `rate-limit.ts` only needs the IP, not the hashing helpers that live
 * alongside getClientIp in crypto.ts, and middleware is exactly the code
 * that should stay import-light. Keeping getClientIp here — with crypto.ts
 * re-exporting it for the existing `import { getClientIp } from '../lib/crypto'`
 * call sites — means a middleware test running under a Bun-less harness
 * (apps/worker/__tests__/integration/rate-limit-concurrency.test.ts, which
 * runs through vitest rather than `bun run`) does not transitively fail to
 * resolve `bun:ffi` just because it imports the rate-limit middleware.
 *
 * This is the SINGLE place that decides who the client is. Rate limiting,
 * audit-log IP hashing and the webhook IP allowlists all go through it, so
 * that there is exactly one answer to "what address is this request from?"
 * and exactly one set of rules about which headers may influence it.
 */

/**
 * Extract the client IP from request headers with multi-source fallback.
 *
 * B-M7: Never returns a constant like 'unknown' — self-hosted instances
 * still get per-client rate limit buckets via X-Forwarded-For, X-Real-IP,
 * or the Bun socket address.
 *
 * Forwarded-for headers are fully client-controlled unless a trusted proxy
 * sets/overwrites them, so they're only honored when TRUST_PROXY_HEADERS=true
 * (operator confirms a reverse proxy sits in front and strips/sets these
 * headers itself — deploy/ansible/roles/llamenos-caddy/templates/caddy.j2
 * does exactly that). Otherwise a spoofed header would let an attacker pick
 * their own rate-limit bucket. When trusted, we take the right-most
 * X-Forwarded-For entry — the value appended by the nearest (trusted) hop —
 * not the left-most, which the client fully controls.
 *
 * `CF-Connecting-IP` is deliberately NOT consulted, even when proxy headers
 * are trusted (issue #1606). It used to be preferred over X-Forwarded-For as
 * "most reliable when behind Cloudflare" — but nothing in this architecture
 * is ever behind Cloudflare, or any other CDN. TLS terminates on the origin
 * host with a Let's Encrypt certificate, because the Android client pins
 * ISRG Root X1/X2 and hard-fails on any other chain (see CLAUDE.md and the
 * four places under deploy/ that say so). So the header is never set by a
 * trusted hop here; it only ever arrives because a client chose to send it,
 * and honoring it would let any caller select its own rate-limit bucket and
 * its own webhook-allowlist verdict. It is not gated behind a second
 * opt-in variable either: that would be configuration for a topology this
 * project forbids, and a second way to get this wrong.
 */
/**
 * Prefix of the synthetic value getClientIp() returns when no network address
 * is available at all. Callers that want "the client's address, if we know
 * one" (the audit log) test for it; callers that only need a stable bucket key
 * (rate limiting) do not care.
 */
export const CLIENT_FINGERPRINT_PREFIX = 'fingerprint:'

export function getClientIp(req: Request): string {
  if (process.env.TRUST_PROXY_HEADERS === 'true') {
    // Reverse proxy (nginx, Caddy, etc.) — right-most entry is the one added
    // by the trusted hop closest to us.
    const xff = req.headers.get('X-Forwarded-For')
    if (xff) {
      const parts = xff.split(',').map(p => p.trim()).filter(Boolean)
      const last = parts[parts.length - 1]
      if (last) return last
    }

    const realIp = req.headers.get('X-Real-IP')
    if (realIp) return realIp
  }

  // Bun exposes the socket address on the request (non-standard)
  const bunAddr = (req as unknown as Record<string, unknown>).requestIP
  if (typeof bunAddr === 'function') {
    const addr = bunAddr()
    if (addr && typeof addr === 'object' && 'address' in addr) {
      return String((addr as { address: string }).address)
    }
  }

  // Last resort: use a hash of invariant request characteristics so each
  // unique client at least gets its own bucket (TLS fingerprint, UA, etc.)
  const ua = req.headers.get('User-Agent') || ''
  const accept = req.headers.get('Accept-Language') || ''
  return `${CLIENT_FINGERPRINT_PREFIX}${ua}:${accept}`
}
