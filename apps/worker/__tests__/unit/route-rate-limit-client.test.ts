/**
 * `lib/route-rate-limit.ts#routeRateLimitClient` — the per-client identity the
 * brute-force limiters inside route handlers bucket on.
 *
 * Why this file exists rather than a line in each route's own test: the
 * mechanism it pins is a deliberate relaxation on a host reachable from the
 * internet (the harness may choose its bucket), and the property that makes it
 * safe is a NEGATIVE one — that nobody else can. A negative property asserted
 * in one place next to the positive one is checkable; the same property implied
 * across five route tests is not.
 *
 * Four directions, matching the four ways this could be got wrong:
 *   1. the harness must get its own bucket, or the deployed-target suite shares
 *      one 5/min bucket per endpoint across every scenario in every worker —
 *      which is 18 of the 27 failures in #1625;
 *   2. the limiter must still FIRE inside that bucket. This is NOT an
 *      exemption, and six scenarios assert a 429 that an exemption would
 *      delete;
 *   3. a caller WITHOUT the secret must be bucketed on its real address even
 *      when it sends the header — otherwise the mechanism is a way for any
 *      caller to dodge the login limiter, which is the whole control;
 *   4. `production` must refuse it, even with a secret in the environment.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'
import { routeRateLimitClient } from '@worker/lib/route-rate-limit'
import {
  DEV_SURFACE_CLIENT_ADDRESS_HEADER,
  devSurfaceSimulatedClientAddress,
} from '@worker/lib/dev-surfaces'
import { checkRateLimit } from '@worker/lib/helpers'

/** 64 hex characters — what `openssl rand -hex 32` produces, as the docs say. */
const SECRET = 'a'.repeat(64)
const HMAC = 'b'.repeat(64)

const STAGING = {
  ENVIRONMENT: 'staging',
  DEV_ROUTES_ENABLED: 'true',
  DEV_RESET_SECRET: SECRET,
  HMAC_SECRET: HMAC,
} as const

/**
 * A route shaped like the real ones: a named per-client limiter at 2/min,
 * enforced for everybody, keyed through `routeRateLimitClient`.
 */
function makeApp(settings: { checkRateLimit: ReturnType<typeof vi.fn> }, env: Record<string, string>) {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('services', { settings } as unknown as AppEnv['Variables']['services'])
    c.env = env as unknown as AppEnv['Bindings']
    await next()
  })
  app.get('/probe', async (c) => {
    const key = `probe:${routeRateLimitClient(c)}`
    if (await checkRateLimit(c.get('services').settings, key, 2)) {
      return c.json({ error: 'Too many requests' }, 429)
    }
    return c.json({ ok: true, key })
  })
  return app
}

/** Counts per key and limits above `max`, like the real PostgreSQL limiter. */
function countingLimiter(max: number) {
  const counts = new Map<string, number>()
  return {
    counts,
    checkRateLimit: vi.fn(async ({ key }: { key: string }) => {
      const next = (counts.get(key) ?? 0) + 1
      counts.set(key, next)
      return { limited: next > max }
    }),
  }
}

async function probe(
  app: Hono<AppEnv>,
  env: Record<string, string>,
  headers: Record<string, string>,
): Promise<{ status: number; key?: string }> {
  const res = await app.request('/probe', { headers }, env as never)
  const body = (await res.json().catch(() => ({}))) as { key?: string }
  return { status: res.status, key: body.key }
}

