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
 */

/**
 * Extract the client IP from request headers with multi-source fallback.
 *
 * B-M7: Never returns a constant like 'unknown' — self-hosted instances
 * without CF-Connecting-IP still get per-client rate limit buckets via
 * X-Forwarded-For, X-Real-IP, or the Bun socket address.
 *
 * Forwarded-for headers are fully client-controlled unless a trusted proxy
 * sets/overwrites them, so they're only honored when TRUST_PROXY_HEADERS=true
 * (operator confirms a reverse proxy sits in front and strips/sets these
 * headers itself). Otherwise a spoofed header would let an attacker pick
 * their own rate-limit bucket. When trusted, we take the right-most
 * X-Forwarded-For entry — the value appended by the nearest (trusted) hop —
 * not the left-most, which the client fully controls.
 */
export function getClientIp(req: Request): string {
  if (process.env.TRUST_PROXY_HEADERS === 'true') {
    // Cloudflare — most reliable when behind CF
    const cfIp = req.headers.get('CF-Connecting-IP')
    if (cfIp) return cfIp

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
  return `fingerprint:${ua}:${accept}`
}
