/**
 * Responses that did not satisfy their declared schema when the
 * declared-response check landed (#2118) — measured by a full backend BDD run,
 * not guessed. Each is owned by an issue; each passes the check with a
 * warning instead of failing it, so the check could land without first fixing
 * every route in the server.
 *
 * Shrink-only. Fix a route, delete its entry. Never add one to make a new
 * route pass: a new route satisfies its schema, or its schema is wrong.
 * `declared-response-ledger.test.ts` fails on an entry naming a route or
 * status the app no longer declares, so a removed route cannot leave a dead
 * entry behind.
 */
import type { ResponseViolation } from './declared-responses'

export interface KnownViolation {
  method: string
  /** The route pattern, exactly as the check reports it. */
  route: string
  status: number
  /** The issue that owns the fix. */
  issue: number
}

export const KNOWN_VIOLATIONS: readonly KnownViolation[] = [
  { method: 'POST', route: '/api/hubs/:hubId/blasts', status: 201, issue: 2572 },
  { method: 'POST', route: '/api/hubs/:hubId/blasts/:id/send', status: 200, issue: 2572 },
  // The reads of the same blast content shape (#2572): measured by the every-GET sweep
  // (core/openapi-spec.feature) once it covered routes no scenario read.
  { method: 'GET', route: '/api/blasts', status: 200, issue: 2572 },
  { method: 'GET', route: '/api/blasts/:id', status: 200, issue: 2572 },
  { method: 'GET', route: '/api/hubs/:hubId/blasts', status: 200, issue: 2572 },
  { method: 'GET', route: '/api/hubs/:hubId/blasts/:id', status: 200, issue: 2572 },
  { method: 'GET', route: '/api/hubs/:hubId/notes/:id/replies', status: 200, issue: 2300 },
]

/** The ledger entry covering `violation`, if any. */
export function knownViolation(violation: ResponseViolation): { issue: number } | undefined {
  return KNOWN_VIOLATIONS.find(k =>
    k.method === violation.method && k.route === violation.route && k.status === violation.status)
}
