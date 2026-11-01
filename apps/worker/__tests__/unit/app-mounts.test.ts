/**
 * #2395 — no handler is served both inside and outside a hub unless its mount
 * is in the reviewed ledger below. Read from the real route table of
 * `apps/worker/app.ts`, not a hand-built copy of its mounts.
 *
 * The shape this closes produced #2239, #1137, the nine rows of #2367, two in
 * #2376, #2381, #2363 and the four of #2395, one at a time. Every instance was
 * the same thing: ONE router mounted at `/api/<x>` and again under
 * `/api/hubs/:hubId/<x>`. On the unscoped mount `c.get('hubId')` is undefined
 * and `permissions` are the caller's GLOBAL ones, so a service that filters
 * `if (hubId)` answers for every hub at once, and a non-super-admin global
 * role, which grants nothing inside any hub, grants its permissions across all
 * of them.
 *
 * A dual mount is detected from handler IDENTITY: Hono keeps the handler
 * function when `route()` copies a sub-app's routes into its parent, so one
 * handler reachable at both a `/api/hubs/:hubId/...` path and an unscoped path
 * is exactly "the same code, with and without a hub". Two routers that happen to
 * share a path but not code (the #2367 settings split) are not flagged.
 *
 * The ledger is a ratchet in both directions:
 *  - a dual mount NOT in it fails. Make the router hub-only instead: mount it
 *    only on `hubScoped` and register `hubOnly` (lib/hub-scope.ts) first, so a
 *    stray unscoped mount still fails closed. Where a deployment-wide view is
 *    genuinely wanted, give it its own router, route and permission (as
 *    `/api/admin/audit` with `system:view-audit`), never the absence of a hub id;
 *  - an entry that is no longer dual fails too, so a removed mount cannot be
 *    re-added later without a review seeing it.
 */
import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'

// app.ts imports the Bun-native db driver; only the route TABLE is read here.
vi.mock('@worker/db', () => ({
  createDatabase: vi.fn(),
  getDb: vi.fn(),
  closeDb: vi.fn(),
  schema: {},
}))

import app from '@worker/app'
import notesRoutes from '@worker/routes/notes'
import reportsRoutes from '@worker/routes/reports'
import contactsRoutes from '@worker/routes/contacts'
import auditRoutes from '@worker/routes/audit'
import conversationsRoutes from '@worker/routes/conversations'

interface RouteEntry { method: string; path: string; handler: unknown }

const HUB_PREFIX = '/api/hubs/:hubId'
const inHub = (path: string) => path === HUB_PREFIX || path.startsWith(`${HUB_PREFIX}/`)

/**
 * Mount key → the unscoped endpoints whose handler is also served under a hub.
 * The key is the first path segment after `/api`, which is where a router is
 * mounted. `ALL` entries (router-wide middleware) are skipped: a dual router
 * always has at least one endpoint as well, so nothing is lost.
 */
function dualMounts(routes: readonly RouteEntry[]): Map<string, string[]> {
  const pathsByHandler = new Map<unknown, RouteEntry[]>()
  for (const r of routes) {
    if (r.method === 'ALL') continue
    const list = pathsByHandler.get(r.handler) ?? []
    list.push(r)
    pathsByHandler.set(r.handler, list)
  }
  const out = new Map<string, Set<string>>()
  for (const entries of pathsByHandler.values()) {
    if (!entries.some(e => inHub(e.path))) continue
    for (const e of entries) {
      if (inHub(e.path) || !e.path.startsWith('/api/')) continue
      const key = `/${e.path.split('/')[2]}`
      const set = out.get(key) ?? new Set<string>()
      set.add(`${e.method} ${e.path}`)
      out.set(key, set)
    }
  }
  return new Map([...out].map(([k, v]) => [k, [...v].sort()]))
}

/**
 * Every mount still served both inside and outside a hub, and what its unscoped
 * half means. "WIDENS" marks one whose unscoped half is the #2395 shape and is
 * tracked for removal in #2404. Nothing may be added here to make this test
 * pass: a new entry is a decision that a missing hub id is safe for EVERY
 * handler of that router, and it is reviewed as one.
 */
