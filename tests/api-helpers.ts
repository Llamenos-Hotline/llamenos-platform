/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * Authenticated API test helpers.
 *
 * All helpers create proper Ed25519 auth tokens matching the server's auth
 * middleware. The admin seed is used by default; pass a different seedHex for
 * role-specific testing (volunteer, reporter, custom).
 *
 * Use these in step definitions for:
 * - Fast test setup (create volunteers/shifts/bans without UI)
 * - Behavioral verification (check API state after UI actions)
 * - Permission enforcement (verify 403s for restricted roles)
 */

import { type APIRequestContext } from '@playwright/test'
import { ed25519 } from '@noble/curves/ed25519.js'
import { hexToBytes, bytesToHex, utf8ToBytes } from '@shared/encoding'
import { LABEL_DEVICE_AUTH, LABEL_NOTE_KEY } from '@shared/crypto-labels'
import {
  generateContentKey,
  encryptContent,
  wrapKeyForRecipient,
  x25519PubkeyFromSeed,
  encryptMessageForDesktop,
  type DesktopReaderEnvelope,
} from './crypto-helpers'

// Admin Ed25519 seed (32 bytes hex) — deterministic test credential.
// The corresponding pubkey is derived at runtime via ed25519PubkeyFromSeed.
export const ADMIN_SEED = 'f54a5851e9372b87810a8e60cdd2e7cfd80b6e31c7af18188f7db106ceda8be7'

/** @deprecated Use ADMIN_SEED instead */
export const ADMIN_NSEC = ADMIN_SEED

// ── Ed25519 Authentication ───────────────────────────────────────

export function seedHexToPubkey(seedHex: string): string {
  return bytesToHex(ed25519.getPublicKey(hexToBytes(seedHex)))
}

/**
 * Build the canonical auth message bytes.
 * Format: `{LABEL_DEVICE_AUTH}:{pubkey_hex}:{timestamp_ms}:{METHOD}:{path}`
 * MUST match apps/worker/lib/auth.ts::buildAuthMessage()
 */
function buildAuthMessage(pubkey: string, timestamp: number, method: string, path: string, nonce?: string): Uint8Array {
  const base = `${LABEL_DEVICE_AUTH}:${pubkey}:${timestamp}:${method}:${path}`
  return utf8ToBytes(nonce ? `${base}:${nonce}` : base)
}

/** Generate a random 16-byte hex nonce for auth replay prevention */
function randomNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return bytesToHex(bytes)
}

/**
 * Create an Ed25519 auth token for API calls.
 * Matches the format expected by apps/worker/lib/auth.ts.
 * Includes a random nonce to prevent replay collisions in parallel test workers.
 */
function createEd25519AuthToken(
  seedHex: string,
  method: string,
  path: string,
): { pubkey: string; timestamp: number; token: string; nonce: string } {
  const pubkey = seedHexToPubkey(seedHex)
  const timestamp = Date.now()
  const nonce = randomNonce()
  const message = buildAuthMessage(pubkey, timestamp, method, path, nonce)
  const sig = ed25519.sign(message, hexToBytes(seedHex))
  return { pubkey, timestamp, token: bytesToHex(sig), nonce }
}

/**
 * Build Ed25519 auth headers for a raw `request.get/post/...()` call that
 * needs the full response object (status, headers, body) — e.g. to inspect
 * a redirect's Location header, which the apiGet/apiPost wrappers below
 * intentionally don't expose.
 */
export function authHeaders(seedHex: string, method: string, path: string): Record<string, string> {
  // Strip query params — server verifies against url.pathname (no query string)
  const pathWithoutQuery = path.split('?')[0]
  const token = createEd25519AuthToken(seedHex, method, pathWithoutQuery)
  return {
    'Authorization': `Bearer ${JSON.stringify(token)}`,
    'Content-Type': 'application/json',
  }
}

// ── Safe JSON parsing (handles HTML error pages) ─────────────────

async function safeJson(res: import('@playwright/test').APIResponse): Promise<unknown> {
  const contentType = res.headers()['content-type'] ?? ''
  if (!contentType.includes('application/json')) return null
  try {
    return await res.json()
  } catch {
    return null
  }
}

// ── Dev Route Request Primitives ─────────────────────────────────
// Dev routes (/api/test-*) require X-Test-Secret header instead of Bearer auth.
// These are gated by ENVIRONMENT=development + DEV_ROUTES_ENABLED=true + secret.

const DEV_TEST_SECRET = process.env.DEV_RESET_SECRET || process.env.E2E_TEST_SECRET || 'test-reset-secret'

function devHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-Test-Secret': DEV_TEST_SECRET }
}

export async function devPost<T = unknown>(
  request: APIRequestContext,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; data: T }> {
  const fullPath = `/api${path}`
  const res = await request.post(fullPath, {
    headers: devHeaders(),
    data: body,
  })
  const data = await safeJson(res)
  return { status: res.status(), data: data as T }
}

export async function devGet<T = unknown>(
  request: APIRequestContext,
  path: string,
): Promise<{ status: number; data: T }> {
  const fullPath = `/api${path}`
  const res = await request.get(fullPath, {
    headers: devHeaders(),
  })
  const data = await safeJson(res)
  return { status: res.status(), data: data as T }
}

export async function devDelete<T = unknown>(
  request: APIRequestContext,
  path: string,
): Promise<{ status: number; data: T }> {
  const fullPath = `/api${path}`
  const res = await request.delete(fullPath, {
    headers: devHeaders(),
  })
  const data = await safeJson(res)
  return { status: res.status(), data: data as T }
}

// ── Authenticated Request Primitives ──────────────────────────────

export async function apiGet<T = unknown>(
  request: APIRequestContext,
  path: string,
  seedHex: string = ADMIN_SEED,
): Promise<{ status: number; data: T }> {
  const fullPath = `/api${path}`
  const res = await request.get(fullPath, {
    headers: authHeaders(seedHex, 'GET', fullPath),
  })
  const data = await safeJson(res)
  return { status: res.status(), data: data as T }
}

export async function apiPost<T = unknown>(
  request: APIRequestContext,
  path: string,
  body: Record<string, unknown>,
  seedHex: string = ADMIN_SEED,
): Promise<{ status: number; data: T }> {
  const fullPath = `/api${path}`
  const res = await request.post(fullPath, {
    headers: authHeaders(seedHex, 'POST', fullPath),
    data: body,
  })
  const data = await safeJson(res)
  return { status: res.status(), data: data as T }
}

export async function apiPatch<T = unknown>(
  request: APIRequestContext,
  path: string,
  body: Record<string, unknown>,
  seedHex: string = ADMIN_SEED,
): Promise<{ status: number; data: T }> {
  const fullPath = `/api${path}`
  const res = await request.patch(fullPath, {
    headers: authHeaders(seedHex, 'PATCH', fullPath),
    data: body,
  })
  const data = await safeJson(res)
  return { status: res.status(), data: data as T }
}

export async function apiPut<T = unknown>(
  request: APIRequestContext,
  path: string,
  body: Record<string, unknown>,
  seedHex: string = ADMIN_SEED,
): Promise<{ status: number; data: T }> {
  const fullPath = `/api${path}`
  const res = await request.put(fullPath, {
    headers: authHeaders(seedHex, 'PUT', fullPath),
    data: body,
  })
  const data = await safeJson(res)
  return { status: res.status(), data: data as T }
}

export async function apiDelete<T = unknown>(
  request: APIRequestContext,
  path: string,
  seedHex: string = ADMIN_SEED,
): Promise<{ status: number; data: T }> {
  const fullPath = `/api${path}`
  const res = await request.delete(fullPath, {
    headers: authHeaders(seedHex, 'DELETE', fullPath),
  })
  const data = await safeJson(res)
  return { status: res.status(), data: data as T }
}

/**
 * Create a hub through the route an operator uses.
 *
 * This called /api/test-create-hub, on the stated grounds that "the
 * authenticated /api/hubs POST requires system:manage-hubs which the bootstrap
 * admin may not have". That is not so: `role-super-admin` carries
 * `permissions: ['*']` (packages/shared/permissions.ts DEFAULT_ROLES), and the
 * bootstrap admin holds that role — global-setup verifies it before any test
 * runs. The dev route was never needed here.
 *
 * It was, however, actively harmful: `devGuard` (apps/worker/app.ts) answers
 * 404 for every /api/test-* outside a development server, so every suite built
 * on this helper — 15 files — could only ever run against a dev box. See #1423.
 *
 * `POST /api/hubs` also calls `setHubRole` for the creator, so the admin ends
 * up a member of the hub exactly as the dev route arranged via `adminPubkey`.
 */
export async function createHubViaApi(
  request: APIRequestContext,
  name: string,
): Promise<string> {
  const { status, data } = await apiPost<{ hub?: { id: string } }>(request, '/hubs', { name })
  if (status !== 201 && status !== 200) {
    throw new Error(`Failed to create hub "${name}": POST /api/hubs returned ${status}`)
  }
  const id = data?.hub?.id
  if (!id) {
    throw new Error(`POST /api/hubs returned ${status} but no hub id: ${JSON.stringify(data)}`)
  }
  return id
}

/**
 * Add a user to a hub with the specified role IDs.
 * Used to ensure test volunteers are members of the worker-scoped hub.
 */
export async function addHubMemberViaApi(
  request: APIRequestContext,
  hubId: string,
  pubkey: string,
  roleIds: string[] = ['role-volunteer'],
): Promise<void> {
  const { status } = await apiPost(request, `/hubs/${hubId}/members`, { pubkey, roleIds })
  if (status !== 200 && status !== 201 && status !== 204 && status !== 409) {
    // 409 = already a member, which is fine
    console.warn(`Failed to add hub member (hub=${hubId}, pubkey=${pubkey}): ${status}`)
  }
}

export async function deleteHubViaApi(
  request: APIRequestContext,
  hubId: string,
): Promise<void> {
  const { status } = await apiDelete(request, `/hubs/${hubId}`)
  if (status !== 200 && status !== 204) {
    // Non-fatal: log but don't throw — teardown should not fail tests
    console.warn(`Failed to delete hub ${hubId}: ${status}`)
  }
}

/**
 * Read the admin's current global roles via the authenticated /auth/me route.
 * Returns null when the call does not succeed (e.g. the user row is momentarily
 * absent during a database reset), which callers treat as "not yet admin".
 */
async function readAdminRoles(request: APIRequestContext): Promise<string[] | null> {
  const { status, data } = await apiGet<{ roles?: string[] }>(request, '/auth/me')
  if (status !== 200) return null
  return data?.roles ?? null
}

