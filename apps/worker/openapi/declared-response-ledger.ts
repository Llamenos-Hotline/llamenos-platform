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

/** Owns every entry below until each is split out or fixed. */
const TRACKING_ISSUE = 2521

export const KNOWN_VIOLATIONS: readonly KnownViolation[] = [
  { method: 'GET', route: '/api/admin/audit', status: 200, issue: TRACKING_ISSUE },
  { method: 'POST', route: '/api/bans', status: 200, issue: TRACKING_ISSUE },
  { method: 'GET', route: '/api/erasure/me', status: 200, issue: TRACKING_ISSUE },
  { method: 'GET', route: '/api/hubs/:hubId/audit', status: 200, issue: TRACKING_ISSUE },
  { method: 'POST', route: '/api/hubs/:hubId/bans', status: 200, issue: TRACKING_ISSUE },
  { method: 'POST', route: '/api/hubs/:hubId/blasts', status: 201, issue: TRACKING_ISSUE },
  { method: 'POST', route: '/api/hubs/:hubId/blasts/:id/send', status: 200, issue: TRACKING_ISSUE },
  { method: 'GET', route: '/api/hubs/:hubId/blasts/subscribers', status: 200, issue: TRACKING_ISSUE },
  { method: 'GET', route: '/api/hubs/:hubId/directory', status: 200, issue: TRACKING_ISSUE },
  { method: 'POST', route: '/api/hubs/:hubId/directory', status: 201, issue: TRACKING_ISSUE },
  { method: 'PATCH', route: '/api/hubs/:hubId/directory/:id', status: 200, issue: TRACKING_ISSUE },
  { method: 'GET', route: '/api/hubs/:hubId/directory/:id/relationships', status: 200, issue: TRACKING_ISSUE },
  { method: 'POST', route: '/api/hubs/:hubId/directory/:id/relationships', status: 201, issue: TRACKING_ISSUE },
  { method: 'GET', route: '/api/hubs/:hubId/directory/groups/:groupId', status: 200, issue: TRACKING_ISSUE },
  { method: 'POST', route: '/api/hubs/:hubId/directory/groups/:groupId/members', status: 201, issue: TRACKING_ISSUE },
  { method: 'DELETE', route: '/api/hubs/:hubId/directory/groups/:groupId/members/:contactId', status: 200, issue: TRACKING_ISSUE },
  { method: 'GET', route: '/api/hubs/:hubId/directory/lookup/:identifierHash', status: 200, issue: TRACKING_ISSUE },
  { method: 'GET', route: '/api/hubs/:hubId/events/:id/records', status: 200, issue: TRACKING_ISSUE },
  { method: 'POST', route: '/api/hubs/:hubId/events/:id/records', status: 201, issue: TRACKING_ISSUE },
  { method: 'GET', route: '/api/hubs/:hubId/evidence/:evidenceId', status: 200, issue: TRACKING_ISSUE },
  { method: 'GET', route: '/api/hubs/:hubId/evidence/:evidenceId/custody', status: 200, issue: TRACKING_ISSUE },
  { method: 'POST', route: '/api/hubs/:hubId/members', status: 200, issue: TRACKING_ISSUE },
  { method: 'GET', route: '/api/hubs/:hubId/notes', status: 200, issue: TRACKING_ISSUE },
  { method: 'POST', route: '/api/hubs/:hubId/notes', status: 201, issue: TRACKING_ISSUE },
  { method: 'PATCH', route: '/api/hubs/:hubId/notes/:id', status: 200, issue: TRACKING_ISSUE },
  { method: 'GET', route: '/api/hubs/:hubId/notes/:id/replies', status: 200, issue: TRACKING_ISSUE },
  { method: 'POST', route: '/api/hubs/:hubId/provider-setup/signal/register', status: 200, issue: TRACKING_ISSUE },
  { method: 'POST', route: '/api/hubs/:hubId/provider-setup/signal/verify', status: 200, issue: TRACKING_ISSUE },
  { method: 'GET', route: '/api/hubs/:hubId/records', status: 200, issue: TRACKING_ISSUE },
  { method: 'POST', route: '/api/hubs/:hubId/records', status: 201, issue: TRACKING_ISSUE },
  { method: 'GET', route: '/api/hubs/:hubId/records/:id', status: 200, issue: TRACKING_ISSUE },
  { method: 'PATCH', route: '/api/hubs/:hubId/records/:id', status: 200, issue: TRACKING_ISSUE },
  { method: 'POST', route: '/api/hubs/:hubId/records/:id/assign', status: 200, issue: TRACKING_ISSUE },
  { method: 'GET', route: '/api/hubs/:hubId/records/:id/contacts', status: 200, issue: TRACKING_ISSUE },
  { method: 'POST', route: '/api/hubs/:hubId/records/:id/contacts', status: 201, issue: TRACKING_ISSUE },
  { method: 'POST', route: '/api/hubs/:hubId/records/:id/evidence', status: 201, issue: TRACKING_ISSUE },
  { method: 'GET', route: '/api/hubs/:hubId/records/:id/interactions', status: 200, issue: TRACKING_ISSUE },
  { method: 'POST', route: '/api/hubs/:hubId/records/:id/interactions', status: 201, issue: TRACKING_ISSUE },
  { method: 'POST', route: '/api/hubs/:hubId/records/:id/reports', status: 201, issue: TRACKING_ISSUE },
  { method: 'GET', route: '/api/hubs/:hubId/records/by-contact/:contactId', status: 200, issue: TRACKING_ISSUE },
  { method: 'GET', route: '/api/hubs/:hubId/reports/:id/records', status: 200, issue: TRACKING_ISSUE },
  { method: 'POST', route: '/api/hubs/:hubId/reports/:id/records', status: 201, issue: TRACKING_ISSUE },
  { method: 'GET', route: '/api/hubs/:hubId/settings/cms/entity-types', status: 200, issue: TRACKING_ISSUE },
  { method: 'POST', route: '/api/hubs/:hubId/settings/cms/entity-types', status: 201, issue: TRACKING_ISSUE },
  { method: 'DELETE', route: '/api/hubs/:hubId/settings/cms/entity-types/:id', status: 200, issue: TRACKING_ISSUE },
  { method: 'PATCH', route: '/api/hubs/:hubId/settings/cms/entity-types/:id', status: 200, issue: TRACKING_ISSUE },
  { method: 'POST', route: '/api/hubs/:hubId/settings/cms/relationship-types', status: 201, issue: TRACKING_ISSUE },
  { method: 'DELETE', route: '/api/hubs/:hubId/settings/cms/report-types/:id', status: 200, issue: TRACKING_ISSUE },
  { method: 'POST', route: '/api/hubs/:hubId/settings/cms/templates/apply', status: 201, issue: TRACKING_ISSUE },
  { method: 'PUT', route: '/api/hubs/:hubId/shifts/fallback', status: 200, issue: TRACKING_ISSUE },
  { method: 'POST', route: '/api/invites', status: 201, issue: TRACKING_ISSUE },
  { method: 'POST', route: '/api/invites/redeem', status: 200, issue: TRACKING_ISSUE },
  { method: 'POST', route: '/api/provider-setup/a2p/brand', status: 200, issue: TRACKING_ISSUE },
  { method: 'POST', route: '/api/provider-setup/a2p/skip', status: 200, issue: TRACKING_ISSUE },
  { method: 'GET', route: '/api/provider-setup/a2p/status', status: 200, issue: TRACKING_ISSUE },
  { method: 'POST', route: '/api/provider-setup/signal/register', status: 200, issue: TRACKING_ISSUE },
  { method: 'GET', route: '/api/provider-setup/signal/status', status: 200, issue: TRACKING_ISSUE },
  { method: 'POST', route: '/api/provider-setup/signal/verify', status: 200, issue: TRACKING_ISSUE },
  { method: 'GET', route: '/api/records', status: 200, issue: TRACKING_ISSUE },
  { method: 'POST', route: '/api/records', status: 201, issue: TRACKING_ISSUE },
  { method: 'GET', route: '/api/records/:id', status: 200, issue: TRACKING_ISSUE },
  { method: 'POST', route: '/api/settings/cms/case-number', status: 200, issue: TRACKING_ISSUE },
  { method: 'GET', route: '/api/settings/cms/entity-types', status: 200, issue: TRACKING_ISSUE },
  { method: 'POST', route: '/api/settings/cms/entity-types', status: 201, issue: TRACKING_ISSUE },
  { method: 'GET', route: '/api/settings/cms/entity-types/:id', status: 200, issue: TRACKING_ISSUE },
  { method: 'GET', route: '/api/settings/cms/relationship-types', status: 200, issue: TRACKING_ISSUE },
  { method: 'POST', route: '/api/settings/cms/templates/apply', status: 201, issue: TRACKING_ISSUE },
  { method: 'GET', route: '/api/settings/custom-fields', status: 200, issue: TRACKING_ISSUE },
  { method: 'PUT', route: '/api/settings/custom-fields', status: 200, issue: TRACKING_ISSUE },
  { method: 'GET', route: '/api/settings/permissions', status: 200, issue: TRACKING_ISSUE },
  { method: 'GET', route: '/api/settings/telephony-provider', status: 200, issue: TRACKING_ISSUE },
  { method: 'GET', route: '/api/settings/ttl', status: 200, issue: TRACKING_ISSUE },
  { method: 'PATCH', route: '/api/settings/ttl', status: 200, issue: TRACKING_ISSUE },
  { method: 'GET', route: '/api/users/:targetPubkey/cases', status: 200, issue: TRACKING_ISSUE },
]

/**
 * One cause, not one route: `validator()`'s default hook answers a body that
 * fails its schema with `{ data, error: Issue[], success: false }`, while every
 * route declares its 400 as `errorResponseSchema` (`error: string`). Matched
 * by that body shape, so a route's OWN 400 that violates its schema is still
 * caught.
 */
export const VALIDATOR_400: { issue: number } = { issue: TRACKING_ISSUE }

function isValidatorFailureBody(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false
  const b = body as { success?: unknown; error?: unknown }
  return b.success === false && Array.isArray(b.error)
}

/** The ledger entry covering `violation`, if any. */
export async function knownViolation(violation: ResponseViolation, res: Response): Promise<{ issue: number } | undefined> {
  const entry = KNOWN_VIOLATIONS.find(k =>
    k.method === violation.method && k.route === violation.route && k.status === violation.status)
  if (entry) return entry
  if (violation.status === 400) {
    try {
      if (isValidatorFailureBody(await res.clone().json())) return VALIDATOR_400
    } catch {
      return undefined
    }
  }
  return undefined
}