const LEDGER: Record<string, string> = {
  '/settings':
    'Layered per-hub settings over a platform default. Governed endpoint by endpoint by settings-scope-mounts.test.ts (#2367).',
  '/users':
    'Deployment user administration. `hubOrSuperAdmin` refuses the unscoped list/create to anyone but a super-admin (#1099, #2153).',
  '/volunteers':
    'Alias of /users, same router and guard.',
  '/identity':
    'WIDENS (#2404): /identity/members with no hub lists every user to a global `users:read` holder.',
  '/shifts':
    'Handlers fall back to `hubId ?? \'\'`, which names no hub; /my-status is the caller\'s own (#2381 audit).',
  '/calls':
    'Handlers fall back to `hubId ?? \'\'`, which names no hub (#2381 audit).',
  '/bans':
    'Unscoped = the platform ban list (`hub_id IS NULL`), a deployment-wide list by design.',
  '/blasts':
    'WIDENS (#2404): listSubscribers / listBlasts / getSubscriberStats drop the hub filter with no hub.',
  '/directory':
    'WIDENS (#2404): POST takes `body.hubId` when unscoped — scope from the body, not the path (#2376 class).',
  '/records':
    'Handlers fall back to `hubId ?? \'\'`, which names no hub; /by-number checks the path hub (#2381 audit).',
  '/events':
    'Handlers fall back to `hubId ?? \'\'`, which names no hub.',
  '/analytics':
    'WIDENS (#2404): `hubId ?? \'\'` reaches services that filter `if (hubId)`, so a global `audit:read` holder gets every hub\'s aggregates. The desktop always calls it unscoped. /me is the caller\'s own.',
  '/messaging':
    'WIDENS (#2404): /messaging/signal reads its hub from `?hub=` / the body even under a hub path.',
  '/provider-setup':
    'WIDENS (#2404): several handlers take `hubId ?? body.hubId` — scope from the body when unscoped.',
  '/retention':
    'Handlers refuse with 400 when there is no hub; should be `hubOnly` (#2404).',
  '/erasure':
    'Self-erasure is account-wide by design (a person, not a hub row); admin queue handlers take the path hub.',
  '/evidence':
    'Mounted at `/`; with no hub, evidence audit reads `listForEvidence(id, undefined)` across hubs (#2404).',
  '/firehose':
    'Falls back to a literal `\'global\'` namespace, which names no hub.',
  '/ring-groups':
    'Handlers fall back to `hubId ?? \'\'`, which names no hub.',
}

const routes = (app as unknown as { routes: RouteEntry[] }).routes
const dual = dualMounts(routes)

describe('dual mounts (#2395)', () => {
  it('detects a dual mount from the route table (the detector is not vacuous)', () => {
    const router = new Hono<AppEnv>()
    router.get('/', (c) => c.json({}))
    router.get('/:id', (c) => c.json({}))
    const hubScoped = new Hono<AppEnv>()
    hubScoped.route('/widgets', router)
    const root = new Hono<AppEnv>()
    root.route('/api/widgets', router)
    root.route('/api/hubs/:hubId', hubScoped)

    expect(dualMounts(root.routes)).toEqual(new Map([['/widgets', ['GET /api/widgets', 'GET /api/widgets/:id']]]))

    // Same paths, different code (a split router) is not a dual mount.
    const hubOnlyCopy = new Hono<AppEnv>()
    hubOnlyCopy.get('/', (c) => c.json({}))
    const split = new Hono<AppEnv>()
    split.route('/api/widgets', router)
    split.route('/api/hubs/:hubId/widgets', hubOnlyCopy)
    expect(dualMounts(split.routes).size).toBe(0)
  })

  it('every handler served both inside and outside a hub is in the reviewed ledger', () => {
    const unlisted = [...dual.keys()].filter(k => !(k in LEDGER))
    expect(
      unlisted.map(k => `${k}: ${dual.get(k)!.slice(0, 3).join(', ')}${dual.get(k)!.length > 3 ? ', …' : ''}`),
      'A router is mounted both unscoped and under /hubs/:hubId. Mount it only under the hub and register `hubOnly` on it; '
        + 'see the header of this file. Do not add it to LEDGER to make this pass.',
    ).toEqual([])
  })

  it('every ledger entry is still a dual mount (the ledger only shrinks)', () => {
    expect(Object.keys(LEDGER).filter(k => !dual.has(k)), 'Remove these entries: the mount is gone.').toEqual([])
  })

  it('the hub-owned routers (#2395, #2381) are reachable only under a hub', () => {
    const paths = routes.filter(r => r.method !== 'ALL').map(r => r.path)
    for (const prefix of ['/notes', '/reports', '/contacts', '/audit', '/conversations']) {
      expect(paths.filter(p => p === `/api${prefix}` || p.startsWith(`/api${prefix}/`)), `unscoped ${prefix}`).toEqual([])
      expect(paths.some(p => p.startsWith(`${HUB_PREFIX}${prefix}`)), `hub ${prefix}`).toBe(true)
    }
    // The platform chain has its own route, and no hub's.
    expect(paths).toContain('/api/admin/audit')
    expect(paths).toContain('/api/admin/audit/verify')
    expect(paths).not.toContain(`${HUB_PREFIX}/admin/audit`)
  })
})

describe('hubOnly fails closed when a hub-owned router is mounted unscoped (#2395)', () => {
  // Mounted the way the old app.ts did, with no hubContext in front. `services`
  // is deliberately absent: a handler that ran would throw, not answer 404.
  const stray = new Hono<AppEnv>()
  stray.use('*', async (c, next) => {
    c.set('permissions', ['*'])
    c.set('pubkey', 'a'.repeat(64))
    await next()
  })
  stray.route('/notes', notesRoutes)
  stray.route('/reports', reportsRoutes)
  stray.route('/contacts', contactsRoutes)
  stray.route('/audit', auditRoutes)
  stray.route('/conversations', conversationsRoutes)

  for (const path of ['/notes', '/notes/n1', '/reports', '/reports/r1/messages', '/contacts', '/contacts/abc', '/audit', '/audit/verify', '/conversations', '/conversations/c1']) {
    it(`GET ${path} with every permission and no hub is a 404`, async () => {
      const res = await stray.request(path)
      expect(res.status).toBe(404)
    })
  }

  it('a write is refused the same way', async () => {
    const res = await stray.request('/notes', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(404)
  })
})
