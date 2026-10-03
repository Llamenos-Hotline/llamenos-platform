/**
 * Permission-Based Access Control (PBAC)
 *
 * Permissions are colon-separated strings: "domain:action"
 * Roles are named bundles of permissions.
 * Users can have multiple roles — effective permissions = union of all.
 * Wildcard "*" grants all permissions; "domain:*" grants all within domain.
 */

// --- Permission Catalog ---

export const PERMISSION_CATALOG = {
  // Calls
  'calls:answer': 'Answer incoming calls',
  'calls:read-active': 'See active calls (caller info redacted)',
  'calls:read-active-full': 'See active calls with full caller info',
  'calls:read-history': 'View call history',
  'calls:read-presence': 'View volunteer presence',
  'calls:read-recording': 'Listen to call recordings',
  'calls:hangup': 'Hang up an active call',
  'calls:report-spam': 'Report a call as spam',
  'calls:identify-caller': 'Identify caller by hash (screen pop)',
  'calls:debug': 'Debug call state',

  // Notes
  'notes:create': 'Create call notes',
  'notes:read-own': 'Read own notes',
  'notes:read-all': 'Read all notes',
  'notes:read-assigned': 'Read notes from assigned volunteers',
  'notes:update-own': 'Update own notes',
  'notes:reply': 'Reply to notes',

  // Contacts
  'contacts:view': 'View contacts page and contact timelines',
  'contacts:view-history': 'View past interactions from other volunteers for a contact',
  'contacts:search': 'Search contacts directory',
  'contacts:export': 'Export contact data',

  // Reports
  'reports:create': 'Submit reports',
  'reports:read-own': 'Read own reports',
  'reports:read-all': 'Read all reports',
  'reports:read-assigned': 'Read assigned reports',
  'reports:assign': 'Assign reports to reviewers/volunteers',
  'reports:update': 'Update report status',
  'reports:read-types': 'View report type definitions',
  'reports:send-message-own': 'Send messages in own reports',
  'reports:send-message': 'Send messages in any report',

  // Conversations
  'conversations:read-assigned': 'Read assigned + waiting conversations',
  'conversations:read-all': 'Read all conversations',
  'conversations:claim': 'Claim a waiting conversation',
  'conversations:claim-sms': 'Claim SMS conversations',
  'conversations:claim-whatsapp': 'Claim WhatsApp conversations',
  'conversations:claim-signal': 'Claim Signal conversations',
  'conversations:claim-rcs': 'Claim RCS conversations',
  'conversations:claim-web': 'Claim web conversations',
  'conversations:claim-any': 'Claim any channel (bypass restrictions)',
  'conversations:send': 'Send messages in assigned conversations',
  'conversations:send-any': 'Send messages in any conversation',
  'conversations:update': 'Reassign/close/reopen conversations',

  // Users
  'users:read': 'List/view user profiles',
  'users:read-cases': 'View case records assigned to a user',
  'users:read-metrics': 'View user workload metrics',
  'users:create': 'Create new users',
  'users:update': 'Update user profiles',
  'users:delete': 'Deactivate/delete users',
  'users:manage-roles': 'Assign/change user roles',
  'users:manage-devices': 'View and manage user devices (admin device oversight, SAS verification)',

  // Shifts
  'shifts:read-own': 'Check own shift status',
  'shifts:read': 'View all shifts',
  'shifts:create': 'Create shifts',
  'shifts:update': 'Modify shifts',
  'shifts:delete': 'Delete shifts',
  'shifts:manage-fallback': 'Manage fallback ring group',
  'shifts:manage-overrides': 'Manage shift overrides',
  'shifts:manage-ring-groups': 'Manage ring groups and membership',
  'shifts:approve-requests': 'Approve/deny shift join/leave requests',
  'shifts:request-join': 'Submit shift join/leave requests',
  'shifts:set-availability': 'Set own availability blocks',

  // Bans
  'bans:report': 'Report/flag a number',
  'bans:read': 'View ban list',
  'bans:create': 'Ban numbers',
  'bans:bulk-create': 'Bulk ban import',
  'bans:delete': 'Remove bans',

  // Invites
  'invites:read': 'View pending invites',
  'invites:create': 'Create invite codes',
  'invites:revoke': 'Revoke invite codes',

  // Settings
  'settings:read': 'View settings',
  'settings:manage': 'Cleanup metrics and admin-only operations',
  'settings:manage-telephony': 'Modify telephony provider',
  'settings:manage-messaging': 'Modify messaging channels',
  'settings:manage-spam': 'Modify spam settings',
  'settings:manage-ivr': 'Modify IVR/language settings',
  'settings:manage-fields': 'Modify custom fields',
  'settings:manage-transcription': 'Modify transcription settings',
  'settings:manage-calls': 'Modify call timeout and voicemail length',
  'settings:manage-webauthn': 'Modify WebAuthn settings',
  'settings:manage-setup': 'Setup wizard access',
  'settings:manage-ttl': 'Modify TTL/cleanup intervals',
  'settings:manage-cms': 'Toggle case management feature',

  // Audit
  'audit:read': 'View audit log',

  // Blasts (future — Epic 62)
  'blasts:read': 'View blast history',
  'blasts:send': 'Send blasts',
  'blasts:manage': 'Manage subscriber lists and templates',
  'blasts:schedule': 'Schedule future blasts',

  // Files
  'files:upload': 'Upload files',
  'files:download-own': 'Download own/authorized files',
  'files:download-all': 'Download any file',
  'files:manage-all': 'Manage any file (admin upload/status override)',
  'files:share': 'Re-encrypt/share files with others',

  // Cases / Records (CMS)
  'cases:create': 'Create new cases/records',
  'cases:read-own': 'Read records assigned to self',
  'cases:read-assigned': 'Read records assigned to self or team',
  'cases:read-all': 'Read all records in hub',
  'cases:update-own': 'Update records assigned to self',
  'cases:update': 'Update any record',
  'cases:close': 'Close/resolve records',
  'cases:delete': 'Delete records',
  'cases:assign': 'Assign records to volunteers',
  'cases:link': 'Link records to reports/events/contacts',
  'cases:unlink': 'Unlink records from reports/events/contacts',
  'cases:manage': 'Configure auto-assignment settings',
  'cases:manage-types': 'Create/edit entity type definitions',
  'cases:import': 'Bulk import records',
  'cases:export': 'Bulk export records',

  // Contacts — CMS (extends existing contacts:view, contacts:view-history)
  'contacts:create': 'Create new contacts',
  'contacts:edit': 'Edit contact profiles',
  'contacts:delete': 'Delete contacts',
  'contacts:merge': 'Merge duplicate contacts',
  'contacts:view-pii': 'View contact PII (name, phone, demographics)',
  'contacts:manage-relationships': 'Manage contact relationships',
  'contacts:manage-groups': 'Manage affinity groups',

  // Events (CMS)
  'events:create': 'Create events',
  'events:read': 'View events',
  'events:update': 'Update events',
  'events:delete': 'Delete events',
  'events:link': 'Link events to records/reports',

  // Evidence (CMS)
  'evidence:upload': 'Upload evidence files to records',
  'evidence:download': 'Download evidence from records',
  'evidence:manage-custody': 'Manage chain of custody records',
  'evidence:delete': 'Delete evidence files',

  // Hubs
  'hubs:read': 'View hub list and details',
  'hubs:manage-members': 'Add/remove members from hubs',
  'hubs:manage-keys': 'Manage hub key envelopes',

  // Firehose
  'firehose:read': 'View firehose connections and status',
  'firehose:manage': 'Create/update/delete firehose connections',

  // Metrics
  'metrics:read': 'View system metrics (Prometheus, JSON)',

  // Telephony
  'telephony:manage-providers': 'Configure telephony providers',
  'telephony:view-providers': 'View telephony provider configuration',
  'telephony:manage-numbers': 'Provision and manage phone numbers',
  'telephony:view-numbers': 'View owned phone numbers',
  'telephony:manage-a2p': 'Manage A2P 10DLC registration',

  // Messaging
  'messaging:manage-signal': 'Manage Signal bridge registration',

  // Hub Configuration
  'hubs:configure': 'Configure hub provisioning and setup wizard',

  // Teams
  'teams:read': 'View teams and membership',
  'teams:manage': 'Create, edit, delete teams and manage membership',

  // Tags
  'tags:view': 'View tags in picker and on contacts',
  'tags:create': 'Create new tags (inline or via admin UI)',
  'tags:manage': 'Edit and delete existing tags',

  // System (super-admin only)
  'system:view-roles': 'View role definitions',
  'system:manage-roles': 'Create/edit/delete custom roles',
  'system:manage-hubs': 'Create/manage hubs',
  'system:create-hub': 'Create new hubs (self-serve hub creation)',
  'system:manage-instance': 'Instance-level settings',

  // Erasure (EP08)
  'erasure:request-self': 'Request own account erasure',
  'erasure:admin': 'Manage erasure queue, execute immediate erasure, trigger remote wipe',

  // Retention (EP08)
  'retention:manage': 'Configure hub-level data retention periods',

  // Bans — platform scope (EP08, extends existing bans domain)
  'bans:read-platform': 'View bans across all hubs',
  'bans:create-platform': 'Create bans that apply across all hubs',
  'bans:delete-platform': 'Remove platform-scoped bans',

  // System (new — platform nav gating)
  'system:view-platform': 'View platform settings',
  'system:view-bans': 'View platform-wide ban list',
  'system:view-audit': 'View platform-wide audit log',
  'system:view-analytics': 'View platform-wide analytics',
  'system:view-health': 'View platform health status',
} as const

