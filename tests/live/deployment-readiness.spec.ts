/**
 * Deployment readiness — the checks an operator runs against a freshly
 * deployed server, before anyone is asked to use it.
 *
 * This suite is the only one that runs against a real deployment, and until
 * now it only covered telephony. Everything here is about the OTHER half: that
 * the server is shaped like a deployment rather than like a development box,
 * and that the roles it shipped with can actually do the job they name.
 *
 * Two properties every test here holds to:
 *
 *  1. **Real routes only.** `devGuard` (apps/worker/app.ts) answers 404 for
 *     every `/api/test-*` outside a development server, so a readiness suite
 *     that leans on one can only ever pass against the thing it is supposed to
 *     be distinguishing itself from (#1423).
 *  2. **Non-destructive.** This is safe to run against a live hotline: it
 *     reads, and never writes. A readiness check that seeds or resets data is
 *     one an operator cannot run on the box they actually care about.
 *
 * Run: `bun run test:live -- deployment-readiness`
 *   LIVE_BASE_URL     the deployment to check (default in playwright.live.config.ts)
 *   STAGING_ADMIN_SEED  enables the authenticated half; without it those skip
 */
import { test, expect } from '@playwright/test'
import { apiGet } from '../api-helpers'

const adminSeed = process.env.STAGING_ADMIN_SEED

interface Role {
  id: string
  name: string
  permissions: string[]
}

/** Mirrors `permissionGranted` (packages/shared/permissions.ts): global
 *  wildcard, exact match, or domain wildcard. Checking only the literal string
 *  reports `calls:*` as "cannot answer calls", which is wrong. */
function holds(permissions: string[], required: string): boolean {
  if (permissions.includes('*')) return true
  if (permissions.includes(required)) return true
  return permissions.includes(`${required.split(':')[0]}:*`)
}

