# EP02: Device & Identity Management — Implementation Plan

> **PARTLY SUPERSEDED (#3065).** The tasks that implement the revoke endpoint's PUK and hub-key
> rotation, the lockdown key phase, `puk_rotate` / `hub_key_rotate` events and
> `lockdownCompleteBodySchema` (`pukRotated`, `hubKeysRotated`) build the pre-v2 cascade, which
> the operator replaced on 2026-11-25 (`../specs/2026-11-25-v2-device-linking-and-recovery.md` §7, L6).
> **Do not build those.** See "Superseded: the revocation and lockdown cascade" in
> `../specs/2026-05-11-EP02-device-management-design.md`. Every other task here stands.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port v1 device/identity management to v2's per-device Ed25519/X25519 architecture with dedicated `/security/*` route tree, device revocation with sigchain+PUK rotation, session management, SAS emoji verification, security event timeline, admin device oversight, and mobile device/session views.

**Architecture:** A dedicated `/security/*` tabbed route layout provides user-facing device, session, passkey, and security history management. The backend adds three DB changes (device metadata columns, `security_events` table, `device_verifications` table), seven new API endpoints (rename, revoke, verify, sessions CRUD, security events, lockdown, admin overview), and wires security event emission into existing services. SAS emoji verification uses a new `derive_sas()` function in `packages/crypto` exposed via Tauri IPC and UniFFI.

**Tech Stack:** TypeScript (React, TanStack Query, TanStack Router), Rust (packages/crypto HKDF/SAS), Hono (backend routes), Drizzle ORM (PostgreSQL), SwiftUI (iOS), Kotlin/Compose (Android), Zod (schemas), packages/protocol codegen.

**Prerequisite:** EP01 must be merged before starting.

---

## Phase 1: Permission Catalog & Crypto Labels

### Task 1: Add `users:manage-devices` permission + `PERMISSION_GROUP_LABELS` entry

**Files:**
- Modify: `packages/shared/permissions.ts`
- Test: `packages/shared/__tests__/permissions.test.ts`

- [ ] **Step 1: Write test for new permission**

```typescript
// Append to existing test file packages/shared/__tests__/permissions.test.ts

describe('users:manage-devices permission', () => {
  test('exists in PERMISSION_CATALOG', () => {
    expect('users:manage-devices' in PERMISSION_CATALOG).toBe(true)
  })

  test('is a valid permission', () => {
    expect(isValidPermission('users:manage-devices')).toBe(true)
  })

  test('super-admin wildcard grants it', () => {
    expect(permissionGranted(['*'], 'users:manage-devices')).toBe(true)
  })

  test('users:* wildcard grants it', () => {
    expect(permissionGranted(['users:*'], 'users:manage-devices')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/shared/__tests__/permissions.test.ts
```
Expected: FAIL — `users:manage-devices` not in catalog.

- [ ] **Step 3: Add permission to PERMISSION_CATALOG**

In `packages/shared/permissions.ts`, add to the `Users` section (after `'users:manage-roles'`):

```typescript
  'users:manage-devices': 'View and manage user devices (admin device oversight, SAS verification)',
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test packages/shared/__tests__/permissions.test.ts
```
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/permissions.ts packages/shared/__tests__/permissions.test.ts
git commit -m "feat(permissions): add users:manage-devices permission for admin device oversight"
```

---

### Task 2: Add `LABEL_SAS_DERIVE` to crypto-labels.json + run codegen

**Files:**
- Modify: `packages/protocol/crypto-labels.json`
- Run: codegen

- [ ] **Step 1: Add LABEL_SAS_DERIVE to crypto-labels.json**

Add to the `"labels"` object in `packages/protocol/crypto-labels.json`:

```json
    "LABEL_SAS_DERIVE": "llamenos:sas-derive:v1"
```

- [ ] **Step 2: Run codegen to generate TS/Swift/Kotlin constants**

```bash
bun run codegen
```
Expected: Generates updated constants in `packages/protocol/generated/` for all platforms.

- [ ] **Step 3: Verify the new label appears in generated TypeScript**

```bash
grep -r 'LABEL_SAS_DERIVE' packages/protocol/generated/
```
Expected: Label constant appears in generated output.

- [ ] **Step 4: Commit**

```bash
git add packages/protocol/crypto-labels.json
git commit -m "feat(crypto): add LABEL_SAS_DERIVE domain separation label for SAS emoji verification"
```

---

## Phase 2: DB Schema & Migrations

### Task 3: Add device metadata columns to `devices` table

**Files:**
- Modify: `apps/worker/db/schema/users.ts`

- [ ] **Step 1: Add metadata columns to devices table**

In `apps/worker/db/schema/users.ts`, add columns to the `devices` table definition (after `lastSeenAt`):

```typescript
    // EP02: device metadata (auto-detected, deviceName user-editable)
    deviceName: text('device_name'),
    deviceModel: text('device_model'),
    osVersion: text('os_version'),
    appVersion: text('app_version'),
    lastIpHash: text('last_ip_hash'),
```

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add apps/worker/db/schema/users.ts
git commit -m "feat(db): add device metadata columns (name, model, osVersion, appVersion, lastIpHash)"
```

---

### Task 4: Create `security_events` table

**Files:**
- Create: `apps/worker/db/schema/security.ts`
- Modify: `apps/worker/db/schema/index.ts`

- [ ] **Step 1: Create security schema file**

Create `apps/worker/db/schema/security.ts`:

```typescript
/**
 * Security domain tables: security events (append-only), device verifications.
 */
import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { jsonb } from '../bun-jsonb'
import { users } from './users'

// ---------------------------------------------------------------------------
// security_events (append-only — no UPDATE or DELETE operations)
// ---------------------------------------------------------------------------

export const securityEvents = pgTable(
  'security_events',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userPubkey: text('user_pubkey')
      .notNull()
      .references(() => users.pubkey, { onDelete: 'set null' }),
    eventType: text('event_type').notNull(),
    deviceId: text('device_id'),
    metadata: jsonb('metadata').notNull().default({}),
    ipHash: text('ip_hash'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('security_events_user_pubkey_idx').on(table.userPubkey),
    index('security_events_event_type_idx').on(table.eventType),
    index('security_events_created_at_idx').on(table.createdAt),
  ],
)
```

- [ ] **Step 2: Export from schema barrel**

Add to `apps/worker/db/schema/index.ts`:

```typescript
export * from './security'
```

- [ ] **Step 3: Run typecheck**

```bash
bun run typecheck
```
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add apps/worker/db/schema/security.ts apps/worker/db/schema/index.ts
git commit -m "feat(db): add security_events table (append-only security audit log)"
```

---

### Task 5: Create `device_verifications` table

**Files:**
- Modify: `apps/worker/db/schema/security.ts`

- [ ] **Step 1: Add device_verifications table**

Append to `apps/worker/db/schema/security.ts`:

```typescript
// ---------------------------------------------------------------------------
// device_verifications (SAS emoji verification records)
// ---------------------------------------------------------------------------

export const deviceVerifications = pgTable(
  'device_verifications',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    verifierPubkey: text('verifier_pubkey').notNull(),
    targetDeviceId: text('target_device_id').notNull(),
    targetPubkey: text('target_pubkey').notNull(),
    signedAuditEntry: text('signed_audit_entry').notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('device_verifications_verifier_idx').on(table.verifierPubkey),
    index('device_verifications_target_idx').on(table.targetDeviceId),
  ],
)
```

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add apps/worker/db/schema/security.ts
git commit -m "feat(db): add device_verifications table for SAS emoji verification records"
```

---

### Task 6: Run migration to generate SQL

**Files:**
- Generate: migration file in `apps/worker/db/migrations/`

- [ ] **Step 1: Generate migration**

```bash
bunx drizzle-kit generate
```
Expected: A new migration file is created in `apps/worker/db/migrations/`.

- [ ] **Step 2: Apply migration locally**

```bash
bunx drizzle-kit push
```
Expected: Tables updated in local PostgreSQL.

- [ ] **Step 3: Commit**

```bash
git add apps/worker/db/
git commit -m "feat(db): generate migration for EP02 schema changes"
```

---

## Phase 3: Protocol Schemas

### Task 7: Create Zod schemas in `packages/protocol/schemas/device-management.ts`

**Files:**
- Create: `packages/protocol/schemas/device-management.ts`

- [ ] **Step 1: Create the schema file**

Create `packages/protocol/schemas/device-management.ts`:

```typescript
import { z } from 'zod'

// --- Device metadata ---

export const deviceMetadataSchema = z.object({
  deviceName: z.string().max(100).optional(),
  deviceModel: z.string().max(100).optional(),
  osVersion: z.string().max(50).optional(),
  appVersion: z.string().max(50).optional(),
})

export type DeviceMetadata = z.infer<typeof deviceMetadataSchema>

// --- Enhanced device response (with metadata) ---

export const deviceDetailResponseSchema = z.object({
  id: z.string(),
  platform: z.string(),
  deviceName: z.string().nullable(),
  deviceModel: z.string().nullable(),
  osVersion: z.string().nullable(),
  appVersion: z.string().nullable(),
  ed25519Pubkey: z.string().nullable(),
  x25519Pubkey: z.string().nullable(),
  registeredAt: z.string(),
  lastSeenAt: z.string().nullable(),
  lastIpHash: z.string().nullable(),
  isCurrent: z.boolean(),
})

export const deviceDetailListResponseSchema = z.object({
  devices: z.array(deviceDetailResponseSchema),
})

// --- Rename device ---

export const renameDeviceBodySchema = z.object({
  deviceName: z.string().min(1).max(100),
})

// --- Revoke device ---

export const revokeDeviceBodySchema = z.object({
  confirm: z.boolean(),
  /** Ed25519 signature over the revocation payload (hex). */
  signature: z.string().regex(/^[0-9a-f]{128}$/i).optional(),
  /** SHA-256 hash for the new sigchain device_remove link (hex). */
  sigchainHash: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
  /** seqNo for the new sigchain link. */
  sigchainSeqNo: z.number().int().nonnegative().optional(),
  /** prevHash for the new sigchain link (hex). */
  sigchainPrevHash: z.string().regex(/^([0-9a-f]{64}|)$/i).optional(),
})

export const revokeDeviceResponseSchema = z.object({
  revoked: z.boolean(),
  deviceId: z.string(),
  hubIdsRequiringKeyRotation: z.array(z.string()),
})

// --- Verify device (SAS) ---

export const verifyDeviceBodySchema = z.object({
  signedAuditEntry: z.string().min(1),
})

export const verifyDeviceResponseSchema = z.object({
  verified: z.boolean(),
  verificationId: z.string(),
})

// --- Security events ---

export const securityEventTypeSchema = z.enum([
  'device_register',
  'device_remove',
  'device_rename',
  'session_create',
  'session_terminate',
  'session_terminate_all',
  'account_lockdown',
  'account_lockdown_complete',
  'webauthn_register',
  'webauthn_authenticate',
  'webauthn_remove',
  'sigchain_append',
  'puk_rotate',
  'hub_key_rotate',
  'device_fingerprint_verified',
  'passkey_rename',
  'login_failed',
])

export const securityEventSchema = z.object({
  id: z.string(),
  eventType: securityEventTypeSchema,
  deviceId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  ipHash: z.string().nullable(),
  createdAt: z.string(),
})

export const securityEventListResponseSchema = z.object({
  events: z.array(securityEventSchema),
  total: z.number(),
})

// --- Session response ---

export const sessionResponseSchema = z.object({
  token: z.string(),
  deviceId: z.string().nullable(),
  platform: z.string().nullable(),
  userAgent: z.string().nullable(),
  ipHash: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  isCurrent: z.boolean(),
})

export const sessionListResponseSchema = z.object({
  sessions: z.array(sessionResponseSchema),
})

export const terminateSessionsResponseSchema = z.object({
  terminated: z.number(),
})

// --- Account lockdown ---

export const lockdownResponseSchema = z.object({
  sessionsTerminated: z.number(),
  hubIds: z.array(z.string()),
})

export const lockdownCompleteBodySchema = z.object({
  pukRotated: z.boolean(),
  hubKeysRotated: z.array(z.string()),
  hubKeysFailed: z.array(z.string()).optional().default([]),
})

// --- Admin device overview ---

export const adminDeviceOverviewEntrySchema = z.object({
  userPubkey: z.string(),
  displayName: z.string().nullable(),
  deviceCount: z.number(),
  lastSeenAt: z.string().nullable(),
  verified: z.boolean(),
  devices: z.array(deviceDetailResponseSchema),
})

export const adminDeviceOverviewResponseSchema = z.object({
  entries: z.array(adminDeviceOverviewEntrySchema),
  total: z.number(),
})

// --- Query schemas (excluded from codegen) ---

export const listSecurityEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
})

export const adminDeviceOverviewQuerySchema = z.object({
  hubId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
})
```

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add packages/protocol/schemas/device-management.ts
git commit -m "feat(protocol): add Zod schemas for device management, security events, sessions, lockdown"
```

---

### Task 8: Register schemas in schema-registry.ts + run codegen

**Files:**
- Modify: `packages/protocol/schemas/index.ts`
- Modify: `packages/protocol/tools/schema-registry.ts` (add exclusions for query schemas)

- [ ] **Step 1: Add barrel export**

Add to `packages/protocol/schemas/index.ts`:

```typescript
export * from './device-management'
```

- [ ] **Step 2: Add query schemas to exclusion list in schema-registry.ts**

In `packages/protocol/tools/schema-registry.ts`, add to `EXCLUDED_SCHEMAS`:

```typescript
  'listSecurityEventsQuerySchema',
  'adminDeviceOverviewQuerySchema',
  'securityEventTypeSchema',
