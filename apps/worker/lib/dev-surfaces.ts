/**
 * The boundary around the server's development-only HTTP surface: every
 * `/api/test-*` route (app.ts `devGuard`, routes/dev.ts `devRouteDenied`).
 *
 * Why this is more than a flag
 * ----------------------------
 * These routes reset the database, delete the admin, promote arbitrary pubkeys
 * to admin and mint the sample cast's signing seeds. Until now they were pinned
 * to `ENVIRONMENT=development`, which made them unreachable on any deployed
 * instance — correct, and the reason the end-to-end suite could not be pointed
 * at one.
 *
 * The seed-minting routes used to carry a SECOND, narrower predicate
 * (`demoSurfacesEnabled`), pinned to `development` alone, because on the way
 * out of demo mode the seeds were also handed to an UNAUTHENTICATED login
 * picker (`GET /api/config/demo/credentials`) and widening that to a reachable
 * host would have been strictly worse than leaving the feature alone. #1604
 * deleted the picker along with the rest of demo mode, so what remains is a
 * secret-gated `/test-*` route handing out seeds for a fictional cast on a host
 * that already serves `POST /api/test-reset` behind the same credential — less
 * authority than the caller holds already. The narrow predicate is therefore
 * gone, and the sample seeds live behind this one gate like every other
 * `/test-*` route.
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
 * rail: `apps/worker/__tests__/unit/sample-identity-rail.test.ts` asserts that
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
 * Header through which the harness states which client a request is from, for
 * the per-client rate limiters INSIDE route handlers
 * (`lib/route-rate-limit.ts`).
 *
 * Why a second header and not the rate-limiter exemption above
 * ------------------------------------------------------------
 * `devSurfaceRequestAuthorized` switches the API rate-limit MIDDLEWARE off for
 * the harness, and that is the right shape there: those tiers bound ordinary
 * API traffic, which is all the suite's own setup is. The limiters inside
 * `routes/auth.ts`, `routes/invites.ts`, `routes/webauthn.ts`,
 * `routes/recovery-group.ts` and `routes/security-events.ts` are different —
 * each is a named brute-force control, and eight scenarios exist to assert that
 * one of them FIRES. Exempting the harness from those would make the suite's
 * own view of them vacuous: the scenarios asserting a 429 would stop seeing
 * one, and the scenarios that merely trip over the control would stop being
 * able to tell the difference between "bounded" and "absent".
 *
 * So the harness gets ISOLATION rather than an exemption. It already presents
 * itself as many clients on a directly-reachable server by setting
 * `X-Forwarded-For` (`tests/api-helpers.ts#simulatedClientIp`); behind the
 * deployed Caddy that does not survive, because Caddy SETS
 * `X-Forwarded-For: {remote_host}` and strips every other forwarded-for header
 * (#1606) precisely so no caller can choose its own bucket. This header is a
 * channel that does survive, and it is honoured only for a request that already
 * carries the dev surface's shared secret.
 *
 * Authority granted: a caller that holds `DEV_RESET_SECRET` may choose which
 * bucket its request counts against. That is strictly LESS than what the same
 * credential already buys one line above — total exemption from the API rate
 * limiter — and far less than `POST /api/test-reset`, which wipes the database.
 * Without the secret the header is ignored entirely, so the limiters an
 * anonymous caller on the same reachable host meets are exactly the production
 * ones.
 */
export const DEV_SURFACE_CLIENT_ADDRESS_HEADER = 'X-Test-Client-Address'

/**
 * Shape a simulated address must have to be honoured: IPv4, IPv6 and short
 * opaque labels, nothing that could enlarge a rate-limit key beyond what a real
 * address produces. `SettingsService.checkRateLimit` validates key length and
 * charset of its own accord; this is the earlier, narrower gate so a malformed
 * value is ignored rather than turned into a key that is rejected downstream.
 */
const SIMULATED_CLIENT_ADDRESS = /^[A-Za-z0-9.:_-]{1,64}$/

/**
 * The address the harness says this request is from, or `null` for every
 * request that is not the harness's own or does not name one.
 *
 * `null` — not `''` and not a fallback value — so a caller cannot accidentally
 * treat "no simulated address" as a usable bucket component.
 */
export function devSurfaceSimulatedClientAddress(
  env: DevSurfacesEnv,
  presentedSecret: string | undefined,
  presentedAddress: string | undefined,
): string | null {
  if (!presentedAddress) return null
  if (!devSurfaceRequestAuthorized(env, presentedSecret)) return null
  const address = presentedAddress.trim()
  return SIMULATED_CLIENT_ADDRESS.test(address) ? address : null
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
 * Why a DESTRUCTIVE SERVICE-LEVEL RESET must be refused, or `null` when it may
 * proceed. `IdentityService.reset`, `SettingsService.reset`,
 * `ContactsService.reset` and `CasesService.reset` all ask this one function.
 *
 * It is the conjunction `devSurfaceRequestAuthorized` already names — the HOST
 * may serve the dev surface at all, AND the REQUEST carries its shared secret —
 * stated separately only so the refusal can say which half failed to an
 * operator reading a log. The ordering of `devSurfacesRefusal` is preserved
 * exactly, which is the load-bearing property: `ENVIRONMENT=production` is
 * refused FIRST and unconditionally, before any secret is read, so there is no
 * path on which a secret alone suffices.
 *
 * Until demo mode was removed (#1604) these four resets were gated on
 * `DEMO_MODE=true` plus `DEMO_MODE_CONFIRM=DESTROY_ALL_DATA` instead, with an
 * `ENVIRONMENT === 'development'` escape hatch that needed no secret at all.
 * That was both looser and narrower than this: looser because two environment
 * flags an operator could set on a whim were the whole gate, and narrower
 * because the only way to reset a deployed target was to put it into a product
 * mode that is being deleted — which is why the deployed-target end-to-end
 * suite could not start without it (#1625). This predicate is per-REQUEST, is
 * refused on `production` ahead of any flag, and requires a 32-character
 * secret on every reachable host.
 *
 * `routes/dev.ts` answers `404` on the same two conditions before a handler is
 * reached, so a real caller never sees these strings. They exist for the
 * service layer's own 403, which is defence in depth rather than the gate.
 */
export function destructiveResetRefusal(
  env: DevSurfacesEnv,
  presentedSecret: string | undefined,
): string | null {
  const refusal = devSurfacesRefusal(env)
  if (refusal) return `destructive reset refused: ${refusal}`
  if (!devSurfaceSecretPresented(env, presentedSecret)) {
    return 'destructive reset requires the dev-surface shared secret in X-Test-Secret'
  }
  return null
}