test.describe('deployment readiness', () => {
  test('the server is live and every dependency it needs is reachable', async ({ request }) => {
    const live = await request.get('/api/health/live')
    expect(live.status(), 'liveness probe').toBe(200)

    const ready = await request.get('/api/health/ready')
    const body = await ready.json() as { status?: string; checks?: Record<string, { status?: string; detail?: string }> }

    // Report WHICH dependency is down, not just that readiness failed —
    // postgres, storage and relay fail for completely different reasons.
    const failing = Object.entries(body.checks ?? {})
      .filter(([, c]) => c.status !== 'ok')
      .map(([name, c]) => `${name}: ${c.status}${c.detail ? ` (${c.detail})` : ''}`)
    expect(failing, 'readiness dependencies').toEqual([])
    expect(ready.status(), 'readiness probe').toBe(200)
  })

  test('development-only routes are absent', async ({ request }) => {
    // The single sharpest "is this a deployment or a dev box" question. These
    // exist and are destructive on a development server; `devGuard` requires
    // ENVIRONMENT=development AND DEV_ROUTES_ENABLED=true, and a deployment
    // must satisfy neither. A 200 or a 400 here means dev surfaces are exposed
    // to the internet — 400 would mean the route matched and only the body was
    // rejected.
    for (const path of ['/api/test-create-hub', '/api/test-reset', '/api/test-add-hub-member']) {
      const res = await request.post(path, {
        headers: { 'Content-Type': 'application/json' },
        data: { name: 'readiness-probe' },
        failOnStatusCode: false,
      })
      expect(res.status(), `POST ${path} must not exist on a deployment`).toBe(404)
    }

    // `/api/demo/reset` is the other destructive surface, gated by
    // demoResetRefusal (lib/demo-reset-gate.ts) on the same ENVIRONMENT +
    // DEV_ROUTES_ENABLED condition plus DEMO_MODE and an explicit confirmation
    // string. It sits behind the authenticated router, so unauthenticated it
    // answers 401 rather than 404.
    //
    // This suite deliberately does NOT call it with credentials. The assertion
    // would be "an admin is refused", and if that gate were ever broken the
    // check would destroy the deployment it exists to vet — the one test whose
    // failure mode is worse than the bug. `demoMode === false` from
    // /api/config below is the safe precondition to assert instead, and
    // apps/worker/__tests__/unit/demo-reset-gate covers the refusal itself.
    const demo = await request.post('/api/demo/reset', {
      headers: { 'Content-Type': 'application/json' },
      data: {},
      failOnStatusCode: false,
    })
    expect(
      demo.status(),
      'POST /api/demo/reset must require authentication (404 if the route is absent entirely)',
    ).not.toBe(200)
  })

  test('the public config is served and reports a completed setup', async ({ request }) => {
    const res = await request.get('/api/config')
    expect(res.status()).toBe(200)
    const cfg = await res.json() as { setupCompleted?: boolean; needsBootstrap?: boolean; demoMode?: boolean }

    // An un-onboarded server is a legitimate state — it is what a fresh ISO
    // boots into — but it is not one a volunteer can use, so a readiness check
    // has to say so rather than pass quietly.
    expect(cfg.setupCompleted, 'setup wizard has not been completed on this deployment').toBe(true)
    expect(cfg.needsBootstrap, 'no admin exists yet').toBe(false)
    expect(cfg.demoMode, 'a deployment serving real callers must not be in demo mode').toBe(false)
  })

  test('an unauthenticated request for hub data is refused', async ({ request }) => {
    const res = await request.get('/api/hubs', { failOnStatusCode: false })
    expect(res.status(), 'GET /api/hubs must require authentication').toBe(401)
  })

  test.describe('with the admin identity', () => {
    test.skip(
      !adminSeed,
      'set STAGING_ADMIN_SEED (the hex seed `bun run bootstrap-admin` prints) to run the authenticated readiness checks',
    )

    test('the admin can authenticate and the hub exists', async ({ request }) => {
      const { status, data } = await apiGet<{ hubs?: Array<{ id: string; name: string }> }>(
        request, '/hubs', adminSeed as string,
      )
      expect(status, 'admin authentication against the deployment').toBe(200)
      expect(data.hubs?.length ?? 0, 'the deployment has no hub — onboarding did not finish').toBeGreaterThan(0)
    })

    /**
     * The defect this exists for: a role that can answer a call but cannot say
     * it is available is not a coherent role, and it has shipped twice.
     *
     * `POST /shifts/clock-in` is `requirePermission('shifts:set-availability')`.
     * #1348 found no hub-template role that could answer calls had it; #1342
     * found the same of the global default `role-volunteer`.
     *
     * Checking this against the DEPLOYMENT rather than against the source is
     * the point. `SettingsService.ensureInit` seeds roles only into an EMPTY
     * table, so a hub created before either fix keeps its old permissions
     * across an image upgrade — the source can be correct while the running
     * server is not.
     */
    test('every role that can answer calls can also go on shift', async ({ request }) => {
      const { status, data } = await apiGet<{ roles?: Role[] }>(
        request, '/settings/roles', adminSeed as string,
      )
      expect(status, 'GET /api/settings/roles').toBe(200)

      const roles = data.roles ?? []
      expect(roles.length, 'the deployment reported no roles at all').toBeGreaterThan(0)

      const answering = roles.filter(r => holds(r.permissions, 'calls:answer'))
      expect(
        answering.map(r => r.id),
        'no role on this deployment can answer a call — nobody can take the hotline',
      ).not.toEqual([])

      const cannotGoOnShift = answering
        .filter(r => !holds(r.permissions, 'shifts:set-availability'))
        .map(r => `${r.id} (${r.name})`)
      expect(
        cannotGoOnShift,
        'these roles can answer calls but get 403 on clock-in — see #1342/#1348; '
        + 'note that ensureInit does not re-seed an existing database, so a fix in the '
        + 'source does not reach a hub that already exists',
      ).toEqual([])
    })
  })
})
