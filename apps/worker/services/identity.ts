/**
 * IdentityService — replaces IdentityDO.
 *
 * Manages volunteers, sessions, invite codes, WebAuthn credentials/challenges,
 * devices, provisioning rooms, hub roles, and admin bootstrap.
 * All state is stored in PostgreSQL via Drizzle ORM.
 */
import { eq, and, lt, sql, inArray, type SQL } from 'drizzle-orm'
import { timingSafeCompare } from '../lib/timing-safe'
import type { Database } from '../db'
import {
  users,
  roles as roleDefinitions,
  sessions,
  inviteCodes,
  webauthnCredentials,
  webauthnChallenges,
  devices,
  provisionRooms,
  systemSettings,
  securityEvents,
  deviceVerifications,
  sigchainLinks,
  authNonces,
} from '../db/schema'
import type {
  User,
  InviteCode,
  WebAuthnCredential,
  WebAuthnSettings,
  ServerSession,
  DeviceRecord,
} from '../types'
import { ServiceError } from './settings'
import type { DemoIdentity } from '../lib/demo-identities'
import { isRevokedSigningKey } from '../lib/revoked-signing-keys'
import { createLogger } from '../lib/logger'
import { withRetry, isRetryableDbError } from '../lib/retry'
import { getCircuitBreaker } from '../lib/circuit-breaker'

const log = createLogger('services.identity')

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

import {
  SESSION_DURATION_MS,
  RENEWAL_THRESHOLD_MS,
  decideSessionRenewal,
} from '../lib/session-renewal'
import { decideDeviceRegistration } from '../lib/device-eviction'
import { resolveHpkeRecipients } from './reader-keys'
const INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const CHALLENGE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const PROVISION_ROOM_TTL_MS = 5 * 60 * 1000 // 5 minutes

/** Fields a non-admin volunteer may self-update */
const VOLUNTEER_SAFE_FIELDS = new Set([
  'name', 'phone', 'spokenLanguages', 'uiLanguage', 'profileCompleted',
  'transcriptionEnabled', 'onBreak', 'callPreference',
  'specializations', // Epic 340: volunteers can self-update specializations
])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// isDuplicateKeyError imported from shared utility
import { isDuplicateKeyError } from '../lib/db-errors'

/** Generate a cryptographically random hex token of `bytes` length */
function randomHexToken(bytes: number): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Map a DB volunteer row to the legacy User interface shape */
function rowToUser(row: typeof users.$inferSelect): User {
  return {
    pubkey: row.pubkey,
    name: row.displayName ?? '',
    phone: row.phone ?? '',
    roles: row.roles,
    hubRoles: (row.hubRoles as User['hubRoles']) ?? [],
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    encryptedSecretKey: row.encryptedSecretKey ?? '',
    transcriptionEnabled: row.transcriptionEnabled ?? true,
    spokenLanguages: row.spokenLanguages ?? [],
    uiLanguage: row.uiLanguage ?? 'en',
    profileCompleted: row.profileCompleted ?? false,
    onBreak: row.onBreak ?? false,
    callPreference: (row.callPreference as User['callPreference']) ?? 'phone',
    supportedMessagingChannels: (row.supportedMessagingChannels as User['supportedMessagingChannels']),
    messagingEnabled: row.messagingEnabled ?? undefined,
    specializations: row.specializations ?? [],
    maxCaseAssignments: row.maxCaseAssignments ?? undefined,
    teamId: row.teamId ?? undefined,
    supervisorPubkey: row.supervisorPubkey ?? undefined,
  }
}

/** The user row created for a configured (ADMIN_PUBKEY) platform admin */
function platformAdminRow(pubkey: string): typeof users.$inferInsert {
  return {
    pubkey,
    displayName: 'Admin',
    phone: '',
    roles: ['role-super-admin'],
    active: true,
    encryptedSecretKey: '',
    transcriptionEnabled: true,
    spokenLanguages: ['en', 'es'],
    uiLanguage: 'en',
    profileCompleted: true,
    onBreak: false,
    callPreference: 'phone',
  }
}

/** Strip encryptedSecretKey from volunteer for external responses */
function sanitizeUser(vol: User): Omit<User, 'encryptedSecretKey'> & { encryptedSecretKey?: undefined } {
  return { ...vol, encryptedSecretKey: undefined }
}

/**
 * SQL predicate: the user is a member of `hubId`. A user can belong to several
 * hubs at once, so this matches any `hub_roles` entry for the hub. Super-admins
 * (a global role granting `*`) reach every hub through hubContext, so they count
 * as members of each; role-super-admin is also matched by id because
 * resolvePermissions falls back to DEFAULT_ROLES when the roles table lacks it.
 */
function hubMember(hubId: string): SQL {
  return sql`(
    ${users.hubRoles} @> jsonb_build_array(jsonb_build_object('hubId', ${hubId}::text))
    OR ${users.roles} @> ARRAY['role-super-admin']::text[]
    OR EXISTS (
      SELECT 1 FROM ${roleDefinitions}
      WHERE ${roleDefinitions.id} = ANY(${users.roles})
        AND ${roleDefinitions.permissions} @> ARRAY['*']::text[]
    )
  )`
}

/** A user as seen from inside one hub: their role assignments in other hubs are not its business */
function scopeToHub(user: User, hubId: string | undefined): User {
  if (!hubId) return user
  return { ...user, hubRoles: (user.hubRoles ?? []).filter(hr => hr.hubId === hubId) }
}

/** Map a DB invite row to InviteCode interface */
function rowToInvite(row: typeof inviteCodes.$inferSelect): InviteCode {
  return {
    code: row.code,
    name: row.name,
    phone: row.phone,
    roleIds: row.roleIds,
    createdBy: row.createdBy ?? '',
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    usedAt: row.usedAt?.toISOString(),
    usedBy: row.usedBy ?? undefined,
  }
}

/** Map a DB session row to ServerSession interface */
function rowToSession(row: typeof sessions.$inferSelect): ServerSession {
  return {
    token: row.token,
    pubkey: row.pubkey,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  }
}

/** Map a DB webauthn credential row to WebAuthnCredential interface */
function rowToWebAuthnCredential(row: typeof webauthnCredentials.$inferSelect): WebAuthnCredential {
  return {
    id: row.credentialId,
    publicKey: row.publicKey,
    counter: row.counter,
    transports: row.transports ?? [],
    backedUp: row.backedUp ?? false,
    label: row.label,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? '',
  }
}