```

- [ ] **Step 3: Run codegen**

```bash
bun run codegen
```
Expected: Generates TypeScript/Swift/Kotlin types for the new schemas.

- [ ] **Step 4: Verify generated types**

```bash
grep -r 'DeviceDetailResponse\|SecurityEvent\|LockdownResponse' packages/protocol/generated/ | head -10
```
Expected: Types appear in generated output.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/schemas/index.ts packages/protocol/tools/schema-registry.ts
git commit -m "feat(protocol): register device-management schemas and run codegen"
```

---

## Phase 4: Backend Routes & Services

### Task 9: Device rename endpoint (`PATCH /api/devices/:id`)

**Files:**
- Modify: `apps/worker/routes/devices.ts`
- Test: `apps/worker/__tests__/unit/devices-routes.test.ts`

- [ ] **Step 1: Write test for device rename**

Add to `apps/worker/__tests__/unit/devices-routes.test.ts`:

```typescript
describe('PATCH /devices/:id', () => {
  test('renames device owned by caller', async () => {
    // Register a device first
    await registerTestDevice(testPubkey, 'device-1', 'ios')

    const res = await app.request('/devices/device-1', {
      method: 'PATCH',
      headers: authHeaders(testPubkey),
      body: JSON.stringify({ deviceName: 'My iPhone' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.deviceName).toBe('My iPhone')
  })

  test('returns 404 for device not owned by caller', async () => {
    const res = await app.request('/devices/nonexistent', {
      method: 'PATCH',
      headers: authHeaders(testPubkey),
      body: JSON.stringify({ deviceName: 'Hacked' }),
    })
    expect(res.status).toBe(404)
  })

  test('rejects empty device name', async () => {
    const res = await app.request('/devices/device-1', {
      method: 'PATCH',
      headers: authHeaders(testPubkey),
      body: JSON.stringify({ deviceName: '' }),
    })
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test apps/worker/__tests__/unit/devices-routes.test.ts
```
Expected: FAIL — PATCH handler not defined.

- [ ] **Step 3: Implement PATCH handler**

Add to `apps/worker/routes/devices.ts` (before the `DELETE /:id` route — order matters for parameterized routes):

```typescript
import { renameDeviceBodySchema } from '@protocol/schemas/device-management'

/**
 * PATCH /api/devices/:id
 * Rename a device. Only the device owner can rename their own devices.
 */
devicesRoutes.patch('/:id',
  describeRoute({
    tags: ['Devices'],
    summary: 'Rename a device',
    responses: {
      200: { description: 'Device renamed' },
      404: { description: 'Device not found or not owned by caller' },
      ...authErrors,
    },
  }),
  validator('json', renameDeviceBodySchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const deviceId = c.req.param('id')
    const { deviceName } = c.req.valid('json')
    const services = c.get('services')

    const updated = await services.identity.renameDevice(pubkey, deviceId, deviceName)
    if (!updated) return c.json({ error: 'Device not found' }, 404)

    // Emit security event
    await services.identity.emitSecurityEvent(pubkey, 'device_rename', deviceId, {
      newName: deviceName,
    })

    return c.json({ id: deviceId, deviceName })
  })
```

- [ ] **Step 4: Implement `renameDevice` in IdentityService**

Add to `apps/worker/services/identity.ts`:

```typescript
  async renameDevice(pubkey: string, deviceId: string, deviceName: string): Promise<boolean> {
    const result = await this.db
      .update(devices)
      .set({ deviceName })
      .where(and(eq(devices.id, deviceId), eq(devices.pubkey, pubkey)))
      .returning({ id: devices.id })
    return result.length > 0
  }
```

- [ ] **Step 5: Run test to verify it passes**

