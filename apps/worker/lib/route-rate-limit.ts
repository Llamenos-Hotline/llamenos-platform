/**
 * The per-client identity that the rate limiters INSIDE route handlers bucket
 * on — `routes/auth.ts` (`auth-login`, `auth-bootstrap`), `routes/invites.ts`
 * (`invite-validate`, `invite-redeem`), `routes/webauthn.ts` (`webauthn`,
 * `webauthn-verify`), `routes/recovery-group.ts` (`recovery-initiate`) and
 * `routes/security-events.ts` (`security-events-submit`).
 *
 * All eight derived it the same way, inline: `hashIP(getClientIp(c.req.raw),
 * c.env.HMAC_SECRET)`. They now derive it here, for two reasons.
 *
 * One: these are named brute-force controls, not the general API throttle, and
 * none of them is exempt for anybody. The API rate-limit MIDDLEWARE exempts the
 * end-to-end harness outright (`middleware/rate-limit.ts`), which is correct
 * there — the suite's own setup is ordinary API traffic. Doing the same here
 * would blind the suite to these controls entirely: eight scenarios assert that
 * one of them FIRES, and the scenarios that merely trip over one would no
 * longer be able to tell "bounded" from "absent". So instead the harness is
 * ISOLATED — it may say which client a request is from, and each scenario gets
 * its own bucket, with the limiter still enforced inside it at the production
 * threshold.
 *
 * Two: that simulation used to ride on `X-Forwarded-For`, which works against a
 * directly reachable dev server and silently stops working behind the deployed
 * Caddy, because Caddy SETS `X-Forwarded-For: {remote_host}` and strips every
 * other forwarded-for header (#1606) so that no caller can pick its own
 * bucket. Against such a target the whole suite was one client and shared one
 * 5/min bucket per endpoint — 18 of the 27 deployed-target failures in #1625.
 * `DEV_SURFACE_CLIENT_ADDRESS_HEADER` is a channel that survives the proxy and
 * is honoured ONLY for a request carrying the dev surface's shared secret; see
 * `lib/dev-surfaces.ts#devSurfaceSimulatedClientAddress` for why that is less
 * authority than the same credential already has.
 *
 * A request without the secret is bucketed on its real address exactly as on
 * production. `__tests__/unit/route-rate-limit-client.test.ts` asserts that
 * from every direction.
 */

import type { Context } from 'hono'
import type { AppEnv } from '../types'
import { hashIP } from './crypto'
import { getClientIp } from './client-ip'
import {
  DEV_SURFACE_CLIENT_ADDRESS_HEADER,
  devSurfaceSimulatedClientAddress,
} from './dev-surfaces'

/**
 * The hashed client component of an in-route rate-limit key.
 *
 * Hashed with `HMAC_SECRET` like every other use of a client address in this
 * codebase, so a bucket key never carries an address in the clear — including
 * a simulated one, which keeps the key shape identical whichever path produced
 * it.
 */
export function routeRateLimitClient(c: Context<AppEnv>): string {
  const simulated = devSurfaceSimulatedClientAddress(
    c.env ?? {},
    c.req.header('X-Test-Secret'),
    c.req.header(DEV_SURFACE_CLIENT_ADDRESS_HEADER),
  )
  return hashIP(simulated ?? getClientIp(c.req.raw), c.env.HMAC_SECRET)
}
