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

  it('lets the canary /test-* route through when devSurfacesEnabled(env) is true', async () => {
    const res = await app.request(CANARY_PATH, {}, { ENVIRONMENT: 'development', DEV_ROUTES_ENABLED: 'true' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})