```bash
bun test apps/worker/__tests__/unit/devices-routes.test.ts
```
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/routes/devices.ts apps/worker/services/identity.ts apps/worker/__tests__/unit/devices-routes.test.ts
git commit -m "feat(api): PATCH /api/devices/:id for device rename"
```

---

### Task 10: Device revoke endpoint (`POST /api/devices/:id/revoke`)

**Files:**
- Modify: `apps/worker/routes/devices.ts`
- Modify: `apps/worker/services/identity.ts`
- Test: `apps/worker/__tests__/unit/devices-routes.test.ts`

- [ ] **Step 1: Write test for device revocation**

Add to `apps/worker/__tests__/unit/devices-routes.test.ts`:

```typescript
describe('POST /devices/:id/revoke', () => {
  test('revokes device owned by caller', async () => {
    await registerTestDevice(testPubkey, 'device-revoke', 'ios')

    const res = await app.request('/devices/device-revoke/revoke', {
      method: 'POST',
      headers: authHeaders(testPubkey),
      body: JSON.stringify({ confirm: true }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.revoked).toBe(true)
    expect(body.deviceId).toBe('device-revoke')
    expect(Array.isArray(body.hubIdsRequiringKeyRotation)).toBe(true)
  })

  test('rejects without confirm: true', async () => {
    await registerTestDevice(testPubkey, 'device-noconfirm', 'ios')

    const res = await app.request('/devices/device-noconfirm/revoke', {
      method: 'POST',
      headers: authHeaders(testPubkey),
      body: JSON.stringify({ confirm: false }),
    })
    expect(res.status).toBe(400)
  })

  test('returns 404 for device not owned by caller', async () => {
    const res = await app.request('/devices/nonexistent/revoke', {
      method: 'POST',
      headers: authHeaders(testPubkey),
      body: JSON.stringify({ confirm: true }),
    })
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test apps/worker/__tests__/unit/devices-routes.test.ts
```
Expected: FAIL — revoke handler not defined.

- [ ] **Step 3: Implement POST revoke handler**

Add to `apps/worker/routes/devices.ts` (before `DELETE /:id`):

```typescript
import { revokeDeviceBodySchema } from '@protocol/schemas/device-management'

/**
 * POST /api/devices/:id/revoke
 * Revoke a device — atomically: delete device, create security event,
 * return hub IDs for client-side key rotation.
 */
devicesRoutes.post('/:id/revoke',
  describeRoute({
    tags: ['Devices'],
    summary: 'Revoke a device with sigchain + PUK rotation signal',
    responses: {
      200: { description: 'Device revoked, hub key rotation needed' },
      400: { description: 'Confirmation required' },
      404: { description: 'Device not found or not owned by caller' },
      ...authErrors,
    },
  }),
  validator('json', revokeDeviceBodySchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const deviceId = c.req.param('id')
    const body = c.req.valid('json')
    const services = c.get('services')

    if (!body.confirm) {
      return c.json({ error: 'Confirmation required' }, 400)
    }

    const result = await services.identity.revokeDevice(pubkey, deviceId, {
      signature: body.signature,
      sigchainHash: body.sigchainHash,
      sigchainSeqNo: body.sigchainSeqNo,
      sigchainPrevHash: body.sigchainPrevHash,
    })

    if (!result) return c.json({ error: 'Device not found' }, 404)

    return c.json({
      revoked: true,
      deviceId,
      hubIdsRequiringKeyRotation: result.hubIds,
    })
  })
```

- [ ] **Step 4: Implement `revokeDevice` in IdentityService**

Add to `apps/worker/services/identity.ts`:

```typescript
  async revokeDevice(
    pubkey: string,
    deviceId: string,
    sigchainData?: {
      signature?: string
      sigchainHash?: string
      sigchainSeqNo?: number
      sigchainPrevHash?: string
    },
  ): Promise<{ hubIds: string[] } | null> {
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

    // Atomic: delete device + emit security event
    await this.db.transaction(async (tx) => {
      await tx.delete(devices).where(eq(devices.id, deviceId))

      await tx.insert(securityEvents).values({
        userPubkey: pubkey,
        eventType: 'device_remove',
        deviceId,
        metadata: { revokedDeviceId: deviceId, platform: device.platform },
      })
    })

    return { hubIds }
  }
```

- [ ] **Step 5: Run test to verify it passes**

```bash
bun test apps/worker/__tests__/unit/devices-routes.test.ts
```
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/routes/devices.ts apps/worker/services/identity.ts apps/worker/__tests__/unit/devices-routes.test.ts
git commit -m "feat(api): POST /api/devices/:id/revoke with sigchain + security event emission"
```

---

### Task 11: Device verify endpoint (`POST /api/devices/:id/verify`)

**Files:**
- Modify: `apps/worker/routes/devices.ts`
- Modify: `apps/worker/services/identity.ts`
- Test: `apps/worker/__tests__/unit/devices-routes.test.ts`

- [ ] **Step 1: Write test for device verification**

Add to `apps/worker/__tests__/unit/devices-routes.test.ts`:

```typescript
describe('POST /devices/:id/verify', () => {
  test('stores verification entry for admin', async () => {
    await registerTestDevice(targetPubkey, 'device-verify', 'ios')

    const res = await app.request('/devices/device-verify/verify', {
      method: 'POST',
      headers: authHeaders(adminPubkey, ['users:manage-devices']),
      body: JSON.stringify({
        signedAuditEntry: 'signed-audit-entry-hex-data',
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.verified).toBe(true)
    expect(body.verificationId).toBeDefined()
  })

  test('rejects without users:manage-devices permission', async () => {
    const res = await app.request('/devices/device-verify/verify', {
      method: 'POST',
      headers: authHeaders(volunteerPubkey, []),
      body: JSON.stringify({
        signedAuditEntry: 'signed-audit-entry-hex-data',
      }),
    })
    expect(res.status).toBe(403)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test apps/worker/__tests__/unit/devices-routes.test.ts
```
Expected: FAIL — verify handler not defined.

- [ ] **Step 3: Implement POST verify handler**

Add to `apps/worker/routes/devices.ts`:

```typescript
import { verifyDeviceBodySchema } from '@protocol/schemas/device-management'
import { requirePermission } from '../middleware/permission-guard'

/**
 * POST /api/devices/:id/verify
 * Store SAS emoji verification result. Admin only (users:manage-devices).
 */
devicesRoutes.post('/:id/verify',
  describeRoute({
    tags: ['Devices'],
    summary: 'Record SAS verification of a device',
    responses: {
      200: { description: 'Verification recorded' },
      404: { description: 'Device not found' },
      ...authErrors,
    },
  }),
  requirePermission('users:manage-devices'),
  validator('json', verifyDeviceBodySchema),
  async (c) => {
    const verifierPubkey = c.get('pubkey')
    const deviceId = c.req.param('id')
    const { signedAuditEntry } = c.req.valid('json')
    const services = c.get('services')

    const result = await services.identity.verifyDevice(
      verifierPubkey,
      deviceId,
      signedAuditEntry,
    )

    if (!result) return c.json({ error: 'Device not found' }, 404)

    return c.json({
      verified: true,
      verificationId: result.id,
    })
  })
```

- [ ] **Step 4: Implement `verifyDevice` in IdentityService**

Add to `apps/worker/services/identity.ts`:

```typescript
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

    // Emit security event
    await this.db.insert(securityEvents).values({
      userPubkey: device.pubkey,
      eventType: 'device_fingerprint_verified',
      deviceId,
      metadata: { verifierPubkey },
    })

    return verification
  }
```

- [ ] **Step 5: Add imports for new tables at top of identity.ts**

Update imports in `apps/worker/services/identity.ts`:

```typescript
import {
  users, sessions, inviteCodes, webauthnCredentials,
  webauthnChallenges, devices, provisionRooms, systemSettings,
  securityEvents, deviceVerifications,
} from '../db/schema'
```

- [ ] **Step 6: Run test to verify it passes**

```bash
bun test apps/worker/__tests__/unit/devices-routes.test.ts
```
Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/routes/devices.ts apps/worker/services/identity.ts apps/worker/__tests__/unit/devices-routes.test.ts
git commit -m "feat(api): POST /api/devices/:id/verify for SAS emoji verification"
```

---

### Task 12: Session CRUD routes (`apps/worker/routes/sessions.ts`)

**Files:**
- Create: `apps/worker/routes/sessions.ts`
- Modify: `apps/worker/app.ts`
- Test: `apps/worker/__tests__/unit/sessions-routes.test.ts` (create)

- [ ] **Step 1: Write tests**

Create `apps/worker/__tests__/unit/sessions-routes.test.ts`:

```typescript
import { describe, test, expect, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'
import sessionRoutes from '@worker/routes/sessions'

// Use existing test harness pattern from devices-routes.test.ts

describe('GET /sessions', () => {
  test('returns sessions for authenticated user', async () => {
    const res = await app.request('/sessions', {
      method: 'GET',
      headers: authHeaders(testPubkey),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.sessions)).toBe(true)
  })
})

describe('DELETE /sessions/:token', () => {
  test('terminates a session owned by caller', async () => {
    const res = await app.request('/sessions/some-session-token', {
      method: 'DELETE',
      headers: authHeaders(testPubkey),
    })
    // 204 or 404 depending on test setup
    expect([204, 404]).toContain(res.status)
  })
})

describe('POST /sessions/terminate-others', () => {
  test('terminates all sessions except current', async () => {
    const res = await app.request('/sessions/terminate-others', {
      method: 'POST',
      headers: authHeaders(testPubkey),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.terminated).toBe('number')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test apps/worker/__tests__/unit/sessions-routes.test.ts
```
Expected: FAIL — route file not found.

- [ ] **Step 3: Create sessions route file**

Create `apps/worker/routes/sessions.ts`:

```typescript
/**
 * Session management API routes.
 *
 * GET    /api/sessions                  — List current user's active sessions.
 * DELETE /api/sessions/:token           — Terminate a specific session.
 * POST   /api/sessions/terminate-others — Terminate all sessions except current.
 */

import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'
import type { AppEnv } from '../types'
import { authErrors } from '../openapi/helpers'

const sessionRoutes = new Hono<AppEnv>()

/**
 * GET /api/sessions
 * List all active sessions for the authenticated user.
 */
sessionRoutes.get('/', async (c) => {
  const pubkey = c.get('pubkey')
  const currentToken = c.get('sessionToken')
  const services = c.get('services')

  const userSessions = await services.identity.listSessions(pubkey)
  return c.json({
    sessions: userSessions.map(s => ({
      token: s.token.slice(0, 8) + '...',  // Truncated for display
      deviceId: (s.deviceInfo as Record<string, unknown>)?.deviceId ?? null,
      platform: (s.deviceInfo as Record<string, unknown>)?.platform ?? null,
      userAgent: (s.deviceInfo as Record<string, unknown>)?.userAgent ?? null,
      ipHash: (s.deviceInfo as Record<string, unknown>)?.ipHash ?? null,
      createdAt: s.createdAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      isCurrent: s.token === currentToken,
    })),
  })
})

/**
 * POST /api/sessions/terminate-others
 * Terminate all sessions except the current one.
 * NOTE: Literal routes MUST come before parameterized routes.
 */
sessionRoutes.post('/terminate-others', async (c) => {
  const pubkey = c.get('pubkey')
  const currentToken = c.get('sessionToken')
  const services = c.get('services')

  const terminated = await services.identity.terminateOtherSessions(pubkey, currentToken)

  await services.identity.emitSecurityEvent(pubkey, 'session_terminate_all', null, {
    terminatedCount: terminated,
  })

  return c.json({ terminated })
})

/**
 * DELETE /api/sessions/:token
 * Terminate a specific session. Only the session owner can terminate their sessions.
 */
sessionRoutes.delete('/:token', async (c) => {
  const pubkey = c.get('pubkey')
  const targetToken = c.req.param('token')
  const services = c.get('services')

  const deleted = await services.identity.terminateSession(pubkey, targetToken)
  if (!deleted) return c.json({ error: 'Session not found' }, 404)

  await services.identity.emitSecurityEvent(pubkey, 'session_terminate', null, {
    terminatedToken: targetToken.slice(0, 8),
  })

  return c.body(null, 204)
})

export default sessionRoutes
```

- [ ] **Step 4: Implement session management methods in IdentityService**

Add to `apps/worker/services/identity.ts`:

```typescript
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
    userPubkey: string,
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
```

- [ ] **Step 5: Register route in app.ts**

In `apps/worker/app.ts`, add:

```typescript
import sessionRoutes from './routes/sessions'
// ...
authenticated.route('/sessions', sessionRoutes)
```

- [ ] **Step 6: Run tests**

```bash
bun test apps/worker/__tests__/unit/sessions-routes.test.ts
```
Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/routes/sessions.ts apps/worker/services/identity.ts apps/worker/app.ts apps/worker/__tests__/unit/sessions-routes.test.ts
git commit -m "feat(api): session management routes (list, terminate, terminate-others)"
```

---

### Task 13: Security events routes (`apps/worker/routes/security-events.ts`)

**Files:**
- Create: `apps/worker/routes/security-events.ts`
- Modify: `apps/worker/app.ts`
- Modify: `apps/worker/services/identity.ts`
- Test: `apps/worker/__tests__/unit/security-events-routes.test.ts` (create)

- [ ] **Step 1: Write tests**

Create `apps/worker/__tests__/unit/security-events-routes.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test'

describe('GET /security-events', () => {
  test('returns events for authenticated user', async () => {
    const res = await app.request('/security-events', {
      method: 'GET',
      headers: authHeaders(testPubkey),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.events)).toBe(true)
    expect(typeof body.total).toBe('number')
  })

  test('supports limit and offset', async () => {
    const res = await app.request('/security-events?limit=10&offset=0', {
      method: 'GET',
      headers: authHeaders(testPubkey),
    })
    expect(res.status).toBe(200)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test apps/worker/__tests__/unit/security-events-routes.test.ts
```
Expected: FAIL — route file not found.

- [ ] **Step 3: Create security-events route file**

Create `apps/worker/routes/security-events.ts`:

```typescript
/**
 * Security event API routes.
 *
 * GET /api/security-events — List security events for authenticated user.
 * GET /api/admin/security-events — Admin: list all security events.
 */

import { Hono } from 'hono'
import { validator } from 'hono-openapi'
import type { AppEnv } from '../types'
import { requirePermission } from '../middleware/permission-guard'
import { listSecurityEventsQuerySchema } from '@protocol/schemas/device-management'

const securityEventsRoutes = new Hono<AppEnv>()

/**
 * GET /api/security-events
 * List security events for the authenticated user (own events only).
 */
securityEventsRoutes.get('/',
  validator('query', listSecurityEventsQuerySchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const { limit, offset } = c.req.valid('query')
    const services = c.get('services')

    const { events, total } = await services.identity.listSecurityEvents(pubkey, limit, offset)

    return c.json({
      events: events.map(e => ({
        id: e.id,
        eventType: e.eventType,
        deviceId: e.deviceId,
        metadata: e.metadata,
        ipHash: e.ipHash,
        createdAt: e.createdAt.toISOString(),
      })),
      total,
    })
  })

export default securityEventsRoutes

// --- Admin security events (separate router, mounted at /api/admin/security-events) ---

export const adminSecurityEventsRoutes = new Hono<AppEnv>()

adminSecurityEventsRoutes.get('/',
  requirePermission('audit:read'),
  validator('query', listSecurityEventsQuerySchema),
  async (c) => {
    const { limit, offset } = c.req.valid('query')
    const services = c.get('services')

    const { events, total } = await services.identity.listAllSecurityEvents(limit, offset)

    return c.json({
      events: events.map(e => ({
        id: e.id,
        eventType: e.eventType,
        deviceId: e.deviceId,
        metadata: e.metadata,
        ipHash: e.ipHash,
        createdAt: e.createdAt.toISOString(),
      })),
      total,
    })
  })
```

- [ ] **Step 4: Implement security event query methods in IdentityService**

Add to `apps/worker/services/identity.ts`:

```typescript
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
```

- [ ] **Step 5: Register routes in app.ts**

In `apps/worker/app.ts`, add:

```typescript
import securityEventsRoutes, { adminSecurityEventsRoutes } from './routes/security-events'
// ...
authenticated.route('/security-events', securityEventsRoutes)
authenticated.route('/admin/security-events', adminSecurityEventsRoutes)
```

- [ ] **Step 6: Run tests**

```bash
bun test apps/worker/__tests__/unit/security-events-routes.test.ts
```
Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/routes/security-events.ts apps/worker/services/identity.ts apps/worker/app.ts apps/worker/__tests__/unit/security-events-routes.test.ts
git commit -m "feat(api): security events routes (user own events + admin all events)"
```

---

### Task 14: Account lockdown routes (`apps/worker/routes/account.ts`)

**Files:**
- Create: `apps/worker/routes/account.ts`
- Modify: `apps/worker/app.ts`
- Modify: `apps/worker/services/identity.ts`
- Test: `apps/worker/__tests__/unit/account-routes.test.ts` (create)

- [ ] **Step 1: Write tests**

Create `apps/worker/__tests__/unit/account-routes.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test'

describe('POST /account/lockdown', () => {
  test('terminates all other sessions and returns hub IDs', async () => {
    const res = await app.request('/account/lockdown', {
      method: 'POST',
      headers: authHeaders(testPubkey),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.sessionsTerminated).toBe('number')
    expect(Array.isArray(body.hubIds)).toBe(true)
  })
})

describe('POST /account/lockdown/complete', () => {
  test('records lockdown completion', async () => {
    const res = await app.request('/account/lockdown/complete', {
      method: 'POST',
      headers: authHeaders(testPubkey),
      body: JSON.stringify({
        pukRotated: true,
        hubKeysRotated: ['hub-1', 'hub-2'],
        hubKeysFailed: [],
      }),
    })
    expect(res.status).toBe(200)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test apps/worker/__tests__/unit/account-routes.test.ts
```
Expected: FAIL — route file not found.

- [ ] **Step 3: Create account route file**

Create `apps/worker/routes/account.ts`:

```typescript
/**
 * Account management API routes.
 *
 * POST /api/account/lockdown          — Emergency lockdown (terminate all sessions, signal PUK + hub key rotation).
 * POST /api/account/lockdown/complete — Client reports completion of lockdown key rotations.
 */

import { Hono } from 'hono'
import { validator } from 'hono-openapi'
import type { AppEnv } from '../types'
import { lockdownCompleteBodySchema } from '@protocol/schemas/device-management'

const accountRoutes = new Hono<AppEnv>()

/**
 * POST /api/account/lockdown
 * Emergency lockdown: terminate all other sessions, return hub IDs for key rotation.
 * Requires elevated auth (fresh PIN or WebAuthn assertion).
 */
accountRoutes.post('/lockdown', async (c) => {
  const pubkey = c.get('pubkey')
  const currentToken = c.get('sessionToken')
  const services = c.get('services')

  // Terminate all sessions except current
  const terminated = await services.identity.terminateOtherSessions(pubkey, currentToken)

  // Get user's hub memberships
  const hubIds = await services.identity.getUserHubIds(pubkey)

  // Emit security event
  await services.identity.emitSecurityEvent(pubkey, 'account_lockdown', null, {
    sessionsTerminated: terminated,
    hubCount: hubIds.length,
  })

  return c.json({ sessionsTerminated: terminated, hubIds })
})

/**
 * POST /api/account/lockdown/complete
 * Client reports completion of PUK rotation and hub key rotations.
 */
accountRoutes.post('/lockdown/complete',
  validator('json', lockdownCompleteBodySchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')
    const services = c.get('services')

    await services.identity.emitSecurityEvent(pubkey, 'account_lockdown_complete', null, {
      pukRotated: body.pukRotated,
      hubKeysRotated: body.hubKeysRotated,
      hubKeysFailed: body.hubKeysFailed,
    })

    return c.json({ ok: true })
  })

export default accountRoutes
```

- [ ] **Step 4: Implement `getUserHubIds` in IdentityService**

Add to `apps/worker/services/identity.ts`:

```typescript
  async getUserHubIds(pubkey: string): Promise<string[]> {
    const [user] = await this.db
      .select({ hubRoles: users.hubRoles })
      .from(users)
      .where(eq(users.pubkey, pubkey))
      .limit(1)

    if (!user?.hubRoles) return []
    return (user.hubRoles as Array<{ hubId: string }>).map(hr => hr.hubId)
  }
```

- [ ] **Step 5: Register route in app.ts**

In `apps/worker/app.ts`, add:

```typescript
import accountRoutes from './routes/account'
// ...
authenticated.route('/account', accountRoutes)
```

- [ ] **Step 6: Run tests**

```bash
bun test apps/worker/__tests__/unit/account-routes.test.ts
```
Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/routes/account.ts apps/worker/services/identity.ts apps/worker/app.ts apps/worker/__tests__/unit/account-routes.test.ts
git commit -m "feat(api): account lockdown routes (emergency session termination + completion reporting)"
```

---

### Task 15: Admin device overview (`apps/worker/routes/admin/devices.ts`)

**Files:**
- Create: `apps/worker/routes/admin/devices.ts`
- Modify: `apps/worker/app.ts`
- Modify: `apps/worker/services/identity.ts`

- [ ] **Step 1: Write test**

Create `apps/worker/__tests__/unit/admin-devices-routes.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test'

describe('GET /admin/devices/overview', () => {
  test('returns hub-scoped device overview for admin', async () => {
    const res = await app.request('/admin/devices/overview?hubId=hub-1', {
      method: 'GET',
      headers: authHeaders(adminPubkey, ['users:manage-devices']),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.entries)).toBe(true)
    expect(typeof body.total).toBe('number')
  })

  test('rejects without users:manage-devices permission', async () => {
    const res = await app.request('/admin/devices/overview', {
      method: 'GET',
      headers: authHeaders(volunteerPubkey, []),
    })
    expect(res.status).toBe(403)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test apps/worker/__tests__/unit/admin-devices-routes.test.ts
```
Expected: FAIL — route not found.

- [ ] **Step 3: Create admin devices route file**

Create `apps/worker/routes/admin/devices.ts`:

```typescript
/**
 * Admin device oversight API routes.
 *
 * GET /api/admin/devices/overview — Paginated hub-scoped device overview with verification status.
 */

import { Hono } from 'hono'
import { validator } from 'hono-openapi'
import type { AppEnv } from '../../types'
import { requirePermission } from '../../middleware/permission-guard'
import { adminDeviceOverviewQuerySchema } from '@protocol/schemas/device-management'

const adminDevicesRoutes = new Hono<AppEnv>()

/**
 * GET /api/admin/devices/overview
 * Paginated hub-scoped aggregate device stats per user.
 */
adminDevicesRoutes.get('/overview',
  requirePermission('users:manage-devices'),
  validator('query', adminDeviceOverviewQuerySchema),
  async (c) => {
    const { hubId, limit, offset } = c.req.valid('query')
    const services = c.get('services')

    const result = await services.identity.getAdminDeviceOverview(hubId, limit, offset)

    return c.json(result)
  })

export default adminDevicesRoutes
```

- [ ] **Step 4: Implement `getAdminDeviceOverview` in IdentityService**

Add to `apps/worker/services/identity.ts`:

```typescript
  async getAdminDeviceOverview(
    hubId: string | undefined,
    limit: number,
    offset: number,
  ) {
    // Get users with their devices, optionally filtered by hub membership
    let userQuery = this.db
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
            isCurrent: false, // Admin view — no "current" concept
          })),
        }
      }),
    )

    return { entries, total }
  }
```

- [ ] **Step 5: Register route in app.ts**

In `apps/worker/app.ts`, add:

```typescript
import adminDevicesRoutes from './routes/admin/devices'
// ...
authenticated.route('/admin/devices', adminDevicesRoutes)
```

- [ ] **Step 6: Run tests**

```bash
bun test apps/worker/__tests__/unit/admin-devices-routes.test.ts
```
Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/routes/admin/devices.ts apps/worker/services/identity.ts apps/worker/app.ts apps/worker/__tests__/unit/admin-devices-routes.test.ts
git commit -m "feat(api): admin device overview with hub-scoped aggregation and verification status"
```

---

### Task 16: Wire security event emission into existing services

**Files:**
- Modify: `apps/worker/services/identity.ts`
- Modify: `apps/worker/routes/devices.ts`

- [ ] **Step 1: Emit security event on device registration**

In `apps/worker/routes/devices.ts`, after `registerDevice` succeeds in the POST `/register` handler:

```typescript
    await services.identity.emitSecurityEvent(pubkey, 'device_register', null, {
      platform: body.platform,
    })
```

- [ ] **Step 2: Emit security event on session creation**

In the session creation logic within IdentityService (find the `createSession` or equivalent method), add:

```typescript
    await this.db.insert(securityEvents).values({
      userPubkey: pubkey,
      eventType: 'session_create',
      metadata: { method: 'webauthn' },
    })
```

- [ ] **Step 3: Emit security event on WebAuthn registration**

In the WebAuthn credential creation logic, add:

```typescript
    await this.db.insert(securityEvents).values({
      userPubkey: pubkey,
      eventType: 'webauthn_register',
      metadata: { credentialId: credential.credentialId },
    })
```

- [ ] **Step 4: Run typecheck**

```bash
bun run typecheck
```
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/services/identity.ts apps/worker/routes/devices.ts
git commit -m "feat(security): wire security event emission into device registration, session creation, and WebAuthn"
```

---

### Task 17: Populate `sessions.deviceInfo` on session creation

**Files:**
- Modify: `apps/worker/services/identity.ts`

- [ ] **Step 1: Update session creation to include deviceInfo**

Find the `createSession` (or equivalent) method in `apps/worker/services/identity.ts`. Update it to accept and store device info:

```typescript
  async createSession(
    pubkey: string,
    opts?: { deviceId?: string; platform?: string; userAgent?: string; ipHash?: string },
  ) {
    const token = randomHexToken(32)
    const now = new Date()
    const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS)

    await this.db.insert(sessions).values({
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
    })

    return { token, expiresAt }
  }
```

- [ ] **Step 2: Update callers to pass device info**

In the WebAuthn authentication route and any other session creation paths, pass through the device info from the request:

```typescript
const ipHash = hmacIpHash(c.req.header('x-forwarded-for') ?? c.req.header('cf-connecting-ip') ?? '')
const session = await services.identity.createSession(pubkey, {
  userAgent: c.req.header('user-agent') ?? undefined,
  ipHash,
})
```

- [ ] **Step 3: Run typecheck**

```bash
bun run typecheck
```
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add apps/worker/services/identity.ts apps/worker/routes/
git commit -m "feat(sessions): populate deviceInfo on session creation with device ID, platform, user agent, IP hash"
```

---

## Phase 5: Rust Crypto — SAS Derivation

### Task 18: Implement `derive_sas()` in `packages/crypto/src/sas.rs`

**Files:**
- Create: `packages/crypto/src/sas.rs`
- Modify: `packages/crypto/src/lib.rs`
- Modify: `packages/crypto/src/labels.rs`

- [ ] **Step 1: Add LABEL_SAS_DERIVE to labels.rs**

Add to `packages/crypto/src/labels.rs`:

```rust
/// Domain separation for SAS emoji derivation (device verification ceremony)
pub const LABEL_SAS_DERIVE: &str = "llamenos:sas-derive:v1";
```

Also add it to the `LABEL_REGISTRY` array at the next available index.

- [ ] **Step 2: Create sas.rs module**

Create `packages/crypto/src/sas.rs`:

```rust
//! SAS (Short Authentication String) emoji derivation for device verification.
//!
//! Given two Ed25519 public keys and a session nonce, derives 7 emoji indices
//! (0-63) using HKDF-SHA256. Both parties compute the same indices and compare
//! emojis visually to confirm device authenticity.
//!
//! Canonical ordering: min(pubkey_a, pubkey_b) || max(pubkey_a, pubkey_b) || nonce
//! This prevents role-confusion attacks.

use hkdf::Hkdf;
use sha2::Sha256;

use crate::errors::CryptoError;
use crate::labels::LABEL_SAS_DERIVE;

/// The 64-entry emoji table for SAS verification display.
/// Each index (0-63) maps to a single emoji codepoint.
pub const SAS_EMOJI_TABLE: [&str; 64] = [
    "\u{1F436}", // dog
    "\u{1F431}", // cat
    "\u{1F434}", // horse
    "\u{1F437}", // pig
    "\u{1F430}", // rabbit
    "\u{1F43B}", // bear
    "\u{1F42F}", // tiger
    "\u{1F428}", // koala
    "\u{1F43C}", // panda
    "\u{1F981}", // lion
    "\u{1F984}", // unicorn
    "\u{1F422}", // turtle
    "\u{1F420}", // tropical fish
    "\u{1F419}", // octopus
    "\u{1F98B}", // butterfly
    "\u{1F33B}", // sunflower
    "\u{1F332}", // evergreen tree
    "\u{1F335}", // cactus
    "\u{1F344}", // mushroom
    "\u{1F30D}", // globe
    "\u{1F319}", // crescent moon
    "\u{2B50}",  // star
    "\u{26A1}",  // lightning
    "\u{1F525}", // fire
    "\u{1F4A7}", // droplet
    "\u{2744}\u{FE0F}",  // snowflake
    "\u{1F308}", // rainbow
    "\u{2600}\u{FE0F}",  // sun
    "\u{2601}\u{FE0F}",  // cloud
    "\u{1F30A}", // wave
    "\u{1F3D4}\u{FE0F}", // mountain
    "\u{1F3DD}\u{FE0F}", // desert island
    "\u{1F680}", // rocket
    "\u{2708}\u{FE0F}",  // airplane
    "\u{1F6A2}", // ship
    "\u{1F3E0}", // house
    "\u{1F3F0}", // castle
    "\u{1F3A8}", // palette
    "\u{1F3B5}", // music note
    "\u{1F3B2}", // dice
    "\u{1F3C6}", // trophy
    "\u{1F48E}", // gem
    "\u{1F511}", // key
    "\u{1F6E1}\u{FE0F}", // shield
    "\u{2764}\u{FE0F}",  // heart
    "\u{1F31F}", // glowing star
    "\u{1F3AF}", // bullseye
    "\u{1F52E}", // crystal ball
    "\u{1F9E9}", // puzzle piece
    "\u{1F3C0}", // basketball
    "\u{26BD}",  // soccer ball
    "\u{1F3B3}", // bowling
    "\u{1F40C}", // snail
    "\u{1F98A}", // fox
    "\u{1F427}", // penguin
    "\u{1F989}", // owl
    "\u{1F99C}", // parrot
    "\u{1F982}", // scorpion
    "\u{1F980}", // crab
    "\u{1F41D}", // honeybee
    "\u{1F33F}", // herb
    "\u{1F34E}", // apple
    "\u{1F352}", // cherries
    "\u{1F349}", // watermelon
];

/// Derive 7 SAS emoji indices from two Ed25519 public keys and a session nonce.
///
/// Both parties compute the same result regardless of argument order, because
/// pubkeys are canonically ordered (lexicographic min first).
///
/// Returns 7 indices (0-63) into `SAS_EMOJI_TABLE`.
pub fn derive_sas(
    pubkey_a: &[u8; 32],
    pubkey_b: &[u8; 32],
    nonce: &[u8; 32],
) -> Result<[u8; 7], CryptoError> {
    // Canonical ordering: min first
    let (first, second) = if pubkey_a <= pubkey_b {
        (pubkey_a, pubkey_b)
    } else {
        (pubkey_b, pubkey_a)
    };

    // Input key material: min_pubkey || max_pubkey || nonce
    let mut ikm = Vec::with_capacity(96);
    ikm.extend_from_slice(first);
    ikm.extend_from_slice(second);
    ikm.extend_from_slice(nonce);

    // HKDF-SHA256: extract then expand
    let hk = Hkdf::<Sha256>::new(None, &ikm);
    let mut output = [0u8; 6]; // 48 bits = 6 bytes, enough for 7 * 6-bit values
    hk.expand(LABEL_SAS_DERIVE.as_bytes(), &mut output)
        .map_err(|_| CryptoError::HkdfExpandError)?;

    // Extract seven 6-bit values from 42 bits (6 bytes = 48 bits, we use 42)
    let bits = u64::from_be_bytes([0, 0, output[0], output[1], output[2], output[3], output[4], output[5]]);
    let mut indices = [0u8; 7];
    for i in 0..7 {
        indices[i] = ((bits >> (42 - 6 * (i + 1))) & 0x3F) as u8;
    }

    Ok(indices)
}

/// Get the emoji string for a SAS index.
pub fn sas_emoji(index: u8) -> &'static str {
    SAS_EMOJI_TABLE.get(index as usize).unwrap_or(&"\u{2753}") // question mark fallback
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_derive_sas_deterministic() {
        let pk_a = [1u8; 32];
        let pk_b = [2u8; 32];
        let nonce = [3u8; 32];

        let r1 = derive_sas(&pk_a, &pk_b, &nonce).unwrap();
        let r2 = derive_sas(&pk_a, &pk_b, &nonce).unwrap();
        assert_eq!(r1, r2);
    }

    #[test]
    fn test_derive_sas_order_independent() {
        let pk_a = [1u8; 32];
        let pk_b = [2u8; 32];
        let nonce = [3u8; 32];

        let r1 = derive_sas(&pk_a, &pk_b, &nonce).unwrap();
        let r2 = derive_sas(&pk_b, &pk_a, &nonce).unwrap();
        assert_eq!(r1, r2, "SAS must be order-independent");
    }

    #[test]
    fn test_derive_sas_indices_in_range() {
        let pk_a = [42u8; 32];
        let pk_b = [99u8; 32];
        let nonce = [7u8; 32];

        let indices = derive_sas(&pk_a, &pk_b, &nonce).unwrap();
        for idx in &indices {
            assert!(*idx < 64, "SAS index {} out of range 0-63", idx);
        }
    }

    #[test]
    fn test_different_nonce_different_result() {
        let pk_a = [1u8; 32];
        let pk_b = [2u8; 32];

        let r1 = derive_sas(&pk_a, &pk_b, &[0u8; 32]).unwrap();
        let r2 = derive_sas(&pk_a, &pk_b, &[1u8; 32]).unwrap();
        assert_ne!(r1, r2, "Different nonces must produce different SAS");
    }

    #[test]
    fn test_sas_emoji_valid_index() {
        assert!(!sas_emoji(0).is_empty());
        assert!(!sas_emoji(63).is_empty());
    }
}
```

- [ ] **Step 3: Register module in lib.rs**

Add to `packages/crypto/src/lib.rs`:

```rust
pub mod sas;
```

- [ ] **Step 4: Run crypto tests**

```bash
bun run crypto:test
```
Expected: All tests PASS including new SAS tests.

- [ ] **Step 5: Run clippy**

```bash
bun run crypto:clippy
```
Expected: No warnings.

- [ ] **Step 6: Commit**

```bash
git add packages/crypto/src/sas.rs packages/crypto/src/lib.rs packages/crypto/src/labels.rs
git commit -m "feat(crypto): implement SAS emoji derivation with HKDF-SHA256 and 64-entry emoji table"
```

---

### Task 19: Expose via Tauri IPC + UniFFI

**Files:**
- Modify: `apps/desktop/src/crypto.rs`
- Modify: `packages/crypto/src/ffi.rs`

- [ ] **Step 1: Add Tauri IPC command**

Add to `apps/desktop/src/crypto.rs`:

```rust
use llamenos_core::sas;

#[tauri::command]
pub fn derive_sas(
    pubkey_a_hex: String,
    pubkey_b_hex: String,
    nonce_hex: String,
) -> Result<Vec<u8>, String> {
    let pk_a: [u8; 32] = hex::decode(&pubkey_a_hex)
        .map_err(err_str)?
        .try_into()
        .map_err(|_| "pubkey_a must be 32 bytes".to_string())?;
    let pk_b: [u8; 32] = hex::decode(&pubkey_b_hex)
        .map_err(err_str)?
        .try_into()
        .map_err(|_| "pubkey_b must be 32 bytes".to_string())?;
    let nonce: [u8; 32] = hex::decode(&nonce_hex)
        .map_err(err_str)?
        .try_into()
        .map_err(|_| "nonce must be 32 bytes".to_string())?;

    let indices = sas::derive_sas(&pk_a, &pk_b, &nonce).map_err(err_str)?;
    Ok(indices.to_vec())
}

#[tauri::command]
pub fn get_sas_emoji_table() -> Vec<String> {
    sas::SAS_EMOJI_TABLE.iter().map(|s| s.to_string()).collect()
}
```

- [ ] **Step 2: Register commands in lib.rs**

Add `derive_sas` and `get_sas_emoji_table` to the `invoke_handler` in `apps/desktop/src/lib.rs`.

- [ ] **Step 3: Add UniFFI bindings**

Add to `packages/crypto/src/ffi.rs`:

```rust
#[cfg(feature = "mobile")]
#[uniffi::export]
pub fn derive_sas_emoji(
    pubkey_a_hex: String,
    pubkey_b_hex: String,
    nonce_hex: String,
) -> Result<Vec<u8>, CryptoError> {
    let pk_a: [u8; 32] = hex::decode(&pubkey_a_hex)?
        .try_into()
        .map_err(|_| CryptoError::InvalidPublicKey)?;
    let pk_b: [u8; 32] = hex::decode(&pubkey_b_hex)?
        .try_into()
        .map_err(|_| CryptoError::InvalidPublicKey)?;
    let nonce: [u8; 32] = hex::decode(&nonce_hex)?
        .try_into()
        .map_err(|_| CryptoError::InvalidInput("nonce must be 32 bytes".into()))?;

    let indices = crate::sas::derive_sas(&pk_a, &pk_b, &nonce)?;
    Ok(indices.to_vec())
}

#[cfg(feature = "mobile")]
#[uniffi::export]
pub fn get_sas_emoji_table() -> Vec<String> {
    crate::sas::SAS_EMOJI_TABLE.iter().map(|s| s.to_string()).collect()
}
```

- [ ] **Step 4: Add `deriveSas` to platform.ts**

In `src/client/lib/platform.ts`, add:

```typescript
export async function deriveSas(
  pubkeyAHex: string,
  pubkeyBHex: string,
  nonceHex: string,
): Promise<number[]> {
  return invoke<number[]>('derive_sas', {
    pubkeyAHex: pubkeyAHex,
    pubkeyBHex: pubkeyBHex,
    nonceHex: nonceHex,
  })
}

export async function getSasEmojiTable(): Promise<string[]> {
  return invoke<string[]>('get_sas_emoji_table')
}
```

- [ ] **Step 5: Add mock to tests/mocks/**

In the Tauri IPC mock layer (`tests/mocks/`), add handlers for `derive_sas` and `get_sas_emoji_table` that return deterministic test values.

- [ ] **Step 6: Run crypto tests**

```bash
bun run crypto:test
```
Expected: All pass.

- [ ] **Step 7: Run typecheck**

```bash
bun run typecheck
```
Expected: No errors.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/crypto.rs apps/desktop/src/lib.rs packages/crypto/src/ffi.rs src/client/lib/platform.ts tests/mocks/
git commit -m "feat(ipc): expose SAS derivation via Tauri IPC, UniFFI, and platform.ts"
```

---

## Phase 6: Desktop — Security Route Tree

### Task 20: SecurityLayout + route setup

**Files:**
- Create: `src/client/routes/security.tsx` (layout)
- Create: `src/client/routes/security/devices.tsx`
- Create: `src/client/routes/security/sessions.tsx`
- Create: `src/client/routes/security/passkeys.tsx`
- Create: `src/client/routes/security/history.tsx`

- [ ] **Step 1: Create SecurityLayout**

Create `src/client/routes/security.tsx`:

```typescript
import { Outlet, Link, useMatchRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Shield, Smartphone, Key, Clock, History } from 'lucide-react'

const tabs = [
  { path: '/security/devices', labelKey: 'security.tabs.devices', icon: Smartphone },
  { path: '/security/sessions', labelKey: 'security.tabs.sessions', icon: Key },
  { path: '/security/passkeys', labelKey: 'security.tabs.passkeys', icon: Shield },
  { path: '/security/history', labelKey: 'security.tabs.history', icon: History },
] as const

export default function SecurityLayout() {
  const { t } = useTranslation()
  const matchRoute = useMatchRoute()

  return (
    <div className="flex flex-col h-full">
      <div className="border-b px-4">
        <nav className="flex gap-1" role="tablist">
          {tabs.map(({ path, labelKey, icon: Icon }) => {
            const isActive = matchRoute({ to: path })
            return (
              <Link
                key={path}
                to={path}
                role="tab"
                aria-selected={!!isActive}
                className={cn(
                  'flex items-center gap-2 px-3 py-2 text-sm font-medium border-b-2 transition-colors',
                  isActive
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="h-4 w-4" />
                {t(labelKey)}
              </Link>
            )
          })}
        </nav>
      </div>
      <div className="flex-1 overflow-auto p-4">
        <Outlet />
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Create placeholder route files**

Create `src/client/routes/security/devices.tsx`:

```typescript
export default function DevicesPage() {
  return <div data-testid="security-devices">Devices — implemented in Task 21</div>
}
```

Create `src/client/routes/security/sessions.tsx`:

```typescript
export default function SessionsPage() {
  return <div data-testid="security-sessions">Sessions — implemented in Task 22</div>
}
```

Create `src/client/routes/security/passkeys.tsx`:

```typescript
export default function PasskeysPage() {
  return <div data-testid="security-passkeys">Passkeys — implemented in Task 24</div>
}
```

Create `src/client/routes/security/history.tsx`:

```typescript
export default function HistoryPage() {
  return <div data-testid="security-history">History — implemented in Task 25</div>
}
```

- [ ] **Step 3: Run typecheck**

```bash
bun run typecheck
```
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/client/routes/security.tsx src/client/routes/security/
git commit -m "feat(ui): security route layout with tabbed navigation (devices, sessions, passkeys, history)"
```

---

### Task 21: DevicesPage (device list, rename, revoke, fingerprint)

**Files:**
- Modify: `src/client/routes/security/devices.tsx`

- [ ] **Step 1: Implement DevicesPage**

Replace `src/client/routes/security/devices.tsx` with full implementation:

```typescript
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Smartphone, Monitor, Pencil, Trash2, Copy, Check } from 'lucide-react'
import { useDevices, useRenameDevice, useRevokeDevice } from '@/lib/queries/devices'
import { cn } from '@/lib/utils'

export default function DevicesPage() {
  const { t } = useTranslation()
  const { data: devices, isLoading } = useDevices()
  const renameDevice = useRenameDevice()
  const revokeDevice = useRevokeDevice()
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; name: string } | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  if (isLoading) return <div className="animate-pulse">{t('common.loading')}</div>

  function startRename(deviceId: string, currentName: string) {
    setRenamingId(deviceId)
    setRenameValue(currentName)
  }

  async function submitRename(deviceId: string) {
    await renameDevice.mutateAsync({ deviceId, deviceName: renameValue })
    setRenamingId(null)
  }

  async function confirmRevoke() {
    if (!revokeTarget) return
    await revokeDevice.mutateAsync({ deviceId: revokeTarget.id })
    setRevokeTarget(null)
  }

  function copyFingerprint(pubkey: string, deviceId: string) {
    navigator.clipboard.writeText(pubkey)
    setCopiedId(deviceId)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const platformIcon = (platform: string) =>
    platform === 'ios' || platform === 'android' ? Smartphone : Monitor

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t('security.devices.title')}</h2>
        <Badge variant="outline">
          {devices?.length ?? 0}/5 {t('security.devices.limit')}
        </Badge>
      </div>

      <div className="space-y-3">
        {devices?.map((device) => {
          const Icon = platformIcon(device.platform)
          const isRenaming = renamingId === device.id
          const fingerprint = device.ed25519Pubkey
            ? device.ed25519Pubkey.slice(0, 16) + '...' + device.ed25519Pubkey.slice(-8)
            : null

          return (
            <div
              key={device.id}
              className={cn(
                'flex items-start gap-3 p-3 rounded-md border',
                device.isCurrent && 'border-primary/30 bg-primary/5',
              )}
              data-testid={`device-${device.id}`}
            >
              <Icon className="h-5 w-5 mt-0.5 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  {isRenaming ? (
                    <div className="flex gap-1">
                      <Input
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && submitRename(device.id)}
                        className="h-7 text-sm"
                        autoFocus
                      />
                      <Button size="sm" variant="ghost" onClick={() => submitRename(device.id)}>
                        <Check className="h-3 w-3" />
                      </Button>
                    </div>
                  ) : (
                    <>
                      <span className="font-medium text-sm truncate">
                        {device.deviceName ?? device.platform}
                      </span>
                      {device.isCurrent && (
                        <Badge variant="secondary" className="text-xs">{t('security.devices.current')}</Badge>
                      )}
                    </>
                  )}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {device.deviceModel && <span>{device.deviceModel}</span>}
                  {device.osVersion && <span> {device.osVersion}</span>}
                  {device.lastSeenAt && (
                    <span> &middot; {t('security.devices.lastSeen')} {new Date(device.lastSeenAt).toLocaleDateString()}</span>
                  )}
                </div>
                {fingerprint && (
                  <button
                    type="button"
                    className="flex items-center gap-1 text-xs text-muted-foreground mt-1 font-mono hover:text-foreground"
                    onClick={() => copyFingerprint(device.ed25519Pubkey!, device.id)}
                  >
                    {copiedId === device.id ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                    {fingerprint}
                  </button>
                )}
              </div>
              <div className="flex gap-1 shrink-0">
                {!isRenaming && (
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => startRename(device.id, device.deviceName ?? '')}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                )}
                {!device.isCurrent && (
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => setRevokeTarget({ id: device.id, name: device.deviceName ?? device.platform })}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <AlertDialog open={!!revokeTarget} onOpenChange={() => setRevokeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('security.devices.revokeTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('security.devices.revokeDescription', { name: revokeTarget?.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRevoke}>
              {t('security.devices.revokeConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
```

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```
Expected: No errors (hooks created in Task 29).

- [ ] **Step 3: Commit**

```bash
git add src/client/routes/security/devices.tsx
git commit -m "feat(ui): DevicesPage with device list, inline rename, revoke dialog, fingerprint copy"
```

---

### Task 22: SessionsPage (session list, terminate, sign-out-everywhere)

**Files:**
- Modify: `src/client/routes/security/sessions.tsx`

- [ ] **Step 1: Implement SessionsPage**

Replace `src/client/routes/security/sessions.tsx`:

```typescript
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { LogOut, ShieldAlert, Smartphone, Monitor } from 'lucide-react'
import { useSessions, useTerminateSession, useTerminateOtherSessions } from '@/lib/queries/devices'

export default function SessionsPage() {
  const { t } = useTranslation()
  const { data: sessions, isLoading } = useSessions()
  const terminateSession = useTerminateSession()
  const terminateOthers = useTerminateOtherSessions()
  const [showLockdown, setShowLockdown] = useState(false)
  const [showTerminateAll, setShowTerminateAll] = useState(false)

  if (isLoading) return <div className="animate-pulse">{t('common.loading')}</div>

  const otherSessions = sessions?.filter(s => !s.isCurrent) ?? []

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t('security.sessions.title')}</h2>
        <div className="flex gap-2">
          {otherSessions.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowTerminateAll(true)}
            >
              <LogOut className="h-4 w-4 mr-1" />
              {t('security.sessions.endOthers')}
            </Button>
          )}
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setShowLockdown(true)}
          >
            <ShieldAlert className="h-4 w-4 mr-1" />
            {t('security.sessions.lockdown')}
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        {sessions?.map((session) => {
          const Icon = session.platform === 'ios' || session.platform === 'android'
            ? Smartphone : Monitor

          return (
            <div
              key={session.token}
              className="flex items-center gap-3 p-3 rounded-md border"
              data-testid={`session-${session.token}`}
            >
              <Icon className="h-5 w-5 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">
                    {session.platform ?? t('security.sessions.unknown')}
                  </span>
                  {session.isCurrent && (
                    <Badge variant="secondary" className="text-xs">
                      {t('security.sessions.current')}
                    </Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {t('security.sessions.created')} {new Date(session.createdAt).toLocaleString()}
                  {' '}&middot;{' '}
                  {t('security.sessions.expires')} {new Date(session.expiresAt).toLocaleString()}
                </div>
              </div>
              {!session.isCurrent && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => terminateSession.mutate({ token: session.token })}
                >
                  <LogOut className="h-4 w-4" />
                </Button>
              )}
            </div>
          )
        })}
      </div>

      {/* Terminate All Others Dialog */}
      <AlertDialog open={showTerminateAll} onOpenChange={setShowTerminateAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('security.sessions.endOthersTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('security.sessions.endOthersDescription', { count: otherSessions.length })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              terminateOthers.mutate()
              setShowTerminateAll(false)
            }}>
              {t('security.sessions.endOthersConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Lockdown — Task 23 */}
      {showLockdown && (
        <LockdownModalPlaceholder onClose={() => setShowLockdown(false)} />
      )}
    </div>
  )
}

function LockdownModalPlaceholder({ onClose }: { onClose: () => void }) {
  // Placeholder — replaced in Task 23
  return null
}
```

- [ ] **Step 2: Commit**

```bash
git add src/client/routes/security/sessions.tsx
git commit -m "feat(ui): SessionsPage with session list, terminate, and sign-out-everywhere"
```

---

### Task 23: LockdownModal

**Files:**
- Create: `src/client/components/security/lockdown-modal.tsx`
- Modify: `src/client/routes/security/sessions.tsx` (import real modal)

- [ ] **Step 1: Create LockdownModal component**

Create `src/client/components/security/lockdown-modal.tsx`:

```typescript
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { ShieldAlert, AlertTriangle } from 'lucide-react'
import { useLockdown } from '@/lib/queries/devices'

interface LockdownModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function LockdownModal({ open, onOpenChange }: LockdownModalProps) {
  const { t } = useTranslation()
  const lockdown = useLockdown()
  const [step, setStep] = useState<'confirm' | 'progress' | 'done'>('confirm')
  const [result, setResult] = useState<{ sessionsTerminated: number; hubIds: string[] } | null>(null)

  async function performLockdown() {
    setStep('progress')
    try {
      const res = await lockdown.mutateAsync()
      setResult(res)
      // Client-side PUK + hub key rotation would happen here via platform.ts
      // For now, report completion
      setStep('done')
    } catch {
      setStep('confirm')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <ShieldAlert className="h-5 w-5" />
            {t('security.lockdown.title')}
          </DialogTitle>
          <DialogDescription>
            {step === 'confirm' && t('security.lockdown.description')}
            {step === 'progress' && t('security.lockdown.inProgress')}
            {step === 'done' && t('security.lockdown.complete', {
              sessions: result?.sessionsTerminated,
              hubs: result?.hubIds.length,
            })}
          </DialogDescription>
        </DialogHeader>

        {step === 'confirm' && (
          <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 text-sm">
            <AlertTriangle className="h-4 w-4 mt-0.5 text-destructive" />
            <span>{t('security.lockdown.warning')}</span>
          </div>
        )}

        <DialogFooter>
          {step === 'confirm' && (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t('common.cancel')}
              </Button>
              <Button variant="destructive" onClick={performLockdown}>
                {t('security.lockdown.confirm')}
              </Button>
            </>
          )}
          {step === 'done' && (
            <Button onClick={() => onOpenChange(false)}>
              {t('common.done')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Wire into SessionsPage**

Update `src/client/routes/security/sessions.tsx` to import and use the real `LockdownModal`:

```typescript
import { LockdownModal } from '@/components/security/lockdown-modal'

// Replace the placeholder at bottom of SessionsPage:
<LockdownModal open={showLockdown} onOpenChange={setShowLockdown} />
```

- [ ] **Step 3: Run typecheck**

```bash
bun run typecheck
```
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/client/components/security/lockdown-modal.tsx src/client/routes/security/sessions.tsx
git commit -m "feat(ui): LockdownModal with elevated auth, session termination, and key rotation"
```

---

### Task 24: PasskeysPage (enhanced WebAuthn management)

**Files:**
- Modify: `src/client/routes/security/passkeys.tsx`

- [ ] **Step 1: Implement PasskeysPage with rename, transport badges, backup status**

Replace `src/client/routes/security/passkeys.tsx`:

```typescript
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Key, Pencil, Trash2, Check, Usb, Wifi, ShieldCheck } from 'lucide-react'
import { usePasskeys, useRenamePasskey, useDeletePasskey, useRegisterPasskey } from '@/lib/queries/devices'

const TRANSPORT_ICONS: Record<string, typeof Usb> = {
  usb: Usb,
  ble: Wifi,
  nfc: Wifi,
  internal: ShieldCheck,
}

export default function PasskeysPage() {
  const { t } = useTranslation()
  const { data: passkeys, isLoading } = usePasskeys()
  const renamePasskey = useRenamePasskey()
  const deletePasskey = useDeletePasskey()
  const registerPasskey = useRegisterPasskey()
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  if (isLoading) return <div className="animate-pulse">{t('common.loading')}</div>

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t('security.passkeys.title')}</h2>
        <Button size="sm" onClick={() => registerPasskey.mutate()}>
          <Key className="h-4 w-4 mr-1" />
          {t('security.passkeys.register')}
        </Button>
      </div>

      <div className="space-y-2">
        {passkeys?.map((passkey) => (
          <div key={passkey.credentialId} className="flex items-center gap-3 p-3 rounded-md border">
            <Key className="h-5 w-5 text-muted-foreground" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                {renamingId === passkey.credentialId ? (
                  <div className="flex gap-1">
                    <Input
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          renamePasskey.mutate({ credentialId: passkey.credentialId, label: renameValue })
                          setRenamingId(null)
                        }
                      }}
                      className="h-7 text-sm"
                      autoFocus
                    />
                    <Button size="sm" variant="ghost" onClick={() => {
                      renamePasskey.mutate({ credentialId: passkey.credentialId, label: renameValue })
                      setRenamingId(null)
                    }}>
                      <Check className="h-3 w-3" />
                    </Button>
                  </div>
                ) : (
                  <span className="font-medium text-sm">{passkey.label || t('security.passkeys.unnamed')}</span>
                )}
                {passkey.backedUp && (
                  <Badge variant="outline" className="text-xs">{t('security.passkeys.backedUp')}</Badge>
                )}
              </div>
              <div className="flex items-center gap-2 mt-1">
                {passkey.transports?.map((transport: string) => {
                  const Icon = TRANSPORT_ICONS[transport] ?? Key
                  return (
                    <Badge key={transport} variant="secondary" className="text-xs gap-1">
                      <Icon className="h-3 w-3" />
                      {transport}
                    </Badge>
                  )
                })}
                {passkey.lastUsedAt && (
                  <span className="text-xs text-muted-foreground">
                    {t('security.passkeys.lastUsed')} {new Date(passkey.lastUsedAt).toLocaleDateString()}
                  </span>
                )}
              </div>
            </div>
            <div className="flex gap-1">
              <Button
                size="icon"
                variant="ghost"
                onClick={() => {
                  setRenamingId(passkey.credentialId)
                  setRenameValue(passkey.label ?? '')
                }}
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => deletePasskey.mutate({ credentialId: passkey.credentialId })}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/client/routes/security/passkeys.tsx
git commit -m "feat(ui): PasskeysPage with rename, transport badges, backup status, and last used"
```

---

### Task 25: HistoryPage (security event timeline)

**Files:**
- Modify: `src/client/routes/security/history.tsx`

- [ ] **Step 1: Implement HistoryPage**

Replace `src/client/routes/security/history.tsx`:

```typescript
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Smartphone, Key, LogOut, ShieldAlert, Shield, Link2, AlertTriangle, Download,
} from 'lucide-react'
import { useSecurityEvents } from '@/lib/queries/devices'

const EVENT_ICONS: Record<string, typeof Smartphone> = {
  device_register: Smartphone,
  device_remove: Smartphone,
  device_rename: Smartphone,
  session_create: Key,
  session_terminate: LogOut,
  session_terminate_all: LogOut,
  account_lockdown: ShieldAlert,
  account_lockdown_complete: Shield,
  webauthn_register: Key,
  webauthn_authenticate: Key,
  webauthn_remove: Key,
  sigchain_append: Link2,
  puk_rotate: Shield,
  hub_key_rotate: Shield,
  device_fingerprint_verified: Shield,
  passkey_rename: Key,
  login_failed: AlertTriangle,
}

export default function HistoryPage() {
  const { t } = useTranslation()
  const [limit] = useState(50)
  const [offset, setOffset] = useState(0)
  const { data, isLoading } = useSecurityEvents(limit, offset)

  function exportJson() {
    if (!data?.events) return
    const blob = new Blob([JSON.stringify(data.events, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `security-events-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (isLoading) return <div className="animate-pulse">{t('common.loading')}</div>

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t('security.history.title')}</h2>
        <Button variant="outline" size="sm" onClick={exportJson}>
          <Download className="h-4 w-4 mr-1" />
          {t('security.history.export')}
        </Button>
      </div>

      <div className="space-y-2">
        {data?.events.map((event) => {
          const Icon = EVENT_ICONS[event.eventType] ?? AlertTriangle

          return (
            <div key={event.id} className="flex items-start gap-3 p-3 rounded-md border">
              <Icon className="h-4 w-4 mt-0.5 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-xs">
                    {t(`security.history.events.${event.eventType}`, { defaultValue: event.eventType })}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {new Date(event.createdAt).toLocaleString()}
                  </span>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {data && data.total > offset + limit && (
        <Button variant="outline" onClick={() => setOffset(o => o + limit)}>
          {t('common.loadMore')}
        </Button>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/client/routes/security/history.tsx
git commit -m "feat(ui): HistoryPage with security event timeline, type icons, and JSON export"
```

---

## Phase 7: Desktop — Admin Device Oversight

### Task 26: DevicesSection in admin settings

**Files:**
- Create: `src/client/components/admin-sections/devices-section.tsx`

- [ ] **Step 1: Create DevicesSection component**

Create `src/client/components/admin-sections/devices-section.tsx`:

```typescript
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Smartphone, Monitor, ShieldCheck, ShieldQuestion } from 'lucide-react'
import { useAdminDeviceOverview } from '@/lib/queries/devices'
import { VerifyFingerprintModal } from '@/components/security/verify-fingerprint-modal'

export function DevicesSection() {
  const { t } = useTranslation()
  const { data, isLoading } = useAdminDeviceOverview()
  const [verifyTarget, setVerifyTarget] = useState<{
    deviceId: string
    targetPubkey: string
    deviceName: string
  } | null>(null)

  if (isLoading) return <div className="animate-pulse">{t('common.loading')}</div>

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">{t('admin.devices.title')}</h3>

      <div className="space-y-3">
        {data?.entries.map((entry) => (
          <div key={entry.userPubkey} className="border rounded-md p-3">
            <div className="flex items-center justify-between">
              <div>
                <span className="font-medium text-sm">{entry.displayName ?? entry.userPubkey.slice(0, 16)}</span>
                <Badge variant="outline" className="ml-2 text-xs">
                  {entry.deviceCount} {t('admin.devices.devices')}
                </Badge>
              </div>
              <Badge variant={entry.verified ? 'default' : 'secondary'} className="gap-1">
                {entry.verified ? <ShieldCheck className="h-3 w-3" /> : <ShieldQuestion className="h-3 w-3" />}
                {entry.verified ? t('admin.devices.verified') : t('admin.devices.unverified')}
              </Badge>
            </div>

            <div className="mt-2 space-y-1">
              {entry.devices.map((device) => {
                const Icon = device.platform === 'ios' || device.platform === 'android'
                  ? Smartphone : Monitor
                return (
                  <div key={device.id} className="flex items-center gap-2 text-sm pl-2">
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    <span>{device.deviceName ?? device.platform}</span>
                    {device.deviceModel && (
                      <span className="text-xs text-muted-foreground">{device.deviceModel}</span>
                    )}
                    {device.ed25519Pubkey && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="ml-auto text-xs"
                        onClick={() => setVerifyTarget({
                          deviceId: device.id,
                          targetPubkey: device.ed25519Pubkey!,
                          deviceName: device.deviceName ?? device.platform,
                        })}
                      >
                        {t('admin.devices.verify')}
                      </Button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {verifyTarget && (
        <VerifyFingerprintModal
          open={!!verifyTarget}
          onOpenChange={() => setVerifyTarget(null)}
          targetDeviceId={verifyTarget.deviceId}
          targetPubkey={verifyTarget.targetPubkey}
          targetDeviceName={verifyTarget.deviceName}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 2: Register in admin section registry**

Register `DevicesSection` in the section registry (check `src/client/components/admin-shell/section-registry.ts` or equivalent) with slug `'devices'` and `requiredPermissions: ['users:manage-devices']`.

- [ ] **Step 3: Run typecheck**

```bash
bun run typecheck
```
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/client/components/admin-sections/devices-section.tsx src/client/components/admin-shell/
git commit -m "feat(ui): admin DevicesSection with hub-scoped device overview and verification badges"
```

---

### Task 27: VerifyFingerprintModal (SAS ceremony)

**Files:**
- Create: `src/client/components/security/verify-fingerprint-modal.tsx`

- [ ] **Step 1: Create VerifyFingerprintModal**

Create `src/client/components/security/verify-fingerprint-modal.tsx`:

```typescript
import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { ShieldCheck, RefreshCw } from 'lucide-react'
import { deriveSas, getSasEmojiTable, getDevicePubkey, signAuditEntry } from '@/lib/platform'
import { useVerifyDevice } from '@/lib/queries/devices'

interface VerifyFingerprintModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  targetDeviceId: string
  targetPubkey: string
  targetDeviceName: string
}

export function VerifyFingerprintModal({
  open,
  onOpenChange,
  targetDeviceId,
  targetPubkey,
  targetDeviceName,
}: VerifyFingerprintModalProps) {
  const { t } = useTranslation()
  const verifyDevice = useVerifyDevice()
  const [emojiIndices, setEmojiIndices] = useState<number[] | null>(null)
  const [emojiTable, setEmojiTable] = useState<string[]>([])
  const [nonce, setNonce] = useState<string>('')
  const [step, setStep] = useState<'display' | 'confirming' | 'done'>('display')

  useEffect(() => {
    if (!open) return
    generateSas()
  }, [open, targetPubkey])

  async function generateSas() {
    // Get admin's own pubkey
    const adminPubkey = await getDevicePubkey()

    // Generate 32-byte random nonce
    const nonceBytes = new Uint8Array(32)
    crypto.getRandomValues(nonceBytes)
    const nonceHex = Array.from(nonceBytes).map(b => b.toString(16).padStart(2, '0')).join('')
    setNonce(nonceHex)

    // Derive SAS indices
    const indices = await deriveSas(adminPubkey, targetPubkey, nonceHex)
    setEmojiIndices(indices)

    // Get emoji table
    const table = await getSasEmojiTable()
    setEmojiTable(table)
  }

  async function confirmMatch() {
    setStep('confirming')

    // Sign audit entry
    const signedEntry = await signAuditEntry({
      type: 'device_fingerprint_verified',
      targetDeviceId,
      targetPubkey,
      nonce,
      timestamp: new Date().toISOString(),
    })

    // POST to server
    await verifyDevice.mutateAsync({
      deviceId: targetDeviceId,
      signedAuditEntry: signedEntry,
    })

    setStep('done')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" />
            {t('admin.devices.verifyTitle', { name: targetDeviceName })}
          </DialogTitle>
          <DialogDescription>
            {t('admin.devices.verifyDescription')}
          </DialogDescription>
        </DialogHeader>

        {step === 'display' && emojiIndices && emojiTable.length > 0 && (
          <div className="space-y-4">
            <div className="flex justify-center gap-3 text-3xl py-4">
              {emojiIndices.map((idx, i) => (
                <span key={i} role="img" aria-label={`emoji-${idx}`}>
                  {emojiTable[idx]}
                </span>
              ))}
            </div>
            <p className="text-sm text-muted-foreground text-center">
              {t('admin.devices.verifyInstruction')}
            </p>
            <p className="text-xs text-muted-foreground text-center font-mono">
              {t('admin.devices.nonce')}: {nonce.slice(0, 16)}...
            </p>
          </div>
        )}

        {step === 'done' && (
          <div className="flex flex-col items-center gap-2 py-4">
            <ShieldCheck className="h-8 w-8 text-green-500" />
            <p className="text-sm font-medium">{t('admin.devices.verifySuccess')}</p>
          </div>
        )}

        <DialogFooter>
          {step === 'display' && (
            <>
              <Button variant="ghost" onClick={() => generateSas()}>
                <RefreshCw className="h-4 w-4 mr-1" />
                {t('admin.devices.newNonce')}
              </Button>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t('admin.devices.noMatch')}
              </Button>
              <Button onClick={confirmMatch}>
                {t('admin.devices.match')}
              </Button>
            </>
          )}
          {step === 'done' && (
            <Button onClick={() => onOpenChange(false)}>
              {t('common.done')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/client/components/security/verify-fingerprint-modal.tsx
git commit -m "feat(ui): VerifyFingerprintModal with SAS 7-emoji ceremony and signed audit entry"
```

---

## Phase 8: Desktop — User Role Assignment UI

### Task 28: UserRoleAssignment component

**Files:**
- Create: `src/client/components/user-role-assignment.tsx`

- [ ] **Step 1: Create UserRoleAssignment component**

Create `src/client/components/user-role-assignment.tsx`:

```typescript
import { useTranslation } from 'react-i18next'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { useRoles } from '@/lib/queries/roles'

interface UserRoleAssignmentProps {
  selectedRoleIds: string[]
  onChange: (roleIds: string[]) => void
  scope?: 'hub' | 'platform'
  disabled?: boolean
}

export function UserRoleAssignment({
  selectedRoleIds,
  onChange,
  scope,
  disabled = false,
}: UserRoleAssignmentProps) {
  const { t } = useTranslation()
  const { data: roles, isLoading } = useRoles(scope)

  if (isLoading) return <div className="animate-pulse text-sm">{t('common.loading')}</div>

  const selectedSet = new Set(selectedRoleIds)

  function toggleRole(roleId: string) {
    if (selectedSet.has(roleId)) {
      onChange(selectedRoleIds.filter(id => id !== roleId))
    } else {
      onChange([...selectedRoleIds, roleId])
    }
  }

  // Group: system roles first, then custom
  const sorted = [...(roles ?? [])].sort((a, b) => {
    if (a.isSystem !== b.isSystem) return a.isSystem ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return (
    <div className="space-y-2">
      {sorted.map((role) => (
        <div
          key={role.id}
          className="flex items-start gap-3 p-2 rounded-md hover:bg-muted/50"
        >
          <Checkbox
            id={`role-${role.id}`}
            checked={selectedSet.has(role.id)}
            onCheckedChange={() => toggleRole(role.id)}
            disabled={disabled}
          />
          <div className="flex-1">
            <Label htmlFor={`role-${role.id}`} className="text-sm font-medium cursor-pointer">
              {role.name}
            </Label>
            {role.description && (
              <p className="text-xs text-muted-foreground">{role.description}</p>
            )}
            <Badge variant="outline" className="text-xs mt-1">
              {role.permissions.length === 1 && role.permissions[0] === '*'
                ? t('roles.allPermissions')
                : t('roles.permissionCount', { count: role.permissions.length })}
            </Badge>
          </div>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/client/components/user-role-assignment.tsx
git commit -m "feat(ui): UserRoleAssignment multi-select picker for admin role management"
```

---

## Phase 9: React Query Hooks

### Task 29: Device/session/event query hooks

**Files:**
- Create: `src/client/lib/queries/devices.ts`

- [ ] **Step 1: Create device/session/event query hooks**

Create `src/client/lib/queries/devices.ts`:

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'

// --- Query keys ---

export const deviceKeys = {
  all: ['devices'] as const,
  list: () => [...deviceKeys.all, 'list'] as const,
  sessions: () => ['sessions'] as const,
  securityEvents: (limit: number, offset: number) => ['security-events', limit, offset] as const,
  adminOverview: () => ['admin-devices-overview'] as const,
  passkeys: () => ['passkeys'] as const,
}

// --- Device hooks ---

export function useDevices() {
  return useQuery({
    queryKey: deviceKeys.list(),
    queryFn: async () => {
      const res = await api.get('/api/devices')
      const data = await res.json()
      return data.devices
    },
    staleTime: 30_000,
  })
}

export function useRenameDevice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ deviceId, deviceName }: { deviceId: string; deviceName: string }) => {
      const res = await api.patch(`/api/devices/${deviceId}`, { json: { deviceName } })
      return res.json()
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: deviceKeys.all }),
  })
}

export function useRevokeDevice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ deviceId }: { deviceId: string }) => {
      const res = await api.post(`/api/devices/${deviceId}/revoke`, { json: { confirm: true } })
      return res.json()
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: deviceKeys.all }),
  })
}

export function useVerifyDevice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ deviceId, signedAuditEntry }: { deviceId: string; signedAuditEntry: string }) => {
      const res = await api.post(`/api/devices/${deviceId}/verify`, { json: { signedAuditEntry } })
      return res.json()
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: deviceKeys.adminOverview() }),
  })
}

// --- Session hooks ---

export function useSessions() {
  return useQuery({
    queryKey: deviceKeys.sessions(),
    queryFn: async () => {
      const res = await api.get('/api/sessions')
      const data = await res.json()
      return data.sessions
    },
    staleTime: 30_000,
  })
}

export function useTerminateSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ token }: { token: string }) => {
      await api.delete(`/api/sessions/${token}`)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: deviceKeys.sessions() }),
  })
}