/**
 * Ensure the admin user has the correct global role (role-super-admin), and
 * verify it actually took effect.
 *
 * A test-reset deletes every user row; a request that lands inside that window
 * can recreate the admin with the default role-volunteer. Promotion alone is
 * not enough — it can itself race a concurrent reset — so this polls /auth/me
 * until the role is really in place. Failing loudly here beats letting a whole
 * shard fail later with unrelated-looking 403s.
 */
export async function ensureAdminRole(
  request: APIRequestContext,
): Promise<void> {
  const pubkey = seedHexToPubkey(ADMIN_SEED)

  // Already correct — the normal case, and the ONLY reachable case on a
  // deployment. The promotion below exists for a dev-only race (a concurrent
  // /api/test-reset wiping the users table mid-run, recreating the admin as
  // role-volunteer). A deployed server has no test-reset, so nothing can
  // downgrade the admin, and /api/test-promote-admin is 404 there anyway.
  // Checking first means this helper is a no-op rather than a hard failure
  // against a real server (#1423).
  const current = await readAdminRoles(request)
  if (current?.includes('role-super-admin')) return

  let lastRoles: string[] | null = current
  let lastStatus = 0
  for (let attempt = 0; attempt < 5; attempt++) {
    const { status } = await devPost(request, '/test-promote-admin', { pubkey })
    lastStatus = status
    if (status === 200) {
      lastRoles = await readAdminRoles(request)
      if (lastRoles?.includes('role-super-admin')) return
    }
    // Back off — a concurrent reset takes a moment to finish re-seeding.
    await new Promise(r => setTimeout(r, 200 * (attempt + 1)))
  }
  throw new Error(
    `[ensureAdminRole] admin ${pubkey.slice(0, 8)} never reached role-super-admin ` +
    `(test-promote-admin returned ${lastStatus}, /auth/me roles: ${JSON.stringify(lastRoles)})`,
  )
}

/**
 * Verify that the admin user has membership in the given hub.
 * Makes an authenticated API call to a hub-scoped endpoint and checks
 * the response is not 403 (Access denied). If membership is missing,
 * retries by re-adding the admin via the test-create-hub membership path.
 *
 * Also ensures the admin has the correct global role (role-super-admin)
 * before checking hub access — a downgraded global role causes 403s on
 * permission-guarded routes even when hub membership is correct.
 */
export async function verifyHubMembership(
  request: APIRequestContext,
  hubId: string,
): Promise<void> {
  // First ensure admin has role-super-admin globally — without this,
  // even correct hub membership won't grant admin-level permissions.
  await ensureAdminRole(request)

  // Try a hub-scoped endpoint that requires any permission
  const { status, data } = await apiGet<unknown>(request, `/hubs/${hubId}/notes?limit=1`)
  if (status === 200) return // Admin has access

  if (status === 403) {
    // The dev backend embeds `debug: { roles, permCount, hubPermCount }` in 403
    // bodies, and hubContext denials say "Access denied". Surfacing the body is
    // the only way to tell a hub-membership denial apart from a permission or
    // WebAuthn-enforcement denial when this only reproduces in CI.
    console.warn(
      `[verifyHubMembership] Admin denied on hub ${hubId} — body: ${JSON.stringify(data)}`,
    )
    // The AUTHENTICATED route first. It works everywhere; the dev route below
    // is 404 outside a development server, so trying it first made this path
    // fail on a deployment for a reason that had nothing to do with hub
    // membership (#1423).
    const { status: addStatus } = await apiPost(request, `/hubs/${hubId}/members`, {
      pubkey: seedHexToPubkey(ADMIN_SEED),
      roleIds: ['role-super-admin'],
    })
    // Declared out here, not inside the branch: the final diagnostic below
    // reports it too, and it stays `null` when the real route succeeded —
    // which is itself the useful signal that no fallback was needed.
    let devStatus: number | null = null
    if (addStatus !== 200 && addStatus !== 201 && addStatus !== 204 && addStatus !== 409) {
      // Dev-only fallback: bypasses auth entirely, for the case where the
      // admin's own permissions are what is broken. 404 here means a
      // deployment, where this route does not exist by design.
      ;({ status: devStatus } = await devPost(request, '/test-add-hub-member', {
        hubId,
        pubkey: seedHexToPubkey(ADMIN_SEED),
        roleIds: ['role-super-admin'],
      }))
      // Only now is it genuinely unrecoverable: the real route failed AND the
      // dev bypass either failed or does not exist on this server.
      if (devStatus !== 200) {
        throw new Error(
          `Failed to ensure admin hub membership for hub ${hubId}: ` +
          `notes returned ${status}, add-member returned ${addStatus}, dev-add returned ${devStatus}`
        )
      }
    }
    // Brief delay for DB commit propagation, then verify
    await new Promise(r => setTimeout(r, 100))
    const { status: retryStatus } = await apiGet<unknown>(request, `/hubs/${hubId}/notes?limit=1`)
    if (retryStatus === 403) {
      // One more attempt: re-ensure admin role and retry
      await ensureAdminRole(request)
      await new Promise(r => setTimeout(r, 200))
      const { status: finalStatus, data: finalData } = await apiGet<unknown>(request, `/hubs/${hubId}/notes?limit=1`)
      if (finalStatus === 403) {
        // A 403 that survives both a hub-role re-add and a global-role re-promote
        // points at the role definitions themselves rather than at membership.
        // Dump what the server currently thinks role-super-admin can do.
        const { status: rolesStatus, data: rolesData } = await apiGet<{
          roles?: { id: string; permissions: string[] }[]
        }>(request, '/settings/roles')
        const superAdmin = rolesData?.roles?.find(r => r.id === 'role-super-admin')
        console.warn(
          `[verifyHubMembership] roles snapshot (status ${rolesStatus}): ` +
          `roleCount=${rolesData?.roles?.length}, ` +
          `role-super-admin permissions=${JSON.stringify(superAdmin?.permissions)}`,
        )
        throw new Error(
          `Admin still lacks hub membership after re-add for hub ${hubId} ` +
          `(status: ${finalStatus}, add-member: ${addStatus}, ` +
          `dev-add: ${devStatus ?? 'not attempted'}, body: ${JSON.stringify(finalData)})`
        )
      }
    }
  }
  // 401 or other errors during verification are non-fatal — the test itself will catch them
}

// ── Unique Test Data Generators ───────────────────────────────────

// Incrementing counter ensures uniqueness within a single worker process,
// preventing collisions when multiple phones are generated in tight loops.
let _phoneSeq = 0
export function uniquePhone(): string {
  const seq = ++_phoneSeq
  return `+1212${String(seq).padStart(7, '0')}`
}

export function uniqueName(prefix: string): string {
  return `${prefix} ${Date.now()}`
}

// ── Keypair Generation ────────────────────────────────────────────

export function generateTestKeypair(): { seedHex: string; pubkey: string } {
  const seedBytes = crypto.getRandomValues(new Uint8Array(32))
  const seedHex = bytesToHex(seedBytes)
  const pubkey = seedHexToPubkey(seedHex)
  return { seedHex, pubkey }
}

// ── User CRUD ─────────────────────────────────────────────────────

export interface CreateUserResult {
  pubkey: string
  seedHex: string
  /** @deprecated Use seedHex */
  nsec: string
  /** @deprecated Use seedHex */
  deviceKey: string
  name: string
  phone: string
}

/** @deprecated Use CreateUserResult instead */
export type CreateVolunteerResult = CreateUserResult

export async function createUserViaApi(
  request: APIRequestContext,
  options?: { name?: string; phone?: string; roleIds?: string[] },
): Promise<CreateUserResult> {
  const name = options?.name ?? uniqueName('TestUser')
  const phone = options?.phone ?? uniquePhone()
  const roleIds = options?.roleIds ?? ['role-volunteer']

  const { seedHex, pubkey } = generateTestKeypair()

  const { status, data } = await apiPost(request, '/users', {
    name, phone, roleIds, pubkey,
  })

  if (status !== 200 && status !== 201) {
    throw new Error(`Failed to create user: ${status}`)
  }

  return { pubkey, seedHex, nsec: seedHex, deviceKey: seedHex, name, phone }
}

/** @deprecated Use createUserViaApi instead */
export const createVolunteerViaApi = createUserViaApi

export async function deleteUserViaApi(
  request: APIRequestContext,
  pubkey: string,
): Promise<void> {
  const { status } = await apiDelete(request, `/users/${pubkey}`)
  if (status !== 200) {
    throw new Error(`Failed to delete user: ${status}`)
  }
}

/** @deprecated Use deleteUserViaApi instead */
export const deleteVolunteerViaApi = deleteUserViaApi

export async function listUsersViaApi(
  request: APIRequestContext,
): Promise<Array<{ pubkey: string; name: string; phone: string; roles: string[]; active: boolean }>> {
  const { status, data } = await apiGet<{ users: Array<{ pubkey: string; name: string; phone: string; roles: string[]; active: boolean }> }>(request, '/users')
  if (status !== 200) throw new Error(`Failed to list users: ${status}`)
  return data.users
}

/** @deprecated Use listUsersViaApi instead */
export const listVolunteersViaApi = listUsersViaApi

export async function getUserViaApi(
  request: APIRequestContext,
  pubkey: string,
  seedHex = ADMIN_SEED,
): Promise<Record<string, unknown>> {
  const { status, data } = await apiGet<Record<string, unknown>>(request, `/users/${pubkey}`, seedHex)
  if (status !== 200) throw new Error(`Failed to get user: ${status}`)
  return data
}

/** @deprecated Use getUserViaApi instead */
export const getVolunteerViaApi = getUserViaApi

export async function updateUserViaApi(
  request: APIRequestContext,
  pubkey: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const { status } = await apiPatch(request, `/users/${pubkey}`, updates)
  if (status !== 200) throw new Error(`Failed to update user: ${status}`)
}

/** @deprecated Use updateUserViaApi instead */
export const updateVolunteerViaApi = updateUserViaApi

// ── Ban CRUD ──────────────────────────────────────────────────────

export interface CreateBanResult {
  phone: string
  phoneHash: string
  reason: string
}

export async function createBanViaApi(
  request: APIRequestContext,
  options?: { phone?: string; reason?: string; hubId?: string },
): Promise<CreateBanResult> {
  const phone = options?.phone ?? uniquePhone()
  const reason = options?.reason ?? 'E2E test ban'

  const { status, data } = await apiPost<{ ban: { phone: string; phoneHash: string; reason: string } }>(request, hubPath('/bans', options?.hubId), { phone, reason })
  if (status !== 200 && status !== 201) {
    throw new Error(`Failed to create ban: ${status}`)
  }
  return { phone, phoneHash: data.ban.phoneHash, reason }
}

