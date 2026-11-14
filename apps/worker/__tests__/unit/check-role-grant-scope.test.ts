/**
 * #2780 — a role a hub owns is granted only inside that hub. The scope check
 * runs BEFORE the super-admin shortcut: `*` is authority, not a licence to put
 * hub A's role into hub B or onto an account globally.
 */
import { describe, it, expect } from 'vitest'
import type { Context } from 'hono'
import type { AppEnv } from '@worker/types'
import type { Role } from '@shared/permissions'
import { checkRoleGrant, checkRoleScope } from '@worker/lib/hub-scope'

const now = new Date().toISOString()
const roles: Role[] = [
  { id: 'role-a', name: null, hubId: 'hub-a', slug: 'role-a', permissions: ['calls:answer'], isDefault: false, isSystem: false, description: '', createdAt: now, updatedAt: now },
  { id: 'role-volunteer', name: 'Volunteer', hubId: null, slug: 'volunteer', permissions: ['calls:answer'], isDefault: true, isSystem: false, description: '', createdAt: now, updatedAt: now },
]

function ctx(hubId: string | undefined, permissions: string[]): Context<AppEnv> {
  const vars: Record<string, unknown> = { allRoles: roles, permissions, hubId }
  return { get: (k: string) => vars[k] } as unknown as Context<AppEnv>
}

describe('checkRoleGrant — hub-owned role scope', () => {
  it('allows a hub role in its own hub', () => {
    expect(checkRoleGrant(ctx('hub-a', ['*']), ['role-a'])).toBeNull()
  })

  it('refuses it in another hub, even to a super-admin', () => {
    expect(checkRoleGrant(ctx('hub-b', ['*']), ['role-a'])).toMatchObject({ status: 400 })
  })

  it('refuses it as a global role, even to a super-admin', () => {
    expect(checkRoleGrant(ctx(undefined, ['*']), ['role-a'])).toMatchObject({ status: 400 })
  })

  it('leaves deployment-wide roles grantable anywhere', () => {
    expect(checkRoleScope(roles, ['role-volunteer'], 'hub-b')).toBeNull()
    expect(checkRoleScope(roles, ['role-volunteer'], null)).toBeNull()
  })
})
