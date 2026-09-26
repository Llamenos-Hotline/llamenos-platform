import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../types'
import type { Hub, MessagingChannelType } from '@shared/types'
import { hashPhone } from '../lib/crypto'
import { publishEvent } from '../lib/ws-events'
import { KIND_CALL_RING, KIND_CALL_UPDATE, KIND_CALL_VOICEMAIL, KIND_MESSAGE_NEW, KIND_PRESENCE_UPDATE } from '@shared/event-kinds'
import { getTestPushLog, clearTestPushLog } from '../lib/push-dispatch'
import { getApnsBundleId, getApnsVoipTopic } from '../lib/apns-topic'
import { seedDemoDataset } from '../services/demo-seeder'
import { DEMO_HUB } from '../lib/demo-dataset'
import { demoIdentities } from '../lib/demo-identities'

/**
 * Decode a pubkey (hex only — npub1 bech32 encoding is no longer supported).
 * Returns the hex pubkey string.
 */
function decodePubkey(input: string): string {
  if (input.startsWith('npub1')) {
    throw new Error('npub1 encoding is no longer supported — use raw hex pubkey')
  }
  return input
}

const dev = new Hono<AppEnv>()

/**
 * Secondary gate: if DEV_RESET_SECRET is set, require X-Test-Secret header.
 * Protects against accidental ENVIRONMENT=development in production.
 */
function checkResetSecret(c: { env: { DEV_RESET_SECRET?: string; E2E_TEST_SECRET?: string }; req: { header(name: string): string | undefined } }): boolean {
  const secret = c.env.DEV_RESET_SECRET || c.env.E2E_TEST_SECRET
  if (!secret) return false // No secret configured — deny by default
  // Accept X-Test-Secret header only — Bearer tokens are not sufficient for destructive dev endpoints
  if (c.req.header('X-Test-Secret') === secret) return true
  return false
}

dev.post('/test-reset', async (c) => {
  // Full reset: development only — too destructive for staging
  if (c.env.ENVIRONMENT !== 'development') {
    return c.json({ error: 'Not Found' }, 404)
  }
  if (!checkResetSecret(c)) {
    return c.json({ error: 'Not Found' }, 404)
  }
  const services = c.get('services')
  const env = { DEMO_MODE: c.env.DEMO_MODE, DEMO_MODE_CONFIRM: c.env.DEMO_MODE_CONFIRM, ENVIRONMENT: c.env.ENVIRONMENT }
  const adminPubkey = c.env.ADMIN_PUBKEY
  const demoMode = c.env.DEMO_MODE === 'true'
  await services.audit.reset()
  await services.identity.reset(true, c.env.ENVIRONMENT, c.env.DEMO_MODE_CONFIRM)
  // Reset settings (including roles table and hubs) BEFORE re-seeding admin.
  // The old order was: identity.reset → identity.ensureInit → settings.reset.
  // That created a window where the admin existed but the roles table was empty,
  // causing resolvePermissions('role-super-admin', []) → [] → 403 on hub routes.
  // By resetting settings first, the roles table is re-seeded before the admin
  // user is created and before concurrent requests can authenticate.
  await services.settings.reset(env)
  await services.settings.ensureInit()
  // Re-seed admin immediately — minimizes the window where hasAdmin()=false
  // (concurrent browser requests between reset() and the later ensureInit() would
  // see needsBootstrap=true, causing flaky AdminBootstrap to appear in E2E tests)
  if (adminPubkey) {
    await services.identity.ensureInit(adminPubkey, demoMode)
  }
  await services.records.reset()
  await services.shifts.reset('')
  await services.calls.reset('')
  await services.conversations.reset()
  await services.blasts.reset()
  await services.contacts.reset(env)
  await services.cases.reset(env)
  await services.providerSetup.reset()
  // Final safety net: verify the admin user has role-super-admin after all
  // resets complete. A race condition between reset() and ensureInit() or
  // concurrent requests during the reset window can leave the admin with
  // role-volunteer. This explicit check-and-fix runs last, after all other
  // services are fully reset and re-initialized.
  if (adminPubkey) {
    const adminUser = await services.identity.getUserInternal(adminPubkey)
    if (adminUser && !adminUser.roles.includes('role-super-admin')) {
      await services.identity.updateUser(adminPubkey, { roles: ['role-super-admin'] }, true)
    }
  }
  return c.json({ ok: true })
})

// Reset to a truly fresh state — no admin, no ADMIN_PUBKEY effect
// Used for testing in-browser admin bootstrap
dev.post('/test-reset-no-admin', async (c) => {
  // Full reset without admin: development only
  if (c.env.ENVIRONMENT !== 'development') {
    return c.json({ error: 'Not Found' }, 404)
  }
  if (!checkResetSecret(c)) {
    return c.json({ error: 'Not Found' }, 404)
  }
  const services = c.get('services')
  const env = { DEMO_MODE: c.env.DEMO_MODE, DEMO_MODE_CONFIRM: c.env.DEMO_MODE_CONFIRM, ENVIRONMENT: c.env.ENVIRONMENT }
  // Reset all services
  await services.audit.reset()
  await services.identity.reset(true, c.env.ENVIRONMENT, c.env.DEMO_MODE_CONFIRM)
  await services.settings.reset(env)
  await services.records.reset()
  await services.shifts.reset('')
  await services.calls.reset('')
  await services.conversations.reset()
  await services.blasts.reset()
  await services.contacts.reset(env)
  await services.cases.reset(env)
  // Tell IdentityService to skip admin re-creation from ADMIN_PUBKEY on next ensureInit().
  await services.identity.testSkipAdminSeed()
  // Delete the admin volunteer that the reset's ensureInit() already created
  if (c.env.ADMIN_PUBKEY) {
    await services.identity.deleteUser(c.env.ADMIN_PUBKEY).catch(() => {})
  }
  return c.json({ ok: true })
})

