/**
 * #2367 — which settings a hub can reach, read from the real route table.
 *
 * `routes/settings.ts` and `routes/entity-schema.ts` used to be ONE router each,
 * mounted at `/api/settings` and again at `/api/hubs/:hubId/settings`. Under the
 * hub mount the caller's permissions are the hub-resolved set, the default hub
 * admin role holds `settings:*`, and the handlers whose service call takes no hub
 * id wrote the deployment row — so a hub admin rewrote every hub's messaging
 * sender credentials, the login policy, the custom-field vocabulary, TTLs and
 * more through their own hub's URL.
 *
 * The fix splits each router by scope and mounts the deployment half only
 * unscoped. This test pins that split against `apps/worker/app.ts` itself (not a
 * hand-built copy of its mounts):
 *
 *   - the settings routes reachable under a hub are EXACTLY the allowlist below.
 *     A new handler that lands on the hub-mounted router fails here until its
 *     author adds it — i.e. decides, visibly, that it writes per-hub state;
 *   - every deployment-wide route is mounted unscoped and NOT under a hub.
 *
 * What the rows actually do when called is pinned against PostgreSQL by
 * `__tests__/integration-bun/settings-scope.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest'

// app.ts imports the Bun-native db driver; only the route TABLE is read here.
vi.mock('@worker/db', () => ({
  createDatabase: vi.fn(),
  getDb: vi.fn(),
  closeDb: vi.fn(),
  schema: {},
}))

import app from '@worker/app'

const HUB = '/api/hubs/:hubId/settings'
const PLATFORM = '/api/settings'

const routes: Set<string> = (() => {
  const seen = new Set<string>()
  for (const r of (app as unknown as { routes: { method: string; path: string }[] }).routes) {
    if (r.method === 'ALL') continue
    seen.add(`${r.method} ${r.path}`)
  }
  return seen
})()

const under = (prefix: string) =>
  [...routes].filter(r => r.split(' ')[1].startsWith(`${prefix}/`)).map(r => r.replace(prefix, '')).sort()

/**
 * Settings a hub has its own value of, layered over a platform default — or,
 * for the CMS, rows keyed by hub. Nothing in this list may write the deployment
 * row when reached through `/hubs/:hubId`.
 */
const HUB_REACHABLE = [
  'DELETE /cms/entity-types/:id',
  'DELETE /cms/relationship-types/:id',
  'DELETE /cms/report-types/:id',
  'DELETE /ivr-audio/:promptType/:language',
  'GET /call',
  'GET /cms/auto-assignment',
  'GET /cms/case-management',
  'GET /cms/entity-types',
  'GET /cms/entity-types/:id',
  'GET /cms/relationship-types',
  'GET /cms/report-types',
  'GET /cms/report-types/:id',
  'GET /cms/templates',
  'GET /cms/templates/:id',
  'GET /cms/templates/updates',
  'GET /ivr-audio',
  'GET /ivr-audio/:promptType/:language',
  'GET /ivr-languages',
  'GET /spam',
  'GET /telephony-provider',
  'GET /telephony-provider/recording-posture',
  'PATCH /call',
  'PATCH /cms/entity-types/:id',
  'PATCH /cms/entity-types/:id/customize',
  'PATCH /cms/relationship-types/:id',
  'PATCH /cms/report-types/:id',
  'PATCH /ivr-languages',
  'PATCH /spam',
  'PATCH /telephony-provider',
  'POST /cms/case-number',
  'POST /cms/entity-types',
  'POST /cms/relationship-types',
  'POST /cms/report-types',
  'POST /cms/templates/apply',
  'POST /telephony-provider/recording-posture/enforce',
  'POST /telephony-provider/test',
  'PUT /cms/auto-assignment',
  'PUT /cms/case-management',
  'PUT /ivr-audio/:promptType/:language',
].sort()

/** Settings the whole deployment has exactly one of. Unscoped only. */
const DEPLOYMENT_ONLY = [
  'GET /transcription', 'PATCH /transcription',
  'GET /custom-fields', 'PUT /custom-fields',
  'GET /webauthn', 'PATCH /webauthn',
  'GET /messaging', 'PATCH /messaging',
  'POST /messaging/test', 'POST /messaging/telegram/register-webhook',
  'GET /setup', 'PATCH /setup',
  'GET /report-types', 'POST /report-types', 'PATCH /report-types/:id', 'DELETE /report-types/:id',
  'GET /roles', 'POST /roles', 'PATCH /roles/:id', 'DELETE /roles/:id', 'POST /roles/:id/envelopes',
  'GET /users/:id/effective-permissions',
  'GET /permissions',
  'GET /migrations',
  'GET /ttl', 'PATCH /ttl',
  'GET /cleanup-metrics',
  'GET /geocoding', 'PUT /geocoding', 'GET /geocoding/test',
  'GET /cms/cross-hub', 'PUT /cms/cross-hub',
  'POST /cms/roles/from-template',
]

const at = (prefix: string, row: string) => {
  const [method, path] = row.split(' ')
  return `${method} ${prefix}${path}`
}

describe('settings reachable under /api/hubs/:hubId/settings (#2367)', () => {
  it('reads a populated route table', () => {
    // A table that stopped enumerating would make every "not mounted" below pass.
    expect(routes.size).toBeGreaterThan(700)
    expect(under(HUB).length).toBeGreaterThan(20)
  })

  it('are exactly the per-hub settings — a new one is a reviewed decision, not a default', () => {
    expect(under(HUB)).toEqual(HUB_REACHABLE)
  })

  it.each(DEPLOYMENT_ONLY)('%s is mounted unscoped and absent under a hub', (row) => {
    expect(routes.has(at(PLATFORM, row))).toBe(true)
    expect(routes.has(at(HUB, row))).toBe(false)
  })

  it('still mounts every per-hub setting unscoped, as the platform default', () => {
    for (const row of HUB_REACHABLE) expect(routes.has(at(PLATFORM, row)), row).toBe(true)
  })
})