export type Permission = keyof typeof PERMISSION_CATALOG

/** Human-readable labels for permission domains, used in the permission picker UI. */
/** Permission group domain keys. Display labels live in i18n at permissions.groups.* */
export const PERMISSION_GROUP_DOMAINS = [
  'audit', 'bans', 'blasts', 'calls', 'cases', 'contacts', 'conversations',
  'erasure', 'events', 'evidence', 'files', 'firehose', 'hubs', 'invites', 'messaging',
  'metrics', 'notes', 'reports', 'retention', 'settings', 'shifts', 'system', 'tags', 'teams', 'telephony', 'users',
] as const

/** All permission domains (first part before the colon) */
export type PermissionDomain = Permission extends `${infer D}:${string}` ? D : never

/** Group permissions by domain for the role editor UI */
export function getPermissionsByDomain(): Record<string, { key: Permission; label: string }[]> {
  const result: Record<string, { key: Permission; label: string }[]> = {}
  for (const [key, label] of Object.entries(PERMISSION_CATALOG)) {
    const domain = key.split(':')[0]
    if (!result[domain]) result[domain] = []
    result[domain].push({ key: key as Permission, label })
  }
  return result
}

// --- Role Definition ---

export interface Role {
  id: string
  /** null for non-system roles — plaintext name stored only in encrypted envelopes */
  name: string | null
  slug: string
  permissions: string[]
  isDefault: boolean   // ships with system
  isSystem: boolean    // can't be modified at all (super-admin)
  description: string
  encryptedName?: string | null
  encryptedDescription?: string | null
  envelopes?: Array<{ adminPubkey: string; encryptedName: string; encryptedDescription: string }>
  assignedUserCount?: number
  createdAt: string
  updatedAt: string
}