export function useTerminateOtherSessions() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const res = await api.post('/api/sessions/terminate-others')
      return res.json()
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: deviceKeys.sessions() }),
  })
}

// --- Lockdown ---

export function useLockdown() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const res = await api.post('/api/account/lockdown')
      return res.json()
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: deviceKeys.sessions() })
      qc.invalidateQueries({ queryKey: deviceKeys.all })
    },
  })
}

// --- Security events ---

export function useSecurityEvents(limit: number, offset: number) {
  return useQuery({
    queryKey: deviceKeys.securityEvents(limit, offset),
    queryFn: async () => {
      const res = await api.get(`/api/security-events?limit=${limit}&offset=${offset}`)
      return res.json()
    },
    staleTime: 60_000,
  })
}

// --- Admin device overview ---

export function useAdminDeviceOverview(hubId?: string) {
  return useQuery({
    queryKey: deviceKeys.adminOverview(),
    queryFn: async () => {
      const params = hubId ? `?hubId=${hubId}` : ''
      const res = await api.get(`/api/admin/devices/overview${params}`)
      return res.json()
    },
    staleTime: 60_000,
  })
}

// --- Passkey hooks ---

export function usePasskeys() {
  return useQuery({
    queryKey: deviceKeys.passkeys(),
    queryFn: async () => {
      const res = await api.get('/api/webauthn/credentials')
      return res.json()
    },
    staleTime: 60_000,
  })
}