describe('routeRateLimitClient — the harness names its own bucket', () => {
  let limiter: ReturnType<typeof countingLimiter>

  beforeEach(() => {
    limiter = countingLimiter(2)
  })

  // --- 1. The harness gets its own bucket ---

  it('gives two harness-named clients two different buckets', async () => {
    const app = makeApp(limiter, { ...STAGING })
    const a = await probe(app, { ...STAGING }, {
      'X-Test-Secret': SECRET,
      [DEV_SURFACE_CLIENT_ADDRESS_HEADER]: '10.99.1.1',
    })
    const b = await probe(app, { ...STAGING }, {
      'X-Test-Secret': SECRET,
      [DEV_SURFACE_CLIENT_ADDRESS_HEADER]: '10.99.1.2',
    })

    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(a.key).not.toBe(b.key)
  })

  it('never puts a simulated address in the key in the clear', async () => {
    const app = makeApp(limiter, { ...STAGING })
    const { key } = await probe(app, { ...STAGING }, {
      'X-Test-Secret': SECRET,
      [DEV_SURFACE_CLIENT_ADDRESS_HEADER]: '203.0.113.9',
    })

    expect(key).toMatch(/^probe:[0-9a-f]+$/)
    expect(key).not.toContain('203.0.113.9')
  })

  // --- 2. It is isolation, NOT an exemption: the limiter still fires ---

  it('still rate limits the harness inside the bucket it named', async () => {
    const app = makeApp(limiter, { ...STAGING })
    const headers = {
      'X-Test-Secret': SECRET,
      [DEV_SURFACE_CLIENT_ADDRESS_HEADER]: '10.99.1.1',
    }

    const statuses: number[] = []
    for (let i = 0; i < 3; i++) statuses.push((await probe(app, { ...STAGING }, headers)).status)

    expect(statuses).toEqual([200, 200, 429])
    expect(limiter.checkRateLimit).toHaveBeenCalledTimes(3)
  })

  // --- 3. Without the secret, the header buys nothing ---

  for (const [name, headers] of [
    ['no secret at all', {}],
    ['a wrong secret of the right shape', { 'X-Test-Secret': 'c'.repeat(64) }],
    ['an empty secret header', { 'X-Test-Secret': '' }],
  ] as const) {
    const app = () => makeApp(countingLimiter(2), { ...STAGING })

    it(`ignores the client-address header with ${name}, and still rate limits`, async () => {
      const limited = makeApp(limiter, { ...STAGING })

      const statuses: number[] = []
      const keys: Array<string | undefined> = []
      // Three DIFFERENT addresses: an attacker's best attempt at three buckets.
      for (const address of ['10.99.1.1', '10.99.1.2', '10.99.1.3']) {
        const res = await probe(limited, { ...STAGING }, {
          ...headers,
          [DEV_SURFACE_CLIENT_ADDRESS_HEADER]: address,
        })
        statuses.push(res.status)
        keys.push(res.key)
      }

      // All three collapse into one bucket, so the third is refused.
      expect(statuses).toEqual([200, 200, 429])
      expect(new Set(keys.filter(Boolean)).size).toBe(1)
    })

    it(`derives the same key with and without the header, given ${name}`, async () => {
      // Stronger than "the three collapsed": pins that the header makes NO
      // difference to the key, so the collapse above is the header being
      // ignored and not an accident of this harness's address.
      const withHeader = await probe(app(), { ...STAGING }, {
        ...headers,
        [DEV_SURFACE_CLIENT_ADDRESS_HEADER]: '10.99.1.1',
      })
      const withoutHeader = await probe(app(), { ...STAGING }, { ...headers })

      expect(withHeader.key).toBeDefined()
      expect(withHeader.key).toBe(withoutHeader.key)
    })
  }

  // --- 4. production refuses it ---

  it('ignores the header on production even with the secret present', async () => {
    const prod = { ...STAGING, ENVIRONMENT: 'production' }
    const app = makeApp(limiter, prod)

    const statuses: number[] = []
    for (const address of ['10.99.1.1', '10.99.1.2', '10.99.1.3']) {
      statuses.push((await probe(app, prod, {
        'X-Test-Secret': SECRET,
        [DEV_SURFACE_CLIENT_ADDRESS_HEADER]: address,
      })).status)
    }

    expect(statuses).toEqual([200, 200, 429])
  })
})

describe('devSurfaceSimulatedClientAddress', () => {
  it('returns the address for an authorized request that names one', () => {
    expect(devSurfaceSimulatedClientAddress(STAGING, SECRET, '10.99.1.1')).toBe('10.99.1.1')
    expect(devSurfaceSimulatedClientAddress(STAGING, SECRET, ' 10.99.1.1 ')).toBe('10.99.1.1')
    expect(devSurfaceSimulatedClientAddress(STAGING, SECRET, '2001:db8::1')).toBe('2001:db8::1')
  })

  it('returns null when no address is named', () => {
    expect(devSurfaceSimulatedClientAddress(STAGING, SECRET, undefined)).toBeNull()
    expect(devSurfaceSimulatedClientAddress(STAGING, SECRET, '')).toBeNull()
  })

  it('returns null for an address that is not of the allowed shape', () => {
    // A key component is not a place to accept arbitrary caller input, even
    // from the secret holder: `/`, spaces and a 65th character are all refused.
    expect(devSurfaceSimulatedClientAddress(STAGING, SECRET, '10.0.0.0/8')).toBeNull()
    expect(devSurfaceSimulatedClientAddress(STAGING, SECRET, 'a b')).toBeNull()
    expect(devSurfaceSimulatedClientAddress(STAGING, SECRET, 'a'.repeat(65))).toBeNull()
  })

  it('returns null without the secret, on every flavour of absent', () => {
    expect(devSurfaceSimulatedClientAddress(STAGING, undefined, '10.99.1.1')).toBeNull()
    expect(devSurfaceSimulatedClientAddress(STAGING, '', '10.99.1.1')).toBeNull()
    expect(devSurfaceSimulatedClientAddress(STAGING, 'c'.repeat(64), '10.99.1.1')).toBeNull()
  })

  it('returns null when the host may not serve dev surfaces at all', () => {
    expect(devSurfaceSimulatedClientAddress(
      { ...STAGING, ENVIRONMENT: 'production' }, SECRET, '10.99.1.1',
    )).toBeNull()
    expect(devSurfaceSimulatedClientAddress(
      { ...STAGING, DEV_ROUTES_ENABLED: 'false' }, SECRET, '10.99.1.1',
    )).toBeNull()
    // Too short to be the deployed-target secret, so the gate refuses it.
    expect(devSurfaceSimulatedClientAddress(
      { ...STAGING, DEV_RESET_SECRET: 'short' }, 'short', '10.99.1.1',
    )).toBeNull()
  })
})