// --- Default Role Definitions ---

export const DEFAULT_ROLES: Omit<Role, 'createdAt' | 'updatedAt'>[] = [
  {
    id: 'role-super-admin',
    name: 'Super Admin',
    slug: 'super-admin',
    permissions: ['*'],
    isDefault: true,
    isSystem: true,
    description: 'Full system access — creates hubs, manages all settings and users',
  },
  {
    id: 'role-hub-admin',
    name: 'Hub Admin',
    slug: 'hub-admin',
    permissions: [
      'users:*', 'shifts:*', 'settings:*', 'audit:read',
      'bans:*', 'invites:*', 'notes:*',
      'reports:*', 'conversations:*', 'calls:*', 'blasts:*', 'files:*',
      'contacts:*', 'cases:*', 'events:*', 'evidence:*',
      'firehose:*',
      'telephony:manage-providers', 'telephony:view-providers', 'telephony:manage-numbers', 'telephony:view-numbers', 'telephony:manage-a2p',
      'messaging:manage-signal',
      'hubs:configure',
      'hubs:read', 'hubs:manage-members', 'hubs:manage-keys',
      'teams:*', 'tags:*',
      'metrics:read', 'system:view-roles',
      'erasure:*', 'retention:manage',
      'bans:read-platform', 'bans:create-platform', 'bans:delete-platform',
    ],
    isDefault: true,
    isSystem: false,
    description: 'Full control within assigned hub(s) — manages volunteers, shifts, settings, cases',
  },
  {
    id: 'role-reviewer',
    name: 'Reviewer',
    slug: 'reviewer',
    permissions: [
      'calls:identify-caller',
      'notes:read-own', 'notes:read-assigned', 'notes:reply',
      'contacts:view-pii', 'contacts:view-history', 'contacts:search',
      'reports:read-assigned', 'reports:read-all', 'reports:read-types',
      'reports:assign', 'reports:update', 'reports:send-message',
      'conversations:read-assigned', 'conversations:send',
      'users:read-cases', 'users:read-metrics',
      'shifts:read-own', 'files:download-own', 'files:upload',
      'settings:read',
      'cases:read-assigned', 'cases:update', 'cases:assign', 'cases:link', 'cases:unlink',
      'events:read', 'events:link', 'evidence:download',
      'hubs:read',
      'teams:read', 'tags:view',
    ],
    isDefault: true,
    isSystem: false,
    description: 'Reviews notes, reports, and cases from assigned volunteers or shifts',
  },
  {
    id: 'role-volunteer',
    name: 'Volunteer',
    slug: 'volunteer',
    permissions: [
      'calls:answer', 'calls:read-active', 'calls:hangup', 'calls:report-spam',
      'calls:identify-caller',
      'notes:create', 'notes:read-own', 'notes:update-own', 'notes:reply',
      'contacts:search',
      'conversations:claim', 'conversations:send', 'conversations:read-assigned',
      'conversations:claim-sms', 'conversations:claim-whatsapp',
      'conversations:claim-signal', 'conversations:claim-rcs', 'conversations:claim-web',
      // Self-service availability: a volunteer sets their OWN shift availability
      // and clocks in. `POST /shifts/clock-in` is requirePermission('shifts:set-availability')
      // (apps/worker/routes/shifts.ts). Without it the client shows the control and the
      // server 403s — #1342. #1406 made exactly this grant to every call-answering hub
      // TEMPLATE role; this is the same decision for the global default role, which that
      // PR did not touch.
      'shifts:read-own', 'shifts:set-availability', 'bans:report',
      'reports:read-assigned', 'reports:read-types', 'reports:send-message',
      'settings:read',
      'files:upload', 'files:download-own',
      'cases:create', 'cases:read-own', 'cases:update-own',
      'events:read', 'evidence:upload',
      'hubs:read',
      'erasure:request-self',
      'teams:read', 'tags:view',
    ],
    isDefault: true,
    isSystem: false,
    description: 'Answers calls, writes notes, handles conversations and assigned cases',
  },
  {
    id: 'role-reporter',
    name: 'Reporter',
    slug: 'reporter',
    permissions: [
      'reports:create', 'reports:read-own', 'reports:read-types', 'reports:send-message-own',
      'files:upload', 'files:download-own',
    ],
    isDefault: true,
    isSystem: false,
    description: 'Submits reports and tracks their own submissions',
  },
]

