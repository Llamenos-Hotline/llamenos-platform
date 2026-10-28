import { sql } from 'drizzle-orm'
import { users } from '../db/schema'

/**
 * SQL predicate: the user holds a role assignment in `hubId`.
 *
 * Compares `hubId` as a text parameter. Binding a JSON string and casting it
 * (`@> ${JSON.stringify(...)}::jsonb`) reaches Postgres double-encoded — a
 * jsonb *string*, not an array — so the containment never matched and every
 * hub's member list came back empty.
 */
export function isHubMember(hubId: string) {
  return sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${users.hubRoles}) AS assignment WHERE assignment->>'hubId' = ${hubId})`
}