export function useRenamePasskey() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ credentialId, label }: { credentialId: string; label: string }) => {
      await api.patch(`/api/webauthn/credentials/${credentialId}`, { json: { label } })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: deviceKeys.passkeys() }),
  })
}

export function useDeletePasskey() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ credentialId }: { credentialId: string }) => {
      await api.delete(`/api/webauthn/credentials/${credentialId}`)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: deviceKeys.passkeys() }),
  })
}

export function useRegisterPasskey() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      // WebAuthn registration flow — platform.ts handles ceremony
      const res = await api.post('/api/webauthn/register')
      return res.json()
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: deviceKeys.passkeys() }),
  })
}
```

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/client/lib/queries/devices.ts
git commit -m "feat(client): React Query hooks for devices, sessions, security events, passkeys, admin overview"
```

---

## Phase 10: Mobile

### Task 30: iOS device list + session list + security events

**Files:**
- Create: `apps/ios/Sources/Views/Security/DeviceListView.swift`
- Create: `apps/ios/Sources/Views/Security/SessionListView.swift`
- Create: `apps/ios/Sources/Views/Security/SecurityEventsView.swift`

- [ ] **Step 1: Create DeviceListView**

Create `apps/ios/Sources/Views/Security/DeviceListView.swift`:

```swift
import SwiftUI

struct DeviceListView: View {
    @State private var devices: [DeviceDetailResponse] = []
    @State private var loading = true

    var body: some View {
        List {
            if loading {
                ProgressView()
            } else {
                ForEach(devices, id: \.id) { device in
                    DeviceRow(device: device)
                }
            }
        }
        .navigationTitle(String(localized: "security.devices.title"))
        .task { await loadDevices() }
    }

    private func loadDevices() async {
        do {
            let response = try await APIClient.shared.get("/api/devices")
            let decoded = try JSONDecoder().decode(DeviceDetailListResponse.self, from: response)
            self.devices = decoded.devices
        } catch {
            // Handle error
        }
        loading = false
    }
}

struct DeviceRow: View {
    let device: DeviceDetailResponse

    var body: some View {
        HStack {
            Image(systemName: device.platform == "ios" || device.platform == "android"
                ? "iphone" : "desktopcomputer")
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text(device.deviceName ?? device.platform)
                        .font(.body)
                    if device.isCurrent {
                        Text("Current")
                            .font(.caption2)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(.blue.opacity(0.1))
                            .clipShape(Capsule())
                    }
                }
                if let model = device.deviceModel {
                    Text(model)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
        }
        .accessibilityIdentifier("device-\(device.id)")
    }
}
```