// --- Permission Resolution ---

/**
 * Check if a set of permissions grants a specific permission.
 * Supports exact match, domain wildcards (e.g. "calls:*"), and global wildcard "*".
 */
export function permissionGranted(grantedPermissions: string[], required: string): boolean {
  // Global wildcard
  if (grantedPermissions.includes('*')) return true
  // Exact match
  if (grantedPermissions.includes(required)) return true
  // Domain wildcard (e.g. "calls:*" matches "calls:answer")
  const domain = required.split(':')[0]
  if (grantedPermissions.includes(`${domain}:*`)) return true
  return false
}

/**
 * Resolve effective permissions from multiple role IDs.
 * Returns the union of all permissions from all roles.
 *
 * Falls back to DEFAULT_ROLES for system role IDs not found in the provided
 * role definitions. This prevents a window during settings.reset() where the
 * roles table is empty — without this fallback, even role-super-admin resolves
 * to zero permissions, causing 403 on every hub-scoped request.
 */
export function resolvePermissions(roleIds: string[], roles: Role[]): string[] {
  const perms = new Set<string>()
  for (const roleId of roleIds) {
    const role = roles.find(r => r.id === roleId)
      ?? DEFAULT_ROLES.find(r => r.id === roleId)
    if (role) {
      for (const p of role.permissions) perms.add(p)
    }
  }
  return Array.from(perms)
}

