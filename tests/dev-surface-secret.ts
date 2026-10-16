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

/**
 * The header that identifies a request as the harness's own, on EVERY request
 * the suite makes — not only the `/api/test-*` ones.
 *
 * Against a deployed target the server is not on `ENVIRONMENT=development`, so
 * `apps/worker/middleware/rate-limit.ts` applies the real per-caller limits to
 * the suite's own setup: `POST /api/hubs` from the `workerHub` fixture is on
 * the `write` tier at 30/min per pubkey, and the suite is three parallel
 * workers sharing one admin identity. It answered 429 and every step in the
 * scenario then failed as `Cannot destructure property 'admin'`.
 *
 * That middleware exempts a request presenting this header with the server's
 * `DEV_RESET_SECRET` — and ONLY such a request, so an anonymous caller on the
 * same reachable host is still limited. Sending it everywhere is what makes the
 * suite that caller. On a local `development` server the limiter is skipped by
 * environment anyway and the header is inert.
 *
 * It is attached where the harness builds its OWN requests —
 * `tests/api-helpers.ts#authHeaders` (every `apiGet`/`apiPost`/... call, which
 * is most of the suite), `tests/steps/fixtures.ts`' two request contexts
 * (where the `workerHub` fixture lives), and `tests/global-setup.ts`' raw
 * `fetch`es — and is opt-in everywhere else.
 *
 * It is deliberately NOT a project-wide `extraHTTPHeaders` in
 * `playwright.config.ts`, even though that would cover the ~70 raw
 * `request.post(...)` calls in step definitions in one line. Scenarios exist
 * whose entire point is that this credential is REQUIRED — "Dev test-reset
 * rejects requests without X-Test-Secret header", "Dev reset requires
 * DEV_RESET_SECRET when configured" — and a project-wide default supplies it
 * to them too. Measured against the deployed target: that scenario got 200
 * instead of 404, which means `POST /api/test-reset` really ran and wiped the
 * database halfway through the suite, taking five unrelated scenarios in other
 * workers down with it (`Failed to delete hub: 401`). The default has to be
 * "an ordinary caller"; a step that needs the exemption spreads this in at the
 * call site, which is also where the reader can see it is not the thing under
 * test.
 */
export function devSurfaceHeaders(): Record<string, string> {
  return { 'X-Test-Secret': devSurfaceSecret() }
}

/**
 * The header through which the harness tells the server which client a request
 * is from, for the per-client rate limiters inside the route handlers
 * (`apps/worker/lib/route-rate-limit.ts`). Mirrors
 * `DEV_SURFACE_CLIENT_ADDRESS_HEADER` on the server.
 */
export const CLIENT_ADDRESS_HEADER = 'X-Test-Client-Address'

/**
 * Headers that make this request the harness, FROM a named client.
 *
 * Two different mechanisms, which is why they belong together in one place:
 *
 *   - `X-Test-Secret` exempts the request from the API rate-limit MIDDLEWARE
 *     (`middleware/rate-limit.ts`). Without it the `strict` tier — 5/min per
 *     IP on `/api/auth/*`, `/api/webauthn/*`, `/api/invites/*`,
 *     `/api/provision/*`, `/api/recovery-group/*` — answers 429 first, with the
 *     body `{"error":"Rate limit exceeded"}`. That is why the auth brute-force
 *     scenarios could not assert their own bodies against a deployed target:
 *     the middleware fired at the same threshold of 5 as the in-route limiter
 *     and won, so `"Too many login attempts"` was never the body anyone saw
 *     (#1625).
 *   - `X-Test-Client-Address` does NOT exempt anything. The limiters inside
 *     the route handlers are named brute-force controls and eight scenarios
 *     assert that one of them fires, so the harness gets a bucket of its own
 *     rather than a way past them — the limit still binds inside that bucket,
 *     at the production threshold. `X-Forwarded-For` is sent alongside because
 *     it is what a directly reachable dev server reads
 *     (`TRUST_PROXY_HEADERS=true`, no proxy in front); the deployed Caddy
 *     overwrites it with the real remote address, which is what the second
 *     header is for.
 *
 * Pass the SAME address twice when two requests must look like one client (two
 * redemptions of one invite code), and different addresses when they must look
 * like different people.
 */
export function harnessClientHeaders(address: string): Record<string, string> {
  return {
    'X-Forwarded-For': address,
    [CLIENT_ADDRESS_HEADER]: address,
    ...devSurfaceHeaders(),
  }
}
