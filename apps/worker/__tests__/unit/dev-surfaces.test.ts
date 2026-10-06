/**
 * The three-factor gate on the `/api/test-*` surface
 * (`apps/worker/lib/dev-surfaces.ts`).
 *
 * The suite has to be able to reset a DEPLOYED staging target — that is what
 * the api-bootstrap step does, and it was answering 404 because the gate was
 * pinned to `ENVIRONMENT=development`. Opening it is the whole risk: these
 * routes wipe the database, delete the admin and promote arbitrary pubkeys.
 *
 * So the properties asserted here are the ones that make it safe, and each one
 * is asserted by trying to BREAK it:
 *
 *   - production refuses with every other factor satisfied;
 *   - an unrecognised environment refuses (allowlist, not denylist) — a typo
 *     cannot open it, and neither can `demo`;
 *   - the flag alone is not enough, and the environment alone is not enough;
 *   - on a reachable environment a missing or short secret refuses;
 *   - the demo surfaces (signing seeds, demo reset) do NOT come along for the
 *     ride.
 */
import { describe, it, expect } from 'vitest'
import {
  devSurfacesEnabled,
  devSurfacesRefusal,
  demoSurfacesEnabled,
  devSurfaceSecretPresented,
  DEV_SURFACE_ENVIRONMENTS,
  MIN_DEPLOYED_SECRET_LENGTH,
} from '@worker/lib/dev-surfaces'

/** A secret that satisfies the length minimum. */
const STRONG = 'a'.repeat(MIN_DEPLOYED_SECRET_LENGTH)

const DEV = { ENVIRONMENT: 'development', DEV_ROUTES_ENABLED: 'true' }
const STAGING = { ENVIRONMENT: 'staging', DEV_ROUTES_ENABLED: 'true', DEV_RESET_SECRET: STRONG }

describe('devSurfacesEnabled — the environment allowlist', () => {
  it('serves the dev surface on a local development server', () => {
    expect(devSurfacesEnabled(DEV)).toBe(true)
  })

  it('serves the dev surface on a staging target that set all three factors', () => {
    expect(devSurfacesRefusal(STAGING)).toBeNull()
    expect(devSurfacesEnabled(STAGING)).toBe(true)
  })

  it('refuses production even with every other factor satisfied', () => {
    const env = { ENVIRONMENT: 'production', DEV_ROUTES_ENABLED: 'true', DEV_RESET_SECRET: STRONG }
    expect(devSurfacesEnabled(env)).toBe(false)
    expect(devSurfacesRefusal(env)).toMatch(/production/)
  })

  it.each(['PRODUCTION', ' production ', 'Production'])(
    'refuses production however it is cased or padded (%j)',
    (environment) => {
      const env = { ENVIRONMENT: environment, DEV_ROUTES_ENABLED: 'true', DEV_RESET_SECRET: STRONG }
      expect(devSurfacesEnabled(env)).toBe(false)
      expect(devSurfacesRefusal(env)).toMatch(/production/)
    },
  )

  // The allowlist is compared EXACTLY. `apps/worker/__tests__/unit/
  // demo-identity-rail.test.ts` asserts the same for the demo surfaces, and a
  // normalising comparison would silently accept spellings nobody configured.
  it.each(['Development', 'development ', ' development', 'DEVELOPMENT', 'Staging', 'staging '])(
    'refuses the near-miss environment spelling %j',
    (environment) => {
      const env = { ENVIRONMENT: environment, DEV_ROUTES_ENABLED: 'true', DEV_RESET_SECRET: STRONG }
      expect(devSurfacesEnabled(env)).toBe(false)
      expect(devSurfacesRefusal(env)).toMatch(/compared exactly/)
    },
  )

  // An allowlist is the point: `!== 'production'` would open the surface on
  // every environment name nobody thought of, including a typo.
  it.each(['demo', 'prod', 'productionn', 'staging2', 'test', '', undefined])(
    'refuses the unrecognised environment %j even with the flag and a strong secret',
    (environment) => {
      const env = { ENVIRONMENT: environment, DEV_ROUTES_ENABLED: 'true', DEV_RESET_SECRET: STRONG }
      expect(devSurfacesEnabled(env)).toBe(false)
      expect(devSurfacesRefusal(env)).toMatch(/is not one of/)
    },
  )

  it('only admits the environments the allowlist names', () => {
    expect([...DEV_SURFACE_ENVIRONMENTS]).toEqual(['development', 'staging'])
  })
})