/**
 * Check if a user with given role IDs has a specific permission.
 */
export function hasPermission(roleIds: string[], roles: Role[], permission: string): boolean {
  const perms = resolvePermissions(roleIds, roles)
  return permissionGranted(perms, permission)
}

/**
 * Get the "primary" role for display purposes — the highest-privilege role.
 * Order: super-admin > hub-admin > reviewer > volunteer > reporter > custom
 */
const ROLE_PRIORITY: Record<string, number> = {
  'role-super-admin': 0,
  'role-hub-admin': 1,
  'role-reviewer': 2,
  'role-volunteer': 3,
  'role-reporter': 4,
}

export function getPrimaryRole(roleIds: string[], roles: Role[]): Role | undefined {
  const userRoles = roleIds
    .map(id => roles.find(r => r.id === id))
    .filter((r): r is Role => !!r)
    .sort((a, b) => {
      const pa = ROLE_PRIORITY[a.id] ?? 99
      const pb = ROLE_PRIORITY[b.id] ?? 99
      return pa - pb
    })
  return userRoles[0]
}

// --- Hub-Scoped Permission Resolution ---

/**
 * Check if a user has a specific permission within a hub.
 * Super-admin (global '*' permission) bypasses hub checks.
 * Otherwise, checks hub-specific role assignments.
 */
export function hasHubPermission(
  globalRoles: string[],
  hubRoles: { hubId: string; roleIds: string[] }[],
  allRoleDefs: Role[],
  hubId: string,
  permission: string,
): boolean {
  // Super-admin bypasses all hub checks
  const globalPerms = resolvePermissions(globalRoles, allRoleDefs)
  if (permissionGranted(globalPerms, permission)) return true

  // Check hub-specific roles
  const assignment = hubRoles.find(hr => hr.hubId === hubId)
  if (!assignment) return false

  const hubPerms = resolvePermissions(assignment.roleIds, allRoleDefs)
  return permissionGranted(hubPerms, permission)
}

/**
 * Resolve all effective permissions for a user within a specific hub.
 * Includes global permissions (from globalRoles) plus hub-specific permissions.
 */
export function resolveHubPermissions(
  globalRoles: string[],
  hubRoles: { hubId: string; roleIds: string[] }[],
  allRoleDefs: Role[],
  hubId: string,
): string[] {
  const perms = new Set<string>()
  // Global permissions always apply
  for (const p of resolvePermissions(globalRoles, allRoleDefs)) {
    perms.add(p)
  }
  // Hub-specific permissions
  const assignment = hubRoles.find(hr => hr.hubId === hubId)
  if (assignment) {
    for (const p of resolvePermissions(assignment.roleIds, allRoleDefs)) {
      perms.add(p)
    }
  }
  return Array.from(perms)
}