// Light reset: only clears records, calls, conversations, and shifts
// Preserves identity (admin account) and settings (setup state)
// Used by live telephony E2E tests against staging
dev.post('/test-reset-records', async (c) => {
  const isDev = c.env.ENVIRONMENT === 'development'
  const isStaging = c.env.ENVIRONMENT === 'staging'
    && c.env.E2E_TEST_SECRET
    && c.req.header('X-Test-Secret') === c.env.E2E_TEST_SECRET
  if (!isDev && !isStaging) {
    return c.json({ error: 'Not Found' }, 404)
  }
  if (isDev && !checkResetSecret(c)) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const services = c.get('services')
  const env = { DEMO_MODE: c.env.DEMO_MODE, DEMO_MODE_CONFIRM: c.env.DEMO_MODE_CONFIRM, ENVIRONMENT: c.env.ENVIRONMENT }
  await services.records.reset()
  await services.shifts.reset('')
  await services.calls.reset('')
  await services.conversations.reset()
  await services.contacts.reset(env)
  await services.cases.reset(env)
  return c.json({ ok: true })
})

// ─── A2P Brand Approve (BDD test helper) ──────────────────────────────────────
// Directly transitions an A2P brand to "approved" state — no real provider poll.
// Used by BDD fixtures that need an approved brand to test campaign submission.

dev.post('/test-a2p-approve-brand', async (c) => {
  if (c.env.ENVIRONMENT !== 'development') {
    return c.json({ error: 'Not Found' }, 404)
  }
  if (!checkResetSecret(c)) {
    return c.json({ error: 'Not Found' }, 404)
  }
  const body = await c.req.json().catch(() => ({})) as { registrationId?: string }
  if (!body.registrationId) {
    return c.json({ error: 'registrationId is required' }, 400)
  }
  const services = c.get('services')
  await services.a2pRegistration.testApproveBrand(body.registrationId)
  return c.json({ ok: true })
})

// ─── WebAuthn Credential Seeding (BDD test helper, #676) ───────────────────
// Inserts a WebAuthn credential row directly, bypassing the real attestation
// ceremony (which needs a real hardware authenticator/private key). Used by
// BDD scenarios that need an admin WITH a registered passkey — e.g. the
// requireForAdmins=true success branch of PATCH /settings/webauthn — without
// simulating WebAuthn crypto end to end.

dev.post('/test-add-webauthn-credential', async (c) => {
  if (c.env.ENVIRONMENT !== 'development') {
    return c.json({ error: 'Not Found' }, 404)
  }
  if (!checkResetSecret(c)) {
    return c.json({ error: 'Not Found' }, 404)
  }
  const body = await c.req.json().catch(() => ({})) as { pubkey?: string }
  if (!body.pubkey) {
    return c.json({ error: 'pubkey is required' }, 400)
  }
  let pubkey: string
  try {
    pubkey = decodePubkey(body.pubkey)
  } catch (e) {
    return c.json({ error: `Invalid pubkey: ${e instanceof Error ? e.message : String(e)}` }, 400)
  }
  const services = c.get('services')
  const credentialId = crypto.randomUUID()
  await services.identity.addWebAuthnCredential(pubkey, {
    id: credentialId,
    publicKey: 'test-fake-public-key',
    counter: 0,
    transports: ['internal'],
    backedUp: false,
    label: 'Test Passkey (BDD)',
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
  })
  return c.json({ ok: true, credentialId })
})

// ─── Recovery Session Seeding (BDD test helper — EP09) ──────────────────────
// Directly creates a recovery_sessions row in an arbitrary status, bypassing
// the Signal verification ceremony (Phase 1). There is no way to intercept
// the out-of-band verification code from a black-box BDD test, and no
// signal-notifier sidecar runs in the test environment — this lets tests
// start from `verified` and exercise real contribution/completion routes.

dev.post('/test-recovery-seed-session', async (c) => {
  if (c.env.ENVIRONMENT !== 'development') {
    return c.json({ error: 'Not Found' }, 404)
  }
  if (!checkResetSecret(c)) {
    return c.json({ error: 'Not Found' }, 404)
  }
  const body = await c.req.json().catch(() => ({})) as {
    hubId?: string
    userPubkey?: string
    newDevicePubkey?: string
    status?: 'pending' | 'verified' | 'active' | 'completed' | 'expired' | 'cancelled'
    expiresInMs?: number
  }
  if (!body.hubId || !body.userPubkey || !body.newDevicePubkey) {
    return c.json({ error: 'hubId, userPubkey, and newDevicePubkey are required' }, 400)
  }
  const services = c.get('services')
  const result = await services.recoveryGroup.seedSessionForTesting({
    hubId: body.hubId,
    userPubkey: body.userPubkey,
    newDevicePubkey: body.newDevicePubkey,
    status: body.status ?? 'verified',
    // Default: already-elapsed delay, so tests don't need to wait out a real timer.
    expiresInMs: body.expiresInMs ?? -1000,
  })
  return c.json(result)
})

// ─── Rate Limit Reset (BDD test helper) ─────────────────────────────────────
// Clears rate limit counters — prevents cross-scenario bleed in BDD tests.
// Accepts optional ?prefix= query param to clear only matching keys (safer for parallel tests).

dev.delete('/test-rate-limits', async (c) => {
  if (c.env.ENVIRONMENT !== 'development') {
    return c.json({ error: 'Not Found' }, 404)
  }
  if (!checkResetSecret(c)) {
    return c.json({ error: 'Not Found' }, 404)
  }
  const prefix = c.req.query('prefix')
  const services = c.get('services')
  await services.settings.clearRateLimits(prefix || undefined)
  await services.settings.clearApiRateLimits(prefix || undefined)
  return c.json({ ok: true })
})

// ─── Trigger Unhandled Error (BDD test helper — Epic I error disclosure) ─────
// Intentionally throws an unhandled error so tests can verify that the global
// error handler returns a generic 500 without leaking stack traces.

dev.get('/test-trigger-error', async (c) => {
  if (c.env.ENVIRONMENT !== 'development') {
    return c.json({ error: 'Not Found' }, 404)
  }
  if (!checkResetSecret(c)) {
    return c.json({ error: 'Not Found' }, 404)
  }
  // Intentionally throw to exercise the global error handler
  throw new Error('Intentional test error for error disclosure verification')
})

