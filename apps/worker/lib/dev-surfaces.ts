/**
 * The boundary around every development-only surface of the server: the
 * /api/test-* routes (app.ts `devGuard`) and demo identities
 * (lib/demo-identities.ts).
 *
 * Both inputs are process environment fixed when the server starts. Nothing
 * stored in the database and nothing in a request can satisfy it. It is not a
 * build-time exclusion — CI tests the shipped image with exactly this
 * environment — so a host started with it IS a development server and must
 * never face the internet. The deploy guard only refuses it for
 * app_environment=production (deploy/ansible/playbooks/tasks/guard-demo-mode.yml).
 */
export interface DevSurfacesEnv {
  ENVIRONMENT?: string
  DEV_ROUTES_ENABLED?: string
}

export function devSurfacesEnabled(env: DevSurfacesEnv): boolean {
  return env.ENVIRONMENT === 'development' && env.DEV_ROUTES_ENABLED === 'true'
}