export async function removeBanViaApi(
  request: APIRequestContext,
  phone: string,
  hubId?: string,
): Promise<void> {
  const { status } = await apiDelete(request, hubPath(`/bans/${encodeURIComponent(phone)}`, hubId))
  if (status !== 200) throw new Error(`Failed to remove ban: ${status}`)
}

export async function listBansViaApi(
  request: APIRequestContext,
  hubId?: string,
): Promise<Array<{ phone: string; phoneHash: string; reason: string; bannedBy: string; bannedAt: string }>> {
  const { status, data } = await apiGet<{ bans: Array<{ phone: string; phoneHash: string; reason: string; bannedBy: string; bannedAt: string }> }>(request, hubPath('/bans', hubId))
  if (status !== 200) throw new Error(`Failed to list bans: ${status}`)
  return data.bans
}

export async function bulkAddBansViaApi(
  request: APIRequestContext,
  phones: string[],
  reason: string,
  hubId?: string,
): Promise<{ count: number }> {
  const { status, data } = await apiPost<{ count: number }>(request, hubPath('/bans/bulk', hubId), { phones, reason })
  if (status !== 200) throw new Error(`Failed to bulk add bans: ${status}`)
  return data
}

// ── Shift CRUD ────────────────────────────────────────────────────

export interface CreateShiftResult {
  id: string
  encryptedName: string
}

/** Resolve hub-scoped path prefix. Hub-scoped resources live at /hubs/:id/resource. */
function hubPath(base: string, hubId?: string): string {
  return hubId ? `/hubs/${hubId}${base}` : base
}

export async function createShiftViaApi(
  request: APIRequestContext,
  options?: {
    encryptedName?: string
    /** @deprecated use encryptedName */
    name?: string
    startTime?: string
    endTime?: string
    days?: number[]
    userPubkeys?: string[]
    hubId?: string
  },
): Promise<CreateShiftResult> {
  const id = crypto.randomUUID()
  const encryptedName = options?.encryptedName ?? options?.name ?? uniqueName('TestShift')
  const startTime = options?.startTime ?? '09:00'
  const endTime = options?.endTime ?? '17:00'
  const days = options?.days ?? [1, 2, 3, 4, 5]
  const userPubkeys = options?.userPubkeys ?? []

  const { status, data } = await apiPost<{ id: string }>(request, hubPath('/shifts', options?.hubId), {
    id, encryptedName, startTime, endTime, days, userPubkeys,
  })
  if (status !== 200 && status !== 201) {
    throw new Error(`Failed to create shift: ${status}`)
  }
  return { id: data.id, encryptedName }
}

export async function deleteShiftViaApi(
  request: APIRequestContext,
  id: string,
  hubId?: string,
): Promise<void> {
  const { status } = await apiDelete(request, hubPath(`/shifts/${id}`, hubId))
  if (status !== 200) throw new Error(`Failed to delete shift: ${status}`)
}

export async function listShiftsViaApi(
  request: APIRequestContext,
  hubId?: string,
): Promise<Array<{ id: string; encryptedName: string; startTime: string; endTime: string; days: number[]; userPubkeys: string[] }>> {
  const { status, data } = await apiGet<{ shifts: Array<{ id: string; encryptedName: string; startTime: string; endTime: string; days: number[]; userPubkeys: string[] }> }>(request, hubPath('/shifts', hubId))
  if (status !== 200) throw new Error(`Failed to list shifts: ${status}`)
  return data.shifts
}

export async function updateShiftViaApi(
  request: APIRequestContext,
  id: string,
  updates: { encryptedName?: string; startTime?: string; endTime?: string; days?: number[]; userPubkeys?: string[] },
  hubId?: string,
): Promise<void> {
  const { status } = await apiPatch(request, hubPath(`/shifts/${id}`, hubId), updates)
  if (status !== 200) throw new Error(`Failed to update shift: ${status}`)
}

export async function getFallbackGroupViaApi(
  request: APIRequestContext,
  hubId?: string,
): Promise<{ volunteers: string[] }> {
  const { status, data } = await apiGet<{ userPubkeys: string[] }>(request, hubPath('/shifts/fallback', hubId))
  if (status !== 200) throw new Error(`Failed to get fallback group: ${status}`)
  return { volunteers: data.userPubkeys ?? [] }
}

export async function setFallbackGroupViaApi(
  request: APIRequestContext,
  volunteers: string[],
  hubId?: string,
): Promise<void> {
  const { status } = await apiPut(request, hubPath('/shifts/fallback', hubId), { userPubkeys: volunteers })
  if (status !== 200) throw new Error(`Failed to set fallback group: ${status}`)
}

// ── Roles CRUD ────────────────────────────────────────────────────

export interface RoleDefinition {
  id: string
  name: string
  slug: string
  permissions: string[]
  isDefault: boolean
  isSystem: boolean
  description: string
}

export async function listRolesViaApi(
  request: APIRequestContext,
): Promise<RoleDefinition[]> {
  const { status, data } = await apiGet<{ roles: RoleDefinition[] }>(request, '/settings/roles')
  if (status !== 200) throw new Error(`Failed to list roles: ${status}`)
  return data.roles
}

export async function createRoleViaApi(
  request: APIRequestContext,
  opts: { name: string; slug: string; permissions: string[]; description?: string; encryptedName?: string; encryptedDescription?: string; envelopes?: Array<{ adminPubkey: string; encryptedName: string; encryptedDescription: string }> },
): Promise<RoleDefinition> {
  const { status, data } = await apiPost<RoleDefinition>(request, '/settings/roles', {
    name: opts.name,
    slug: opts.slug,
    permissions: opts.permissions,
    description: opts.description || `Custom role: ${opts.name}`,
    encryptedName: opts.encryptedName,
    encryptedDescription: opts.encryptedDescription,
    envelopes: opts.envelopes,
  })
  if (status === 409) {
    // Role already exists (parallel test created it) — fetch and return it
    const roles = await listRolesViaApi(request)
    const existing = roles.find(r => r.slug === opts.slug)
    if (existing) return existing
    throw new Error(`Role slug "${opts.slug}" conflicts but not found in list`)
  }
  if (status !== 200 && status !== 201) {
    throw new Error(`Failed to create role: ${status}`)
  }
  // API returns the role directly, not wrapped in { role: ... }
  const role = (data as unknown as { role?: RoleDefinition })?.role ?? data
  return role
}

export async function updateRoleViaApi(
  request: APIRequestContext,
  id: string,
  updates: { name?: string; permissions?: string[]; description?: string },
): Promise<void> {
  const { status } = await apiPatch(request, `/settings/roles/${id}`, updates)
  if (status !== 200) throw new Error(`Failed to update role: ${status}`)
}

export async function deleteRoleViaApi(
  request: APIRequestContext,
  id: string,
): Promise<{ status: number }> {
  // Returns status so callers can assert 403 for system roles
  return apiDelete(request, `/settings/roles/${id}`)
}

export async function getPermissionsCatalogViaApi(
  request: APIRequestContext,
): Promise<{ permissions: Record<string, string>; byDomain: Record<string, Array<{ key: string; label: string }>> }> {
  const { status, data } = await apiGet<{ permissions: Record<string, string>; byDomain: Record<string, Array<{ key: string; label: string }>> }>(request, '/settings/permissions')
  if (status !== 200) throw new Error(`Failed to get permissions catalog: ${status}`)
  return data
}

// ── Notes (list/verify — creation requires encryption) ────────────

export interface NoteRecord {
  id: string
  callId?: string
  conversationId?: string
  contactHash?: string
  authorPubkey: string
  encryptedContent: string
  createdAt: string
  updatedAt: string
  replyCount?: number
}

export async function listNotesViaApi(
  request: APIRequestContext,
  params?: { callId?: string; conversationId?: string; page?: number; limit?: number; hubId?: string },
): Promise<{ notes: NoteRecord[]; total: number }> {
  const qs = new URLSearchParams()
  if (params?.callId) qs.set('callId', params.callId)
  if (params?.conversationId) qs.set('conversationId', params.conversationId)
  if (params?.page) qs.set('page', String(params.page))
  if (params?.limit) qs.set('limit', String(params.limit))
  const qsStr = qs.toString()
  const base = `/notes${qsStr ? `?${qsStr}` : ''}`
  const path = params?.hubId ? hubPath(base.split('?')[0], params.hubId) + (qsStr ? `?${qsStr}` : '') : base
  const { status, data } = await apiGet<{ notes: NoteRecord[]; total: number }>(request, path)
  if (status !== 200) throw new Error(`Failed to list notes: ${status}`)
  return data
}

// ── Audit Log ─────────────────────────────────────────────────────

export interface AuditEntry {
  id: string
  action: string
  actorPubkey: string
  details: Record<string, unknown>
  createdAt: string
  entryHash?: string
  previousEntryHash?: string
}

export async function listAuditLogViaApi(
  request: APIRequestContext,
  params?: { eventType?: string; search?: string; page?: number; limit?: number; hubId?: string },
): Promise<{ entries: AuditEntry[]; total: number }> {
  const qs = new URLSearchParams()
  if (params?.eventType) qs.set('eventType', params.eventType)
  if (params?.search) qs.set('search', params.search)
  if (params?.page) qs.set('page', String(params.page))
  if (params?.limit) qs.set('limit', String(params.limit))
  const qsStr = qs.toString()
  const path = hubPath('/audit', params?.hubId) + (qsStr ? `?${qsStr}` : '')
  const { status, data } = await apiGet<{ entries: AuditEntry[]; total: number }>(request, path)
  if (status !== 200) throw new Error(`Failed to list audit log: ${status}`)
  return data
}

export interface ChainVerificationResult {
  valid: boolean
  totalEntries: number
  checkedEntries: number
  firstBrokenEntry?: {
    id: string
    seqIndex: number
    expected: string | null
    actual: string | null
    reason: string
  }
}

export async function verifyAuditChainViaApi(
  request: APIRequestContext,
  params?: { hubId?: string; limit?: number; offset?: number },
): Promise<ChainVerificationResult> {
  const qs = new URLSearchParams()
  if (params?.limit != null) qs.set('limit', String(params.limit))
  if (params?.offset != null) qs.set('offset', String(params.offset))
  const qsStr = qs.toString()
  const path = hubPath('/audit/verify', params?.hubId) + (qsStr ? `?${qsStr}` : '')
  const { status, data } = await apiGet<ChainVerificationResult>(request, path)
  if (status !== 200) throw new Error(`Failed to verify audit chain: ${status}`)
  return data
}

// ── Reports ───────────────────────────────────────────────────────

export interface ReportRecord {
  id: string
  channelType: string
  status: string
  assignedTo?: string
  createdAt: string
  metadata?: {
    type?: string
    reportTitle?: string
    reportCategory?: string
  }
}

