/**
 * Who a hub's founder becomes, and who counts as an admin, are decided by
 * PERMISSIONS (#2233) — never by a role's id or name. Roles are user-definable
 * bundles: a hub may rename `role-hub-admin`, split it, or define its own admin
 * role from a template, and none of that may stop the hub working.
 */
import { describe, it, expect } from 'vitest'
import { DEFAULT_ROLES, HUB_ADMIN_PERMISSIONS, rolesConferHubAdmin } from '@shared/permissions'
import { hubFounderRoleIds, type RoleCatalog } from '../../lib/hub-admin'

const MIN = [...HUB_ADMIN_PERMISSIONS]
const role = (id: string, permissions: string[]) => ({ id, permissions })

describe('hubFounderRoleIds', () => {
  it('picks the shipped admin role from an untouched catalog', () => {
    const catalog: RoleCatalog = DEFAULT_ROLES.map(r => role(r.id, r.permissions))
    const [chosen] = hubFounderRoleIds(catalog)
    expect(rolesConferHubAdmin([chosen], catalog)).toBe(true)
    expect(hubFounderRoleIds(catalog)).toHaveLength(1)
  })

  it('finds a hub-defined admin role when the shipped one no longer grants admin', () => {
    const catalog: RoleCatalog = [
      // the operator edited the shipped admin role down to a non-admin bundle…
      role('role-hub-admin', ['users:read']),
      // …and the hub defined its own from a template, under an id of its own
      role('role-9f2c-coordinator', ['settings:*', 'notes:*', 'users:*']),
      role('role-volunteer', ['calls:answer']),
    ]
    expect(hubFounderRoleIds(catalog)).toEqual(['role-9f2c-coordinator'])
  })

  it('grants the least authority that still administers the hub', () => {
    const catalog: RoleCatalog = [
      role('role-big', ['users:*', 'shifts:*', 'settings:*', 'notes:*', 'bans:*']),
      role('role-small', MIN),
    ]
    expect(hubFounderRoleIds(catalog)).toEqual(['role-small'])
  })

  it('is deterministic when roles tie', () => {
    const catalog: RoleCatalog = [role('role-b', MIN), role('role-a', MIN)]
    expect(hubFounderRoleIds(catalog)).toEqual(['role-a'])
  })

  it('never hands a hub founder an instance-wide wildcard role', () => {
    // A `*` role satisfies the minimum, but a hub grant of it would make the
    // founder a super-admin of every hub (#2153).
    const catalog: RoleCatalog = [role('role-instance', ['*']), role('role-volunteer', ['calls:answer'])]
    expect(hubFounderRoleIds(catalog)).not.toContain('role-instance')
  })

  it.each([['system:manage-instance'], ['system:manage-roles'], ['system:manage-hubs'], ['system:*']])(
    'never picks a role carrying instance-level %s, however small it is',
    (instancePermission) => {
      // A role planted in the shared catalog must not win the selection by being
      // small and then hand every future founder instance authority.
      const catalog: RoleCatalog = [
        role('role-planted', [...MIN, instancePermission]),
        role('role-honest', [...MIN, 'users:*', 'shifts:*', 'bans:*']),
      ]
      expect(hubFounderRoleIds(catalog)).toEqual(['role-honest'])
    },
  )

  it('still accepts read-only system:view-* permissions, as the shipped admin role carries', () => {
    const catalog: RoleCatalog = [role('role-viewer-admin', [...MIN, 'system:view-roles'])]
    expect(hubFounderRoleIds(catalog)).toEqual(['role-viewer-admin'])
  })

  it('returns nothing when no role grants the minimum, so createHub refuses', () => {
    const catalog: RoleCatalog = [
      ...DEFAULT_ROLES.map(r => role(r.id, ['calls:answer'])),
    ]
    expect(hubFounderRoleIds(catalog)).toEqual([])
  })
})

describe('rolesConferHubAdmin is decided by permissions alone', () => {
  it('an arbitrary role id that grants the minimum confers admin', () => {
    expect(rolesConferHubAdmin(['role-renamed-lead'], [role('role-renamed-lead', MIN)])).toBe(true)
  })

  it('the shipped admin id confers nothing once its permissions are taken away', () => {
    expect(rolesConferHubAdmin(['role-hub-admin'], [role('role-hub-admin', ['calls:answer'])])).toBe(false)
  })

  it('the minimum may be assembled from several roles', () => {
    const catalog: RoleCatalog = [role('role-settings', ['settings:manage']), role('role-reader', ['notes:read-all'])]
    expect(rolesConferHubAdmin(['role-settings', 'role-reader'], catalog)).toBe(true)
    expect(rolesConferHubAdmin(['role-settings'], catalog)).toBe(false)
  })
})
