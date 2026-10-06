/**
 * The boundary around the server's development-only HTTP surface: every
 * `/api/test-*` route (app.ts `devGuard`, routes/dev.ts `devRouteDenied`).
 *
 * Why this is more than a flag
 * ----------------------------
 * These routes reset the database, delete the admin and promote arbitrary
 * pubkeys to admin. Until now they were pinned to `ENVIRONMENT=development`,
 * which made them unreachable on any deployed instance — correct, and the
 * reason the end-to-end suite could not be pointed at one. #723 declined to
 * widen this gate for the demo/telephony feature it was about, and that
 * judgement is kept for the surfaces that hand out signing material: see
 * `demoSurfacesEnabled`.
 *
 * A deployed, non-production TEST instance is a different case, and it gets a
 * deliberately three-factor opt-in. The axis is the ENVIRONMENT plus an
 * explicit opt-in — not the deployment profile: the hosted shape
 * (deploy/scripts/deploy-official.sh) and the self-hosted shape
 * (deploy/scripts/deploy-self-hosted.sh) both run `setup.yml` ->
 * `playbooks/deploy.yml` -> the same per-service roles, so "which profile" says
 * nothing about whether an instance is production. ALL of these must hold:
 *
 *   1. `ENVIRONMENT` is on an ALLOWLIST (`development`, `staging`).
 *      `production` is refused first and unconditionally, before any flag is
 *      read, so no flag can override it. Anything unrecognised is refused too:
 *      an allowlist cannot be widened by a typo the way a
 *      `!== 'production'` denylist can.
 *   2. `DEV_ROUTES_ENABLED=true` — an explicit opt-in nobody sets by accident.
 *   3. Outside `development`, a shared secret of at least
 *      `MIN_DEPLOYED_SECRET_LENGTH` characters in `DEV_RESET_SECRET` (or
 *      `E2E_TEST_SECRET`). A developer's own machine is not reachable; a
 *      deployed host is, so there the surface must carry a credential. A
 *      mis-set `ENVIRONMENT=staging` alone cannot expose it, and neither can
 *      `ENVIRONMENT=staging` plus the flag without a strong secret.
 *
 * Every individual route then ALSO requires that secret in an `X-Test-Secret`
 * header, compared in constant time, and answers `404` — not `401`/`403` — so
 * the surface is not discoverable by probing. `routes/dev.ts` holds that half,
 * and `app.ts` rate-limits the secret-less requests.
 *
 * That same header is the test harness's identity for one thing beyond this
 * surface: `middleware/rate-limit.ts` exempts a request presenting it from the
 * API rate limiter (`devSurfaceRequestAuthorized` below), because the suite's
 * own per-scenario setup is ordinary API traffic and 30 writes/min per pubkey
 * makes it unrunnable. The exemption is per-REQUEST and never per-host: an
 * anonymous caller on the same reachable staging box is limited exactly as on
 * production.
 *
 * All inputs are process environment fixed when the server starts. Nothing
 * stored in the database and nothing in a request can satisfy it. It is not a
 * build-time exclusion — CI tests the shipped image with exactly this
 * environment.
 *
 * Four independent layers refuse the production case, so a bypass of any one
 * of them still cannot open the surface on a host that serves real callers:
 *   - `deploy/ansible/playbooks/tasks/guard-dev-routes.yml` (the play fails
 *     before a single file is rendered to the target),
 *   - `templates/env/_worker-required-env.j2` and the compose templates (the
 *     vars never reach the `.env`, and no database port is published),
 *   - `lib/config.ts` (the process refuses to START at all), and
 *   - this module (the router and every handler answer 404).
 *
 * `docs/deploy/E2E_AGAINST_A_DEPLOYMENT.md` is the operator-facing runbook.
 */

import { sha256 } from '@noble/hashes/sha2.js'

/** Environments that MAY serve `/api/test-*`. An allowlist, never a denylist. */
export const DEV_SURFACE_ENVIRONMENTS = ['development', 'staging'] as const