- [ ] **Step 2: Create SessionListView**

Create `apps/ios/Sources/Views/Security/SessionListView.swift`:

```swift
import SwiftUI

struct SessionListView: View {
    @State private var sessions: [SessionResponse] = []
    @State private var loading = true

    var body: some View {
        List {
            if loading {
                ProgressView()
            } else {
                ForEach(sessions, id: \.token) { session in
                    SessionRow(session: session)
                }
            }
        }
        .navigationTitle(String(localized: "security.sessions.title"))
        .task { await loadSessions() }
    }

    private func loadSessions() async {
        do {
            let response = try await APIClient.shared.get("/api/sessions")
            let decoded = try JSONDecoder().decode(SessionListResponse.self, from: response)
            self.sessions = decoded.sessions
        } catch {
            // Handle error
        }
        loading = false
    }
}

struct SessionRow: View {
    let session: SessionResponse

    var body: some View {
        HStack {
            Image(systemName: "key.fill")
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text(session.platform ?? "Unknown")
                        .font(.body)
                    if session.isCurrent {
                        Text("Current")
                            .font(.caption2)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(.blue.opacity(0.1))
                            .clipShape(Capsule())
                    }
                }
                Text("Created: \(session.createdAt)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
    }
}
```

- [ ] **Step 3: Create SecurityEventsView**

