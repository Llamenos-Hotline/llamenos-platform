/**
 * Who owns a row that is not always a hub's: the named scope (#2463).
 *
 * Some row sets are deployment configuration rather than hub data: the
 * platform ban list, the platform audit chain, platform-wide retention floors.
 * Their rows genuinely have no hub. A ban on a caller, for example, is not
 * about any hub's records. Before #2463 each of them said "platform" by
 * leaving `hub_id` empty, so a producer that forgot its hub wrote a platform
 * row by omission. That is the hubless-data bug #2459 names.
 *
 * The fix is a discriminated union. The caller STATES the scope, and the
 * owner id is legal only where the scope requires it:
 *
 *   kind 'hub'          ⇒ hubId set
 *   kind 'platform'     ⇒ no owner id
 *   kind 'organization' ⇒ organizationId set           (M2, not yet a member)
 *
 * Code never infers a scope from whether an id happens to be present. Switch
 * on `kind` and end with {@link assertNeverScope}. M2 adds the organization
 * member here, and the compiler then names every site that has to handle it.
 *
 * The design and the table-by-table plan are in
 * docs/architecture/named-owner-scope.md.
 */

export interface HubScope {
  readonly kind: 'hub'
  readonly hubId: string
}

export interface PlatformScope {
  readonly kind: 'platform'
}

/**
 * The owner of a scoped row. M1 has two owners. M2 adds
 * `{ kind: 'organization'; organizationId: string }` as a third member, not
 * as a second encoding.
 */
export type OwnerScope = HubScope | PlatformScope

export type OwnerScopeKind = OwnerScope['kind']

/** The deployment itself. The only scope whose rows carry no owner id. */
export const PLATFORM_SCOPE: PlatformScope = Object.freeze({ kind: 'platform' })

/**
 * The scope of one hub. An empty id names no hub, so it is refused here
 * rather than becoming the hub-`''` bucket (#2460, #2461).
 */
export function hubScope(hubId: string): HubScope {
  if (!hubId) throw new Error('hubScope: a hub scope needs a hub id')
  return { kind: 'hub', hubId }
}

/** Exhaustiveness guard. An unhandled scope kind fails to compile, and throws if it ever arrives at run time. */
export function assertNeverScope(scope: never): never {
  throw new Error(`Unhandled owner scope: ${JSON.stringify(scope)}`)
}