export async function listReportsViaApi(
  request: APIRequestContext,
  params?: { status?: string; hubId?: string },
): Promise<{ conversations: ReportRecord[]; total: number }> {
  const qs = new URLSearchParams()
  if (params?.status) qs.set('status', params.status)
  const qsStr = qs.toString()
  const basePath = hubPath('/reports', params?.hubId)
  const path = basePath + (qsStr ? `?${qsStr}` : '')
  const { status, data } = await apiGet<{ conversations: ReportRecord[]; total: number }>(request, path)
  if (status !== 200) throw new Error(`Failed to list reports: ${status}`)
  return data
}

/**
 * Create a report via API with dummy encrypted content.
 * Uses placeholder encryption values — suitable for test data seeding only.
 */
export async function createReportViaApi(
  request: APIRequestContext,
  options?: { title?: string; category?: string; status?: string; reportTypeId?: string; seedHex?: string; hubId?: string },
): Promise<ReportRecord> {
  const seedHex = options?.seedHex ?? ADMIN_SEED

  const title = options?.title ?? `Test Report ${Date.now()}`
  const { encryptedContent, envelopes } = await encryptForTest(
    `report content: ${title}`,
    [seedHex],
  )

  const body: Record<string, unknown> = {
    title,
    category: options?.category ?? 'test',
    encryptedContent,
    readerEnvelopes: envelopes,
  }
  if (options?.reportTypeId) body.reportTypeId = options.reportTypeId

  const { status, data } = await apiPost<ReportRecord>(request, hubPath('/reports', options?.hubId), body, seedHex)
  if (status !== 201 && status !== 200) {
    throw new Error(`Failed to create report: ${status} ${JSON.stringify(data)}`)
  }

  const report = data as ReportRecord
  // If caller wants a specific status, update it
  if (options?.status && options.status !== 'waiting') {
    const assigneePubkey = seedHexToPubkey(seedHex)
    if (options.status === 'active') {
      await assignReportViaApi(request, report.id, assigneePubkey, options?.hubId)
    } else if (options.status === 'closed') {
      await assignReportViaApi(request, report.id, assigneePubkey, options?.hubId)
      await updateReportStatusViaApi(request, report.id, 'closed', options?.hubId)
    }
  }
  return report
}

export async function assignReportViaApi(
  request: APIRequestContext,
  reportId: string,
  pubkey: string,
  hubId?: string,
): Promise<void> {
  const path = hubPath(`/reports/${reportId}/assign`, hubId)
  const { status } = await apiPost(request, path, { assignedTo: pubkey })
  if (status !== 200) throw new Error(`Failed to assign report: ${status}`)
}

export async function updateReportStatusViaApi(
  request: APIRequestContext,
  reportId: string,
  newStatus: string,
  hubId?: string,
): Promise<void> {
  const path = hubPath(`/reports/${reportId}`, hubId)
  const { status } = await apiPatch(request, path, { status: newStatus })
  if (status !== 200) throw new Error(`Failed to update report status: ${status}`)
}

// ── Custom Fields ─────────────────────────────────────────────────

export interface CustomFieldDefinition {
  id: string
  name: string
  label: string
  type: 'text' | 'select' | 'number' | 'boolean'
  context?: 'call-notes' | 'conversation-notes' | 'reports' | 'all'
  options?: string[]
  required?: boolean
}

export async function getCustomFieldsViaApi(
  request: APIRequestContext,
): Promise<CustomFieldDefinition[]> {
  const { status, data } = await apiGet<{ fields: CustomFieldDefinition[] }>(request, '/settings/custom-fields')
  if (status !== 200) throw new Error(`Failed to get custom fields: ${status}`)
  return data.fields
}

export async function updateCustomFieldsViaApi(
  request: APIRequestContext,
  fields: CustomFieldDefinition[],
): Promise<CustomFieldDefinition[]> {
  const { status, data } = await apiPut<{ fields: CustomFieldDefinition[] }>(request, '/settings/custom-fields', { fields })
  if (status !== 200) throw new Error(`Failed to update custom fields: ${status}`)
  return data.fields
}

// ── Settings ──────────────────────────────────────────────────────

export async function getSpamSettingsViaApi(
  request: APIRequestContext,
): Promise<{ voiceCaptchaEnabled: boolean; rateLimitEnabled: boolean; maxCallsPerMinute: number; blockDurationMinutes: number }> {
  const { status, data } = await apiGet(request, '/settings/spam')
  if (status !== 200) throw new Error(`Failed to get spam settings: ${status}`)
  return data as { voiceCaptchaEnabled: boolean; rateLimitEnabled: boolean; maxCallsPerMinute: number; blockDurationMinutes: number }
}

export async function getTranscriptionSettingsViaApi(
  request: APIRequestContext,
): Promise<{ globalEnabled: boolean; allowUserOptOut: boolean }> {
  const { status, data } = await apiGet(request, '/settings/transcription')
  if (status !== 200) throw new Error(`Failed to get transcription settings: ${status}`)
  return data as { globalEnabled: boolean; allowUserOptOut: boolean }
}

// ── Auth Verification ─────────────────────────────────────────────

export async function getMeViaApi(
  request: APIRequestContext,
  seedHex: string,
): Promise<{ status: number; data: { pubkey: string; roles: string[]; permissions: string[]; name: string } | null }> {
  return apiGet(request, '/auth/me', seedHex)
}

/**
 * Test endpoint access with a specific seed.
 * Returns just the status code — useful for permission enforcement tests.
 */
export async function testEndpointAccess(
  request: APIRequestContext,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  seedHex: string,
  body?: Record<string, unknown>,
): Promise<number> {
  switch (method) {
    case 'GET':
      return (await apiGet(request, path, seedHex)).status
    case 'POST':
      return (await apiPost(request, path, body ?? {}, seedHex)).status
    case 'PATCH':
      return (await apiPatch(request, path, body ?? {}, seedHex)).status
    case 'PUT':
      return (await apiPut(request, path, body ?? {}, seedHex)).status
    case 'DELETE':
      return (await apiDelete(request, path, seedHex)).status
  }
}

// ── Cleanup ───────────────────────────────────────────────────────

export async function cleanupTestData(
  request: APIRequestContext,
  data: {
    userPubkeys?: string[]
    /** @deprecated Use userPubkeys instead */
    volunteerPubkeys?: string[]
    banPhones?: string[]
    shiftIds?: string[]
    roleIds?: string[]
  },
): Promise<void> {
  const errors: string[] = []

  for (const pubkey of [...(data.userPubkeys ?? []), ...(data.volunteerPubkeys ?? [])]) {
    try { await deleteUserViaApi(request, pubkey) } catch (e) { errors.push(String(e)) }
  }
  for (const phone of data.banPhones ?? []) {
    try { await removeBanViaApi(request, phone) } catch (e) { errors.push(String(e)) }
  }
  for (const id of data.shiftIds ?? []) {
    try { await deleteShiftViaApi(request, id) } catch (e) { errors.push(String(e)) }
  }
  for (const id of data.roleIds ?? []) {
    try { await deleteRoleViaApi(request, id) } catch (e) { errors.push(String(e)) }
  }

  if (errors.length > 0) {
    console.warn('Cleanup errors:', errors.join(', '))
  }
}

// ── Case Management: Entity Schema (Epic 315) ──────────────────────

export async function enableCaseManagementViaApi(
  request: APIRequestContext,
  enabled = true,
  seedHex = ADMIN_SEED,
  hubId?: string,
): Promise<{ enabled: boolean }> {
  const { status, data } = await apiPut<{ enabled: boolean }>(request, hubPath('/settings/cms/case-management', hubId), { enabled }, seedHex)
  if (status !== 200) throw new Error(`Failed to toggle case management: ${status}`)
  return data
}

export async function getCaseManagementEnabledViaApi(
  request: APIRequestContext,
  seedHex = ADMIN_SEED,
  hubId?: string,
): Promise<{ enabled: boolean }> {
  const { data } = await apiGet<{ enabled: boolean }>(request, hubPath('/settings/cms/case-management', hubId), seedHex)
  return data
}

export async function createEntityTypeViaApi(
  request: APIRequestContext,
  options?: {
    name?: string
    label?: string
    category?: string
    color?: string
    hubId?: string
    statuses?: Array<{ value: string; label: string; order: number; isClosed?: boolean }>
    fields?: Array<{ name: string; label: string; type: string; required?: boolean; order: number }>
    numberPrefix?: string
  },
  seedHex = ADMIN_SEED,
): Promise<Record<string, unknown>> {
  const name = options?.name ?? `test_type_${Date.now()}`
  const defaultStatuses = [
    { value: 'open', label: 'Open', order: 0 },
    { value: 'closed', label: 'Closed', order: 1, isClosed: true },
  ]
  const { status, data } = await apiPost<Record<string, unknown>>(
    request,
    hubPath('/settings/cms/entity-types', options?.hubId),
    {
      name,
      label: options?.label ?? name.replace(/_/g, ' '),
      labelPlural: options?.label ? `${options.label}s` : `${name.replace(/_/g, ' ')}s`,
      description: `Test entity type ${name}`,
      category: options?.category ?? 'case',
      color: options?.color,
      hubId: options?.hubId ?? '',
      statuses: options?.statuses ?? defaultStatuses,
      defaultStatus: (options?.statuses ?? defaultStatuses)[0].value,
      closedStatuses: (options?.statuses ?? defaultStatuses).filter(s => (s as Record<string, unknown>).isClosed).map(s => s.value),
      fields: (options?.fields ?? []).map((f, i) => ({
        ...f,
        label: f.label ?? f.name,
        required: f.required ?? false,
        order: f.order ?? i,
        indexable: false,
        indexType: 'none',
        accessLevel: 'all',
        visibleToUsers: true,
        editableByUsers: true,
        hubEditable: true,
      })),
      numberPrefix: options?.numberPrefix,
      numberingEnabled: !!options?.numberPrefix,
    },
    seedHex,
  )
  // 409 = entity type already exists (TOCTOU race in parallel test workers).
  // The concurrent create may still be mid-commit; retry the list with backoff.
  if (status === 409) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 200 * attempt))
      const types = await listEntityTypesViaApi(request, options?.hubId, seedHex)
      const existing = types.find(t => t.name === name)
      if (existing) return existing
    }
    throw new Error(`Entity type '${name}' returned 409 but not found after retries (hubId=${options?.hubId})`)
  }
  if (status !== 201 && status !== 200) throw new Error(`Failed to create entity type: ${status}`)
  return data
}

