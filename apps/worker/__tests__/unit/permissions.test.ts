import { describe, it, expect } from 'vitest'
import {
  permissionGranted,
  resolvePermissions,
  hasPermission,
  getPrimaryRole,
  getPermissionsByDomain,
  hasHubPermission,
  resolveHubPermissions,
  getUserHubIds,
  isSuperAdmin,
  canClaimChannel,
  getClaimableChannels,
  PERMISSION_CATALOG,
  DEFAULT_ROLES,
  CHANNEL_CLAIM_PERMISSIONS,
  type Role,
} from '@shared/permissions'

// Helper to create a full Role from a partial definition
function makeRole(partial: Omit<Role, 'createdAt' | 'updatedAt'>): Role {
  return { ...partial, createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' }
}

const allRoles: Role[] = DEFAULT_ROLES.map(makeRole)

describe('permissionGranted', () => {
  it('returns true for exact match', () => {
    expect(permissionGranted(['calls:answer'], 'calls:answer')).toBe(true)
  })

  it('returns false when permission is not in the list', () => {
    expect(permissionGranted(['calls:answer'], 'notes:create')).toBe(false)
  })

  it('returns true for global wildcard', () => {
    expect(permissionGranted(['*'], 'calls:answer')).toBe(true)
    expect(permissionGranted(['*'], 'system:manage-roles')).toBe(true)
  })

  it('returns true for domain wildcard', () => {
    expect(permissionGranted(['calls:*'], 'calls:answer')).toBe(true)
    expect(permissionGranted(['calls:*'], 'calls:read-active')).toBe(true)
    expect(permissionGranted(['calls:*'], 'calls:read-active-full')).toBe(true)
  })

  it('returns false when domain wildcard does not match', () => {
    expect(permissionGranted(['calls:*'], 'notes:create')).toBe(false)
    expect(permissionGranted(['notes:*'], 'calls:answer')).toBe(false)
  })

  it('returns false for empty permissions array', () => {
    expect(permissionGranted([], 'calls:answer')).toBe(false)
  })

  it('handles multiple permissions in the list', () => {
    const perms = ['calls:answer', 'notes:create', 'shifts:read-own']
    expect(permissionGranted(perms, 'calls:answer')).toBe(true)
    expect(permissionGranted(perms, 'notes:create')).toBe(true)
    expect(permissionGranted(perms, 'shifts:read-own')).toBe(true)
    expect(permissionGranted(perms, 'audit:read')).toBe(false)
  })

  it('domain wildcard does not match other domains', () => {
    expect(permissionGranted(['conversations:*'], 'conversations:claim-sms')).toBe(true)
    expect(permissionGranted(['conversations:*'], 'calls:answer')).toBe(false)
  })
})

describe('resolvePermissions', () => {
  it('resolves permissions from a single role', () => {
    const perms = resolvePermissions(['role-volunteer'], allRoles)
    expect(perms).toContain('calls:answer')
    expect(perms).toContain('notes:create')
    expect(perms).toContain('notes:read-own')
  })

  it('returns empty array for unknown role ID', () => {
    const perms = resolvePermissions(['role-nonexistent'], allRoles)
    expect(perms).toEqual([])
  })

  it('returns wildcard for super-admin', () => {
    const perms = resolvePermissions(['role-super-admin'], allRoles)
    expect(perms).toContain('*')
  })

  it('merges permissions from multiple roles (union)', () => {
    const perms = resolvePermissions(['role-volunteer', 'role-reviewer'], allRoles)
    // Volunteer has calls:answer, reviewer has notes:read-assigned
    expect(perms).toContain('calls:answer')
    expect(perms).toContain('notes:read-assigned')
  })

  it('deduplicates permissions', () => {
    // Both volunteer and reviewer should have shifts:read-own
    const perms = resolvePermissions(['role-volunteer', 'role-reviewer'], allRoles)
    const count = perms.filter(p => p === 'shifts:read-own').length
    expect(count).toBe(1)
  })

  it('ignores unknown roles gracefully', () => {
    const perms = resolvePermissions(['role-volunteer', 'role-unknown'], allRoles)
    expect(perms).toContain('calls:answer')
    expect(perms.length).toBeGreaterThan(0)
  })
})

describe('hasPermission', () => {
  it('returns true when role has the permission', () => {
    expect(hasPermission(['role-volunteer'], allRoles, 'calls:answer')).toBe(true)
  })

  it('returns false when role lacks the permission', () => {
    expect(hasPermission(['role-volunteer'], allRoles, 'audit:read')).toBe(false)
  })

  it('super-admin has all permissions', () => {
    expect(hasPermission(['role-super-admin'], allRoles, 'audit:read')).toBe(true)
    expect(hasPermission(['role-super-admin'], allRoles, 'system:manage-roles')).toBe(true)
    expect(hasPermission(['role-super-admin'], allRoles, 'bans:create')).toBe(true)
  })

  it('hub-admin has domain wildcards', () => {
    expect(hasPermission(['role-hub-admin'], allRoles, 'users:create')).toBe(true)
    expect(hasPermission(['role-hub-admin'], allRoles, 'users:delete')).toBe(true)
    expect(hasPermission(['role-hub-admin'], allRoles, 'shifts:create')).toBe(true)
  })

  it('reporter has minimal permissions', () => {
    expect(hasPermission(['role-reporter'], allRoles, 'reports:create')).toBe(true)
    expect(hasPermission(['role-reporter'], allRoles, 'reports:read-own')).toBe(true)
    expect(hasPermission(['role-reporter'], allRoles, 'calls:answer')).toBe(false)
    expect(hasPermission(['role-reporter'], allRoles, 'audit:read')).toBe(false)
  })
})

describe('getPrimaryRole', () => {
  it('returns super-admin as highest priority', () => {
    const primary = getPrimaryRole(['role-volunteer', 'role-super-admin'], allRoles)
    expect(primary?.slug).toBe('super-admin')
  })

  it('returns hub-admin over volunteer', () => {
    const primary = getPrimaryRole(['role-volunteer', 'role-hub-admin'], allRoles)
    expect(primary?.slug).toBe('hub-admin')
  })

  it('returns reviewer over volunteer', () => {
    const primary = getPrimaryRole(['role-volunteer', 'role-reviewer'], allRoles)
    expect(primary?.slug).toBe('reviewer')
  })

  it('returns volunteer over reporter', () => {
    const primary = getPrimaryRole(['role-reporter', 'role-volunteer'], allRoles)
    expect(primary?.slug).toBe('volunteer')
  })

  it('returns undefined for empty roleIds', () => {
    const primary = getPrimaryRole([], allRoles)
    expect(primary).toBeUndefined()
  })

  it('returns undefined for unknown role IDs', () => {
    const primary = getPrimaryRole(['role-nonexistent'], allRoles)
    expect(primary).toBeUndefined()
  })

  it('handles custom roles with priority 99', () => {
    const customRole = makeRole({
      id: 'role-custom',
      name: 'Custom',
      slug: 'custom',
      permissions: ['calls:answer'],
      isDefault: false,
      isSystem: false,
      description: 'Custom role',
    })
    const rolesWithCustom = [...allRoles, customRole]
    const primary = getPrimaryRole(['role-custom', 'role-volunteer'], rolesWithCustom)
    expect(primary?.slug).toBe('volunteer')
  })
})

describe('getPermissionsByDomain', () => {
  it('groups permissions by domain', () => {
    const grouped = getPermissionsByDomain()
    expect(grouped).toHaveProperty('calls')
    expect(grouped).toHaveProperty('notes')
    expect(grouped).toHaveProperty('users')
    expect(grouped).toHaveProperty('shifts')
    expect(grouped).toHaveProperty('bans')
    expect(grouped).toHaveProperty('settings')
    expect(grouped).toHaveProperty('audit')
    expect(grouped).toHaveProperty('system')
  })

  it('each domain entry has key and label', () => {
    const grouped = getPermissionsByDomain()
    for (const domain of Object.values(grouped)) {
      for (const entry of domain) {
        expect(entry).toHaveProperty('key')
        expect(entry).toHaveProperty('label')
        expect(typeof entry.key).toBe('string')
        expect(typeof entry.label).toBe('string')
        expect(entry.key).toContain(':')
      }
    }
  })

  it('all PERMISSION_CATALOG entries are present', () => {
    const grouped = getPermissionsByDomain()
    const allKeys = Object.values(grouped).flatMap(entries => entries.map(e => e.key))
    for (const key of Object.keys(PERMISSION_CATALOG)) {
      expect(allKeys).toContain(key)
    }
  })
})

describe('hasHubPermission', () => {
  it('super-admin bypasses hub check', () => {
    expect(hasHubPermission(
      ['role-super-admin'],
      [],
      allRoles,
      'hub-123',
      'notes:read-all',
    )).toBe(true)
  })

  it('user with hub-specific role has hub permission', () => {
    expect(hasHubPermission(
      ['role-volunteer'],
      [{ hubId: 'hub-123', roleIds: ['role-hub-admin'] }],
      allRoles,
      'hub-123',
      'audit:read',
    )).toBe(true)
  })

  it('user without hub assignment lacks hub permission', () => {
    expect(hasHubPermission(
      ['role-volunteer'],
      [{ hubId: 'hub-456', roleIds: ['role-hub-admin'] }],
      allRoles,
      'hub-123',
      'audit:read',
    )).toBe(false)
  })

  // #1037: a non-super-admin global role must not reach into a hub the user
  // was never added to — hub membership is the isolation boundary.
  it('non-super-admin global roles grant nothing in a hub', () => {
    expect(hasHubPermission(
      ['role-hub-admin'],
      [],
      allRoles,
      'hub-123',
      'users:create',
    )).toBe(false)
  })

  it('removing the hub assignment removes the hub permission', () => {
    const before = [{ hubId: 'hub-123', roleIds: ['role-volunteer'] }]
    expect(hasHubPermission(['role-volunteer'], before, allRoles, 'hub-123', 'calls:answer')).toBe(true)
    expect(hasHubPermission(['role-volunteer'], [], allRoles, 'hub-123', 'calls:answer')).toBe(false)
  })
})

describe('resolveHubPermissions', () => {
  it('resolves only the roles assigned in that hub for a non-super-admin', () => {
    const perms = resolveHubPermissions(
      ['role-volunteer'],
      [{ hubId: 'hub-123', roleIds: ['role-reviewer'] }],
      allRoles,
      'hub-123',
    )
    // Reviewer permissions (hub assignment)
    expect(perms).toContain('notes:read-assigned')
    expect(perms).toEqual(resolvePermissions(['role-reviewer'], allRoles))
  })

  it('returns no permissions when the user has no assignment in the hub (#1037)', () => {
    const perms = resolveHubPermissions(
      ['role-volunteer'],
      [{ hubId: 'hub-other', roleIds: ['role-hub-admin'] }],
      allRoles,
      'hub-123',
    )
    expect(perms).toEqual([])
  })

  it('super-admin gets the wildcard in every hub without an assignment', () => {
    const perms = resolveHubPermissions(['role-super-admin'], [], allRoles, 'hub-123')
    expect(perms).toContain('*')
  })
})

describe('isSuperAdmin', () => {
  it('is true only for a global role granting the wildcard', () => {
    expect(isSuperAdmin(['role-super-admin'], allRoles)).toBe(true)
    expect(isSuperAdmin(['role-hub-admin'], allRoles)).toBe(false)
    expect(isSuperAdmin(['role-volunteer'], allRoles)).toBe(false)
    expect(isSuperAdmin([], allRoles)).toBe(false)
  })
})

describe('getUserHubIds', () => {
  it('returns null for super-admin (all hubs)', () => {
    const ids = getUserHubIds(['role-super-admin'], [], allRoles)
    expect(ids).toBeNull()
  })

  it('returns hub IDs from hub role assignments', () => {
    const ids = getUserHubIds(
      ['role-volunteer'],
      [
        { hubId: 'hub-1', roleIds: ['role-volunteer'] },
        { hubId: 'hub-2', roleIds: ['role-reviewer'] },
      ],
      allRoles,
    )
    expect(ids).toEqual(['hub-1', 'hub-2'])
  })

  it('returns empty array when no hub assignments', () => {
    const ids = getUserHubIds(['role-volunteer'], [], allRoles)
    expect(ids).toEqual([])
  })
})

describe('canClaimChannel', () => {
  it('claim-any grants all channels', () => {
    expect(canClaimChannel(['conversations:claim-any'], 'sms')).toBe(true)
    expect(canClaimChannel(['conversations:claim-any'], 'whatsapp')).toBe(true)
    expect(canClaimChannel(['conversations:claim-any'], 'signal')).toBe(true)
    expect(canClaimChannel(['conversations:claim-any'], 'rcs')).toBe(true)
  })

  it('specific channel permission grants only that channel', () => {
    expect(canClaimChannel(['conversations:claim-sms'], 'sms')).toBe(true)
    expect(canClaimChannel(['conversations:claim-sms'], 'whatsapp')).toBe(false)
  })

  it('wildcard conversations:* grants all channels', () => {
    expect(canClaimChannel(['conversations:*'], 'sms')).toBe(true)
    expect(canClaimChannel(['conversations:*'], 'signal')).toBe(true)
  })

  it('global wildcard grants all channels', () => {
    expect(canClaimChannel(['*'], 'rcs')).toBe(true)
  })

  it('returns false for unknown channel type', () => {
    expect(canClaimChannel(['conversations:claim-sms'], 'telegram')).toBe(false)
  })

  it('returns false when no matching permissions', () => {
    expect(canClaimChannel(['calls:answer'], 'sms')).toBe(false)
  })
})

describe('getClaimableChannels', () => {
  it('returns all channels for claim-any', () => {
    const channels = getClaimableChannels(['conversations:claim-any'])
    expect(channels).toContain('sms')
    expect(channels).toContain('whatsapp')
    expect(channels).toContain('signal')
    expect(channels).toContain('rcs')
    expect(channels.length).toBe(Object.keys(CHANNEL_CLAIM_PERMISSIONS).length)
  })

  it('returns specific channels for specific permissions', () => {
    const channels = getClaimableChannels(['conversations:claim-sms', 'conversations:claim-whatsapp'])
    expect(channels).toContain('sms')
    expect(channels).toContain('whatsapp')
    expect(channels).not.toContain('signal')
    expect(channels).not.toContain('rcs')
  })

  it('returns empty array when no claim permissions', () => {
    const channels = getClaimableChannels(['calls:answer', 'notes:create'])
    expect(channels).toEqual([])
  })

  it('returns all channels for global wildcard', () => {
    const channels = getClaimableChannels(['*'])
    expect(channels.length).toBe(Object.keys(CHANNEL_CLAIM_PERMISSIONS).length)
  })
})

describe('DEFAULT_ROLES', () => {
  it('has 5 default roles', () => {
    expect(DEFAULT_ROLES.length).toBe(5)
  })

  it('super-admin is system role with wildcard', () => {
    const superAdmin = DEFAULT_ROLES.find(r => r.slug === 'super-admin')
    expect(superAdmin).toBeDefined()
    expect(superAdmin!.isSystem).toBe(true)
    expect(superAdmin!.permissions).toEqual(['*'])
  })

  it('all default roles have isDefault true', () => {
    for (const role of DEFAULT_ROLES) {
      expect(role.isDefault).toBe(true)
    }
  })

  it('only super-admin is a system role', () => {
    const systemRoles = DEFAULT_ROLES.filter(r => r.isSystem)
    expect(systemRoles.length).toBe(1)
    expect(systemRoles[0].slug).toBe('super-admin')
  })

  it('volunteer role has correct core permissions', () => {
    const vol = DEFAULT_ROLES.find(r => r.slug === 'volunteer')
    expect(vol!.permissions).toContain('calls:answer')
    expect(vol!.permissions).toContain('notes:create')
    expect(vol!.permissions).toContain('notes:read-own')
    expect(vol!.permissions).toContain('shifts:read-own')
    expect(vol!.permissions).toContain('bans:report')
  })
})

describe('PERMISSION_CATALOG', () => {
  it('has descriptions for all permissions', () => {
    for (const [key, desc] of Object.entries(PERMISSION_CATALOG)) {
      expect(key).toContain(':')
      expect(typeof desc).toBe('string')
      expect(desc.length).toBeGreaterThan(0)
    }
  })

  it('contains expected domains', () => {
    const domains = new Set(Object.keys(PERMISSION_CATALOG).map(k => k.split(':')[0]))
    expect(domains.has('calls')).toBe(true)
    expect(domains.has('notes')).toBe(true)
    expect(domains.has('conversations')).toBe(true)
    expect(domains.has('users')).toBe(true)
    expect(domains.has('shifts')).toBe(true)
    expect(domains.has('bans')).toBe(true)
    expect(domains.has('settings')).toBe(true)
    expect(domains.has('audit')).toBe(true)
    expect(domains.has('system')).toBe(true)
    expect(domains.has('files')).toBe(true)
  })
})
