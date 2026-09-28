/**
 * The boundary around every development-only surface of the server: the
 * /api/test-* routes (app.ts `devGuard`) and demo identities
 * (lib/demo-identities.ts).
 *
 * Both inputs are process environment fixed when the server starts. Nothing
 * stored in the database and nothing in a request can satisfy it, and the
 * deploy guard (deploy/ansible/playbooks/tasks/guard-demo-mode.yml) refuses to
 * render DEV_ROUTES_ENABLED into a production host's environment.
 */
export interface DevSurfacesEnv {
  ENVIRONMENT?: string
  DEV_ROUTES_ENABLED?: string
}

export function devSurfacesEnabled(env: DevSurfacesEnv): boolean {
  return env.ENVIRONMENT === 'development' && env.DEV_ROUTES_ENABLED === 'true'
}