export async function listEntityTypesViaApi(
  request: APIRequestContext,
  hubId?: string,
  seedHex = ADMIN_SEED,
): Promise<Record<string, unknown>[]> {
  const path = hubId ? `/settings/cms/entity-types?hubId=${hubId}` : '/settings/cms/entity-types'
  const { data } = await apiGet<{ entityTypes: Record<string, unknown>[] }>(request, path, seedHex)
  return data?.entityTypes ?? []
}

export async function updateEntityTypeViaApi(
  request: APIRequestContext,
  id: string,
  updates: Record<string, unknown>,
  seedHex = ADMIN_SEED,
  hubId?: string,
): Promise<Record<string, unknown>> {
  const { status, data } = await apiPatch<Record<string, unknown>>(request, hubPath(`/settings/cms/entity-types/${id}`, hubId), updates, seedHex)
  if (status !== 200) throw new Error(`Failed to update entity type: ${status}`)
  return data
}

export async function deleteEntityTypeViaApi(
  request: APIRequestContext,
  id: string,
  seedHex = ADMIN_SEED,
  hubId?: string,
): Promise<void> {
  const { status } = await apiDelete(request, hubPath(`/settings/cms/entity-types/${id}`, hubId), seedHex)
  if (status !== 200) throw new Error(`Failed to delete entity type: ${status}`)
}

export async function createRelationshipTypeViaApi(
  request: APIRequestContext,
  options: {
    sourceEntityTypeId: string
    targetEntityTypeId: string
    cardinality?: string
    label?: string
    reverseLabel?: string
    hubId?: string
  },
  seedHex = ADMIN_SEED,
): Promise<Record<string, unknown>> {
  const { status, data } = await apiPost<Record<string, unknown>>(
    request,
    hubPath('/settings/cms/relationship-types', options.hubId),
    {
      sourceEntityTypeId: options.sourceEntityTypeId,
      targetEntityTypeId: options.targetEntityTypeId,
      cardinality: options.cardinality ?? 'M:N',
      label: options.label ?? 'Related',
      reverseLabel: options.reverseLabel ?? 'Related',
      sourceLabel: 'has',
      targetLabel: 'belongs to',
      hubId: options.hubId ?? '',
    },
    seedHex,
  )
  if (status !== 201 && status !== 200) throw new Error(`Failed to create relationship type: ${status}`)
  return data
}

export async function generateCaseNumberViaApi(
  request: APIRequestContext,
  prefix: string,
  hubId?: string,
  seedHex = ADMIN_SEED,
): Promise<{ number: string; sequence: number }> {
  const { status, data } = await apiPost<{ number: string; sequence: number }>(
    request,
    '/settings/cms/case-number',
    { prefix, hubId: hubId ?? '' },
    seedHex,
  )
  if (status !== 200) throw new Error(`Failed to generate case number: ${status}`)
  return data
}

// ── Case Management: Templates (Epic 317) ──────────────────────────

export interface TemplateSummary {
  id: string
  version: string
  name: string
  description: string
  tags: string[]
  entityTypeCount: number
  extends: string[]
}

export async function listTemplatesViaApi(
  request: APIRequestContext,
  seedHex = ADMIN_SEED,
  hubId?: string,
): Promise<TemplateSummary[]> {
  const { status, data } = await apiGet<{ templates: TemplateSummary[] }>(request, hubPath('/settings/cms/templates', hubId), seedHex)
  if (status !== 200) throw new Error(`Failed to list templates: ${status}`)
  return data.templates
}

export async function getTemplateViaApi(
  request: APIRequestContext,
  templateId: string,
  seedHex = ADMIN_SEED,
  hubId?: string,
): Promise<Record<string, unknown>> {
  const { status, data } = await apiGet<Record<string, unknown>>(request, hubPath(`/settings/cms/templates/${templateId}`, hubId), seedHex)
  if (status !== 200) throw new Error(`Failed to get template: ${status}`)
  return data
}

export async function applyTemplateViaApi(
  request: APIRequestContext,
  templateId: string,
  seedHex = ADMIN_SEED,
  hubId?: string,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const body: Record<string, unknown> = { templateId }
  if (hubId) body.hubId = hubId
  return apiPost<Record<string, unknown>>(request, hubPath('/settings/cms/templates/apply', hubId), body, seedHex)
}

// ── Case Management: CMS Report Types (Epic 343) ────────────────

export async function listCmsReportTypesViaApi(
  request: APIRequestContext,
  hubId?: string,
  seedHex = ADMIN_SEED,
): Promise<Record<string, unknown>[]> {
  const path = hubId ? `/settings/cms/report-types?hubId=${hubId}` : '/settings/cms/report-types'
  const { data } = await apiGet<{ reportTypes: Record<string, unknown>[] }>(request, path, seedHex)
  return data?.reportTypes ?? []
}

export async function getCmsReportTypeViaApi(
  request: APIRequestContext,
  id: string,
  seedHex = ADMIN_SEED,
  hubId?: string,
): Promise<Record<string, unknown>> {
  const { status, data } = await apiGet<Record<string, unknown>>(request, hubPath(`/settings/cms/report-types/${id}`, hubId), seedHex)
  if (status !== 200) throw new Error(`Failed to get CMS report type: ${status}`)
  return data
}

export async function createCmsReportTypeViaApi(
  request: APIRequestContext,
  options?: {
    name?: string
    label?: string
    labelPlural?: string
    description?: string
    hubId?: string
    fields?: Array<Record<string, unknown>>
    statuses?: Array<{ value: string; label: string; order: number; isClosed?: boolean }>
    allowCaseConversion?: boolean
    mobileOptimized?: boolean
    allowFileAttachments?: boolean
  },
  seedHex = ADMIN_SEED,
): Promise<Record<string, unknown>> {
  const name = options?.name ?? `test_report_type_${Date.now()}`
  const defaultStatuses = [
    { value: 'submitted', label: 'Submitted', order: 0 },
    { value: 'closed', label: 'Closed', order: 1, isClosed: true },
  ]
  const { status, data } = await apiPost<Record<string, unknown>>(
    request,
    '/settings/cms/report-types',
    {
      name,
      label: options?.label ?? name.replace(/_/g, ' '),
      labelPlural: options?.labelPlural ?? `${name.replace(/_/g, ' ')}s`,
      description: options?.description ?? `Test report type ${name}`,
      hubId: options?.hubId ?? '',
      statuses: options?.statuses ?? defaultStatuses,
      defaultStatus: (options?.statuses ?? defaultStatuses)[0].value,
      closedStatuses: (options?.statuses ?? defaultStatuses).filter(s => (s as Record<string, unknown>).isClosed).map(s => s.value),
      fields: (options?.fields ?? []).map((f, i) => ({
        ...f,
        label: f.label ?? f.name,
        required: f.required ?? false,
        order: f.order ?? i,
        indexable: false,
        indexType: 'none',
        accessLevel: 'all',
        visibleToUsers: true,
        editableByUsers: true,
        hubEditable: true,
        supportAudioInput: f.supportAudioInput ?? false,
      })),
      allowCaseConversion: options?.allowCaseConversion ?? false,
      mobileOptimized: options?.mobileOptimized ?? false,
      allowFileAttachments: options?.allowFileAttachments ?? true,
    },
    seedHex,
  )
  if (status !== 201 && status !== 200) throw new Error(`Failed to create CMS report type: ${status}`)
  return data
}

export async function updateCmsReportTypeViaApi(
  request: APIRequestContext,
  id: string,
  updates: Record<string, unknown>,
  seedHex = ADMIN_SEED,
  hubId?: string,
): Promise<Record<string, unknown>> {
  const { status, data } = await apiPatch<Record<string, unknown>>(request, hubPath(`/settings/cms/report-types/${id}`, hubId), updates, seedHex)
  if (status !== 200) throw new Error(`Failed to update CMS report type: ${status}`)
  return data
}

export async function deleteCmsReportTypeViaApi(
  request: APIRequestContext,
  id: string,
  seedHex = ADMIN_SEED,
  hubId?: string,
): Promise<void> {
  const { status } = await apiDelete(request, hubPath(`/settings/cms/report-types/${id}`, hubId), seedHex)
  if (status !== 200) throw new Error(`Failed to archive CMS report type: ${status}`)
}

// ── Case Management: Contacts (Epic 318) ──────────────────────────

/**
 * Convenience wrapper: create a contact by display name.
 * Encrypts the contact summary (matching the E2EE format) and sends
 * to POST /directory with proper blind indexes and trigram tokens for search.
 */
export async function createContactByNameViaApi(
  request: APIRequestContext,
  displayName: string,
  extraOptions?: { contactTypeHash?: string; hubId?: string },
  seedHex = ADMIN_SEED,
): Promise<Record<string, unknown>> {
  const contactType = extraOptions?.contactTypeHash ?? 'individual'
  // Build trigram tokens for name search
  const normalized = displayName.toLowerCase()
  const trigrams: string[] = []
  for (let i = 0; i <= normalized.length - 3; i++) {
    trigrams.push(normalized.slice(i, i + 3))
  }
  const nameHash = bytesToHex(utf8ToBytes(normalized)).slice(0, 32)

  // Encrypt the summary the way the desktop client's encryptMessage does, for
  // the admin reader, so the directory renders the contact instead of the
  // "Restricted" placeholder (issue #796).
  const { encryptedContent: encryptedSummary, readerEnvelopes } = encryptMessageForDesktop(
    JSON.stringify({ displayName, contactType, tags: [] }),
    [seedHex],
  )

  return createContactViaApi(request, {
    encryptedSummary,
    summaryEnvelopes: readerEnvelopes,
    identifierHashes: [`name_${Date.now()}_${Math.random().toString(36).slice(2)}`],
    contactTypeHash: contactType,
    nameHash,
    trigramTokens: trigrams,
    hubId: extraOptions?.hubId,
  }, seedHex)
}

/**
 * Create a real HPKE envelope wrapping a content key for a recipient.
 * Uses the same DHKEM(X25519, HKDF-SHA256) + AES-256-GCM as production code.
 */
async function realEnvelope(
  contentKey: Uint8Array,
  seedHex = ADMIN_SEED,
  label = LABEL_NOTE_KEY,
): Promise<{ pubkey: string; ct: string; enc: string }> {
  const x25519Pubkey = x25519PubkeyFromSeed(seedHex)
  const envelope = await wrapKeyForRecipient(contentKey, x25519Pubkey, seedHex, label)
  return { pubkey: x25519Pubkey, ...envelope }
}

/**
 * Encrypt content with real AES-256-GCM and produce HPKE envelopes for recipients.
 * Returns the hex ciphertext and an array of recipient envelopes.
 * This replaces all fake base64 "encryption" in test helpers.
 */