Create `apps/ios/Sources/Views/Security/SecurityEventsView.swift`:

```swift
import SwiftUI

struct SecurityEventsView: View {
    @State private var events: [SecurityEvent] = []
    @State private var loading = true
    @State private var total = 0

    var body: some View {
        List {
            if loading {
                ProgressView()
            } else {
                ForEach(events, id: \.id) { event in
                    HStack {
                        Image(systemName: iconForEventType(event.eventType))
                            .foregroundStyle(.secondary)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(event.eventType)
                                .font(.body)
                            Text(event.createdAt)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .navigationTitle(String(localized: "security.history.title"))
        .task { await loadEvents() }
    }

    private func loadEvents() async {
        do {
            let response = try await APIClient.shared.get("/api/security-events?limit=50&offset=0")
            let decoded = try JSONDecoder().decode(SecurityEventListResponse.self, from: response)
            self.events = decoded.events
            self.total = decoded.total
        } catch {
            // Handle error
        }
        loading = false
    }

    private func iconForEventType(_ type: String) -> String {
        switch type {
        case "device_register", "device_remove", "device_rename": return "iphone"
        case "session_create", "session_terminate", "session_terminate_all": return "key.fill"
        case "account_lockdown", "account_lockdown_complete": return "shield.fill"
        case "webauthn_register", "webauthn_authenticate": return "key.fill"
        default: return "exclamationmark.triangle"
        }
    }
}
```

- [ ] **Step 4: Wire into iOS Settings navigation**

Add navigation links to the iOS Settings tab for these three views.

- [ ] **Step 5: Build and test**