/**
 * Get all hub IDs a user has access to (any role assignment).
 * Super-admin has access to all hubs (returns null = all).
 */
export function getUserHubIds(
  globalRoles: string[],
  hubRoles: { hubId: string; roleIds: string[] }[],
  allRoleDefs: Role[],
): string[] | null {
  const globalPerms = resolvePermissions(globalRoles, allRoleDefs)
  if (permissionGranted(globalPerms, '*')) return null // all hubs
  return hubRoles.map(hr => hr.hubId)
}

// --- Channel Permission Helpers ---

/** Map of channel types to their claim permission */
export const CHANNEL_CLAIM_PERMISSIONS: Record<string, string> = {
  sms: 'conversations:claim-sms',
  whatsapp: 'conversations:claim-whatsapp',
  signal: 'conversations:claim-signal',
  rcs: 'conversations:claim-rcs',
  web: 'conversations:claim-web',
}

/**
 * Check if a user can claim conversations on a specific channel.
 * Returns true if user has:
 * - Global wildcard (*)
 * - conversations:* wildcard
 * - conversations:claim-any (bypass channel restrictions)
 * - The specific channel claim permission (e.g., conversations:claim-sms)
 */
// --- Permission Group Labels (for role editor UI) ---

export const PERMISSION_GROUP_LABELS: Record<string, string> = {
  calls: 'Calls',
  notes: 'Notes',
  contacts: 'Contacts',
  reports: 'Reports',
  conversations: 'Conversations',
  users: 'Users',
  shifts: 'Shifts',
  bans: 'Bans',
  invites: 'Invites',
  settings: 'Settings',
  audit: 'Audit',
  blasts: 'Blasts',
  files: 'Files',
  cases: 'Cases',
  events: 'Events',
  evidence: 'Evidence',
  hubs: 'Hubs',
  firehose: 'Firehose',
  metrics: 'Metrics',
  telephony: 'Telephony',
  messaging: 'Messaging',
  system: 'System',
  teams: 'Teams',
  tags: 'Tags',
  erasure: 'Erasure',
  retention: 'Retention',
}

// --- Permission Validation ---

/**
 * Check if a permission string exists in the PERMISSION_CATALOG.
 * Accepts exact permissions and domain wildcards (e.g. "cases:*").
 */
export function isValidPermission(perm: string): boolean {
  // Global wildcard
  if (perm === '*') return true
  // Domain wildcard (e.g. "cases:*")
  if (perm.endsWith(':*')) {
    const domain = perm.slice(0, -2)
    return Object.keys(PERMISSION_CATALOG).some(k => k.startsWith(`${domain}:`))
  }
  // Exact match
  return perm in PERMISSION_CATALOG
}

export function canClaimChannel(permissions: string[], channelType: string): boolean {
  // Global or domain wildcard
  if (permissionGranted(permissions, 'conversations:claim-any')) return true

  // Check specific channel permission
  const channelPerm = CHANNEL_CLAIM_PERMISSIONS[channelType]
  if (channelPerm && permissionGranted(permissions, channelPerm)) return true

  return false
}

/**
 * Get the list of channels a user can claim based on their permissions.
 */
export function getClaimableChannels(permissions: string[]): string[] {
  // If has claim-any, return all channels
  if (permissionGranted(permissions, 'conversations:claim-any')) {
    return Object.keys(CHANNEL_CLAIM_PERMISSIONS)
  }

  // Filter to channels they have specific permissions for
  return Object.entries(CHANNEL_CLAIM_PERMISSIONS)
    .filter(([, perm]) => permissionGranted(permissions, perm))
    .map(([channel]) => channel)
}
