/**
 * The third, independent layer that keeps the `/api/test-*` surface off a
 * production host: `validateConfig` refuses to START the process.
 *
 * The other two are `apps/worker/lib/dev-surfaces.ts` (the router and every
 * route answer 404) and `deploy/ansible` (the `.env` is never rendered, and
 * `playbooks/tasks/guard-dev-routes.yml` hard-fails the combination before any
 * file reaches the host).
 *
 * Why a startup refusal and not just the 404: a production process configured
 * WITH these variables is a host one guard regression away from a destructive
 * backdoor, and nothing would say so. Refusing to boot makes the
 * misconfiguration impossible to miss and impossible to leave in place.
 */
import { describe, it, expect } from 'vitest'
import { validateConfig } from '@worker/lib/config'
import { MIN_DEPLOYED_SECRET_LENGTH } from '@worker/lib/dev-surfaces'

const STRONG = 'a'.repeat(MIN_DEPLOYED_SECRET_LENGTH)

/** The minimum env a server boots on, for a given environment. */
function baseEnv(environment: string): Record<string, string> {
  return {
    DATABASE_URL: 'postgresql://llamenos:dev@localhost:5432/llamenos',
    HMAC_SECRET: 'a'.repeat(64),
    SERVER_SECRET: 'b'.repeat(64),
    HOTLINE_NAME: 'Test Hotline',
    ENVIRONMENT: environment,
    // config.ts requires this in production; irrelevant elsewhere.
    WEBHOOK_BASE_URL: 'https://hotline.example.org',
  }
}

describe('validateConfig: the dev surface may not be configured in production', () => {
  it('boots a production server that has none of the dev-surface variables', () => {
    expect(() => validateConfig(baseEnv('production'))).not.toThrow()
  })

  it.each([
    ['DEV_ROUTES_ENABLED=true', { DEV_ROUTES_ENABLED: 'true' }],
    ['DEV_RESET_SECRET set', { DEV_RESET_SECRET: STRONG }],
    ['E2E_TEST_SECRET set', { E2E_TEST_SECRET: STRONG }],
    ['all three set', { DEV_ROUTES_ENABLED: 'true', DEV_RESET_SECRET: STRONG, E2E_TEST_SECRET: STRONG }],
  ])('refuses to boot a production server with %s', (_label, extra) => {
    expect(() => validateConfig({ ...baseEnv('production'), ...extra })).toThrow(
      /CRITICAL.*production environment/s,
    )
  })

  it('names which variable is at fault, so the operator can act on it', () => {
    expect(() => validateConfig({ ...baseEnv('production'), DEV_RESET_SECRET: STRONG }))
      .toThrow(/DEV_RESET_SECRET/)
    expect(() => validateConfig({ ...baseEnv('production'), DEV_ROUTES_ENABLED: 'true' }))
      .toThrow(/DEV_ROUTES_ENABLED=true/)
  })

  // An empty value is how `vars.example.yml`-style defaults arrive. It is not a
  // configured backdoor, and failing on it would make a correct production
  // deploy impossible to boot.
  it.each(['', '   '])('treats a blank secret as absent (%j)', (blank) => {
    expect(() => validateConfig({ ...baseEnv('production'), DEV_RESET_SECRET: blank })).not.toThrow()
  })

  it.each(['false', '', 'TRUE', '1'])(
    'treats DEV_ROUTES_ENABLED=%j as not enabled',
    (flag) => {
      expect(() => validateConfig({ ...baseEnv('production'), DEV_ROUTES_ENABLED: flag })).not.toThrow()
    },
  )
})

describe('validateConfig: a reachable dev surface needs a strong secret', () => {
  it('boots a staging target with the flag and a strong secret', () => {
    expect(() => validateConfig({
      ...baseEnv('staging'),
      DEV_ROUTES_ENABLED: 'true',
      DEV_RESET_SECRET: STRONG,
    })).not.toThrow()
  })

  // The failure this prevents: the server starts, every /api/test-* request
  // 404s because dev-surfaces.ts refuses the short secret, and the operator
  // sees only an unexplained 404 at api-bootstrap.
  it.each(['', 'test-reset-secret', 'a'.repeat(MIN_DEPLOYED_SECRET_LENGTH - 1)])(
    'refuses to boot a staging target whose secret is %j',
    (secret) => {
      expect(() => validateConfig({
        ...baseEnv('staging'),
        DEV_ROUTES_ENABLED: 'true',
        ...(secret ? { DEV_RESET_SECRET: secret } : {}),
      })).toThrow(/at least 32 characters/)
    },
  )

  it('imposes no length minimum on a development server', () => {
    expect(() => validateConfig({
      ...baseEnv('development'),
      DEV_ROUTES_ENABLED: 'true',
      DEV_RESET_SECRET: 'test-reset-secret',
    })).not.toThrow()
  })
})