// ─── Identity Promotion (E2E test helpers) ──────────────────────────────────
// Promotes a test identity to admin role so mobile E2E tests can access all features.

dev.post('/test-promote-admin', async (c) => {
  if (c.env.ENVIRONMENT !== 'development') {
    return c.json({ error: 'Not Found' }, 404)
  }
  if (!checkResetSecret(c)) {
    return c.json({ error: 'Not Found' }, 404)
  }
  const body = await c.req.json().catch(() => ({})) as { pubkey?: string }
  if (!body.pubkey) {
    return c.json({ error: 'pubkey is required' }, 400)
  }
  let pubkey: string
  try {
    pubkey = decodePubkey(body.pubkey)
  } catch (e) {
    return c.json({ error: `Invalid pubkey: ${e instanceof Error ? e.message : String(e)}` }, 400)
  }
  const services = c.get('services')
  // Use ensureInit which does INSERT ... ON CONFLICT DO UPDATE SET roles = ['role-super-admin'].
  // This is atomic and race-safe — unlike the old updateUser/createUser pattern which could
  // fail if the user was created by a concurrent request between the two calls.
  await services.identity.ensureInit(pubkey, false)
  return c.json({ ok: true, pubkey })
})

// ─── Hub Membership (E2E test helpers) ─────────────────────────────────────
// Adds a user as a member of a hub with a given role.
// Needed by hub-switch E2E tests so the test user can see specific hubs
// without being promoted to super-admin (which would show ALL hubs).

dev.post('/test-add-hub-member', async (c) => {
  if (c.env.ENVIRONMENT !== 'development') {
    return c.json({ error: 'Not Found' }, 404)
  }
  if (!checkResetSecret(c)) {
    return c.json({ error: 'Not Found' }, 404)
  }
  const body = await c.req.json().catch(() => ({})) as { pubkey?: string; hubId?: string; roleIds?: string[] }
  if (!body.pubkey) {
    return c.json({ error: 'pubkey is required' }, 400)
  }
  if (!body.hubId) {
    return c.json({ error: 'hubId is required' }, 400)
  }
  let pubkey: string
  try {
    pubkey = decodePubkey(body.pubkey)
  } catch (e) {
    return c.json({ error: `Invalid pubkey: ${e instanceof Error ? e.message : String(e)}` }, 400)
  }
  const services = c.get('services')
  const roleIds = body.roleIds ?? ['role-admin']
  // Determine the correct global roles for user creation.
  // If the pubkey matches ADMIN_PUBKEY, the user MUST get role-super-admin
  // to avoid silently downgrading the admin to role-volunteer.
  const isAdminPubkey = pubkey === c.env.ADMIN_PUBKEY
  const globalRoleIds = isAdminPubkey ? ['role-super-admin'] : roleIds
  try {
    await services.identity.setHubRole({ pubkey, hubId: body.hubId, roleIds })
  } catch {
    // User may not exist yet — create with the correct global role
    try {
      await services.identity.createUser({
        pubkey,
        name: isAdminPubkey ? 'Admin' : 'BDD Test User',
        phone: isAdminPubkey ? '' : '+15550000002',
        roleIds: globalRoleIds,
        encryptedSecretKey: '',
      })
      await services.identity.setHubRole({ pubkey, hubId: body.hubId, roleIds })
    } catch (e2) {
      return c.json({ error: `setHubRole failed: ${e2 instanceof Error ? e2.message : String(e2)}` }, 500)
    }
  }
  return c.json({ ok: true, pubkey, hubId: body.hubId })
})

// ─── Shift Creation (E2E test helpers) ──────────────────────────────────────
// Creates a shift covering the current time with a specific volunteer on it.
// Active call simulation requires on-shift volunteers for call routing.