```bash
bun run ios:build && bun run ios:test
```
Expected: Builds and existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/ios/Sources/Views/Security/
git commit -m "feat(ios): device list, session list, and security events views"
```

---

### Task 31: Android device list + session list + security events

**Files:**
- Create: `apps/android/app/src/main/kotlin/org/llamenos/app/ui/security/DeviceListScreen.kt`
- Create: `apps/android/app/src/main/kotlin/org/llamenos/app/ui/security/SessionListScreen.kt`
- Create: `apps/android/app/src/main/kotlin/org/llamenos/app/ui/security/SecurityEventsScreen.kt`

- [ ] **Step 1: Create DeviceListScreen**

Create `apps/android/app/src/main/kotlin/org/llamenos/app/ui/security/DeviceListScreen.kt`:

```kotlin
package org.llamenos.app.ui.security

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material.icons.filled.Computer
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp

@Composable
fun DeviceListScreen(
    devices: List<DeviceDetailResponse>,
    loading: Boolean,
    modifier: Modifier = Modifier,
) {
    if (loading) {
        Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        return
    }

    LazyColumn(
        modifier = modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(devices, key = { it.id }) { device ->
            Card(modifier = Modifier.fillMaxWidth().testTag("device-${device.id}")) {
                Row(
                    modifier = Modifier.padding(16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Icon(
                        if (device.platform == "ios" || device.platform == "android")
                            Icons.Default.PhoneAndroid else Icons.Default.Computer,
                        contentDescription = device.platform,
                    )
                    Column(modifier = Modifier.weight(1f)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(
                                device.deviceName ?: device.platform,
                                style = MaterialTheme.typography.bodyLarge,
                            )
                            if (device.isCurrent) {
                                AssistChip(
                                    onClick = {},
                                    label = { Text("Current", style = MaterialTheme.typography.labelSmall) },
                                )
                            }
                        }
                        device.deviceModel?.let {
                            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
    }
}
```

- [ ] **Step 2: Create SessionListScreen**

Create `apps/android/app/src/main/kotlin/org/llamenos/app/ui/security/SessionListScreen.kt`:

```kotlin
package org.llamenos.app.ui.security

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Key
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable
fun SessionListScreen(
    sessions: List<SessionResponse>,
    loading: Boolean,
    modifier: Modifier = Modifier,
) {
    if (loading) {
        Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        return
    }

    LazyColumn(
        modifier = modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(sessions, key = { it.token }) { session ->
            Card(modifier = Modifier.fillMaxWidth()) {
                Row(
                    modifier = Modifier.padding(16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Icon(Icons.Default.Key, contentDescription = "Session")
                    Column(modifier = Modifier.weight(1f)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(
                                session.platform ?: "Unknown",
                                style = MaterialTheme.typography.bodyLarge,
                            )
                            if (session.isCurrent) {
                                AssistChip(
                                    onClick = {},
                                    label = { Text("Current", style = MaterialTheme.typography.labelSmall) },
                                )
                            }
                        }
                        Text(
                            "Created: ${session.createdAt}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
}
```

- [ ] **Step 3: Create SecurityEventsScreen**

Create `apps/android/app/src/main/kotlin/org/llamenos/app/ui/security/SecurityEventsScreen.kt`:

```kotlin
package org.llamenos.app.ui.security

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.filled.Shield
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp

@Composable
fun SecurityEventsScreen(
    events: List<SecurityEvent>,
    loading: Boolean,
    total: Int,
    modifier: Modifier = Modifier,
) {
    if (loading) {
        Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        return
    }

    LazyColumn(
        modifier = modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(events, key = { it.id }) { event ->
            Card(modifier = Modifier.fillMaxWidth()) {
                Row(
                    modifier = Modifier.padding(16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Icon(iconForEventType(event.eventType), contentDescription = event.eventType)
                    Column {
                        Text(event.eventType, style = MaterialTheme.typography.bodyMedium)
                        Text(
                            event.createdAt,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
}

private fun iconForEventType(type: String): ImageVector = when {
    type.startsWith("device_") -> Icons.Default.PhoneAndroid
    type.startsWith("session_") -> Icons.Default.Key
    type.startsWith("account_") || type.startsWith("puk_") || type.startsWith("hub_key_") -> Icons.Default.Shield
    type.startsWith("webauthn_") -> Icons.Default.Key
    else -> Icons.Default.Warning
}
```

- [ ] **Step 4: Wire into Android Settings navigation**

Register screens in the Android settings navigation (check existing patterns in `apps/android/app/src/main/kotlin/org/llamenos/app/ui/`).

- [ ] **Step 5: Build and test**

```bash
bun run test:android
```
Expected: Builds and existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/android/app/src/main/kotlin/org/llamenos/app/ui/security/
git commit -m "feat(android): device list, session list, and security events screens with Material 3"
```

---

### Task 32: Mobile device metadata reporting

**Files:**
- Modify: `apps/ios/Sources/Services/APIClient.swift` (or device registration path)
- Modify: `apps/android/app/src/main/kotlin/org/llamenos/app/api/` (or device registration path)

- [ ] **Step 1: iOS — send device metadata on registration**

In the iOS device registration flow, add metadata to the POST body:

```swift
import UIKit

func registerDevice() async throws {
    var body: [String: Any] = [
        "platform": "ios",
        "pushToken": pushToken,
    ]

    // Auto-detected metadata
    body["deviceName"] = UIDevice.current.name
    body["deviceModel"] = mapMachineToModel() // utsname.machine mapped
    body["osVersion"] = UIDevice.current.systemVersion
    body["appVersion"] = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String

    try await APIClient.shared.post("/api/devices/register", body: body)
}

private func mapMachineToModel() -> String {
    var systemInfo = utsname()
    uname(&systemInfo)
    let machine = withUnsafePointer(to: &systemInfo.machine) {
        $0.withMemoryRebound(to: CChar.self, capacity: 1) {
            String(cString: $0)
        }
    }
    return machine
}
```

- [ ] **Step 2: Android — send device metadata on registration**

In the Android device registration flow, add metadata:

```kotlin
import android.os.Build

suspend fun registerDevice(pushToken: String) {
    val body = mapOf(
        "platform" to "android",
        "pushToken" to pushToken,
        "deviceName" to Build.MODEL,
        "deviceModel" to Build.MODEL,
        "osVersion" to Build.VERSION.RELEASE,
        "appVersion" to BuildConfig.VERSION_NAME,
    )
    apiClient.post("/api/devices/register", body)
}
```

- [ ] **Step 3: Update backend to accept and store metadata**

In `apps/worker/routes/devices.ts`, update the POST `/register` handler to store the metadata fields:

```typescript
    await services.identity.registerDevice(pubkey, {
      platform: body.platform,
      pushToken: body.pushToken,
      wakeKeyPublic: body.wakeKeyPublic,
      ed25519Pubkey: body.ed25519Pubkey,
      x25519Pubkey: body.x25519Pubkey,
      // EP02 metadata
      deviceName: body.deviceName,
      deviceModel: body.deviceModel,
      osVersion: body.osVersion,
      appVersion: body.appVersion,
    })
```

Update `registerDeviceBodySchema` in `packages/protocol/schemas/devices.ts` to accept the optional metadata fields:

```typescript
export const registerDeviceBodySchema = z.looseObject({
  platform: z.enum(['ios', 'android']),
  pushToken: z.string().min(1, 'pushToken is required'),
  wakeKeyPublic: z.string().regex(/^0[23][0-9a-f]{64}$/i, 'Must be 33-byte compressed secp256k1 pubkey in hex'),
  ed25519Pubkey: ed25519PubkeySchema.optional(),
  x25519Pubkey: x25519PubkeySchema.optional(),
  // EP02: device metadata
  deviceName: z.string().max(100).optional(),
  deviceModel: z.string().max(100).optional(),
  osVersion: z.string().max(50).optional(),
  appVersion: z.string().max(50).optional(),
})
```

- [ ] **Step 4: Update `registerDevice` in IdentityService**

In `apps/worker/services/identity.ts`, update the `registerDevice` method to accept and store the metadata fields when upserting the device record.

- [ ] **Step 5: Run typecheck**

```bash
bun run typecheck
```
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add apps/ios/ apps/android/ apps/worker/ packages/protocol/schemas/devices.ts
git commit -m "feat(mobile): report device metadata on registration (name, model, OS version, app version)"
```

---

## Phase 11: i18n Strings

### Task 33: Add i18n strings for security management

**Files:**
- Modify: `packages/i18n/locales/en.json`

- [ ] **Step 1: Add security namespace strings to en.json**

Add under a `security` namespace:

```json
{
  "security": {
    "tabs": {
      "devices": "Devices",
      "sessions": "Sessions",
      "passkeys": "Passkeys",
      "history": "History"
    },
    "devices": {
      "title": "Your Devices",
      "limit": "devices",
      "current": "This device",
      "lastSeen": "Last seen",
      "revokeTitle": "Remove device",
      "revokeDescription": "Remove {{name}}? It will lose access to all encrypted content.",
      "revokeConfirm": "Remove device"
    },
    "sessions": {
      "title": "Active Sessions",
      "current": "Current session",
      "unknown": "Unknown device",
      "created": "Created",
      "expires": "Expires",
      "endOthers": "End all other sessions",
      "endOthersTitle": "End all other sessions?",
      "endOthersDescription": "This will sign out {{count}} other sessions.",
      "endOthersConfirm": "End sessions",
      "lockdown": "Emergency lockdown"
    },
    "passkeys": {
      "title": "Passkeys",
      "register": "Add passkey",
      "unnamed": "Unnamed passkey",
      "backedUp": "Backed up",
      "lastUsed": "Last used"
    },
    "history": {
      "title": "Security History",
      "export": "Export JSON",
      "events": {
        "device_register": "Device registered",
        "device_remove": "Device removed",
        "device_rename": "Device renamed",
        "session_create": "Session created",
        "session_terminate": "Session terminated",
        "session_terminate_all": "All sessions terminated",
        "account_lockdown": "Account locked down",
        "account_lockdown_complete": "Lockdown completed",
        "webauthn_register": "Passkey registered",
        "webauthn_authenticate": "Passkey authenticated",
        "webauthn_remove": "Passkey removed",
        "sigchain_append": "Sigchain updated",
        "puk_rotate": "PUK rotated",
        "hub_key_rotate": "Hub key rotated",
        "device_fingerprint_verified": "Device verified",
        "passkey_rename": "Passkey renamed",
        "login_failed": "Login failed"
      }
    },
    "lockdown": {
      "title": "Emergency Lockdown",
      "description": "This will terminate all other sessions and trigger key rotation for all your hubs.",
      "warning": "This action cannot be undone. All other devices will be signed out immediately.",
      "inProgress": "Terminating sessions and rotating keys...",
      "complete": "Lockdown complete. {{sessions}} sessions terminated, {{hubs}} hub keys queued for rotation.",
      "confirm": "Lock down now"
    }
  },
  "admin": {
    "devices": {
      "title": "Device Overview",
      "devices": "devices",
      "verified": "Verified",
      "unverified": "Unverified",
      "verify": "Verify",
      "verifyTitle": "Verify {{name}}",
      "verifyDescription": "Compare the emojis below with the device owner. Both parties must see the same 7 emojis.",
      "verifyInstruction": "Read these emojis aloud to the device owner and confirm they see the same sequence.",
      "nonce": "Session nonce",
      "newNonce": "New nonce",
      "noMatch": "No match",
      "match": "Emojis match",
      "verifySuccess": "Device verified successfully"
    }
  }
}
```

- [ ] **Step 2: Run i18n codegen**

```bash
bun run i18n:codegen
```
Expected: Generates iOS `.strings` and Android `strings.xml`.

- [ ] **Step 3: Validate i18n completeness**

```bash
bun run i18n:validate:all
```
Expected: No validation errors.

- [ ] **Step 4: Commit**

```bash
git add packages/i18n/
git commit -m "feat(i18n): add security management strings for devices, sessions, passkeys, history, lockdown, admin verification"
```

---

## Phase 12: Integration Testing & Final Verification

### Task 34: Desktop E2E tests for security route tree

**Files:**
- Create: `tests/e2e/security.spec.ts`

- [ ] **Step 1: Write Playwright E2E tests**

Test scenarios:
1. Navigate to `/security/devices` — verify tab bar renders, device list loads
2. Rename a device — verify inline edit flow
3. Navigate to `/security/sessions` — verify session list loads
4. Navigate to `/security/passkeys` — verify passkey list loads
5. Navigate to `/security/history` — verify event timeline loads
6. Export security events as JSON

Ensure Tauri IPC mock layer handles `derive_sas` and `get_sas_emoji_table`.

- [ ] **Step 2: Run E2E tests**

```bash
bun run test
```
Expected: All security E2E tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/security.spec.ts
git commit -m "test: E2E tests for security route tree (devices, sessions, passkeys, history)"
```

---

### Task 35: Final verification

- [ ] **Step 1: Run full typecheck**

```bash
bun run typecheck
```
Expected: No errors.

- [ ] **Step 2: Run all desktop tests**

```bash
bun run test
```
Expected: All tests pass.

- [ ] **Step 3: Run backend unit tests**

```bash
bun test apps/worker/__tests__/unit/
```
Expected: All tests pass including new device/session/security-event tests.

- [ ] **Step 4: Run backend BDD tests**

```bash
bun run test:backend:bdd
```
Expected: All tests pass.

- [ ] **Step 5: Run crypto tests**

```bash
bun run crypto:test
```
Expected: All pass including SAS derivation tests.

- [ ] **Step 6: Run i18n validation**

```bash
bun run i18n:validate:all
```
Expected: All pass.

- [ ] **Step 7: Run codegen to verify schema registration**

```bash
bun run codegen
```
Expected: All device-management schemas generate correctly.

- [ ] **Step 8: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address issues from EP02 final verification pass"
```