/**
 * Minimum length of the shared secret on a reachable (non-`development`)
 * target. 32 characters of `openssl rand -hex 32` is 128 bits, which is what
 * actually makes guessing hopeless; the per-IP cap app.ts puts on /test-*
 * requests that do NOT carry the secret is belt-and-braces on top. Short enough
 * to paste into a CI secret.
 */
export const MIN_DEPLOYED_SECRET_LENGTH = 32

export interface DevSurfacesEnv {
  ENVIRONMENT?: string
  DEV_ROUTES_ENABLED?: string
  DEV_RESET_SECRET?: string
  E2E_TEST_SECRET?: string
}

/**
 * `ENVIRONMENT` as given, with NO trimming and NO case folding.
 *
 * The allowlist below compares this EXACTLY, and that strictness is itself a
 * rail: `apps/worker/__tests__/unit/demo-identity-rail.test.ts` asserts that
 * `"Development"` and `"development "` are refused. An environment value is a
 * deployment's own identifier, not user input to be guessed at — normalising it
 * would make the gate accept spellings nobody configured on purpose, which is
 * the opposite of what an allowlist is for.
 */
function environmentOf(env: DevSurfacesEnv): string {
  return env.ENVIRONMENT ?? ''
}

/**
 * The shared secret for the dev surface, or `''` when none is configured.
 * `DEV_RESET_SECRET` wins; `E2E_TEST_SECRET` is the harness-facing alias.
 */
export function devSurfaceSecret(env: DevSurfacesEnv): string {
  return (env.DEV_RESET_SECRET ?? env.E2E_TEST_SECRET ?? '').trim()
}

/**
 * Why `/api/test-*` must stay closed on this server, or `null` when it may be
 * served. The reason is for logs and for operators — it is never returned to a
 * caller, which always gets an indistinguishable 404.
 */
export function devSurfacesRefusal(env: DevSurfacesEnv): string | null {
  const environment = environmentOf(env)

  // Stated first and unconditionally so it is the one refusal nobody has to
  // reason about, and so the message names the real cause. The allowlist below
  // would refuse production anyway — this is not the load-bearing check, it is
  // the legible one. Trimmed and case-folded HERE only: `Production` is
  // production for the purpose of explaining the refusal, while the allowlist
  // stays an exact comparison.
  if (environment.trim().toLowerCase() === 'production') {
    return 'ENVIRONMENT=production never serves /api/test-*'
  }
  if (!(DEV_SURFACE_ENVIRONMENTS as readonly string[]).includes(environment)) {
    return (
      `ENVIRONMENT=${JSON.stringify(environment) === '""' ? '(unset)' : JSON.stringify(environment)} ` +
      `is not one of ${DEV_SURFACE_ENVIRONMENTS.join(', ')} (compared exactly)`
    )
  }
  if ((env.DEV_ROUTES_ENABLED ?? '').trim() !== 'true') {
    return 'DEV_ROUTES_ENABLED is not "true"'
  }
  // A development server is not reachable from anywhere; a deployed one is.
  if (environment !== 'development') {
    const secret = devSurfaceSecret(env)
    if (secret.length === 0) {
      return (
        `ENVIRONMENT=${environment} additionally requires DEV_RESET_SECRET ` +
        '(or E2E_TEST_SECRET) — a reachable host may not serve /api/test-* without a secret'
      )
    }
    if (secret.length < MIN_DEPLOYED_SECRET_LENGTH) {
      return (
        `DEV_RESET_SECRET must be at least ${MIN_DEPLOYED_SECRET_LENGTH} characters ` +
        `on ENVIRONMENT=${environment} (got ${secret.length})`
      )
    }
  }
  return null
}

/**
 * Length-independent constant-time comparison of two UTF-8 strings.
 *
 * Hashes first so the compared buffers are always 32 bytes: comparing the raw
 * strings would leak the secret's LENGTH through an early return.
 */