dev.post('/test-create-shift', async (c) => {
  if (c.env.ENVIRONMENT !== 'development') {
    return c.json({ error: 'Not Found' }, 404)
  }
  if (!checkResetSecret(c)) {
    return c.json({ error: 'Not Found' }, 404)
  }
  const body = await c.req.json().catch(() => ({})) as { pubkey?: string; hubId?: string }
  if (!body.pubkey) {
    return c.json({ error: 'pubkey is required' }, 400)
  }
  const services = c.get('services')
  const hubId = body.hubId ?? ''
  try {
    const now = new Date()
    const currentDay = now.getUTCDay()
    const hour = now.getUTCHours()
    const startTime = `${String(Math.max(0, hour - 1)).padStart(2, '0')}:00`
    const endTime = `${String(Math.min(23, hour + 1)).padStart(2, '0')}:59`
    await services.shifts.create(hubId, {
      encryptedName: btoa('BDD Test Shift'),
      startTime,
      endTime,
      days: [currentDay],
      userPubkeys: [body.pubkey],
    })
    return c.json({ ok: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Failed to create shift'
    return c.json({ error: msg }, 400)
  }
})

// ─── Declarative Test Seeding (cross-platform E2E helper) ─────────────────
// Single endpoint that creates all test data from a declarative spec.
// Replaces per-platform reimplementations (TestApiClient.kt, etc.)

const seedEntityTypeSchema = z.object({
  template: z.enum(['arrest_case', 'protest_event']),
  records: z.number().int().min(0).max(50).optional().default(0),
  assignTo: z.array(z.string()).optional().default([]),
})

const seedReportTypeSchema = z.object({
  template: z.enum(['general_report']),
  triageReports: z.number().int().min(0).max(50).optional().default(0),
})

const seedShiftSchema = z.object({
  pubkey: z.string().min(64).max(64),
  allDay: z.boolean().optional().default(true),
})

const seedMemberSchema = z.object({
  pubkey: z.string().min(64).max(64),
  roleIds: z.array(z.string()).optional().default(['role-volunteer']),
})

const seedContactSchema = z.object({
  displayName: z.string().min(1),
  contactType: z.string().optional().default('person'),
})

const seedSpecSchema = z.object({
  hubId: z.string().uuid(),
  adminSeed: z.string().length(64).regex(/^[0-9a-f]+$/),
  permissions: z.object({
    grantVolunteerCms: z.boolean().optional().default(false),
    enableCaseManagement: z.boolean().optional().default(false),
  }).optional().default({ grantVolunteerCms: false, enableCaseManagement: false }),
  entityTypes: z.array(seedEntityTypeSchema).optional().default([]),
  reportTypes: z.array(seedReportTypeSchema).optional().default([]),
  shifts: z.array(seedShiftSchema).optional().default([]),
  members: z.array(seedMemberSchema).optional().default([]),
  contacts: z.array(seedContactSchema).optional().default([]),
})

function entityTypeTemplate(name: 'arrest_case' | 'protest_event') {
  if (name === 'arrest_case') {
    return {
      id: crypto.randomUUID(),
      name: 'arrest_case',
      label: 'Arrest Case',
      labelPlural: 'Arrest Cases',
      description: 'BDD test entity type',
      category: 'case' as const,
      color: '#ef4444',
      statuses: [
        { value: 'reported', label: 'Reported', color: '#f59e0b', order: 1 },
        { value: 'confirmed', label: 'Confirmed', color: '#3b82f6', order: 2 },
        { value: 'in_custody', label: 'In Custody', color: '#ef4444', order: 3 },
        { value: 'released', label: 'Released', color: '#22c55e', order: 4 },
        { value: 'case_closed', label: 'Case Closed', color: '#6b7280', order: 5, isClosed: true },
      ],
      defaultStatus: 'reported',
      closedStatuses: ['case_closed'],
      fields: [
        { id: crypto.randomUUID(), name: 'arrest_datetime', label: 'Arrest Date/Time', type: 'date', required: true, order: 1, accessLevel: 'all', indexable: false, indexType: 'none', visibleToUsers: true, editableByUsers: true, hubEditable: true },
        { id: crypto.randomUUID(), name: 'location', label: 'Location', type: 'text', required: false, order: 2, accessLevel: 'all', indexable: false, indexType: 'none', visibleToUsers: true, editableByUsers: true, hubEditable: true },
        { id: crypto.randomUUID(), name: 'charges', label: 'Charges', type: 'textarea', required: false, order: 3, accessLevel: 'all', indexable: false, indexType: 'none', visibleToUsers: true, editableByUsers: true, hubEditable: true },
      ],
      numberPrefix: 'JS',
      numberingEnabled: true,
    }
  }
  return {
    id: crypto.randomUUID(),
    name: 'protest_event',
    label: 'Protest Event',
    labelPlural: 'Protest Events',
    description: 'BDD test event entity type',
    category: 'event' as const,
    color: '#3b82f6',
    statuses: [
      { value: 'planned', label: 'Planned', color: '#f59e0b', order: 1 },
      { value: 'active', label: 'Active', color: '#22c55e', order: 2 },
      { value: 'completed', label: 'Completed', color: '#6b7280', order: 3, isClosed: true },
    ],
    defaultStatus: 'planned',
    closedStatuses: ['completed'],
    fields: [
      { id: crypto.randomUUID(), name: 'event_date', label: 'Event Date', type: 'date', required: true, order: 1, accessLevel: 'all', indexable: false, indexType: 'none', visibleToUsers: true, editableByUsers: true, hubEditable: true },
      { id: crypto.randomUUID(), name: 'location', label: 'Location', type: 'text', required: false, order: 2, accessLevel: 'all', indexable: false, indexType: 'none', visibleToUsers: true, editableByUsers: true, hubEditable: true },
    ],
    numberPrefix: 'EVT',
    numberingEnabled: true,
  }
}

dev.post('/test-seed', async (c) => {
  if (c.env.ENVIRONMENT !== 'development') {
    return c.json({ error: 'Not Found' }, 404)
  }
  if (!checkResetSecret(c)) {
    return c.json({ error: 'Not Found' }, 404)
  }

  const rawBody = await c.req.json().catch(() => ({}))
  const parsed = seedSpecSchema.safeParse(rawBody)
  if (!parsed.success) {
    return c.json({ error: 'Invalid seed spec', details: parsed.error.issues }, 400)
  }
  const spec = parsed.data
  const { hubId, adminSeed } = spec
  const services = c.get('services')
  const warnings: string[] = []

  // Ensure default roles/settings exist (CI fresh database)
  await services.settings.ensureInit({ ENVIRONMENT: c.env.ENVIRONMENT })

  // ── Permissions ──────────────────────────────────────────────────────────
  if (spec.permissions.enableCaseManagement) {
    try {
      await services.settings.setCaseManagementEnabled({ enabled: true }, hubId)
    } catch (e) {
      warnings.push(`setCaseManagementEnabled: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (spec.permissions.grantVolunteerCms) {
    try {
      await services.settings.updateRole('role-volunteer', {
        permissions: [
          'calls:answer', 'calls:read-active',
          'notes:create', 'notes:read-own', 'notes:update-own', 'notes:reply',
          'conversations:claim', 'conversations:send', 'conversations:read-assigned',
          'conversations:claim-sms', 'conversations:claim-whatsapp',
          'conversations:claim-signal', 'conversations:claim-rcs', 'conversations:claim-web',
          'shifts:read-own', 'bans:report',
          'reports:read-assigned', 'reports:send-message',
          'files:upload', 'files:download-own',
          'cases:create', 'cases:read-all', 'cases:update', 'cases:assign',
          'events:read', 'events:create', 'evidence:upload', 'evidence:download',
          'settings:read', 'hubs:read',
        ],
      })
    } catch (e) {
      warnings.push(`grantVolunteerCms: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ── Members ──────────────────────────────────────────────────────────────
  const memberIds: Array<{ pubkey: string }> = []
  for (const m of spec.members) {
    try {
      await services.identity.setHubRole({
        pubkey: m.pubkey,
        hubId,
        roleIds: m.roleIds,
      })
      memberIds.push({ pubkey: m.pubkey })
    } catch (e) {
      warnings.push(`member ${m.pubkey.slice(0, 8)}...: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ── Entity Types + Records ───────────────────────────────────────────────
  const entityTypeIds: Array<{ id: string; name: string; category: string }> = []
  const recordIds: Array<{ id: string; entityTypeId: string; caseNumber?: string }> = []

  for (const etSpec of spec.entityTypes) {
    const tmpl = entityTypeTemplate(etSpec.template)
    let entityTypeId: string

    try {
      const created = await services.settings.createEntityType({ ...tmpl, hubId })
      entityTypeId = created.id
    } catch (e) {
      // If already exists (409), look it up
      if (e instanceof Error && e.message.includes('already exists')) {
        const { entityTypes } = await services.settings.getEntityTypes(hubId)
        const existing = entityTypes.find(et => et.name === tmpl.name)
        if (existing) {
          entityTypeId = existing.id
        } else {
          warnings.push(`entityType ${tmpl.name}: already exists but not found on lookup`)
          continue
        }
      } else {
        warnings.push(`entityType ${tmpl.name}: ${e instanceof Error ? e.message : String(e)}`)
        continue
      }
    }

    entityTypeIds.push({ id: entityTypeId, name: tmpl.name, category: tmpl.category })

    // Create records for this entity type
    // Use a dummy HPKE envelope so the app can find a readable envelope.
    // Without this, records exist in DB but the app filters them out
    // (no envelope matching the user's pubkey).
    const dummyEnvelope = { pubkey: adminSeed, ct: 'a'.repeat(64), enc: adminSeed }
    for (let i = 0; i < etSpec.records; i++) {
      try {
        const isEvent = tmpl.category === 'event'
        const record = await services.cases.create({
          entityTypeId,
          statusHash: tmpl.defaultStatus,
          assignedTo: etSpec.assignTo,
          blindIndexes: {},
          encryptedSummary: btoa(isEvent
            ? `{"title":"Test Event ${i + 1}","summary":"Seeded event"}`
            : `{"title":"Test Case ${i + 1}","summary":"Seeded case"}`),
          summaryEnvelopes: [dummyEnvelope],
          createdBy: adminSeed,
          hubId,
        })
        recordIds.push({ id: record.id, entityTypeId, caseNumber: record.caseNumber ?? undefined })
      } catch (e) {
        warnings.push(`record ${tmpl.name}[${i}]: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  // ── Report Types + Triage Reports ────────────────────────────────────────
  const reportTypeIds: Array<{ id: string; name: string }> = []
  const triageReportIds: Array<{ id: string }> = []

  for (const rtSpec of spec.reportTypes) {
    try {
      const reportTypeName = rtSpec.template === 'general_report' ? 'General Report' : rtSpec.template
      const reportType = await services.settings.createCmsReportType({
        hubId,
        name: reportTypeName,
        label: reportTypeName,
        description: 'BDD test report type',
        allowCaseConversion: true,
        fields: [],
        statuses: [],
        defaultStatus: '',
        closedStatuses: [],
      })
      reportTypeIds.push({ id: reportType.id, name: reportType.name })

      // Create triage reports as conversations with report metadata
      for (let i = 0; i < rtSpec.triageReports; i++) {
        try {
          const report = await services.conversations.create({
            hubId,
            channelType: 'web',
            status: 'waiting',
            metadata: {
              type: 'report',
              reportTitle: `Test Triage Report ${i + 1}`,
              reportCategory: 'general',
              reportTypeId: reportType.id,
              conversionStatus: 'pending',
            },
          })
          triageReportIds.push({ id: report.id })
        } catch (e) {
          warnings.push(`triageReport[${i}]: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    } catch (e) {
      warnings.push(`reportType ${rtSpec.template}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ── Shifts ───────────────────────────────────────────────────────────────
  const shiftIds: Array<{ id: string }> = []

  for (const shiftSpec of spec.shifts) {
    try {
      const now = new Date()
      const currentDay = now.getUTCDay()
      let startTime: string
      let endTime: string

      if (shiftSpec.allDay) {
        startTime = '00:00'
        endTime = '23:59'
      } else {
        const hour = now.getUTCHours()
        startTime = `${String(Math.max(0, hour - 1)).padStart(2, '0')}:00`
        endTime = `${String(Math.min(23, hour + 1)).padStart(2, '0')}:59`
      }

      const shift = await services.shifts.create(hubId, {
        encryptedName: btoa('Seeded Shift'),
        startTime,
        endTime,
        days: [currentDay],
        userPubkeys: [shiftSpec.pubkey],
      })
      shiftIds.push({ id: shift.id })
    } catch (e) {
      warnings.push(`shift ${shiftSpec.pubkey.slice(0, 8)}...: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ── Contacts ─────────────────────────────────────────────────────────────
  const contactIds: Array<{ id: string }> = []
  const dummyEnvelope = { pubkey: adminSeed, ct: 'a'.repeat(64), enc: adminSeed }

  for (const contactSpec of spec.contacts) {
    try {
      const contact = await services.contacts.create({
        hubId,
        identifierHashes: [contactSpec.displayName.toLowerCase().replace(/\s+/g, '-')],
        encryptedSummary: btoa(JSON.stringify({ displayName: contactSpec.displayName })),
        summaryEnvelopes: [dummyEnvelope],
        contactTypeHash: contactSpec.contactType,
      })
      contactIds.push({ id: contact.id })
    } catch (e) {
      warnings.push(`contact ${contactSpec.displayName}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return c.json({
    ok: true,
    hubId,
    entityTypes: entityTypeIds,
    records: recordIds,
    reportTypes: reportTypeIds,
    triageReports: triageReportIds,
    shifts: shiftIds,
    members: memberIds,
    contacts: contactIds,
    warnings: warnings.length > 0 ? warnings : undefined,
  })
})


// ─── Demo dataset (BDD helper) ─────────────────────────────────────────────────
// Runs the same seeder the demo reset uses, without the destructive global wipe,
// so BDD can exercise it against the shared dev server. Creates the demo accounts
// if they are missing; DELETE removes the demo hub and accounts again.

dev.post('/test-seed-demo', async (c) => {
  if (c.env.ENVIRONMENT !== 'development' || !checkResetSecret(c)) {
    return c.json({ error: 'Not Found' }, 404)
  }
  const services = c.get('services')
  await services.identity.ensureInit(undefined, true)
  const summary = await seedDemoDataset(services, c.env)
  return c.json({ ok: true, summary })
})

dev.delete('/test-seed-demo', async (c) => {
  if (c.env.ENVIRONMENT !== 'development' || !checkResetSecret(c)) {
    return c.json({ error: 'Not Found' }, 404)
  }
  const services = c.get('services')
  await services.settings.purgeHub(DEMO_HUB.id)
  for (const account of demoIdentities()) {
    await services.identity.deleteUser(account.pubkey).catch(() => {})
  }
  return c.json({ ok: true })
})

// ─── Simulation Endpoints (E2E test helpers) ───────────────────────────────
// These bypass TelephonyAdapter entirely — they proxy directly to service calls.
// Gated by ENVIRONMENT=development + DEV_RESET_SECRET / E2E_TEST_SECRET.

/** Request/response types for simulation endpoints */
interface SimulateIncomingCallBody {
  callerNumber: string
  language?: string
  hubId?: string
  /** When true, returns 422 if no volunteers are on shift (mirrors real telephony routing) */
  checkVolunteers?: boolean
}

interface SimulateAnswerCallBody {
  callId: string
  pubkey: string
}

interface SimulateEndCallBody {
  callId: string
}

interface SimulateVoicemailBody {
  callId: string
}

interface SimulateIncomingMessageBody {
  senderNumber: string
  body: string
  channel?: MessagingChannelType
  hubId?: string
}

interface SimulateDeliveryStatusBody {
  conversationId: string
  messageId: string
  status: 'delivered' | 'read' | 'failed'
}

/**
 * Guard: require ENVIRONMENT=development + valid test secret.
 * Returns an error Response if denied, or null if allowed.
 */
function simulationGuard(c: {
  env: { ENVIRONMENT: string; DEV_RESET_SECRET?: string; E2E_TEST_SECRET?: string }
  req: { header(name: string): string | undefined }
}): Response | null {
  if (c.env.ENVIRONMENT !== 'development') {
    return Response.json({ error: 'Not Found' }, { status: 404 })
  }
  if (!checkResetSecret(c)) {
    return Response.json({ error: 'Not Found' }, { status: 404 })
  }
  return null
}

// 1. Simulate incoming call
dev.post('/test-simulate/incoming-call', async (c) => {
  const denied = simulationGuard(c)
  if (denied) return denied

  const body = await c.req.json() as SimulateIncomingCallBody
  if (!body.callerNumber) {
    return c.json({ error: 'callerNumber is required' }, 400)
  }

  const callId = crypto.randomUUID()
  const services = c.get('services')
  const hubId = body.hubId ?? ''

  // Check if the caller is banned (hash before lookup — mirrors real telephony flow)
  const callerNumberHash = hashPhone(body.callerNumber, c.env.HMAC_SECRET)
  const banned = await services.records.checkBan(callerNumberHash, hubId || undefined)
  if (banned) {
    return c.json({ error: 'Caller is banned', banned: true }, 403)
  }

  // Optionally check for on-shift volunteers (mirrors real telephony routing)
  if (body.checkVolunteers) {
    let volunteerPubkeys: string[] = []
    try {
      volunteerPubkeys = await services.shifts.getCurrentVolunteers(hubId)
    } catch {
      // Shifts not configured — proceed with empty list
    }
    if (volunteerPubkeys.length === 0) {
      return c.json({ error: 'No volunteers available', status: 'no-volunteers' }, 422)
    }
  }

  await services.calls.addCall(hubId, {
    callId,
    callerNumber: callerNumberHash,
    callerLast4: body.callerNumber?.slice(-4),
  })

  // Publish call ring event (mirrors real telephony flow)
  // Await to ensure event is in relay before returning — prevents race conditions in E2E tests
  publishEvent(c.env, KIND_CALL_RING, {
    type: 'call:ring',
    callId,
  }, hubId)

  return c.json({ ok: true, callId, status: 'ringing' })
})

// 2. Simulate answering a call
dev.post('/test-simulate/answer-call', async (c) => {
  const denied = simulationGuard(c)
  if (denied) return denied

  const body = await c.req.json() as SimulateAnswerCallBody
  if (!body.callId || !body.pubkey) {
    return c.json({ error: 'callId and pubkey are required' }, 400)
  }

  const services = c.get('services')
  const call = await services.calls.getActiveCallByCallId(body.callId)
  if (!call) return c.json({ error: 'Call not found' }, 404)
  await services.calls.answerCall(call.hubId ?? '', body.callId, body.pubkey)

  // Publish call update event (mirrors real telephony flow)
  // Await to ensure event is in relay before returning — prevents race conditions in E2E tests
  publishEvent(c.env, KIND_CALL_UPDATE, {
    type: 'call:update',
    callId: body.callId,
    status: 'in-progress',
  }, call.hubId ?? '')

  // Publish presence update (mirrors real telephony flow)
  publishEvent(c.env, KIND_PRESENCE_UPDATE, {
    type: 'presence:summary',
    callId: body.callId,
  }, call.hubId ?? '')

  return c.json({ ok: true, callId: body.callId, status: 'in-progress' })
})

// 3. Simulate ending a call
dev.post('/test-simulate/end-call', async (c) => {
  const denied = simulationGuard(c)
  if (denied) return denied

  const body = await c.req.json() as SimulateEndCallBody
  if (!body.callId) {
    return c.json({ error: 'callId is required' }, 400)
  }

  const services = c.get('services')
  const call = await services.calls.getActiveCallByCallId(body.callId)
  if (!call) return c.json({ error: 'Call not found' }, 404)
  await services.calls.endCall(call.hubId ?? '', body.callId)

  // Publish call update event (mirrors real telephony flow)
  publishEvent(c.env, KIND_CALL_UPDATE, {
    type: 'call:update',
    callId: body.callId,
    status: 'completed',
  }, call.hubId ?? '')

  return c.json({ ok: true, callId: body.callId, status: 'completed' })
})

// 4. Simulate voicemail
dev.post('/test-simulate/voicemail', async (c) => {
  const denied = simulationGuard(c)
  if (denied) return denied

  const body = await c.req.json() as SimulateVoicemailBody
  if (!body.callId) {
    return c.json({ error: 'callId is required' }, 400)
  }

  const services = c.get('services')
  const call = await services.calls.getActiveCallByCallId(body.callId)
  if (!call) return c.json({ error: 'Call not found' }, 404)
  // Voicemail = call ends without being answered → status becomes 'unanswered'
  await services.calls.endCall(call.hubId ?? '', body.callId)

  // Publish voicemail event (mirrors real telephony flow)
  publishEvent(c.env, KIND_CALL_VOICEMAIL, {
    type: 'voicemail:new',
    callId: body.callId,
  }, call.hubId ?? '')

  return c.json({ ok: true, callId: body.callId, status: 'unanswered' })
})

// 5. Simulate incoming message
dev.post('/test-simulate/incoming-message', async (c) => {
  const denied = simulationGuard(c)
  if (denied) return denied

  const body = await c.req.json() as SimulateIncomingMessageBody
  if (!body.senderNumber || !body.body) {
    return c.json({ error: 'senderNumber and body are required' }, 400)
  }

  const channel: MessagingChannelType = body.channel || 'sms'
  const senderHash = hashPhone(body.senderNumber, c.env.HMAC_SECRET)

  const services = c.get('services')
  const adminDecryptionPubkey = c.env.ADMIN_DECRYPTION_PUBKEY || c.env.ADMIN_PUBKEY
  const result = await services.conversations.handleIncoming({
    channelType: channel,
    externalId: crypto.randomUUID(),
    senderIdentifier: body.senderNumber,
    senderIdentifierHash: senderHash,
    body: body.body,
    timestamp: new Date().toISOString(),
  }, adminDecryptionPubkey, body.hubId)

  // Publish to the conversation's hub (mirrors real messaging webhook flow)
  publishEvent(c.env, KIND_MESSAGE_NEW, {
    type: 'message:new',
    conversationId: result.conversationId,
    messageId: result.messageId,
    channelType: channel,
  }, body.hubId ?? '')

  return c.json({ ok: true, conversationId: result.conversationId, messageId: result.messageId })
})

// 6. Simulate delivery status update
dev.post('/test-simulate/delivery-status', async (c) => {
  const denied = simulationGuard(c)
  if (denied) return denied

  const body = await c.req.json() as SimulateDeliveryStatusBody
  if (!body.conversationId || !body.messageId || !body.status) {
    return c.json({ error: 'conversationId, messageId, and status are required' }, 400)
  }

  const services = c.get('services')

  // Delivery status updates use the external ID mapping in ConversationsService.
  // For simulation, we fetch the message to find its externalId, then call the status endpoint.
  const { messages } = await services.conversations.listMessages(body.conversationId, { limit: 200 })

  const message = messages.find(m => m.id === body.messageId)
  if (!message) {
    return c.json({ error: 'Message not found in conversation' }, 404)
  }

  if (!message.externalId) {
    return c.json({ error: 'Message has no externalId — only outbound messages with provider IDs support delivery status' }, 400)
  }

  await services.conversations.updateMessageStatus({
    externalId: message.externalId,
    status: body.status,
    timestamp: new Date().toISOString(),
    failureReason: body.status === 'failed' ? 'Simulated failure' : undefined,
  })

  return c.json({ ok: true })
})

// 7a. Simulate Signal delivery receipt
// Accepts { conversationId, timestamp, receiptType } and updates the outbound
// message whose externalId matches the timestamp to "delivered" / "read".
dev.post('/test-simulate/signal-receipt', async (c) => {
  const denied = simulationGuard(c)
  if (denied) return denied

  const body = await c.req.json().catch(() => ({})) as {
    conversationId?: string
    timestamp?: string
    receiptType?: string
  }
  if (!body.conversationId || !body.timestamp) {
    return c.json({ error: 'conversationId and timestamp are required' }, 400)
  }

  const services = c.get('services')
  const { messages } = await services.conversations.listMessages(body.conversationId, { limit: 200 })
  const message = messages.find(m => m.externalId === body.timestamp)
  if (!message) {
    return c.json({ error: 'No outbound message found with that externalId/timestamp' }, 404)
  }

  const newStatus = body.receiptType === 'read' ? 'read' : 'delivered'
  await services.conversations.updateMessageStatus({
    externalId: message.externalId!,
    status: newStatus,
    timestamp: new Date().toISOString(),
  })

  return c.json({ ok: true, messageId: message.id, status: newStatus })
})

// 7b. Simulate Signal reaction webhook
// Returns the eventType/payload that the backend would publish over Nostr
// so BDD tests can assert MESSAGE_REACTION events are dispatched.
dev.post('/test-simulate/signal-reaction', async (c) => {
  const denied = simulationGuard(c)
  if (denied) return denied

  const body = await c.req.json().catch(() => ({})) as {
    conversationId?: string
    emoji?: string
    targetTimestamp?: string
  }
  if (!body.conversationId || !body.emoji) {
    return c.json({ error: 'conversationId and emoji are required' }, 400)
  }

  // Signal reactions are published as Nostr MESSAGE_REACTION events.
  // In simulation we record the intent and return the expected event shape.
  const payload = {
    conversationId: body.conversationId,
    emoji: body.emoji,
    targetTimestamp: body.targetTimestamp,
    simulatedAt: new Date().toISOString(),
  }

  return c.json({ ok: true, eventType: 'MESSAGE_REACTION', payload })
})

// 7c. Simulate Signal typing indicator webhook
// Returns the eventType/payload that the backend would publish over Nostr
// so BDD tests can assert TYPING_INDICATOR events are dispatched.
dev.post('/test-simulate/signal-typing', async (c) => {
  const denied = simulationGuard(c)
  if (denied) return denied

  const body = await c.req.json().catch(() => ({})) as {
    conversationId?: string
    action?: string
  }
  if (!body.conversationId) {
    return c.json({ error: 'conversationId is required' }, 400)
  }

  const payload = {
    conversationId: body.conversationId,
    action: body.action ?? 'STARTED',
    simulatedAt: new Date().toISOString(),
  }

  return c.json({ ok: true, eventType: 'TYPING_INDICATOR', payload })
})

// ─── Test Push Log (dev/test BDD helper) ──────────────────────────────────
// Returns or clears the in-memory push payload log recorded by push-dispatch.ts.
// Used by backend BDD tests to verify that push payloads carry hubId without
// real APNs/FCM credentials being configured.

dev.get('/test-push-log', (c) => {
  const denied = simulationGuard(c)
  if (denied) return denied

  return c.json({ entries: getTestPushLog() })
})

dev.delete('/test-push-log', (c) => {
  const denied = simulationGuard(c)
  if (denied) return denied

  clearTestPushLog()
  return c.json({ ok: true })
})

// Returns the APNs topic (bundle id) and VoIP topic that a real push dispatch
// would set as the outgoing `apns-topic` header, derived the same way
// push-dispatch.ts and voip-push.ts derive it (see lib/apns-topic.ts).
// Lets BDD tests assert the header value without real APNs credentials
// configured in the test environment (Issue #724).
dev.get('/test-apns-topic', (c) => {
  const denied = simulationGuard(c)
  if (denied) return denied

  return c.json({
    topic: getApnsBundleId(c.env),
    voipTopic: getApnsVoipTopic(c.env),
  })
})

// 7. Simulate push dispatch — directly invokes createPushDispatcherFromService with
//    a synthetic WakePayload to verify that hubId is present in the dispatched payload.
//    Useful for BDD scenarios that need to assert push payload structure without
//    requiring a full telephony or messaging flow.

interface SimulatePushDispatchBody {
  hubId: string
  type: 'message' | 'voicemail' | 'shift_reminder' | 'assignment'
  recipientPubkey: string
  conversationId?: string
  channelType?: string
  callId?: string
}

dev.post('/test-simulate/push-dispatch', async (c) => {
  const denied = simulationGuard(c)
  if (denied) return denied

  const body = await c.req.json().catch(() => ({})) as SimulatePushDispatchBody
  if (!body.hubId || !body.type || !body.recipientPubkey) {
    return c.json({ error: 'hubId, type, and recipientPubkey are required' }, 400)
  }

  const services = c.get('services')
  const { createPushDispatcherFromService } = await import('../lib/push-dispatch')

  const wake = {
    hubId: body.hubId,
    type: body.type,
    conversationId: body.conversationId,
    channelType: body.channelType,
    callId: body.callId,
  }

  const dispatcher = createPushDispatcherFromService(c.env, services.identity, services.shifts)
  await dispatcher.sendToVolunteer(body.recipientPubkey, wake, { ...wake })

  return c.json({ ok: true, wake })
})

// ─── Test Hub Creation (dev/test isolation helper) ──────────────────────────
// Creates an isolated hub for a single test run.
// Gated by ENVIRONMENT=development + DEV_RESET_SECRET / E2E_TEST_SECRET.

dev.post('/test-create-hub', async (c) => {
  const denied = simulationGuard(c)
  if (denied) return denied

  // Seed default roles/settings if this is the first request to a fresh database.
  const services = c.get('services')
  await services.settings.ensureInit({ ENVIRONMENT: c.env.ENVIRONMENT })

  const rawBody = await c.req.json().catch(() => ({}))
  const hubName = typeof rawBody === 'object' && rawBody !== null && 'name' in rawBody && typeof rawBody.name === 'string'
    ? rawBody.name
    : `test-hub-${Date.now()}`
  const name = hubName.trim()
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

  const hub: Hub = {
    id: crypto.randomUUID(),
    name,
    slug,
    status: 'active',
    createdBy: 'test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  try {
    await services.settings.createHub(hub)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create hub'
    return c.json({ error: message }, 500)
  }

  // Add admin as a member of the new hub so WS relay subscribe works in tests.
  // This is CRITICAL for E2E — without hub membership, all hub-scoped API calls
  // return 403 and the frontend fails to render hub pages.
  // Accept adminPubkey from request body as fallback — local dev may not have
  // ADMIN_PUBKEY set in env, but the test helper knows the admin pubkey.
  const bodyAdminPubkey = typeof rawBody === 'object' && rawBody !== null && 'adminPubkey' in rawBody && typeof rawBody.adminPubkey === 'string'
    ? rawBody.adminPubkey : undefined
  const adminPubkey = (c.env?.ADMIN_PUBKEY as string | undefined) || bodyAdminPubkey
  if (adminPubkey) {
    // Ensure the admin user exists before attempting setHubRole. During parallel
    // test startup, test-create-hub can race with test-reset/ensureInit — the
    // admin row may not exist yet. ensureInit uses onConflictDoUpdate so it's
    // safe to call concurrently (idempotent, always sets role-super-admin).
    await services.identity.ensureInit(adminPubkey, false)

    // Retry up to 3 times — even after ensureInit, a concurrent reset could
    // briefly delete the user row between our ensureInit and setHubRole.
    let hubRoleSet = false
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await services.identity.setHubRole({
          pubkey: adminPubkey,
          hubId: hub.id,
          roleIds: ['role-super-admin'],
        })
        hubRoleSet = true
        break
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[test-create-hub] setHubRole attempt ${attempt + 1}/3 failed: ${msg}`)
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 500))
          // Re-ensure admin exists before retrying
          await services.identity.ensureInit(adminPubkey, false).catch(() => {})
        }
      }
    }
    if (!hubRoleSet) {
      console.error(`[test-create-hub] FAILED to set admin hub role for hub ${hub.id} — hub-scoped tests will 403`)
    }
  }

  return c.json({ id: hub.id, name: hub.name })
})

export default dev
