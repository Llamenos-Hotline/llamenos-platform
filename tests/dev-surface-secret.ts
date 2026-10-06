/**
 * The ONE place the test harness resolves the `/api/test-*` shared secret.
 *
 * It was resolved three different ways: `tests/api-helpers.ts` and
 * `tests/db-identity.ts` accepted either variable, `tests/global-setup.ts`
 * preferred `E2E_TEST_SECRET`, and `tests/simulation-helpers.ts` and
 * `tests/helpers.ts` read ONLY `DEV_RESET_SECRET`. A run that exported just
 * `E2E_TEST_SECRET` — which `scripts/test-backend-bdd.sh` documents as
 * sufficient — therefore sent `'test-reset-secret'` from the simulation
 * helpers, and the gate answered 404. Measured against a deployed staging
 * target: five scenarios failed as "Simulation endpoint incoming-call failed
 * (404)" while every other call to the same surface succeeded.
 *
 * `404`, not `401`, is the gate's deliberate answer to a wrong secret
 * (`apps/worker/lib/dev-surfaces.ts` — a probe must not be able to tell a
 * gated route from an absent one), which is exactly why a mis-resolved secret
 * reads as "the route does not exist" and cost an afternoon to see.
 */

/** Harness default for a local dev server. Rejected on any deployed target. */
export const LOCAL_DEV_SECRET_DEFAULT = 'test-reset-secret'

export function devSurfaceSecret(): string {
  return process.env.DEV_RESET_SECRET || process.env.E2E_TEST_SECRET || LOCAL_DEV_SECRET_DEFAULT
}