export async function encryptForTest(
  plaintext: string,
  recipientSeedHexes: string[] = [ADMIN_SEED],
  label = LABEL_NOTE_KEY,
): Promise<{ encryptedContent: string; envelopes: Array<{ pubkey: string; ct: string; enc: string }> }> {
  const contentKey = generateContentKey()
  const encryptedContent = encryptContent(plaintext, contentKey, label)
  const envelopes = await Promise.all(
    recipientSeedHexes.map(seed => realEnvelope(contentKey, seed, label)),
  )
  return { encryptedContent, envelopes }
}

export async function createContactViaApi(
  request: APIRequestContext,
  options?: {
    identifierHashes?: string[]
    nameHash?: string
    trigramTokens?: string[]
    encryptedSummary?: string
    /**
     * Reader envelopes for `encryptedSummary`, when the caller encrypted it
     * itself (e.g. createContactByNameViaApi via encryptMessageForDesktop, so
     * the desktop UI can decrypt it — issue #796). When omitted, the envelope
     * wraps an unrelated fresh key: fine for backend-only scenarios that never
     * decrypt the summary, but the contact is then permanently undecryptable.
     */
    summaryEnvelopes?: DesktopReaderEnvelope[]
    contactTypeHash?: string
    hubId?: string
  },
  seedHex = ADMIN_SEED,
): Promise<Record<string, unknown>> {
  let encryptedSummary = options?.encryptedSummary
  let summaryEnvelopes = options?.summaryEnvelopes
  if (!summaryEnvelopes) {
    const contentKey = generateContentKey()
    encryptedSummary ??= encryptContent('test contact summary', contentKey, LABEL_NOTE_KEY)
    summaryEnvelopes = [await realEnvelope(contentKey, seedHex)]
  }
  const { status, data } = await apiPost<Record<string, unknown>>(
    request,
    hubPath('/directory', options?.hubId),
    {
      hubId: options?.hubId ?? '',
      identifierHashes: options?.identifierHashes ?? [`idhash_${Date.now()}_${Math.random().toString(36).slice(2)}`],
      nameHash: options?.nameHash,
      trigramTokens: options?.trigramTokens,
      encryptedSummary,
      summaryEnvelopes,
      contactTypeHash: options?.contactTypeHash,
      tagHashes: [],
      blindIndexes: {},
    },
    seedHex,
  )
  if (status !== 201 && status !== 200) throw new Error(`Failed to create contact: ${status}`)
  return data
}

export async function listContactsViaApi(
  request: APIRequestContext,
  params?: { page?: number; limit?: number; contactTypeHash?: string; hubId?: string },
  seedHex = ADMIN_SEED,
): Promise<{ contacts: Record<string, unknown>[]; total: number; hasMore: boolean }> {
  const qs = new URLSearchParams()
  if (params?.page) qs.set('page', String(params.page))
  if (params?.limit) qs.set('limit', String(params.limit))
  if (params?.contactTypeHash) qs.set('contactTypeHash', params.contactTypeHash)
  const qsStr = qs.toString()
  const path = `${hubPath('/directory', params?.hubId)}${qsStr ? `?${qsStr}` : ''}`
  const { status, data } = await apiGet<{ contacts: Record<string, unknown>[]; total: number; hasMore: boolean }>(request, path, seedHex)
  if (status !== 200) throw new Error(`Failed to list contacts: ${status}`)
  return data
}

export async function lookupContactViaApi(
  request: APIRequestContext,
  identifierHash: string,
  hubId?: string,
  seedHex = ADMIN_SEED,
): Promise<{ contact: Record<string, unknown> | null }> {
  const { status, data } = await apiGet<{ contact: Record<string, unknown> | null }>(request, `${hubPath('/directory', hubId)}/lookup/${identifierHash}`, seedHex)
  if (status !== 200) throw new Error(`Failed to lookup contact: ${status}`)
  return data
}

export async function updateContactViaApi(
  request: APIRequestContext,
  contactId: string,
  updates: Record<string, unknown>,
  hubId?: string,
  seedHex = ADMIN_SEED,
): Promise<Record<string, unknown>> {
  const { status, data } = await apiPatch<Record<string, unknown>>(request, `${hubPath('/directory', hubId)}/${contactId}`, updates, seedHex)
  if (status !== 200) throw new Error(`Failed to update contact: ${status}`)
  return data
}

export async function deleteContactViaApi(
  request: APIRequestContext,
  contactId: string,
  hubId?: string,
  seedHex = ADMIN_SEED,
): Promise<void> {
  const { status } = await apiDelete(request, `${hubPath('/directory', hubId)}/${contactId}`, seedHex)
  if (status !== 200) throw new Error(`Failed to delete contact: ${status}`)
}

// ── Case Management: Records (Epic 319) ──────────────────────────

export async function createRecordViaApi(
  request: APIRequestContext,
  entityTypeId: string,
  options?: {
    statusHash?: string
    assignedTo?: string[]
    blindIndexes?: Record<string, string>
    parentRecordId?: string
    hubId?: string
  },
  seedHex = ADMIN_SEED,
): Promise<Record<string, unknown>> {
  const contentKey = generateContentKey()
  const encryptedSummary = encryptContent('test record', contentKey, LABEL_NOTE_KEY)
  const envelope = await realEnvelope(contentKey, seedHex)
  const { status, data } = await apiPost<Record<string, unknown>>(
    request,
    hubPath('/records', options?.hubId),
    {
      entityTypeId,
      statusHash: options?.statusHash ?? 'status_open_hash',
      assignedTo: options?.assignedTo ?? [],
      blindIndexes: options?.blindIndexes ?? {},
      encryptedSummary,
      summaryEnvelopes: [envelope],
      parentRecordId: options?.parentRecordId,
    },
    seedHex,
  )
  if (status !== 201 && status !== 200) throw new Error(`Failed to create record: ${status}`)
  return data
}

export async function listRecordsViaApi(
  request: APIRequestContext,
  params?: { entityTypeId?: string; statusHash?: string; assignedTo?: string; parentRecordId?: string; page?: number; limit?: number; hubId?: string },
  seedHex = ADMIN_SEED,
): Promise<{ records: Record<string, unknown>[]; total: number; hasMore: boolean }> {
  const qs = new URLSearchParams()
  if (params?.page) qs.set('page', String(params.page))
  if (params?.limit) qs.set('limit', String(params.limit))
  if (params?.entityTypeId) qs.set('entityTypeId', params.entityTypeId)
  if (params?.statusHash) qs.set('statusHash', params.statusHash)
  if (params?.assignedTo) qs.set('assignedTo', params.assignedTo)
  if (params?.parentRecordId) qs.set('parentRecordId', params.parentRecordId)
  const qsStr = qs.toString()
  const path = `${hubPath('/records', params?.hubId)}${qsStr ? `?${qsStr}` : ''}`
  const { status, data } = await apiGet<{ records: Record<string, unknown>[]; total: number; hasMore: boolean }>(request, path, seedHex)
  if (status !== 200) throw new Error(`Failed to list records: ${status}`)
  return data
}

export async function getRecordViaApi(
  request: APIRequestContext,
  recordId: string,
  hubId?: string,
  seedHex = ADMIN_SEED,
): Promise<Record<string, unknown>> {
  const { status, data } = await apiGet<Record<string, unknown>>(request, `${hubPath('/records', hubId)}/${recordId}`, seedHex)
  if (status !== 200) throw new Error(`Failed to get record: ${status}`)
  return data
}

export async function updateRecordViaApi(
  request: APIRequestContext,
  recordId: string,
  updates: Record<string, unknown>,
  hubId?: string,
  seedHex = ADMIN_SEED,
): Promise<Record<string, unknown>> {
  const { status, data } = await apiPatch<Record<string, unknown>>(request, `${hubPath('/records', hubId)}/${recordId}`, updates, seedHex)
  if (status !== 200) throw new Error(`Failed to update record: ${status}`)
  return data
}

export async function linkContactToRecordViaApi(
  request: APIRequestContext,
  recordId: string,
  contactId: string,
  role: string,
  seedHex = ADMIN_SEED,
  hubId?: string,
): Promise<Record<string, unknown>> {
  const { status, data } = await apiPost<Record<string, unknown>>(
    request,
    hubPath(`/records/${recordId}/contacts`, hubId),
    { contactId, role },
    seedHex,
  )
  if (status !== 201 && status !== 200) throw new Error(`Failed to link contact to record: ${status}`)
  return data
}

export async function listRecordContactsViaApi(
  request: APIRequestContext,
  recordId: string,
  seedHex = ADMIN_SEED,
  hubId?: string,
): Promise<{ contacts: Record<string, unknown>[] }> {
  const { status, data } = await apiGet<{ contacts: Record<string, unknown>[] }>(request, hubPath(`/records/${recordId}/contacts`, hubId), seedHex)
  if (status !== 200) throw new Error(`Failed to list record contacts: ${status}`)
  return data
}

export async function assignRecordViaApi(
  request: APIRequestContext,
  recordId: string,
  pubkeys: string[],
  seedHex = ADMIN_SEED,
  hubId?: string,
): Promise<void> {
  const { status } = await apiPost(request, hubPath(`/records/${recordId}/assign`, hubId), { pubkeys }, seedHex)
  if (status !== 200) throw new Error(`Failed to assign record: ${status}`)
}

// ── Case Management: Events (Epic 320) ──────────────────────────

export async function createEventViaApi(
  request: APIRequestContext,
  entityTypeId: string,
  options?: {
    startDate?: string
    endDate?: string
    eventTypeHash?: string
    statusHash?: string
    parentEventId?: string
    hubId?: string
  },
  seedHex = ADMIN_SEED,
): Promise<Record<string, unknown>> {
  const contentKey = generateContentKey()
  const encryptedDetails = encryptContent('test event', contentKey, LABEL_NOTE_KEY)
  const envelope = await realEnvelope(contentKey, seedHex)
  const { status, data } = await apiPost<Record<string, unknown>>(
    request,
    hubPath('/events', options?.hubId),
    {
      entityTypeId,
      startDate: options?.startDate ?? new Date().toISOString(),
      endDate: options?.endDate,
      parentEventId: options?.parentEventId,
      eventTypeHash: options?.eventTypeHash ?? 'event_type_hash',
      statusHash: options?.statusHash ?? 'event_status_hash',
      blindIndexes: {},
      encryptedDetails,
      detailEnvelopes: [envelope],
      locationPrecision: 'neighborhood',
    },
    seedHex,
  )
  if (status !== 201 && status !== 200) throw new Error(`Failed to create event: ${status}`)
  return data
}

