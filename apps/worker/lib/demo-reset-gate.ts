/**
 * Gate for the admin-authenticated demo reset endpoint.
 *
 * The reset wipes every table and registers the demo accounts, so it is
 * deliberately hard to enable: a production environment refuses no matter what
 * else is configured (checked first, so no flag can override it), the demo
 * accounts only exist on a development server (lib/demo-identities.ts), and
 * both demo flags must be set.
 */
import { devSurfacesEnabled, type DevSurfacesEnv } from './dev-surfaces'

export interface DemoResetGateEnv extends DevSurfacesEnv {
  DEMO_MODE?: string
  DEMO_MODE_CONFIRM?: string
}

/** The two-factor confirmation value shared with startup validation and the service resets. */
export const DEMO_RESET_CONFIRMATION = 'DESTROY_ALL_DATA'

/**
 * Returns why the demo reset must be refused, or `null` when it may proceed.
 * The reason is safe to return to an authenticated admin.
 */
export function demoResetRefusal(env: DemoResetGateEnv): string | null {
  if ((env.ENVIRONMENT ?? '').trim().toLowerCase() === 'production') {
    return 'Demo reset is never available in a production environment'
  }
  if (!devSurfacesEnabled(env)) {
    return 'Demo reset is only available on a development server (ENVIRONMENT=development and DEV_ROUTES_ENABLED=true)'
  }
  if (env.DEMO_MODE !== 'true') {
    return 'Demo reset requires DEMO_MODE=true'
  }
  if (env.DEMO_MODE_CONFIRM !== DEMO_RESET_CONFIRMATION) {
    return `Demo reset requires DEMO_MODE_CONFIRM=${DEMO_RESET_CONFIRMATION}`
  }
  return null
}
