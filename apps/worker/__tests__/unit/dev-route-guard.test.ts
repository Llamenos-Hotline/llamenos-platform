/**
 * Regression test for #1277 — the outer `devGuard` middleware
 * (`api.use('/test-*', devGuard)` in apps/worker/app.ts) must 404 every
 * /api/test-* route when devSurfacesEnabled(env) is false, independent of
 * whatever inner guard the individual route handler carries.
 *
 * Every real /test-* route also checks ENVIRONMENT/checkResetSecret itself,
 * so a test that only hits a real route can pass even if the outer
 * middleware never matched at all — exactly how this went unnoticed. This
 * test hits `/api/test-devguard-canary` (apps/worker/routes/dev.ts), which
 * has no inner guard, so only devGuard's own 404 can produce a 404 here.
 *
 * Imports the real exported app (not a reconstructed mini-router) so a
 * future regression in the real registration/mount order is caught.
 */
import { describe, it, expect, vi } from 'vitest'

// apps/worker/app.ts transitively imports apps/worker/db, which uses Bun's
// native `bun` SQL driver — unavailable under vitest's worker pool even when
// invoked via `bunx`. Stub it out; devGuard runs before any handler touches
// the database, so nothing here needs to behave like a real connection.
vi.mock('@worker/db', () => ({
  createDatabase: vi.fn(),
  getDb: vi.fn(),
  closeDb: vi.fn(),
  schema: {},
}))

import app from '@worker/app'

const CANARY_PATH = '/api/test-devguard-canary'
/** Satisfies MIN_DEPLOYED_SECRET_LENGTH in lib/dev-surfaces.ts. */
const STRONG_SECRET = 'e2e-deployed-target-secret-0123456789abcdef'

describe('devGuard (#1277)', () => {
  it.each([
    ['ENVIRONMENT unset', {}],
    ['ENVIRONMENT=production', { ENVIRONMENT: 'production', DEV_ROUTES_ENABLED: 'true' }],
    ['ENVIRONMENT=development, DEV_ROUTES_ENABLED unset', { ENVIRONMENT: 'development' }],
    ['ENVIRONMENT=development, DEV_ROUTES_ENABLED=false', { ENVIRONMENT: 'development', DEV_ROUTES_ENABLED: 'false' }],
  ])('404s the canary /test-* route when %s', async (_label, env) => {
    const res = await app.request(CANARY_PATH, {}, env)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not Found' })
  })

  // The three-factor staging opt-in (lib/dev-surfaces.ts): each factor missing
  // in turn, through the REAL app, so this covers the registration order too.
  it.each([
    ['ENVIRONMENT=staging alone', { ENVIRONMENT: 'staging' }],
    ['ENVIRONMENT=staging + flag, no secret', { ENVIRONMENT: 'staging', DEV_ROUTES_ENABLED: 'true' }],
    ['ENVIRONMENT=staging + flag + a secret too short to be one', {
      ENVIRONMENT: 'staging', DEV_ROUTES_ENABLED: 'true', DEV_RESET_SECRET: 'test-reset-secret',
    }],
    ['ENVIRONMENT=demo with everything set', {
      ENVIRONMENT: 'demo', DEV_ROUTES_ENABLED: 'true', DEV_RESET_SECRET: STRONG_SECRET,
    }],
    ['ENVIRONMENT=production with everything set', {
      ENVIRONMENT: 'production', DEV_ROUTES_ENABLED: 'true', DEV_RESET_SECRET: STRONG_SECRET,
    }],
  ])('404s the canary /test-* route for %s', async (_label, env) => {
    const res = await app.request(CANARY_PATH, {}, env)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not Found' })
  })

  it('lets the canary /test-* route through when devSurfacesEnabled(env) is true', async () => {
    const res = await app.request(CANARY_PATH, {}, { ENVIRONMENT: 'development', DEV_ROUTES_ENABLED: 'true' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  // The reason this change exists: the end-to-end suite's api-bootstrap step
  // got 404s against a deployed staging instance (#723), so the suite could
  // never be pointed at one.
  it('lets the canary /test-* route through on a staging target with all three factors', async () => {
    const res = await app.request(CANARY_PATH, {}, {
      ENVIRONMENT: 'staging', DEV_ROUTES_ENABLED: 'true', DEV_RESET_SECRET: STRONG_SECRET,
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  // Real routes, not just the canary: the inner per-route guard must agree with
  // the outer one. These carry their own check (routes/dev.ts `devRouteDenied`),
  // which is where 18 hand-copied `ENVIRONMENT !== 'development'` conditions
  // used to live — one of which had already drifted.
  describe('the real bootstrap routes the suite needs', () => {
    const BOOTSTRAP_ROUTES = ['/api/test-reset-no-admin', '/api/test-promote-admin', '/api/test-db-identity']

    it.each(BOOTSTRAP_ROUTES)('404s %s on production with everything set', async (path) => {
      const res = await app.request(path, {
        method: path === '/api/test-db-identity' ? 'GET' : 'POST',
        headers: { 'X-Test-Secret': STRONG_SECRET },
      }, { ENVIRONMENT: 'production', DEV_ROUTES_ENABLED: 'true', DEV_RESET_SECRET: STRONG_SECRET })
      expect(res.status).toBe(404)
    })

    it.each(BOOTSTRAP_ROUTES)('404s %s on staging without the X-Test-Secret header', async (path) => {
      const res = await app.request(path, {
        method: path === '/api/test-db-identity' ? 'GET' : 'POST',
      }, { ENVIRONMENT: 'staging', DEV_ROUTES_ENABLED: 'true', DEV_RESET_SECRET: STRONG_SECRET })
      expect(res.status).toBe(404)
    })

    it.each(BOOTSTRAP_ROUTES)('404s %s on staging with the wrong X-Test-Secret', async (path) => {
      const res = await app.request(path, {
        method: path === '/api/test-db-identity' ? 'GET' : 'POST',
        headers: { 'X-Test-Secret': `${STRONG_SECRET}-wrong` },
      }, { ENVIRONMENT: 'staging', DEV_ROUTES_ENABLED: 'true', DEV_RESET_SECRET: STRONG_SECRET })
      expect(res.status).toBe(404)
    })
  })
})