export async function linkRecordToEventViaApi(
  request: APIRequestContext,
  eventId: string,
  recordId: string,
  seedHex = ADMIN_SEED,
  hubId?: string,
): Promise<void> {
  const { status } = await apiPost(request, hubPath(`/events/${eventId}/records`, hubId), { recordId }, seedHex)
  if (status !== 201 && status !== 200) throw new Error(`Failed to link record to event: ${status}`)
}

export async function linkReportToEventViaApi(
  request: APIRequestContext,
  eventId: string,
  reportId: string,
  seedHex = ADMIN_SEED,
  hubId?: string,
): Promise<void> {
  const { status } = await apiPost(request, hubPath(`/events/${eventId}/reports`, hubId), { reportId }, seedHex)
  if (status !== 201 && status !== 200) throw new Error(`Failed to link report to event: ${status}`)
}

export async function listEventRecordsViaApi(
  request: APIRequestContext,
  eventId: string,
  seedHex = ADMIN_SEED,
  hubId?: string,
): Promise<{ links: Record<string, unknown>[] }> {
  const { status, data } = await apiGet<{ links: Record<string, unknown>[] }>(request, hubPath(`/events/${eventId}/records`, hubId), seedHex)
  if (status !== 200) throw new Error(`Failed to list event records: ${status}`)
  return data
}

export async function listEventReportsViaApi(
  request: APIRequestContext,
  eventId: string,
  seedHex = ADMIN_SEED,
  hubId?: string,
): Promise<{ links: Record<string, unknown>[] }> {
  const { status, data } = await apiGet<{ links: Record<string, unknown>[] }>(request, hubPath(`/events/${eventId}/reports`, hubId), seedHex)
  if (status !== 200) throw new Error(`Failed to list event reports: ${status}`)
  return data
}

// ── Case Management: Interactions (Epic 323) ──────────────────────

export async function createInteractionViaApi(
  request: APIRequestContext,
  caseId: string,
  options: {
    interactionType: string
    sourceId?: string
    encryptedContent?: string
    interactionTypeHash?: string
    previousStatusHash?: string
    newStatusHash?: string
    hubId?: string
  },
  seedHex = ADMIN_SEED,
): Promise<Record<string, unknown>> {
  const contentKey = generateContentKey()
  const body: Record<string, unknown> = {
    interactionType: options.interactionType,
    interactionTypeHash: options.interactionTypeHash ?? `${options.interactionType}_hash`,
  }
  // Schema requires sourceId for note/call/message; encryptedContent for comment
  if (options.interactionType === 'comment' && !options.encryptedContent) {
    body.encryptedContent = encryptContent('test comment', contentKey, LABEL_NOTE_KEY)
    body.contentEnvelopes = [await realEnvelope(contentKey, seedHex)]
  }
  if (['note', 'call', 'message'].includes(options.interactionType) && !options.sourceId) {
    body.sourceId = crypto.randomUUID()
  }
  if (options.sourceId) body.sourceId = options.sourceId
  if (options.encryptedContent) {
    body.encryptedContent = options.encryptedContent
    body.contentEnvelopes = [await realEnvelope(contentKey, seedHex)]
  }
  if (options.previousStatusHash) body.previousStatusHash = options.previousStatusHash
  if (options.newStatusHash) body.newStatusHash = options.newStatusHash

  const { status, data } = await apiPost<Record<string, unknown>>(
    request,
    hubPath(`/records/${caseId}/interactions`, options.hubId),
    body,
    seedHex,
  )
  if (status !== 201 && status !== 200) throw new Error(`Failed to create interaction: ${status}`)
  return data
}

export async function listInteractionsViaApi(
  request: APIRequestContext,
  caseId: string,
  params?: { page?: number; limit?: number; interactionTypeHash?: string; hubId?: string },
  seedHex = ADMIN_SEED,
): Promise<{ interactions: Record<string, unknown>[]; total: number }> {
  const qs = new URLSearchParams()
  if (params?.page) qs.set('page', String(params.page))
  if (params?.limit) qs.set('limit', String(params.limit))
  if (params?.interactionTypeHash) qs.set('interactionTypeHash', params.interactionTypeHash)
  const qsStr = qs.toString()
  const path = `${hubPath(`/records/${caseId}/interactions`, params?.hubId)}${qsStr ? `?${qsStr}` : ''}`
  const { status, data } = await apiGet<{ interactions: Record<string, unknown>[]; total: number }>(request, path, seedHex)
  if (status !== 200) throw new Error(`Failed to list interactions: ${status}`)
  return data
}

// ── Case Management: Evidence (Epic 325) ──────────────────────────

export async function uploadEvidenceViaApi(
  request: APIRequestContext,
  caseId: string,
  options?: {
    fileId?: string
    filename?: string
    mimeType?: string
    sizeBytes?: number
    classification?: string
    integrityHash?: string
    hubId?: string
  },
  seedHex = ADMIN_SEED,
): Promise<Record<string, unknown>> {
  const hash = options?.integrityHash ?? 'a'.repeat(64)
  const { status, data } = await apiPost<Record<string, unknown>>(
    request,
    hubPath(`/records/${caseId}/evidence`, options?.hubId),
    {
      fileId: options?.fileId ?? `file_${Date.now()}`,
      filename: options?.filename ?? `test_evidence_${Date.now()}.jpg`,
      mimeType: options?.mimeType ?? 'image/jpeg',
      sizeBytes: options?.sizeBytes ?? 1024,
      classification: options?.classification ?? 'photo',
      integrityHash: hash,
      source: 'volunteer_upload',
    },
    seedHex,
  )
  if (status !== 201 && status !== 200) throw new Error(`Failed to upload evidence: ${status}`)
  return data
}

export async function getEvidenceCustodyViaApi(
  request: APIRequestContext,
  evidenceId: string,
  seedHex = ADMIN_SEED,
  hubId?: string,
): Promise<{ custodyChain: Record<string, unknown>[]; total: number }> {
  const { status, data } = await apiGet<{ custodyChain: Record<string, unknown>[]; total: number }>(
    request,
    hubPath(`/evidence/${evidenceId}/custody`, hubId),
    seedHex,
  )
  if (status !== 200) throw new Error(`Failed to get custody chain: ${status}`)
  return data
}

export async function verifyEvidenceIntegrityViaApi(
  request: APIRequestContext,
  evidenceId: string,
  currentHash: string,
  seedHex = ADMIN_SEED,
  hubId?: string,
): Promise<{ valid: boolean; originalHash: string; currentHash: string }> {
  const { status, data } = await apiPost<{ valid: boolean; originalHash: string; currentHash: string }>(
    request,
    hubPath(`/evidence/${evidenceId}/verify`, hubId),
    { currentHash },
    seedHex,
  )
  if (status !== 200) throw new Error(`Failed to verify evidence integrity: ${status}`)
  return data
}

// ── Telephony-CRM: Caller Identification (Epic 326) ──────────────────

export interface CallerIdentificationResult {
  contact: Record<string, unknown> | null
  activeCaseCount: number
  recentCases: Array<{ id: string; caseNumber?: string; status: string }>
}

export async function identifyCallerViaApi(
  request: APIRequestContext,
  identifierHash: string,
  seedHex = ADMIN_SEED,
  hubId?: string,
): Promise<CallerIdentificationResult> {
  const path = hubId
    ? `/hubs/${hubId}/calls/identify/${identifierHash}`
    : `/calls/identify/${identifierHash}`
  const { status, data } = await apiGet<CallerIdentificationResult>(
    request,
    path,
    seedHex,
  )
  if (status !== 200) throw new Error(`Failed to identify caller: ${status}`)
  return data
}

export async function listRecordsByContactViaApi(
  request: APIRequestContext,
  contactId: string,
  seedHex = ADMIN_SEED,
  hubId?: string,
): Promise<{ records: Record<string, unknown>[]; total: number }> {
  // Hub isolation (Epic E): use hub-scoped path when hubId is provided
  const path = hubId
    ? `/hubs/${hubId}/records/by-contact/${contactId}`
    : `/records/by-contact/${contactId}`
  const { status, data } = await apiGet<{ records: Record<string, unknown>[]; total: number }>(
    request,
    path,
    seedHex,
  )
  if (status !== 200) throw new Error(`Failed to list records by contact: ${status}`)
  return data
}

// ── Case Management: Cross-Hub Sharing (Epic 328) ──────────────────

export async function enableCrossHubSharingViaApi(
  request: APIRequestContext,
  enabled: boolean,
  seedHex = ADMIN_SEED,
  hubId?: string,
): Promise<{ enabled: boolean }> {
  const { status, data } = await apiPut<{ enabled: boolean }>(
    request,
    hubPath('/settings/cms/cross-hub', hubId),
    { enabled },
    seedHex,
  )
  if (status !== 200) throw new Error(`Failed to toggle cross-hub sharing: ${status}`)
  return data
}

export async function getCrossHubSharingViaApi(
  request: APIRequestContext,
  seedHex = ADMIN_SEED,
  hubId?: string,
): Promise<{ enabled: boolean }> {
  const { data } = await apiGet<{ enabled: boolean }>(
    request,
    hubPath('/settings/cms/cross-hub', hubId),
    seedHex,
  )
  return data
}

// ── Case Management: Notifications (Epic 327) ──────────────────

export interface NotifyContactsResult {
  recordId: string
  notified: number
  skipped: number
  results: Array<{
    identifier: string
    channel: string
    success: boolean
    error?: string
  }>
}

/**
 * Send notifications to support contacts for a record.
 * The client pre-renders messages (E2EE constraint).
 */
export async function notifyContactsViaApi(
  request: APIRequestContext,
  recordId: string,
  recipients: Array<{
    identifier: string
    channel: 'sms' | 'signal' | 'whatsapp'
    message: string
  }>,
  statusLabel = 'released',
  seedHex = ADMIN_SEED,
): Promise<{ status: number; data: NotifyContactsResult | null }> {
  return apiPost<NotifyContactsResult>(
    request,
    `/records/${recordId}/notify-contacts`,
    {
      statusLabel,
      recipients,
    },
    seedHex,
  )
}

/**
 * Attempt to send notifications with raw body (for validation testing).
 * Does not throw on error -- returns status + data for assertion.
 */
export async function notifyContactsRawViaApi(
  request: APIRequestContext,
  recordId: string,
  body: Record<string, unknown>,
  seedHex = ADMIN_SEED,
): Promise<{ status: number; data: unknown }> {
  return apiPost(
    request,
    `/records/${recordId}/notify-contacts`,
    body,
    seedHex,
  )
}

// ── Case Management: Relationships & Affinity Groups (Epic 322) ────

export interface RelationshipResult {
  id: string
  contactIdA: string
  contactIdB: string
  relationshipType: string
  direction: string
  createdAt: string
  createdBy: string
}