function timingSafeEqualUtf8(a: string, b: string): boolean {
  const encoder = new TextEncoder()
  const ha = sha256(encoder.encode(a))
  const hb = sha256(encoder.encode(b))
  let diff = 0
  for (let i = 0; i < ha.length; i++) diff |= ha[i]! ^ hb[i]!
  return diff === 0
}

/**
 * True when the request carries the dev surface's shared secret.
 *
 * `X-Test-Secret` only — a Bearer token is not sufficient for destructive
 * endpoints. Compared in constant time: a reachable staging target now serves
 * these routes, so `===` on a secret would be a real timing oracle rather than
 * a localhost-only curiosity.
 *
 * Deny by default when no secret is configured.
 */
export function devSurfaceSecretPresented(env: DevSurfacesEnv, presented: string | undefined): boolean {
  const secret = devSurfaceSecret(env)
  if (!secret) return false
  return timingSafeEqualUtf8(presented ?? '', secret)
}

/** True when this server may serve `/api/test-*` at all. */
export function devSurfacesEnabled(env: DevSurfacesEnv): boolean {
  return devSurfacesRefusal(env) === null
}

/**
 * True when a request is the test harness's own: it presents the dev surface's
 * shared secret, AND this server is one that may serve the dev surface at all.
 *
 * This is the conjunction of the two halves above, named once so that callers
 * outside `/api/test-*` cannot accidentally take only one of them. Both are
 * load-bearing:
 *
 *   - without `devSurfacesEnabled`, a `production` host that somehow had a
 *     `DEV_RESET_SECRET` would honour it;
 *   - without `devSurfaceSecretPresented`, every unauthenticated caller on a
 *     reachable staging host would be treated as the harness.
 *
 * `middleware/rate-limit.ts` uses it to let the suite's own fixtures through
 * the API rate limiter. That is the whole reason it is exported: the suite
 * makes hundreds of writes per run and 30/min per pubkey makes it unrunnable,
 * while an anonymous request to the same deployed host must still be limited.
 * The authority granted is "not rate limited", which is why it is keyed on the
 * same credential as the destructive `/api/test-*` surface rather than on
 * anything weaker — a caller who holds this secret can already wipe the
 * database, so letting them skip a throttle adds nothing.
 *
 * Note what it is NOT keyed on: the ENVIRONMENT alone, and `devSurfacesEnabled`
 * alone. "Dev surfaces are switched on here" is a property of the HOST;
 * "this is the harness" is a property of the REQUEST, and only the second one
 * may relax a per-caller control.
 */
export function devSurfaceRequestAuthorized(
  env: DevSurfacesEnv,
  presented: string | undefined,
): boolean {
  return devSurfacesEnabled(env) && devSurfaceSecretPresented(env, presented)
}

/**
 * The DEMO surfaces — minting the fictional demo cast's signing seeds
 * (`lib/demo-identities.ts`), handing them to the login picker
 * (`routes/config.ts` `GET /api/config/demo/credentials`, unauthenticated), the
 * `/test-*` routes that register or reveal them (`routes/dev.ts`
 * `demoRouteDenied`), the admin-authenticated demo reset
 * (`lib/demo-reset-gate.ts`), and the `demoMode` the public `/api/config`
 * reports off a STORED database flag (`routes/config.ts` `effectiveDemoMode`) —
 * keep their own predicate, still pinned to a developer's own machine.
 *
 * Demo mode is being removed from the product altogether (the deployment
 * shapes are the hosted one and the self-hosted one; there is no demo
 * instance). This predicate exists so that removal is the ONLY thing that
 * changes these surfaces: without it, widening `devSurfacesEnabled` for a test
 * instance would have handed signing seeds to a staging host on the way out,
 * which is a strictly worse place to leave a feature nobody wants. It costs
 * nothing and it dies with `lib/demo-identities.ts`.
 */
export function demoSurfacesEnabled(env: DevSurfacesEnv): boolean {
  return environmentOf(env) === 'development' && devSurfacesEnabled(env)
}