/** Map a DB device row to DeviceRecord interface */
function rowToDevice(row: typeof devices.$inferSelect): DeviceRecord {
  return {
    platform: row.platform as DeviceRecord['platform'],
    pushToken: row.pushToken ?? '',
    wakeKeyPublic: row.wakeKeyPublic ?? '',
    registeredAt: row.registeredAt.toISOString(),
    lastSeenAt: row.lastSeenAt?.toISOString() ?? row.registeredAt.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class IdentityService {
  /**
   * @param adminPubkey The platform admin configured via ADMIN_PUBKEY. This user
   *   is the root of trust for the deployment and must always hold
   *   role-super-admin — see `enforceAdminRoles`.
   */
  constructor(protected db: Database, protected adminPubkey?: string) {}

  /**
   * Enforce the platform-admin invariant: the user identified by ADMIN_PUBKEY
   * always holds role-super-admin.
   *
   * Any write path that can assign roles (createUser, updateUser, invite
   * redemption) must funnel role arrays through this. Without it, a user row
   * for the configured admin can be (re-)created with the default
   * `role-volunteer` — for example when a request races a database reset that
   * has momentarily deleted the row — and the deployment is left with no admin.
   * The scattered per-route "restore the admin" patches only papered over
   * individual paths; this closes the class at the data layer.
   */
  protected enforceAdminRoles(pubkey: string, roles: string[]): string[] {
    if (!this.adminPubkey || pubkey !== this.adminPubkey) return roles
    if (roles.includes('role-super-admin')) return roles
    log.warn('Refusing to demote the configured platform admin', {
      pubkeyPrefix: pubkey.slice(0, 8),
      attemptedRoles: roles,
    })
    return ['role-super-admin']
  }

  // =========================================================================
  // Admin Bootstrap & Init
  // =========================================================================

  /**
   * Check whether any active super-admin volunteer exists.
   *
   * Counts rows under revoked signing keys too: treating them as absent would
   * reopen first-admin bootstrap to anyone on a deployment whose only admin
   * row is revoked.
   */
  async hasAdmin(): Promise<{ hasAdmin: boolean }> {
    const rows = await this.db
      .select({ pubkey: users.pubkey })
      .from(users)
      .where(
        and(
          eq(users.active, true),
          sql`${users.roles} @> ARRAY['role-super-admin']::text[]`,
        ),
      )
      .limit(1)
    return { hasAdmin: rows.length > 0 }
  }

  /**
   * Pubkeys of all active super-admins — recipients of client-reported
   * security alerts (e.g. certificate pin mismatches).
   */
  async listActiveSuperAdminPubkeys(): Promise<string[]> {
    const rows = await this.db
      .select({ pubkey: users.pubkey })
      .from(users)
      .where(
        and(
          eq(users.active, true),
          sql`${users.roles} @> ARRAY['role-super-admin']::text[]`,
        ),
      )
    return rows.map((r) => r.pubkey).filter(pubkey => !isRevokedSigningKey(pubkey))
  }

  /**
   * Bootstrap the first admin. Fails if an admin already exists.
   */
  async bootstrapAdmin(pubkey: string): Promise<void> {
    const { hasAdmin } = await this.hasAdmin()
    if (hasAdmin) throw new ServiceError(403, 'Admin already exists')

    // Use onConflictDoUpdate instead of onConflictDoNothing:
    // If the user row already exists with role-volunteer (e.g. race between
    // test-reset and concurrent requests), onConflictDoNothing silently skips
    // the insert, leaving the user with the wrong role. onConflictDoUpdate
    // guarantees the admin always ends up with role-super-admin.
    await this.db.insert(users).values({
      pubkey,
      displayName: 'Admin',
      phone: '',
      roles: ['role-super-admin'],
      active: true,
      encryptedSecretKey: '',
      transcriptionEnabled: true,
      spokenLanguages: ['en', 'es'],
      uiLanguage: 'en',
      profileCompleted: false,
      onBreak: false,
      callPreference: 'phone',
    }).onConflictDoUpdate({
      target: users.pubkey,
      set: {
        roles: ['role-super-admin'],
        active: true,
      },
    })
  }

  /**
   * Seed (or restore) the given admin as an active super-admin. Used by the
   * dev and demo resets; server startup uses ensurePlatformAdmin, which does
   * not overwrite an existing row.
   */
  async ensureInit(adminPubkey?: string): Promise<void> {
    if (!adminPubkey) return
    // Use onConflictDoUpdate to ensure admin always has role-super-admin.
    // A race condition in test-add-hub-member can create the admin user
    // with role-volunteer; this corrects that on the next ensureInit call
    // (e.g., during test-reset).
    await this.db.insert(users).values(platformAdminRow(adminPubkey)).onConflictDoUpdate({
      target: users.pubkey,
      set: {
        roles: ['role-super-admin'],
        active: true,
      },
    })
  }

  /**
   * Register the demo accounts. The identities can only come from
   * `demoIdentities(env)`, which refuses anywhere but a development server.
   */
  async ensureDemoAccounts(identities: readonly DemoIdentity[]): Promise<void> {
    for (const account of identities) {
      await this.db.insert(users).values({
        pubkey: account.pubkey,
        displayName: account.name,
        phone: account.phone,
        roles: account.roleIds,
        active: account.name !== 'Fatima Al-Rashid',
        encryptedSecretKey: '',
        transcriptionEnabled: true,
        spokenLanguages: account.spokenLanguages,
        uiLanguage: 'en',
        profileCompleted: true,
        onBreak: false,
        callPreference: 'phone',
      }).onConflictDoNothing()
    }
  }

  /**
   * Server-startup initialisation of the ADMIN_PUBKEY platform admin. Runs on
   * every boot, so unlike `ensureInit` it never overwrites an existing row: it
   * creates the admin when missing and otherwise only restores the
   * `enforceAdminRoles` invariant — appending role-super-admin if the row lacks
   * it, keeping any other roles. `active` is left alone, so an admin who
   * deliberately deactivated the configured admin is not overruled by a restart.
   */
  async ensurePlatformAdmin(): Promise<void> {
    if (!this.adminPubkey) return
    await this.db.insert(users).values(platformAdminRow(this.adminPubkey)).onConflictDoUpdate({
      target: users.pubkey,
      set: {
        roles: sql`array_append(${users.roles}, 'role-super-admin')`,
        updatedAt: new Date(),
      },
      setWhere: sql`NOT (${users.roles} @> ARRAY['role-super-admin']::text[])`,
    })
  }

  // =========================================================================
  // User CRUD
  // =========================================================================

  /**
   * List users (encryptedSecretKey stripped). Users under revoked signing
   * keys are not members of anything — never listed, never an envelope recipient.
   *
   * With a hubId: only that hub's members (see `hubMember`), each showing only
   * their role assignment in that hub. Without one: every user on the instance.
   */
  async getUsers(hubId?: string): Promise<{ users: ReturnType<typeof sanitizeUser>[] }> {
    const rows = hubId
      ? await this.db.select().from(users).where(hubMember(hubId))
      : await this.db.select().from(users)
    return {
      users: rows
        .filter(r => !isRevokedSigningKey(r.pubkey))
        .map(r => sanitizeUser(scopeToHub(rowToUser(r), hubId))),
    }
  }

  /**
   * Get a single volunteer by pubkey. With a hubId, 404 unless they are a
   * member of that hub, and only their role assignment in it.
   */
  async getUser(pubkey: string, hubId?: string): Promise<ReturnType<typeof sanitizeUser>> {
    const rows = await this.db
      .select()
      .from(users)
      .where(and(eq(users.pubkey, pubkey), hubId ? hubMember(hubId) : undefined))
      .limit(1)
    if (rows.length === 0) throw new ServiceError(404, 'Not found')
    return sanitizeUser(scopeToHub(rowToUser(rows[0]), hubId))
  }

  /**
   * Get a volunteer's full record (including encryptedSecretKey) — internal use only.
   * Every authority decision resolves the acting key here, so a revoked signing
   * key resolves to no user at all.
   */
  async getUserInternal(pubkey: string): Promise<User | null> {
    if (isRevokedSigningKey(pubkey)) return null
    const rows = await this.db
      .select()
      .from(users)
      .where(eq(users.pubkey, pubkey))
      .limit(1)
    return rows.length > 0 ? rowToUser(rows[0]) : null
  }

  /**
   * Create a new volunteer. With a hubId, they are created as a member of that
   * hub, holding the same roles there.
   */
  async createUser(data: {
    pubkey: string
    name: string
    phone: string
    roleIds?: string[]
    roles?: string[]
    encryptedSecretKey: string
    specializations?: string[]
    maxCaseAssignments?: number
    supervisorPubkey?: string
    hubId?: string
  }): Promise<{ volunteer: ReturnType<typeof sanitizeUser> }> {
    if (isRevokedSigningKey(data.pubkey)) throw new ServiceError(400, 'This signing key is revoked')
    const roles = this.enforceAdminRoles(data.pubkey, data.roleIds ?? data.roles ?? ['role-volunteer'])
    const [row] = await this.db.insert(users).values({
      pubkey: data.pubkey,
      displayName: data.name,
      phone: data.phone,
      roles,
      ...(data.hubId && { hubRoles: [{ hubId: data.hubId, roleIds: roles }] }),
      active: true,
      encryptedSecretKey: data.encryptedSecretKey,
      transcriptionEnabled: true,
      spokenLanguages: ['en'],
      uiLanguage: 'en',
      profileCompleted: false,
      onBreak: false,
      callPreference: 'phone',
      specializations: data.specializations ?? [],
      maxCaseAssignments: data.maxCaseAssignments,
      supervisorPubkey: data.supervisorPubkey,
    }).returning()

    return { volunteer: sanitizeUser(rowToUser(row)) }
  }

  /**
   * Update a volunteer's fields. Non-admin callers are restricted to safe fields.
   * With a hubId, the returned volunteer shows only their role assignment in it.
   */
  async updateUser(
    pubkey: string,
    data: Partial<User>,
    isAdmin: boolean,
    hubId?: string,
  ): Promise<{ volunteer: ReturnType<typeof sanitizeUser> }> {
    // RACE-11: Removed redundant SELECT — the UPDATE...RETURNING below handles
    // the "not found" case. The old SELECT was a read-before-write pattern that
    // added latency without value.

    // Build update payload — map User fields to DB columns
    const updates: Partial<typeof users.$inferInsert> = {}

    const applyField = (key: string, value: unknown) => {
      switch (key) {
        case 'name': updates.displayName = value as string; break
        case 'phone': updates.phone = value as string; break
        case 'roles': updates.roles = this.enforceAdminRoles(pubkey, value as string[]); break
        case 'active': updates.active = value as boolean; break
        case 'encryptedSecretKey': updates.encryptedSecretKey = value as string; break
        case 'transcriptionEnabled': updates.transcriptionEnabled = value as boolean; break
        case 'spokenLanguages': updates.spokenLanguages = value as string[]; break
        case 'uiLanguage': updates.uiLanguage = value as string; break
        case 'profileCompleted': updates.profileCompleted = value as boolean; break
        case 'onBreak': updates.onBreak = value as boolean; break
        case 'callPreference': updates.callPreference = value as string; break
        case 'hubRoles': updates.hubRoles = value; break
        case 'supportedMessagingChannels': updates.supportedMessagingChannels = value as string[]; break
        case 'messagingEnabled': updates.messagingEnabled = value as boolean; break
        case 'specializations': updates.specializations = value as string[]; break
        case 'maxCaseAssignments': updates.maxCaseAssignments = value as number; break
        case 'teamId': updates.teamId = value as string; break
        case 'supervisorPubkey': updates.supervisorPubkey = value as string; break
      }
    }

    for (const [key, value] of Object.entries(data)) {
      if (key === 'pubkey') continue // never overwrite PK
      if (key === 'active' && !isAdmin) {
        throw new ServiceError(403, 'Only admins can change user active status')
      }
      if (isAdmin || VOLUNTEER_SAFE_FIELDS.has(key)) {
        applyField(key, value)
      }
    }
    updates.updatedAt = new Date()

    const [row] = await this.db
      .update(users)
      .set(updates)
      .where(eq(users.pubkey, pubkey))
      .returning()

    if (!row) throw new ServiceError(404, 'Not found')
    return { volunteer: sanitizeUser(scopeToHub(rowToUser(row), hubId)) }
  }

  /**
   * Delete (hard-remove) a volunteer. Cascading FKs clean up sessions, creds, devices.
   */
  async deleteUser(pubkey: string): Promise<void> {
    await this.db.delete(users).where(eq(users.pubkey, pubkey))
  }

  // =========================================================================
  // Hub Role Management
  // =========================================================================

  /**
   * Set hub-specific role assignments for a volunteer.
   */
  async setHubRole(data: { pubkey: string; hubId: string; roleIds: string[] }): Promise<{ volunteer: User }> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(users)
        .where(eq(users.pubkey, data.pubkey))
        .for('update')
        .limit(1)
      if (rows.length === 0) throw new ServiceError(404, 'User not found')

      const vol = rowToUser(rows[0])
      const hubRoles = vol.hubRoles ?? []
      const idx = hubRoles.findIndex(hr => hr.hubId === data.hubId)
      if (idx >= 0) {
        hubRoles[idx].roleIds = data.roleIds
      } else {
        hubRoles.push({ hubId: data.hubId, roleIds: data.roleIds })
      }

      const [row] = await tx
        .update(users)
        .set({ hubRoles, updatedAt: new Date() })
        .where(eq(users.pubkey, data.pubkey))
        .returning()

      return { volunteer: rowToUser(row) }
    })
  }

  /**
   * Remove all hub-specific roles for a volunteer in a given hub.
   */
  async removeHubRole(data: { pubkey: string; hubId: string }): Promise<{ volunteer: User }> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(users)
        .where(eq(users.pubkey, data.pubkey))
        .for('update')
        .limit(1)
      if (rows.length === 0) throw new ServiceError(404, 'User not found')

      const vol = rowToUser(rows[0])
      const hubRoles = (vol.hubRoles ?? []).filter(hr => hr.hubId !== data.hubId)

      const [row] = await tx
        .update(users)
        .set({ hubRoles, updatedAt: new Date() })
        .where(eq(users.pubkey, data.pubkey))
        .returning()

      return { volunteer: rowToUser(row) }
    })
  }

  // =========================================================================
  // Invite Code Management
  // =========================================================================

  /**
   * List all unredeemed invites.
   */
  async getInvites(): Promise<{ invites: InviteCode[] }> {
    const rows = await this.db
      .select()
      .from(inviteCodes)
      .where(sql`${inviteCodes.usedAt} IS NULL`)
    return { invites: rows.map(rowToInvite) }
  }

  /**
   * Create a new invite code.
   */
  async createInvite(data: {
    name: string
    phone: string
    roleIds: string[]
    createdBy: string
  }): Promise<{ invite: InviteCode }> {
    const code = crypto.randomUUID()
    const now = new Date()
    const expiresAt = new Date(now.getTime() + INVITE_EXPIRY_MS)

    const [row] = await this.db.insert(inviteCodes).values({
      code,
      name: data.name,
      phone: data.phone,
      roleIds: data.roleIds || ['role-volunteer'],
      createdBy: data.createdBy,
      createdAt: now,
      expiresAt,
    }).returning()

    return { invite: rowToInvite(row) }
  }

  /**
   * Validate an invite code (check existence, usage, expiry).
   */
  async validateInvite(code: string): Promise<{
    valid: boolean
    error?: string
    name?: string
    roleIds?: string[]
  }> {
    const rows = await this.db
      .select()
      .from(inviteCodes)
      .where(eq(inviteCodes.code, code))
      .limit(1)

    if (rows.length === 0) return { valid: false, error: 'not_found' }
    const invite = rows[0]
    if (invite.usedAt) return { valid: false, error: 'already_used' }
    if (invite.expiresAt < new Date()) return { valid: false, error: 'expired' }
    return { valid: true, name: invite.name, roleIds: invite.roleIds }
  }

  /**
   * Redeem an invite code — marks it used and creates a volunteer.
   */
  async redeemInvite(data: { code: string; pubkey: string }): Promise<{
    volunteer: ReturnType<typeof sanitizeUser>
  }> {
    return this.db.transaction(async (tx) => {
      // RACE-01: Atomic claim — single UPDATE collapses read+check+write.
      // PostgreSQL's row-level lock on UPDATE ensures only one concurrent
      // redemption matches the WHERE clause.
      const [invite] = await tx
        .update(inviteCodes)
        .set({ usedAt: new Date(), usedBy: data.pubkey })
        .where(
          and(
            eq(inviteCodes.code, data.code),
            sql`${inviteCodes.usedAt} IS NULL`,
            sql`${inviteCodes.expiresAt} > NOW()`,
          ),
        )
        .returning()

      if (!invite) throw new ServiceError(400, 'Invalid, expired, or already-used invite code')

      // Create volunteer. An existing pubkey must not surface as an unhandled
      // unique-key violation (500): ON CONFLICT DO NOTHING + explicit 409. Throwing
      // rolls back the claim above, so the invite stays redeemable.
      // TODO(#1037): once invites carry a hub, merge the grant into the existing
      // user's hubRoles instead of rejecting.
      const [volRow] = await tx.insert(users).values({
        pubkey: data.pubkey,
        displayName: invite.name,
        phone: invite.phone,
        roles: this.enforceAdminRoles(
          data.pubkey,
          invite.roleIds.length > 0 ? invite.roleIds : ['role-volunteer'],
        ),
        active: true,
        encryptedSecretKey: '',
        transcriptionEnabled: true,
        spokenLanguages: ['en'],
        uiLanguage: 'en',
        profileCompleted: false,
        onBreak: false,
        callPreference: 'phone',
      }).onConflictDoNothing({ target: users.pubkey }).returning()

      if (!volRow) throw new ServiceError(409, 'A user with this key already exists')

      return { volunteer: sanitizeUser(rowToUser(volRow)) }
    })
  }

  /**
   * Revoke (delete) an invite code.
   */
  async revokeInvite(code: string): Promise<void> {
    await this.db.delete(inviteCodes).where(eq(inviteCodes.code, code))
  }

  // =========================================================================
  // Server Sessions
  // =========================================================================

  /**
   * Create a new session for a pubkey (8h expiry).
   */
  async createSession(
    pubkey: string,
    opts?: { deviceId?: string; platform?: string; userAgent?: string; ipHash?: string },
  ): Promise<ServerSession> {
    if (isRevokedSigningKey(pubkey)) throw new ServiceError(403, 'This signing key is revoked')
    const token = randomHexToken(32)
    const now = new Date()
    const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS)

    const [row] = await this.db.insert(sessions).values({
      token,
      pubkey,
      createdAt: now,
      expiresAt,
      deviceInfo: opts ? {
        deviceId: opts.deviceId ?? null,
        platform: opts.platform ?? null,
        userAgent: opts.userAgent ?? null,
        ipHash: opts.ipHash ?? null,
      } : null,
    }).returning()

    return rowToSession(row)
  }

  /**
   * Validate a session token. Implements sliding expiry: if remaining time < 1h,
   * extend to now + 8h.
   */
  async validateSession(token: string): Promise<ServerSession> {
    const rows = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.token, token))
      .limit(1)

    if (rows.length === 0) throw new ServiceError(401, 'Invalid session')
    const row = rows[0]

    // B-M15: Constant-time verification of the token after DB retrieval
    // prevents timing oracle attacks even if SQL comparison leaks timing
    if (!timingSafeCompare(row.token, token)) {
      throw new ServiceError(401, 'Invalid session')
    }

    // Checked before any renewal: a session under a revoked key is removed, never extended.
    if (isRevokedSigningKey(row.pubkey)) {
      await this.db.delete(sessions).where(eq(sessions.token, token))
      throw new ServiceError(401, 'Invalid session')
    }

    const decision = decideSessionRenewal(
      row.expiresAt,
      new Date(),
      RENEWAL_THRESHOLD_MS,
      SESSION_DURATION_MS,
      row.createdAt,
    )

    if (decision.action === 'max_lifetime_exceeded') {
      await this.db.delete(sessions).where(eq(sessions.token, token))
      throw new ServiceError(401, 'Session max lifetime exceeded')
    }

    if (decision.action === 'expired') {
      await this.db.delete(sessions).where(eq(sessions.token, token))
      throw new ServiceError(401, 'Session expired')
    }

    // RACE-06 + replay fix: Atomic renewal with token rotation.
    // Generating a new token value on each renewal limits the replay window:
    // a captured token is only valid until the next renewal event (~7h after
    // last renewal). The token field acts as a one-time-use credential per window.
    if (decision.action === 'renew') {
      const newToken = randomHexToken(32)
      const [updated] = await this.db
        .update(sessions)
        .set({ token: newToken, expiresAt: decision.newExpiresAt })
        .where(
          and(
            eq(sessions.token, token),
            sql`${sessions.expiresAt} > NOW()`,
          ),
        )
        .returning()

      if (!updated) throw new ServiceError(401, 'Session expired or revoked')
      return {
        ...rowToSession({ ...row, token: newToken }),
        expiresAt: decision.newExpiresAt.toISOString(),
        newToken,
      }
    }

    return rowToSession(row)
  }

  /**
   * Revoke a single session by token.
   */
  async revokeSession(token: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.token, token))
  }

  /**
   * Revoke all sessions for a given pubkey.
   */
  async revokeAllSessions(pubkey: string): Promise<{ revoked: number }> {
    const deleted = await this.db
      .delete(sessions)
      .where(eq(sessions.pubkey, pubkey))
      .returning({ token: sessions.token })
    return { revoked: deleted.length }
  }

  // =========================================================================
  // WebAuthn Credentials
  // =========================================================================

  /**
   * Get all WebAuthn credentials for a pubkey.
   */
  async getWebAuthnCredentials(pubkey: string): Promise<{ credentials: WebAuthnCredential[] }> {
    const rows = await this.db
      .select()
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.pubkey, pubkey))
    return { credentials: rows.map(rowToWebAuthnCredential) }
  }

  /**
   * Store a new WebAuthn credential.
   */
  async addWebAuthnCredential(pubkey: string, credential: WebAuthnCredential): Promise<void> {
    await this.db.insert(webauthnCredentials).values({
      credentialId: credential.id,
      pubkey,
      publicKey: credential.publicKey,
      counter: credential.counter,
      transports: credential.transports,
      backedUp: credential.backedUp,
      label: credential.label,
      lastUsedAt: credential.lastUsedAt ? new Date(credential.lastUsedAt) : null,
    })
  }

  /**
   * Delete a specific WebAuthn credential for a pubkey.
   */
  async deleteWebAuthnCredential(pubkey: string, credId: string): Promise<void> {
    const result = await this.db
      .delete(webauthnCredentials)
      .where(
        and(
          eq(webauthnCredentials.pubkey, pubkey),
          eq(webauthnCredentials.credentialId, credId),
        ),
      )
      .returning({ credentialId: webauthnCredentials.credentialId })

    if (result.length === 0) throw new ServiceError(404, 'Credential not found')
  }

  /**
   * Update the signature counter and lastUsedAt for a credential.
   */
  async updateWebAuthnCounter(data: {
    pubkey: string
    credId: string
    counter: number
    lastUsedAt: string
  }): Promise<void> {
    const result = await this.db
      .update(webauthnCredentials)
      .set({
        counter: data.counter,
        lastUsedAt: new Date(data.lastUsedAt),
      })
      .where(
        and(
          eq(webauthnCredentials.pubkey, data.pubkey),
          eq(webauthnCredentials.credentialId, data.credId),
        ),
      )
      .returning({ credentialId: webauthnCredentials.credentialId })

    if (result.length === 0) throw new ServiceError(404, 'Credential not found')
  }

  /**
   * Get all WebAuthn credentials across all volunteers (admin view).
   */
  async getAllWebAuthnCredentials(): Promise<{
    credentials: Array<WebAuthnCredential & { ownerPubkey: string }>
  }> {
    const rows = await this.db.select().from(webauthnCredentials)
    return {
      credentials: rows.map(r => ({
        ...rowToWebAuthnCredential(r),
        ownerPubkey: r.pubkey,
      })),
    }
  }

  // =========================================================================
  // WebAuthn Challenges
  // =========================================================================

  /**
   * Store a WebAuthn challenge (5-minute TTL, consumed on read).
   */
  async storeWebAuthnChallenge(id: string, challenge: string, pubkey?: string, allowedCredIds?: string[]): Promise<void> {
    await this.db.insert(webauthnChallenges).values({
      challengeId: id,
      challenge,
      pubkey: pubkey ?? null,
      allowedCredIds: allowedCredIds ? allowedCredIds.join(',') : null,
    })
  }

  /**
   * Retrieve and consume a WebAuthn challenge. Throws if not found or expired.
   * Returns the stored pubkey binding (if any) for caller-side verification (B-M14).
   */
  async getWebAuthnChallenge(id: string): Promise<{ challenge: string; pubkey: string | null; allowedCredIds: string[] | null }> {
    // RACE-08: Atomic consume — DELETE...RETURNING with TTL in WHERE clause.
    // Fixes two issues: (1) concurrent consume race, (2) delete-before-validate
    // bug where expired challenges were deleted then errored, wasting the entry.
    const ttlSeconds = Math.floor(CHALLENGE_TTL_MS / 1000)
    const [row] = await this.db
      .delete(webauthnChallenges)
      .where(
        and(
          eq(webauthnChallenges.challengeId, id),
          sql`${webauthnChallenges.createdAt} > NOW() - INTERVAL '${sql.raw(String(ttlSeconds))} seconds'`,
        ),
      )
      .returning()

    if (row) return {
      challenge: row.challenge,
      pubkey: row.pubkey ?? null,
      allowedCredIds: row.allowedCredIds ? row.allowedCredIds.split(',') : null,
    }

    // No row deleted — either doesn't exist or expired. Check which case
    // to return the appropriate error code (H08 error differentiation).
    const [stale] = await this.db
      .select()
      .from(webauthnChallenges)
      .where(eq(webauthnChallenges.challengeId, id))
      .limit(1)

    if (stale) {
      // Expired — clean up the stale row
      await this.db
        .delete(webauthnChallenges)
        .where(eq(webauthnChallenges.challengeId, id))
      throw new ServiceError(410, 'Challenge expired')
    }

    throw new ServiceError(404, 'Challenge not found')
  }

  // =========================================================================
  // WebAuthn Settings (stored in systemSettings table)
  // =========================================================================

  /**
   * Get WebAuthn enforcement settings.
   */
  async getWebAuthnSettings(): Promise<WebAuthnSettings> {
    const rows = await this.db
      .select({ webauthnSettings: systemSettings.webauthnSettings })
      .from(systemSettings)
      .limit(1)

    const defaults: WebAuthnSettings = { requireForAdmins: false, requireForUsers: false }
    if (rows.length === 0 || !rows[0].webauthnSettings) {
      return defaults
    }
    // DB stores {} when no settings have been explicitly set — merge with safe defaults
    return { ...defaults, ...(rows[0].webauthnSettings as Partial<WebAuthnSettings>) }
  }

  /**
   * Update WebAuthn enforcement settings.
   */
  async updateWebAuthnSettings(data: Partial<WebAuthnSettings>): Promise<WebAuthnSettings> {
    const current = await this.getWebAuthnSettings()
    const updated = { ...current, ...data }

    // Upsert into systemSettings — assumes a single row exists (created by SettingsService.ensureInit)
    await this.db
      .update(systemSettings)
      .set({ webauthnSettings: updated })

    return updated
  }

  // =========================================================================
  // Device Push Token Management (Epic 86)
  // =========================================================================

  /**
   * List all devices for a volunteer.
   */
  async getDevices(pubkey: string): Promise<{ devices: DeviceRecord[] }> {
    const rows = await this.db
      .select()
      .from(devices)
      .where(eq(devices.pubkey, pubkey))
    return { devices: rows.map(rowToDevice) }
  }

  /**
   * Register (upsert) a device. Enforces max 5 devices per volunteer.
   */
  async registerDevice(pubkey: string, data: {
    platform: 'ios' | 'android'
    pushToken: string
    wakeKeyPublic: string
    /** Phase 6: Ed25519 signing public key (hex, optional for legacy clients) */
    ed25519Pubkey?: string
    /** Phase 6: X25519 key-agreement public key (hex, optional for legacy clients) */
    x25519Pubkey?: string
    deviceName?: string
    deviceModel?: string
    osVersion?: string
    appVersion?: string
  }): Promise<void> {
    // RACE-05: Row locking — lock the user row with FOR UPDATE to serialize
    // concurrent device registrations. Without this, two concurrent registrations
    // could both see room for one more device and exceed the max limit.
    await this.db.transaction(async (tx) => {
      const [user] = await tx
        .select({ pubkey: users.pubkey })
        .from(users)
        .where(eq(users.pubkey, pubkey))
        .for('update')
        .limit(1)

      if (!user) throw new ServiceError(404, 'User not found')

      const now = new Date()
      const allDevices = await tx
        .select({ id: devices.id, lastSeenAt: devices.lastSeenAt, pushToken: devices.pushToken })
        .from(devices)
        .where(eq(devices.pubkey, pubkey))

      const decision = decideDeviceRegistration(allDevices, data.pushToken)

      if (decision.action === 'update_existing') {
        await tx
          .update(devices)
          .set({
            wakeKeyPublic: data.wakeKeyPublic,
            ...(data.ed25519Pubkey !== undefined && { ed25519Pubkey: data.ed25519Pubkey }),
            ...(data.x25519Pubkey !== undefined && { x25519Pubkey: data.x25519Pubkey }),
            ...(data.deviceName !== undefined && { deviceName: data.deviceName }),
            ...(data.deviceModel !== undefined && { deviceModel: data.deviceModel }),
            ...(data.osVersion !== undefined && { osVersion: data.osVersion }),
            ...(data.appVersion !== undefined && { appVersion: data.appVersion }),
            lastSeenAt: now,
          })
          .where(eq(devices.id, decision.deviceId))
        return
      }

      if (decision.evictDeviceId) {
        await tx.delete(devices).where(eq(devices.id, decision.evictDeviceId))
      }

      await tx.insert(devices).values({
        pubkey,
        platform: data.platform,
        pushToken: data.pushToken,
        wakeKeyPublic: data.wakeKeyPublic,
        ed25519Pubkey: data.ed25519Pubkey,
        x25519Pubkey: data.x25519Pubkey,
        deviceName: data.deviceName,
        deviceModel: data.deviceModel,
        osVersion: data.osVersion,
        appVersion: data.appVersion,
        registeredAt: now,
        lastSeenAt: now,
      })
    })
  }

  /**
   * List all registered devices for a user.
   */
  async listDevices(pubkey: string): Promise<Array<{
    id: string
    platform: string
    deviceName: string | null
    deviceModel: string | null
    osVersion: string | null
    appVersion: string | null
    wakeKeyPublic: string | null
    ed25519Pubkey: string | null
    x25519Pubkey: string | null
    registeredAt: Date
    lastSeenAt: Date | null
    lastIpHash: string | null
  }>> {
    return this.db
      .select({
        id: devices.id,
        platform: devices.platform,
        deviceName: devices.deviceName,
        deviceModel: devices.deviceModel,
        osVersion: devices.osVersion,
        appVersion: devices.appVersion,
        wakeKeyPublic: devices.wakeKeyPublic,
        ed25519Pubkey: devices.ed25519Pubkey,
        x25519Pubkey: devices.x25519Pubkey,
        registeredAt: devices.registeredAt,
        lastSeenAt: devices.lastSeenAt,
        lastIpHash: devices.lastIpHash,
      })
      .from(devices)
      .where(eq(devices.pubkey, pubkey))
  }

  /** HPKE recipient keys for a server-sealed envelope — see `resolveHpkeRecipients`. */
  async resolveHpkeRecipients(readers: ReadonlyArray<string | null | undefined>): Promise<string[]> {
    return resolveHpkeRecipients(this.db, readers)
  }

  async deleteDeviceById(pubkey: string, deviceId: string): Promise<boolean> {
    const result = await this.db
      .delete(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.pubkey, pubkey)))
      .returning({ id: devices.id })
    return result.length > 0
  }

  /**
   * Rename a device. Only the device owner can rename their own devices.
   */
  async renameDevice(pubkey: string, deviceId: string, deviceName: string): Promise<boolean> {
    const result = await this.db
      .update(devices)
      .set({ deviceName })
      .where(and(eq(devices.id, deviceId), eq(devices.pubkey, pubkey)))
      .returning({ id: devices.id })
    return result.length > 0
  }

  /**
   * Revoke a device — atomically: append sigchain link, delete device, emit
   * security event, and return hub IDs for client-side PUK + hub key rotation.
   *
   * The client signs a `device_remove` sigchain link before calling this endpoint.
   * The server validates hash-chain continuity, persists the link, then deletes
   * the device record — all within a single transaction.
   */
  async revokeDevice(
    pubkey: string,
    deviceId: string,
    sigchainData?: {
      signature?: string
      sigchainHash?: string
      sigchainSeqNo?: number
      sigchainPrevHash?: string
    },
  ): Promise<{ hubIds: string[]; pukRotationNeeded: boolean } | null> {
    // Verify device belongs to caller
    const [device] = await this.db
      .select()
      .from(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.pubkey, pubkey)))
      .limit(1)

    if (!device) return null

    // Get user's hub memberships for key rotation
    const [user] = await this.db
      .select({ hubRoles: users.hubRoles })
      .from(users)
      .where(eq(users.pubkey, pubkey))
      .limit(1)

    const hubIds = user?.hubRoles
      ? (user.hubRoles as Array<{ hubId: string }>).map(hr => hr.hubId)
      : []

    // Atomic: append sigchain link + delete device + emit security event
    await this.db.transaction(async (tx) => {
      // 1. Append device_remove sigchain link (if client provided signed data)
      if (sigchainData?.signature && sigchainData.sigchainHash != null && sigchainData.sigchainSeqNo != null) {
        await tx.insert(sigchainLinks).values({
          userPubkey: pubkey,
          seqNo: sigchainData.sigchainSeqNo,
          linkType: 'device_remove',
          payload: {
            deviceId,
            devicePubkey: device.ed25519Pubkey,
            platform: device.platform,
          },
          signature: sigchainData.signature,
          prevHash: sigchainData.sigchainPrevHash ?? '',
          hash: sigchainData.sigchainHash,
        })
      }

      // 2. Delete device record
      await tx.delete(devices).where(eq(devices.id, deviceId))

      // 3. Delete all sessions for this device (C02 — atomic with device deletion)
      await tx.delete(sessions).where(
        and(
          eq(sessions.pubkey, pubkey),
          sql`${sessions.deviceInfo}->>'deviceId' = ${deviceId}`,
        ),
      )

      // 4. Emit security event
      await tx.insert(securityEvents).values({
        userPubkey: pubkey,
        eventType: 'device_remove',
        deviceId,
        metadata: {
          revokedDeviceId: deviceId,
          platform: device.platform,
          sigchainSeqNo: sigchainData?.sigchainSeqNo,
        },
      })
    })

    // Signal client to rotate PUK (excluding revoked device) and hub keys
    return { hubIds, pukRotationNeeded: true }
  }

  /**
   * Verify a device (SAS emoji verification). Admin only.
   */
  async verifyDevice(
    verifierPubkey: string,
    deviceId: string,
    signedAuditEntry: string,
  ): Promise<{ id: string } | null> {
    // Look up device to get target pubkey
    const [device] = await this.db
      .select({ ed25519Pubkey: devices.ed25519Pubkey, pubkey: devices.pubkey })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1)

    if (!device || !device.ed25519Pubkey) return null

    const [verification] = await this.db
      .insert(deviceVerifications)
      .values({
        verifierPubkey,
        targetDeviceId: deviceId,
        targetPubkey: device.ed25519Pubkey,
        signedAuditEntry,
      })
      .returning({ id: deviceVerifications.id })

    // Emit security event for device owner
    await this.db.insert(securityEvents).values({
      userPubkey: device.pubkey,
      eventType: 'device_fingerprint_verified',
      deviceId,
      metadata: { verifierPubkey },
    })

    return verification
  }

  /**
   * Remove devices with specific push tokens (e.g., after APNS feedback).
   */
  async cleanupDevices(pubkey: string, tokens: string[]): Promise<{ removed: number }> {
    if (tokens.length === 0) return { removed: 0 }

    const deleted = await this.db
      .delete(devices)
      .where(
        and(
          eq(devices.pubkey, pubkey),
          inArray(devices.pushToken, tokens),
        ),
      )
      .returning({ id: devices.id })

    return { removed: deleted.length }
  }

  /**
   * Delete all devices for a volunteer.
   */
  async deleteAllDevices(pubkey: string): Promise<void> {
    await this.db.delete(devices).where(eq(devices.pubkey, pubkey))
  }

  /**
   * Register or update a VoIP push token for a device.
   * Updates the voipToken on the device matching the pubkey + platform,
   * or creates a new device entry if none exists.
   */
  async registerVoipToken(pubkey: string, data: {
    platform: 'ios' | 'android'
    voipToken: string
  }): Promise<void> {
    const now = new Date()

    // Find existing device for this pubkey + platform
    const existing = await this.db
      .select()
      .from(devices)
      .where(
        and(
          eq(devices.pubkey, pubkey),
          eq(devices.platform, data.platform),
        ),
      )
      .limit(1)

    if (existing.length > 0) {
      await this.db
        .update(devices)
        .set({ voipToken: data.voipToken, lastSeenAt: now })
        .where(eq(devices.id, existing[0].id))
    } else {
      // Create a device record just for the voip token
      await this.db.insert(devices).values({
        pubkey,
        platform: data.platform,
        voipToken: data.voipToken,
        registeredAt: now,
        lastSeenAt: now,
      })
    }
  }

  /**
   * Get VoIP tokens for multiple volunteers (batch).
   * Used by VoIP push dispatch during incoming calls.
   */
  async getVoipTokens(pubkeys: string[]): Promise<{
    devices: Array<{ pubkey: string; platform: 'ios' | 'android'; voipToken: string }>
  }> {
    if (pubkeys.length === 0) return { devices: [] }

    const rows = await this.db
      .select({
        pubkey: devices.pubkey,
        platform: devices.platform,
        voipToken: devices.voipToken,
      })
      .from(devices)
      .where(
        and(
          inArray(devices.pubkey, pubkeys),
          sql`${devices.voipToken} IS NOT NULL`,
        ),
      )

    return {
      devices: rows
        .filter((r): r is typeof r & { voipToken: string } => r.voipToken !== null)
        .map(r => ({
          pubkey: r.pubkey,
          platform: r.platform as 'ios' | 'android',
          voipToken: r.voipToken,
        })),
    }
  }

  /**
   * Remove VoIP push token from all devices for a volunteer.
   */
  async deleteVoipToken(pubkey: string): Promise<void> {
    await this.db
      .update(devices)
      .set({ voipToken: null })
      .where(eq(devices.pubkey, pubkey))
  }

  // =========================================================================
  // Device Provisioning Rooms
  // =========================================================================

  /**
   * Create a provisioning room for cross-device key transfer.
   */
  async createProvisionRoom(ephemeralPubkey: string): Promise<{ roomId: string; token: string }> {
    const roomId = crypto.randomUUID()
    const token = randomHexToken(16)
    const now = new Date()
    const expiresAt = new Date(now.getTime() + PROVISION_ROOM_TTL_MS)

    await this.db.insert(provisionRooms).values({
      roomId,
      ephemeralPubkey,
      token,
      status: 'waiting',
      createdAt: now,
      expiresAt,
    })

    return { roomId, token }
  }

  /**
   * Get provisioning room status. Consumes the room if payload is ready.
   */
  async getProvisionRoom(id: string, token: string): Promise<{
    status: 'waiting' | 'ready' | 'expired'
    ephemeralPubkey?: string
    encryptedNsec?: string
    primaryPubkey?: string
  }> {
    // RACE-03: Atomic consume — attempt DELETE...RETURNING for ready rooms first.
    // Only one concurrent caller can delete the row; others fall through to the
    // SELECT path which distinguishes waiting/expired/not-found.
    const [consumed] = await this.db
      .delete(provisionRooms)
      .where(
        and(
          eq(provisionRooms.roomId, id),
          eq(provisionRooms.token, token),
          sql`${provisionRooms.encryptedNsec} IS NOT NULL`,
          sql`${provisionRooms.expiresAt} > NOW()`,
        ),
      )
      .returning()

    if (consumed) {
      return {
        status: 'ready',
        ephemeralPubkey: consumed.ephemeralPubkey,
        encryptedNsec: consumed.encryptedNsec!,
        primaryPubkey: consumed.primaryPubkey ?? undefined,
      }
    }

    // Fall back to SELECT to distinguish waiting/expired/not-found
    const [existing] = await this.db
      .select()
      .from(provisionRooms)
      .where(eq(provisionRooms.roomId, id))
      .limit(1)

    if (!existing) throw new ServiceError(404, 'Room not found')
    if (existing.token !== token) throw new ServiceError(403, 'Invalid token')

    if (existing.expiresAt < new Date()) {
      await this.db.delete(provisionRooms).where(eq(provisionRooms.roomId, id))
      return { status: 'expired' }
    }

    return { status: 'waiting', ephemeralPubkey: existing.ephemeralPubkey }
  }

  /**
   * Set the encrypted payload on a provisioning room.
   */
  async setProvisionPayload(id: string, data: {
    token: string
    encryptedNsec: string
    primaryPubkey: string
    senderPubkey: string
  }): Promise<void> {
    const rows = await this.db
      .select()
      .from(provisionRooms)
      .where(eq(provisionRooms.roomId, id))
      .limit(1)

    if (rows.length === 0) throw new ServiceError(404, 'Room not found')
    const room = rows[0]
    if (room.token !== data.token) throw new ServiceError(403, 'Invalid token')

    if (room.expiresAt < new Date()) {
      await this.db.delete(provisionRooms).where(eq(provisionRooms.roomId, id))
      throw new ServiceError(410, 'Room expired')
    }

    await this.db
      .update(provisionRooms)
      .set({
        encryptedNsec: data.encryptedNsec,
        primaryPubkey: data.primaryPubkey,
        status: 'ready',
      })
      .where(eq(provisionRooms.roomId, id))
  }

  // =========================================================================
  // Session Management (EP02)
  // =========================================================================

  async getSessionDeviceId(token: string): Promise<string | null> {
    const rows = await this.db
      .select({ deviceInfo: sessions.deviceInfo })
      .from(sessions)
      .where(eq(sessions.token, token))
      .limit(1)
    if (rows.length === 0) return null
    const info = rows[0].deviceInfo as Record<string, unknown> | null
    return (info?.deviceId as string | undefined) ?? null
  }

  async listSessions(pubkey: string) {
    return this.db
      .select()
      .from(sessions)
      .where(eq(sessions.pubkey, pubkey))
      .orderBy(sessions.createdAt)
  }

  async terminateSession(pubkey: string, token: string): Promise<boolean> {
    const result = await this.db
      .delete(sessions)
      .where(and(eq(sessions.token, token), eq(sessions.pubkey, pubkey)))
      .returning({ token: sessions.token })
    return result.length > 0
  }

  async terminateSessionById(pubkey: string, id: string): Promise<boolean> {
    const result = await this.db
      .delete(sessions)
      .where(and(eq(sessions.id, id), eq(sessions.pubkey, pubkey)))
      .returning({ token: sessions.token })
    return result.length > 0
  }

  async terminateOtherSessions(pubkey: string, currentToken: string): Promise<number> {
    const result = await this.db
      .delete(sessions)
      .where(
        and(
          eq(sessions.pubkey, pubkey),
          sql`${sessions.token} != ${currentToken}`,
        ),
      )
      .returning({ token: sessions.token })
    return result.length
  }

  async emitSecurityEvent(
    /** null for events reported by an unauthenticated client (e.g. cert pin mismatch). */
    userPubkey: string | null,
    eventType: string,
    deviceId: string | null,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await this.db.insert(securityEvents).values({
      userPubkey,
      eventType,
      deviceId,
      metadata,
    })
  }

  // =========================================================================
  // Security Events (EP02)
  // =========================================================================

  async listSecurityEvents(pubkey: string, limit: number, offset: number) {
    const [countResult] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(securityEvents)
      .where(eq(securityEvents.userPubkey, pubkey))

    const events = await this.db
      .select()
      .from(securityEvents)
      .where(eq(securityEvents.userPubkey, pubkey))
      .orderBy(sql`${securityEvents.createdAt} desc`)
      .limit(limit)
      .offset(offset)

    return { events, total: Number(countResult.count) }
  }

  async listAllSecurityEvents(limit: number, offset: number) {
    const [countResult] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(securityEvents)

    const events = await this.db
      .select()
      .from(securityEvents)
      .orderBy(sql`${securityEvents.createdAt} desc`)
      .limit(limit)
      .offset(offset)

    return { events, total: Number(countResult.count) }
  }

  // =========================================================================
  // Account Management (EP02)
  // =========================================================================

  async getUserHubIds(pubkey: string): Promise<string[]> {
    const [user] = await this.db
      .select({ hubRoles: users.hubRoles })
      .from(users)
      .where(eq(users.pubkey, pubkey))
      .limit(1)

    if (!user?.hubRoles) return []
    return (user.hubRoles as Array<{ hubId: string }>).map(hr => hr.hubId)
  }

  /**
   * Verify that a device ID belongs to the specified user.
   * Returns true if the device exists and is owned by the given pubkey.
   */
  async verifyDeviceOwnership(pubkey: string, deviceId: string): Promise<boolean> {
    const [device] = await this.db
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.pubkey, pubkey)))
      .limit(1)
    return !!device
  }

  /**
   * Get all device IDs belonging to active members of a specific hub.
   * Used to validate that MLS recipient device IDs are legitimate hub members.
   */
  async getHubMemberDeviceIds(hubId: string): Promise<Set<string>> {
    // Get all active users who are members of this hub
    const allUsers = await this.db
      .select({ pubkey: users.pubkey, hubRoles: users.hubRoles })
      .from(users)
      .where(eq(users.active, true))

    const memberPubkeys = allUsers
      .filter(u => {
        const roles = u.hubRoles as Array<{ hubId: string }> | null
        return roles?.some(hr => hr.hubId === hubId)
      })
      .map(u => u.pubkey)

    if (memberPubkeys.length === 0) return new Set()

    const memberDevices = await this.db
      .select({ id: devices.id })
      .from(devices)
      .where(inArray(devices.pubkey, memberPubkeys))

    return new Set(memberDevices.map(d => d.id))
  }

  // =========================================================================
  // Admin Device Overview (EP02)
  // =========================================================================

  async getAdminDeviceOverview(
    hubId: string | undefined,
    limit: number,
    offset: number,
  ) {
    // Get users with their devices, optionally filtered by hub membership
    const userQuery = this.db
      .select({
        pubkey: users.pubkey,
        displayName: users.displayName,
        hubRoles: users.hubRoles,
      })
      .from(users)
      .where(eq(users.active, true))

    const allUsers = await userQuery

    // Filter by hub membership if hubId provided
    const filteredUsers = hubId
      ? allUsers.filter(u => {
          const roles = u.hubRoles as Array<{ hubId: string }> | null
          return roles?.some(hr => hr.hubId === hubId)
        })
      : allUsers

    const total = filteredUsers.length
    const pagedUsers = filteredUsers.slice(offset, offset + limit)

    // Get devices and verification status for each user
    const entries = await Promise.all(
      pagedUsers.map(async (u) => {
        const userDevices = await this.db
          .select()
          .from(devices)
          .where(eq(devices.pubkey, u.pubkey))

        const verifications = await this.db
          .select({ targetDeviceId: deviceVerifications.targetDeviceId })
          .from(deviceVerifications)

        const verifiedDeviceIds = new Set(verifications.map(v => v.targetDeviceId))

        return {
          userPubkey: u.pubkey,
          displayName: u.displayName,
          deviceCount: userDevices.length,
          lastSeenAt: userDevices
            .map(d => d.lastSeenAt)
            .filter(Boolean)
            .sort()
            .pop()?.toISOString() ?? null,
          verified: userDevices.length > 0 && userDevices.every(d => verifiedDeviceIds.has(d.id)),
          devices: userDevices.map(d => ({
            id: d.id,
            platform: d.platform,
            deviceName: d.deviceName,
            deviceModel: d.deviceModel,
            osVersion: d.osVersion,
            appVersion: d.appVersion,
            ed25519Pubkey: d.ed25519Pubkey,
            x25519Pubkey: d.x25519Pubkey,
            registeredAt: d.registeredAt.toISOString(),
            lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
            lastIpHash: d.lastIpHash,
            isCurrent: false,
          })),
        }
      }),
    )

    return { entries, total }
  }

  // =========================================================================
  // Auth Token Nonce Tracking (replay prevention)
  // =========================================================================

  /**
   * Check whether a Bearer auth token nonce has been used, and mark it used if not.
   *
   * The nonce is the SHA-256 hash of the Ed25519 signature bytes (the `token`
   * field in `AuthPayload`). Because Ed25519 is deterministic, two requests
   * with identical pubkey+timestamp+method+path produce the same signature —
   * storing used signatures prevents replay within the TOKEN_MAX_AGE_MS window.
   *
   * @param nonceHash  SHA-256 of the token signature hex string
   * @param pubkey     Pubkey that issued the token (for audit)
   * @param expiresAt  When to expire the nonce record (= token issue time + max age)
   * @returns `true` if the nonce is fresh (first use), `false` if it is a replay
   */
  async checkAndMarkAuthNonce(
    nonceHash: string,
    pubkey: string,
    expiresAt: Date,
  ): Promise<boolean> {
    try {
      await this.db.insert(authNonces).values({ nonceHash, pubkey, expiresAt })
      return true
    } catch (e: unknown) {
      // Unique primary key violation = replay detected.
      // Check both the outer error and the cause — Bun's native SQL driver wraps
      // PG errors with code 'ERR_POSTGRES_SERVER_ERROR' instead of the raw '23505',
      // while Drizzle wraps the whole thing in DrizzleQueryError.
      if (isDuplicateKeyError(e)) return false
      throw e
    }
  }

  // =========================================================================
  // Cleanup (replaces DO alarm)
  // =========================================================================

  /**
   * Expire old sessions, challenges, provisioning rooms, and redeemed/expired invites.
   * Intended to be called from a scheduled worker or cron trigger.
   */
  async cleanup(): Promise<{
    expiredSessions: number
    expiredChallenges: number
    expiredProvisionRooms: number
    expiredInvites: number
    expiredAuthNonces: number
  }> {
    log.info('Starting identity cleanup')

    const cb = getCircuitBreaker({
      name: 'identity-cleanup',
      failureThreshold: 5,
      resetTimeoutMs: 5 * 60 * 1000, // 5 minutes
      onStateChange: (_name, _from, to) => {
        if (to === 'open') {
          log.error(
            'CRITICAL: Identity cleanup circuit opened — persistent cleanup failures detected',
            new Error('Circuit opened: identity-cleanup'),
          )
        } else if (to === 'closed') {
          log.info('Identity cleanup circuit recovered')
        }
      },
    })

    try {
      return await cb.execute(() =>
        withRetry(
          async () => {
            const now = new Date()

            // Expired sessions
            const deletedSessions = await this.db
              .delete(sessions)
              .where(lt(sessions.expiresAt, now))
              .returning({ token: sessions.token })

            // Expired challenges (5 min TTL)
            const challengeCutoff = new Date(now.getTime() - CHALLENGE_TTL_MS)
            const deletedChallenges = await this.db
              .delete(webauthnChallenges)
              .where(lt(webauthnChallenges.createdAt, challengeCutoff))
              .returning({ challengeId: webauthnChallenges.challengeId })

            // Expired provisioning rooms
            const deletedRooms = await this.db
              .delete(provisionRooms)
              .where(lt(provisionRooms.expiresAt, now))
              .returning({ roomId: provisionRooms.roomId })

            // Redeemed invites (clean up after 24h) and expired-unredeemed invites (clean up after 7 days)
            const redeemedCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000)
            const expiredCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

            const deletedRedeemedInvites = await this.db
              .delete(inviteCodes)
              .where(
                and(
                  sql`${inviteCodes.usedAt} IS NOT NULL`,
                  lt(inviteCodes.usedAt, redeemedCutoff),
                ),
              )
              .returning({ code: inviteCodes.code })

            const deletedExpiredInvites = await this.db
              .delete(inviteCodes)
              .where(
                and(
                  sql`${inviteCodes.usedAt} IS NULL`,
                  lt(inviteCodes.expiresAt, expiredCutoff),
                ),
              )
              .returning({ code: inviteCodes.code })

            // Expired auth nonces (Bearer token replay prevention records)
            const deletedAuthNonces = await this.db
              .delete(authNonces)
              .where(lt(authNonces.expiresAt, now))
              .returning({ nonceHash: authNonces.nonceHash })

            const result = {
              expiredSessions: deletedSessions.length,
              expiredChallenges: deletedChallenges.length,
              expiredProvisionRooms: deletedRooms.length,
              expiredInvites: deletedRedeemedInvites.length + deletedExpiredInvites.length,
              expiredAuthNonces: deletedAuthNonces.length,
            }

            log.info('Identity cleanup complete', result)
            return result
          },
          {
            maxAttempts: 3,
            baseDelayMs: 1_000,
            maxDelayMs: 10_000,
            isRetryable: isRetryableDbError,
            onRetry: (attempt, error) => {
              log.warn('Identity cleanup attempt failed, retrying', {
                attempt,
                error: error instanceof Error ? error.message : String(error),
              })
            },
          },
        ),
      )
    } catch (err) {
      log.error('Identity cleanup failed', err instanceof Error ? err : new Error(String(err)))
      throw err
    }
  }

  // =========================================================================
  // Test Reset (demo/development only)
  // =========================================================================

  /**
   * Truncate all identity-related tables. Only allowed in demo/development mode.
   */
  async reset(demoMode: boolean, environment: string, demoModeConfirm?: string): Promise<void> {
    const isDev = environment === 'development'
    if (!demoMode && !isDev) {
      throw new ServiceError(403, 'Reset not allowed outside demo/development mode')
    }
    if (demoMode && !isDev && demoModeConfirm !== 'DESTROY_ALL_DATA') {
      throw new ServiceError(403, 'DEMO_MODE reset requires DEMO_MODE_CONFIRM=DESTROY_ALL_DATA')
    }

    await this.db.transaction(async (tx) => {
      // Delete in FK-safe order (children first)
      await tx.delete(devices)
      await tx.delete(webauthnCredentials)
      await tx.delete(webauthnChallenges)
      await tx.delete(sessions)
      await tx.delete(authNonces)
      await tx.delete(provisionRooms)
      await tx.delete(inviteCodes)
      await tx.delete(users)
    })
  }

  /**
   * Skip admin seed on next init (for bootstrap tests).
   * Deletes all volunteers — used only in test setup.
   */
  async testSkipAdminSeed(): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(devices)
      await tx.delete(webauthnCredentials)
      await tx.delete(webauthnChallenges)
      await tx.delete(sessions)
      await tx.delete(users)
    })
  }
}