export interface RelationshipListResult {
  relationships: RelationshipResult[]
}

export interface GroupResult {
  id: string
  encryptedDetails: string
  memberCount: number
  createdAt: string
  updatedAt: string
  createdBy: string
}

export interface GroupMemberResult {
  contactId: string
  role?: string
  isPrimary: boolean
}

export async function createRelationshipViaApi(
  request: APIRequestContext,
  contactIdA: string,
  contactIdB: string,
  relationshipType: string,
  direction: 'a_to_b' | 'b_to_a' | 'bidirectional' = 'bidirectional',
  seedHex = ADMIN_SEED,
  hubId?: string,
): Promise<RelationshipResult> {
  const { status, data } = await apiPost<RelationshipResult>(
    request,
    hubPath(`/directory/${contactIdA}/relationships`, hubId),
    { contactIdB, relationshipType, direction },
    seedHex,
  )
  if (status !== 201 && status !== 200) throw new Error(`Failed to create relationship: ${status}`)
  return data
}

export async function listRelationshipsViaApi(
  request: APIRequestContext,
  contactId: string,
  seedHex = ADMIN_SEED,
  hubId?: string,
): Promise<RelationshipListResult> {
  const { status, data } = await apiGet<RelationshipListResult>(
    request,
    hubPath(`/directory/${contactId}/relationships`, hubId),
    seedHex,
  )
  if (status !== 200) throw new Error(`Failed to list relationships: ${status}`)
  return data
}

export async function deleteRelationshipViaApi(
  request: APIRequestContext,
  contactId: string,
  relId: string,
  seedHex = ADMIN_SEED,
  hubId?: string,
): Promise<void> {
  const { status } = await apiDelete(
    request,
    hubPath(`/directory/${contactId}/relationships/${relId}`, hubId),
    seedHex,
  )
  if (status !== 200) throw new Error(`Failed to delete relationship: ${status}`)
}

export async function createAffinityGroupViaApi(
  request: APIRequestContext,
  name: string,
  initialMembers: Array<{ contactId: string; role?: string; isPrimary?: boolean }> = [],
  seedHex = ADMIN_SEED,
  hubId?: string,
): Promise<GroupResult> {
  const contentKey = generateContentKey()
  const encryptedDetails = encryptContent(JSON.stringify({ name }), contentKey, LABEL_NOTE_KEY)
  const envelope = await realEnvelope(contentKey, seedHex)
  // The group body requires at least one member. If none provided, the caller
  // must supply initialMembers. The encryptedDetails is encrypted with real AES-256-GCM.
  const members = initialMembers.map(m => ({
    contactId: m.contactId,
    role: m.role,
    isPrimary: m.isPrimary ?? false,
  }))
  const { status, data } = await apiPost<GroupResult>(
    request,
    hubPath('/directory/groups', hubId),
    {
      encryptedDetails,
      detailEnvelopes: [envelope],
      members,
    },
    seedHex,
  )
  if (status !== 201 && status !== 200) throw new Error(`Failed to create affinity group: ${status}`)
  return data
}

export async function addGroupMemberViaApi(
  request: APIRequestContext,
  groupId: string,
  contactId: string,
  role?: string,
  seedHex = ADMIN_SEED,
  hubId?: string,
): Promise<{ added: boolean; memberCount: number }> {
  const { status, data } = await apiPost<{ added: boolean; memberCount: number }>(
    request,
    hubPath(`/directory/groups/${groupId}/members`, hubId),
    { contactId, role, isPrimary: false },
    seedHex,
  )
  if (status !== 201 && status !== 200) throw new Error(`Failed to add group member: ${status}`)
  return data
}

export async function removeGroupMemberViaApi(
  request: APIRequestContext,
  groupId: string,
  contactId: string,
  seedHex = ADMIN_SEED,
  hubId?: string,
): Promise<void> {
  const { status } = await apiDelete(
    request,
    hubPath(`/directory/groups/${groupId}/members/${contactId}`, hubId),
    seedHex,
  )
  if (status !== 200) throw new Error(`Failed to remove group member: ${status}`)
}

export async function listGroupMembersViaApi(
  request: APIRequestContext,
  groupId: string,
  seedHex = ADMIN_SEED,
  hubId?: string,
): Promise<{ members: GroupMemberResult[] }> {
  const { status, data } = await apiGet<{ members: GroupMemberResult[] }>(
    request,
    hubPath(`/directory/groups/${groupId}/members`, hubId),
    seedHex,
  )
  if (status !== 200) throw new Error(`Failed to list group members: ${status}`)
  return data
}

export async function getAffinityGroupViaApi(
  request: APIRequestContext,
  groupId: string,
  seedHex = ADMIN_SEED,
  hubId?: string,
): Promise<GroupResult & { members: GroupMemberResult[] }> {
  const { status, data } = await apiGet<GroupResult & { members: GroupMemberResult[] }>(
    request,
    hubPath(`/directory/groups/${groupId}`, hubId),
    seedHex,
  )
  if (status !== 200) throw new Error(`Failed to get affinity group: ${status}`)
  return data
}

// ── Triage Queue (Epic 342) ──────────────────────────────────────

export async function listTriageQueueViaApi(
  request: APIRequestContext,
  params?: { conversionStatus?: string; hubId?: string },
  seedHex = ADMIN_SEED,
): Promise<{ conversations: Record<string, unknown>[]; total: number }> {
  const qs = new URLSearchParams({ conversionEnabled: 'true' })
  if (params?.conversionStatus) qs.set('conversionStatus', params.conversionStatus)
  const path = `${hubPath('/reports', params?.hubId)}?${qs}`
  const { status, data } = await apiGet<{ conversations: Record<string, unknown>[]; total: number }>(request, path, seedHex)
  if (status !== 200) throw new Error(`Failed to list triage queue: ${status}`)
  return data
}

export async function updateReportConversionStatusViaApi(
  request: APIRequestContext,
  reportId: string,
  conversionStatus: string,
  seedHex = ADMIN_SEED,
  hubId?: string,
): Promise<Record<string, unknown>> {
  const { status, data } = await apiPatch<Record<string, unknown>>(
    request,
    hubPath(`/reports/${reportId}`, hubId),
    { conversionStatus },
    seedHex,
  )
  if (status !== 200) throw new Error(`Failed to update conversion status: ${status}`)
  return data
}

export async function createCaseFromReportViaApi(
  request: APIRequestContext,
  reportId: string,
  entityTypeId: string,
  seedHex = ADMIN_SEED,
  hubId?: string,
): Promise<{ recordId: string; linkId: string }> {
  // Create the record first
  const record = await createRecordViaApi(request, entityTypeId, {
    statusHash: 'status_open_hash',
    hubId,
  }, seedHex)
  const recordId = (record as { id: string }).id

  // Link it to the report with real encryption
  const contentKey = generateContentKey()
  const encryptedNotes = encryptContent('test link', contentKey, LABEL_NOTE_KEY)
  const envelope = await realEnvelope(contentKey, seedHex)
  const { status, data } = await apiPost<{ id?: string; reportId?: string; caseId?: string }>(
    request,
    hubPath(`/reports/${reportId}/records`, hubId),
    {
      caseId: recordId,
      encryptedNotes,
      notesEnvelopes: [envelope],
    },
    seedHex,
  )
  if (status !== 201 && status !== 200) throw new Error(`Failed to link case to report: ${status}`)
  // Response is ReportCaseRow with composite PK (reportId + caseId) — no separate id field.
  // linkId is the caseId from the row, which equals recordId.
  const linkData = data as { caseId?: string; reportId?: string }
  return { recordId, linkId: linkData.caseId ?? recordId }
}

/**
 * Upload an entity field file (encrypted blob) via POST /uploads/entity-file.
 * Returns the fileId and uploadedAt on success (201).
 */
export async function uploadEntityFileViaApi(
  request: APIRequestContext,
  blobSizeBytes: number = 1024,
  seedHex: string = ADMIN_SEED,
): Promise<{ fileId: string; uploadedAt: string }> {
  const fullPath = '/api/uploads/entity-file'
  // Use auth headers without Content-Type — Playwright sets multipart/form-data automatically
  const { 'Content-Type': _ct, ...headers } = authHeaders(seedHex, 'POST', fullPath)
  const res = await request.post(fullPath, {
    headers,
    multipart: { file: { name: 'entity-field.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(blobSizeBytes, 0xab) } },
  })
  if (res.status() !== 201) throw new Error(`uploadEntityFileViaApi failed: ${res.status()}`)
  return res.json() as Promise<{ fileId: string; uploadedAt: string }>
}

/**
 * Enable messaging channels (SMS by default) via the settings API.
 * This is needed so the conversations page renders the conversation list
 * instead of the "No messaging channels enabled" empty state.
 */
export async function enableMessagingViaApi(
  request: APIRequestContext,
  channels: string[] = ['sms'],
  nsec = ADMIN_NSEC,
): Promise<void> {
  const { status } = await apiPatch(request, '/settings/messaging', {
    enabledChannels: channels,
  }, nsec)
  if (status !== 200) {
    throw new Error(`Failed to enable messaging channels: ${status}`)
  }
}

// ── Declarative Test Seeding ─────────────────────────────────────

export interface SeedSpec {
  hubId: string
  adminSeed: string
  permissions?: {
    grantVolunteerCms?: boolean
    enableCaseManagement?: boolean
  }
  entityTypes?: Array<{
    template: 'arrest_case' | 'protest_event'
    records?: number
    assignTo?: string[]
  }>
  reportTypes?: Array<{
    template: 'general_report'
    triageReports?: number
  }>
  shifts?: Array<{
    pubkey: string
    allDay?: boolean
  }>
  members?: Array<{
    pubkey: string
    roleIds?: string[]
  }>
  contacts?: Array<{
    displayName: string
    contactType?: string
  }>
}

export interface SeedResult {
  ok: boolean
  entityTypes: Array<{ id: string; name: string; category: string; defaultStatus: string }>
  records: Array<{ id: string; entityTypeId: string; caseNumber?: string }>
  reportTypes: Array<{ id: string; name: string }>
  triageReports: Array<{ id: string }>
  shifts: Array<{ id: string }>
  contacts: Array<{ id: string }>
  members: Array<{ pubkey: string }>
  errors: string[]
}

export async function seedViaApi(
  request: APIRequestContext,
  spec: SeedSpec,
): Promise<SeedResult> {
  // test-seed is a dev route — requires X-Test-Secret, not Bearer auth
  const { status, data } = await devPost<SeedResult>(
    request,
    '/test-seed',
    spec as unknown as Record<string, unknown>,
  )
  if (status !== 200) throw new Error(`test-seed failed: HTTP ${status}`)
  return data
}