describe('devSurfacesEnabled — the explicit opt-in flag', () => {
  it.each([undefined, '', 'false', 'TRUE', '1', 'yes'])(
    'refuses when DEV_ROUTES_ENABLED is %j',
    (flag) => {
      expect(devSurfacesEnabled({ ENVIRONMENT: 'development', DEV_ROUTES_ENABLED: flag })).toBe(false)
      expect(devSurfacesEnabled({ ENVIRONMENT: 'staging', DEV_ROUTES_ENABLED: flag, DEV_RESET_SECRET: STRONG })).toBe(false)
    },
  )

  // The factor that stops a mis-set environment from being enough on its own.
  it('a staging environment alone does not open the surface', () => {
    expect(devSurfacesEnabled({ ENVIRONMENT: 'staging' })).toBe(false)
    expect(devSurfacesEnabled({ ENVIRONMENT: 'staging', DEV_RESET_SECRET: STRONG })).toBe(false)
  })
})

describe('devSurfacesEnabled — the shared secret on a reachable target', () => {
  it('refuses a staging target with no secret configured', () => {
    const env = { ENVIRONMENT: 'staging', DEV_ROUTES_ENABLED: 'true' }
    expect(devSurfacesEnabled(env)).toBe(false)
    expect(devSurfacesRefusal(env)).toMatch(/requires DEV_RESET_SECRET/)
  })

  it('refuses a staging target whose secret is too short to be one', () => {
    const env = { ENVIRONMENT: 'staging', DEV_ROUTES_ENABLED: 'true', DEV_RESET_SECRET: 'test-reset-secret' }
    expect(env.DEV_RESET_SECRET.length).toBeLessThan(MIN_DEPLOYED_SECRET_LENGTH)
    expect(devSurfacesEnabled(env)).toBe(false)
    expect(devSurfacesRefusal(env)).toMatch(/at least 32 characters/)
  })

  it('accepts E2E_TEST_SECRET as the alias', () => {
    expect(devSurfacesEnabled({ ENVIRONMENT: 'staging', DEV_ROUTES_ENABLED: 'true', E2E_TEST_SECRET: STRONG })).toBe(true)
  })

  // Localhost is not reachable, so a developer is not forced to invent a
  // 32-character secret to run the suite on their own machine. The per-route
  // check still denies by default when no secret is configured at all.
  it('does not impose the length minimum on a development server', () => {
    expect(devSurfacesEnabled({ ENVIRONMENT: 'development', DEV_ROUTES_ENABLED: 'true', DEV_RESET_SECRET: 'short' })).toBe(true)
  })
})

describe('devSurfaceSecretPresented', () => {
  it('denies by default when no secret is configured', () => {
    expect(devSurfaceSecretPresented({ ENVIRONMENT: 'development' }, 'anything')).toBe(false)
    expect(devSurfaceSecretPresented({ ENVIRONMENT: 'development' }, undefined)).toBe(false)
  })

  it('accepts the configured secret and rejects every near miss', () => {
    const env = { DEV_RESET_SECRET: STRONG }
    expect(devSurfaceSecretPresented(env, STRONG)).toBe(true)
    expect(devSurfaceSecretPresented(env, undefined)).toBe(false)
    expect(devSurfaceSecretPresented(env, '')).toBe(false)
    expect(devSurfaceSecretPresented(env, STRONG.slice(0, -1))).toBe(false)
    expect(devSurfaceSecretPresented(env, `${STRONG}x`)).toBe(false)
    expect(devSurfaceSecretPresented(env, STRONG.toUpperCase())).toBe(false)
  })
})

describe('demoSurfacesEnabled — NOT widened by the staging allowlist', () => {
  // The demo surfaces mint the demo cast's Ed25519 signing seeds and re-seed
  // their accounts. #723 decided they stay on a developer's own machine, and
  // letting a test harness reach a staging box must not quietly change that.
  it('is true on a development server', () => {
    expect(demoSurfacesEnabled(DEV)).toBe(true)
  })

  it('is false on a staging target that CAN serve /api/test-*', () => {
    expect(devSurfacesEnabled(STAGING)).toBe(true)
    expect(demoSurfacesEnabled(STAGING)).toBe(false)
  })

  it.each(['production', 'demo', 'staging'])('is false on ENVIRONMENT=%s', (environment) => {
    expect(demoSurfacesEnabled({ ENVIRONMENT: environment, DEV_ROUTES_ENABLED: 'true', DEV_RESET_SECRET: STRONG })).toBe(false)
  })
})
