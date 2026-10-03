/**
 * OpenAPI Response Conformance Tests
 *
 * For each route that declares a response schema via describeRoute({ responses: { 200: { schema: resolver(...) } } }),
 * these tests:
 *   1. Call the route via app.request() with mocked services
 *   2. Validate the response body against the declared Zod schema
 *   3. Assert the parse succeeds — a failure means the route returns data clients cannot decode
 *
 * When a test fails it means the route sends a response the mobile/desktop clients will
 * reject, because the same schemas are the source of truth for Swift Codable and Kotlin
 * @Serializable generated types.
 */

// Module-level mocks must be at top level (Vitest hoists vi.mock)
vi.mock('../../db', () => ({
  getDb: () => ({
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
  }),
}))

// Mock auth lib: importOriginal to keep all exports, override auth-critical functions
vi.mock('../../lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/auth')>()
  const FIXED_PUBKEY = 'a'.repeat(64)
  return {
    ...actual,
    verifyAuthToken: vi.fn().mockResolvedValue(true),
    authenticateRequest: vi.fn().mockResolvedValue({
      pubkey: FIXED_PUBKEY,
      user: {
        pubkey: FIXED_PUBKEY,
        name: 'Test User',
        phone: '+15551234567',
        roles: ['role-super-admin'],
        hubRoles: [],
        active: true,
        createdAt: new Date().toISOString(),
        encryptedSecretKey: '',
        transcriptionEnabled: false,
        spokenLanguages: ['en'],
        uiLanguage: 'en',
        profileCompleted: true,
        onBreak: false,
        callPreference: 'phone',
        specializations: [],
      },
    }),
  }
})

import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '../../types'
import { assertConformsToSchema } from '../helpers/response-conformance'

// ---- Route imports ----
import healthRoutes from '../../routes/health'
import authRoutes from '../../routes/auth'
import configRoutes from '../../routes/config'
import callsRoutes from '../../routes/calls'
import hubRoutes from '../../routes/hubs'
import notesRoutes from '../../routes/notes'
import bansRoutes from '../../routes/bans'
import invitesRoutes from '../../routes/invites'
import usersRoutes from '../../routes/users'
import shiftsRoutes from '../../routes/shifts'

// ---- Schema imports ----
import { healthResponseSchema, livenessResponseSchema, readinessResponseSchema } from '@protocol/schemas/health'
import { loginResponseSchema, meResponseSchema } from '@protocol/schemas/auth'
import { configResponseSchema } from '@protocol/schemas/config'
import { activeCallsResponseSchema, todayCountResponseSchema, callPresenceResponseSchema } from '@protocol/schemas/calls'
import { hubListResponseSchema, hubDetailResponseSchema } from '@protocol/schemas/hubs'
import { noteListResponseSchema, noteResponseSchema } from '@protocol/schemas/notes'
import { banListResponseSchema } from '@protocol/schemas/bans'
import { inviteValidationResponseSchema, inviteListResponseSchema } from '@protocol/schemas/invites'
import { userListResponseSchema, userResponseSchema } from '@protocol/schemas/users'
import { myStatusResponseSchema } from '@protocol/schemas/shifts'

// ---------------------------------------------------------------------------
// Default env bindings — passed to app.request() as the 3rd argument.
// Hono stores these in c.env, so routes can access c.env.HOTLINE_NAME etc.
// ---------------------------------------------------------------------------

const MOCK_PUBKEY = 'a'.repeat(64)
// Must be valid hex for hashIP (uses hexToBytes internally)
const MOCK_HMAC_SECRET = 'a'.repeat(64)

const DEFAULT_ENV: Record<string, string> = {
  ENVIRONMENT: 'development',
  HOTLINE_NAME: 'Test Hotline',
  TWILIO_PHONE_NUMBER: '+15550000000',
  HMAC_SECRET: MOCK_HMAC_SECRET,
  ADMIN_PUBKEY: MOCK_PUBKEY,
}

// ---------------------------------------------------------------------------
// Test app factory — injects mock services + auth context via middleware.
// Env bindings are passed via app.request(path, init, env) as 3rd argument.
// ---------------------------------------------------------------------------

function buildApp(
  mountPath: string,
  routes: Hono<AppEnv>,
  opts: {
    permissions?: string[]
    hubId?: string
    services?: Record<string, unknown>
    extraEnv?: Record<string, string>
  } = {},
): { app: Hono<AppEnv>; env: Record<string, string> } {
  const {
    permissions = ['*'],
    hubId = 'hub-test-1',
    services = {},
    extraEnv = {},
  } = opts

  const mockAudit = { log: vi.fn().mockResolvedValue(undefined) }
  // Auth middleware calls services.settings.getRoles() to resolve permissions.
  // Return a super-admin role with wildcard permission so all routes pass permission checks.
  const mockSettingsBase = {
    getRoles: vi.fn().mockResolvedValue({
      roles: [{ id: 'role-super-admin', name: 'Super Admin', slug: 'super-admin', permissions: ['*'], hubPermissions: [] }],
    }),
  }

  const app = new Hono<AppEnv>()

  // Inject context variables normally set by auth + hub middleware.
  // This runs BEFORE the route handlers so auth-gated routes work without
  // a real authentication round-trip.
  app.use('*', async (c, next) => {
    c.set('pubkey', MOCK_PUBKEY)
    c.set('permissions', permissions)
    c.set('allRoles', [])
    c.set('requestId', 'test-req-id')
    c.set('hubId', hubId)
    c.set('user', {
      pubkey: MOCK_PUBKEY,
      name: 'Test User',
      phone: '+15551234567',
      roles: ['role-super-admin'],
      hubRoles: [],
      active: true,
      createdAt: new Date().toISOString(),
      encryptedSecretKey: '',
      transcriptionEnabled: false,
      spokenLanguages: ['en'],
      uiLanguage: 'en',
      profileCompleted: true,
      onBreak: false,
      callPreference: 'phone' as const,
      specializations: [],
    })
    c.set('services', {
      audit: mockAudit,
      settings: mockSettingsBase,
      ...services,
    } as unknown as AppEnv['Variables']['services'])

    await next()
  })

  app.route(mountPath, routes)
  return { app, env: { ...DEFAULT_ENV, ...extraEnv } }
}

// ---------------------------------------------------------------------------
// Health Routes
// ---------------------------------------------------------------------------

describe('Health Routes — response conformance', () => {
  it('GET /live — conforms to livenessResponseSchema', async () => {
    const { app, env } = buildApp('/', healthRoutes)
    const result = await assertConformsToSchema(app, 'GET', '/live', livenessResponseSchema, { env })
    expect(result.parsed.status).toBe('ok')
  })

  it('GET /health — response body conforms to healthResponseSchema (may return 503 when deps unavailable)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }))
    const { app, env } = buildApp('/', healthRoutes, {
      extraEnv: {
        STORAGE_ENDPOINT: 'http://fake-storage:9000',
      },
    })

    // When all deps are reachable (fetch mocked to ok), returns 200
    const result = await assertConformsToSchema(app, 'GET', '/', healthResponseSchema, {
      expectedStatus: 200,
      env,
    })
    expect(result.parsed.status).toBe('ok')
    // checks values must be objects with status field (not raw strings)
    const firstCheck = Object.values(result.parsed.checks)[0]
    expect(firstCheck).toHaveProperty('status')
    vi.unstubAllGlobals()
  })

  it('GET /ready — response body conforms to readinessResponseSchema (may return 503 when deps unavailable)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }))
    const { app, env } = buildApp('/', healthRoutes, {
      extraEnv: {
        STORAGE_ENDPOINT: 'http://fake-storage:9000',
      },
    })

    const result = await assertConformsToSchema(app, 'GET', '/ready', readinessResponseSchema, {
      expectedStatus: 200,
      env,
    })
    expect(result.parsed.status).toBe('ok')
    vi.unstubAllGlobals()
  })
})

// ---------------------------------------------------------------------------
// Auth Routes
// ---------------------------------------------------------------------------

describe('Auth Routes — response conformance', () => {
  it('POST /login — conforms to loginResponseSchema', async () => {
    const mockIdentity = {
      getUser: vi.fn().mockResolvedValue({
        pubkey: MOCK_PUBKEY,
        roles: ['role-super-admin'],
      }),
    }

    const { app, env } = buildApp('/auth', authRoutes, {
      services: { identity: mockIdentity },
    })

    const result = await assertConformsToSchema(app, 'POST', '/auth/login', loginResponseSchema, {
      body: { pubkey: MOCK_PUBKEY, timestamp: Date.now(), token: 'test-token' },
      env,
    })
    expect(result.parsed.ok).toBe(true)
    expect(Array.isArray(result.parsed.roles)).toBe(true)
  })

  it('GET /me — conforms to meResponseSchema', async () => {
    const mockIdentity = {
      getWebAuthnCredentials: vi.fn().mockResolvedValue({ credentials: [] }),
      getWebAuthnSettings: vi.fn().mockResolvedValue({ requireForAdmins: false, requireForUsers: false }),
    }

    const { app, env } = buildApp('/auth', authRoutes, {
      services: { identity: mockIdentity },
    })

    const result = await assertConformsToSchema(app, 'GET', '/auth/me', meResponseSchema, { env })
    expect(result.parsed.pubkey).toBe(MOCK_PUBKEY)
    expect(Array.isArray(result.parsed.roles)).toBe(true)
    expect(Array.isArray(result.parsed.permissions)).toBe(true)
    expect(typeof result.parsed.webauthnRequired).toBe('boolean')
    expect(typeof result.parsed.webauthnRegistered).toBe('boolean')
  })
})

// ---------------------------------------------------------------------------
// Config Routes
// ---------------------------------------------------------------------------

describe('Config Routes — response conformance', () => {
  it('GET /config — conforms to configResponseSchema', async () => {
    const mockSettings = {
      getEnabledChannels: vi.fn().mockResolvedValue({ voice: true, sms: false, whatsapp: false, signal: false, rcs: false, telegram: false, reports: false }),
      getTelephonyProvider: vi.fn().mockResolvedValue(null),
      getSetupState: vi.fn().mockResolvedValue({ setupCompleted: true }),
      getHubs: vi.fn().mockResolvedValue({ hubs: [] }),
    }
    const mockIdentity = {
      hasAdmin: vi.fn().mockResolvedValue({ hasAdmin: true }),
    }

    const { app, env } = buildApp('/config', configRoutes, {
      services: { settings: mockSettings, identity: mockIdentity },
    })

    const result = await assertConformsToSchema(app, 'GET', '/config', configResponseSchema, { env })
    expect(result.parsed.hotlineName).toBe('Test Hotline')
    expect(typeof result.parsed.setupCompleted).toBe('boolean')
    expect(Array.isArray(result.parsed.hubs)).toBe(true)
    expect(typeof result.parsed.apiVersion).toBe('number')
  })
})

// ---------------------------------------------------------------------------
// Calls Routes
// ---------------------------------------------------------------------------

describe('Calls Routes — response conformance', () => {
  const mockActiveCalls = [
    {
      id: 'call-1',
      callerNumber: '+15551234567',
      startedAt: new Date().toISOString(),
      status: 'ringing' as const,
      answeredBy: null,
    },
  ]

  it('GET /calls/active — conforms to activeCallsResponseSchema', async () => {
    const mockCalls = {
      getActiveCalls: vi.fn().mockResolvedValue(mockActiveCalls),
    }

    const { app, env } = buildApp('/calls', callsRoutes, {
      services: { calls: mockCalls },
    })

    const result = await assertConformsToSchema(app, 'GET', '/calls/active', activeCallsResponseSchema, { env })
    expect(Array.isArray(result.parsed.calls)).toBe(true)
  })

  it('GET /calls/today-count — conforms to todayCountResponseSchema', async () => {
    const mockCalls = {
      getTodayCount: vi.fn().mockResolvedValue(7),
    }

    const { app, env } = buildApp('/calls', callsRoutes, {
      services: { calls: mockCalls },
    })

    const result = await assertConformsToSchema(app, 'GET', '/calls/today-count', todayCountResponseSchema, { env })
    expect(typeof result.parsed.count).toBe('number')
    expect(result.parsed.count).toBe(7)
  })

  it('GET /calls/presence — conforms to callPresenceResponseSchema', async () => {
    // Presence is composed in services/presence.ts from the ringing resolver,
    // not read off CallsService, so the route needs the services that resolver
    // reads. Mocking `calls.getPresence` here would have conformed to the
    // schema while production answered `users: []` — the defect this shape
    // change removes.
    const { app, env } = buildApp('/calls', callsRoutes, {
      services: {
        calls: {
          getActiveCalls: vi.fn().mockResolvedValue([]),
          getBusyPubkeys: vi.fn().mockResolvedValue(new Set<string>()),
        },
        shifts: { getCurrentVolunteers: vi.fn().mockResolvedValue([MOCK_PUBKEY]) },
        activeShifts: {
          listActiveByHub: vi.fn().mockResolvedValue({ activeShifts: [{ pubkey: MOCK_PUBKEY, hubId: '' }] }),
          listClockedInPubkeys: vi.fn().mockResolvedValue(new Set([MOCK_PUBKEY])),
        },
        settings: {
          getFallbackGroup: vi.fn().mockResolvedValue({ userPubkeys: [] }),
          getRoles: vi.fn().mockResolvedValue({
            roles: [{ id: 'role-volunteer', name: 'Volunteer', permissions: ['calls:answer'] }],
          }),
        },
        identity: {
          getUsers: vi.fn().mockResolvedValue({
            users: [{ pubkey: MOCK_PUBKEY, active: true, onBreak: false, roles: ['role-volunteer'], hubRoles: [] }],
          }),
        },
      },
    })

    const result = await assertConformsToSchema(app, 'GET', '/calls/presence', callPresenceResponseSchema, { env })
    expect(Array.isArray(result.parsed.users)).toBe(true)
    expect(result.parsed.users[0].status).toMatch(/^(available|on-call|online)$/)
  })
})

// ---------------------------------------------------------------------------
// Hub Routes
// ---------------------------------------------------------------------------

describe('Hub Routes — response conformance', () => {
  const mockHub = {
    id: 'hub-1',
    name: 'Test Hub',
    slug: 'test-hub',
    status: 'active' as const,
    createdBy: MOCK_PUBKEY,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  it('GET /hubs — conforms to hubListResponseSchema', async () => {
    const mockSettings = {
      getHubs: vi.fn().mockResolvedValue({ hubs: [mockHub] }),
    }

    const { app, env } = buildApp('/hubs', hubRoutes, {
      services: { settings: mockSettings },
      permissions: ['*'],
    })

    const result = await assertConformsToSchema(app, 'GET', '/hubs', hubListResponseSchema, { env })
    expect(Array.isArray(result.parsed.hubs)).toBe(true)
    expect(result.parsed.hubs[0].id).toBe('hub-1')
  })

  it('GET /hubs/:hubId — conforms to hubDetailResponseSchema', async () => {
    const mockSettings = {
      // Service returns { hub: ... } wrapper
      getHub: vi.fn().mockResolvedValue({ hub: mockHub }),
    }

    const { app, env } = buildApp('/hubs', hubRoutes, {
      services: { settings: mockSettings },
      permissions: ['*'],  // super-admin bypasses hub membership check
    })

    const result = await assertConformsToSchema(app, 'GET', '/hubs/hub-1', hubDetailResponseSchema, { env })
    expect(result.parsed.hub.id).toBe('hub-1')
    expect(result.parsed.hub.slug).toBe('test-hub')
  })
})

// ---------------------------------------------------------------------------
// Notes Routes
// ---------------------------------------------------------------------------

describe('Notes Routes — response conformance', () => {
  const mockNote = {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    encryptedContent: 'encrypted-data-base64',
    authorPubkey: MOCK_PUBKEY,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  it('GET /notes — conforms to noteListResponseSchema', async () => {
    const mockRecords = {
      listNotes: vi.fn().mockResolvedValue({ notes: [mockNote], total: 1 }),
    }

    const { app, env } = buildApp('/notes', notesRoutes, {
      services: { records: mockRecords },
    })

    const result = await assertConformsToSchema(app, 'GET', '/notes', noteListResponseSchema, { env })
    expect(Array.isArray(result.parsed.notes)).toBe(true)
    expect(typeof result.parsed.total).toBe('number')
    expect(typeof result.parsed.page).toBe('number')
    expect(typeof result.parsed.limit).toBe('number')
  })

  it('POST /notes — conforms to noteResponseSchema (flat, no wrapper)', async () => {
    const mockRecords = {
      createNote: vi.fn().mockResolvedValue(mockNote),
    }
    const mockCasesService = {
      createInteraction: vi.fn().mockResolvedValue(undefined),
    }

    const { app, env } = buildApp('/notes', notesRoutes, {
      services: { records: mockRecords, cases: mockCasesService },
    })

    const result = await assertConformsToSchema(app, 'POST', '/notes', noteResponseSchema, {
      body: {
        callId: 'call-1',
        encryptedContent: 'encrypted-data',
      },
      expectedStatus: 201,
      env,
    })
    // Response must be a flat note, not wrapped in { note: ... }
    expect(result.parsed.encryptedContent).toBe('encrypted-data-base64')
    expect(result.parsed.authorPubkey).toBe(MOCK_PUBKEY)
  })
})

// ---------------------------------------------------------------------------
// Bans Routes
// ---------------------------------------------------------------------------

describe('Bans Routes — response conformance', () => {
  it('GET /bans — conforms to banListResponseSchema', async () => {
    const mockBans = [
      {
        phone: '***4567',
        phoneHash: 'a'.repeat(64),
        reason: 'Harassment',
        bannedBy: MOCK_PUBKEY,
        bannedAt: new Date().toISOString(),
      },
    ]
    const mockRecords = {
      listBans: vi.fn().mockResolvedValue({ bans: mockBans }),
    }

    const { app, env } = buildApp('/bans', bansRoutes, {
      services: { records: mockRecords },
      permissions: ['bans:read'],
    })

    const result = await assertConformsToSchema(app, 'GET', '/bans', banListResponseSchema, { env })
    expect(Array.isArray(result.parsed.bans)).toBe(true)
    expect(result.parsed.bans[0].phone).toBe('***4567')
  })
})

// ---------------------------------------------------------------------------
// Invites Routes
// ---------------------------------------------------------------------------

describe('Invites Routes — response conformance', () => {
  it('GET /invites/validate/:code — conforms to inviteValidationResponseSchema', async () => {
    const mockIdentity = {
      validateInvite: vi.fn().mockResolvedValue({
        valid: true,
        name: 'John Doe',
        roleIds: ['role-volunteer'],
      }),
    }
    const mockSettings = {
      // checkRateLimit is called as settings.checkRateLimit({ key, maxPerMinute })
      // must return { limited: boolean }
      checkRateLimit: vi.fn().mockResolvedValue({ limited: false }),
    }

    const { app, env } = buildApp('/invites', invitesRoutes, {
      services: { identity: mockIdentity, settings: mockSettings },
    })

    const result = await assertConformsToSchema(
      app,
      'GET',
      '/invites/validate/550e8400-e29b-41d4-a716-446655440000',
      inviteValidationResponseSchema,
      { env },
    )
    expect(result.parsed.valid).toBe(true)
  })

  it('GET /invites (list) — conforms to inviteListResponseSchema', async () => {
    const mockInvite = {
      code: '550e8400-e29b-41d4-a716-446655440000',
      name: 'John Doe',
      phone: '+15551234567',
      roleIds: ['role-volunteer'],
      createdBy: MOCK_PUBKEY,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    }
    const mockIdentity = {
      // Entity router uses 'getInvites' as the list method
      getInvites: vi.fn().mockResolvedValue({ invites: [mockInvite] }),
    }

    const { app, env } = buildApp('/invites', invitesRoutes, {
      services: { identity: mockIdentity },
      permissions: ['invites:read'],
    })

    const result = await assertConformsToSchema(app, 'GET', '/invites', inviteListResponseSchema, { env })
    expect(Array.isArray(result.parsed.invites)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Users Routes
// ---------------------------------------------------------------------------

describe('Users Routes — response conformance', () => {
  const mockUser = {
    pubkey: MOCK_PUBKEY,
    name: 'Test User',
    roles: ['role-volunteer'],
    active: true,
    createdAt: new Date().toISOString(),
    transcriptionEnabled: false,
    spokenLanguages: ['en'],
    uiLanguage: 'en',
    profileCompleted: true,
    onBreak: false,
    callPreference: 'phone' as const,
  }

  it('GET /users — conforms to userListResponseSchema', async () => {
    const mockIdentity = {
      getUsers: vi.fn().mockResolvedValue({ users: [mockUser] }),
    }

    const { app, env } = buildApp('/users', usersRoutes, {
      services: { identity: mockIdentity },
      permissions: ['users:read'],
    })

    const result = await assertConformsToSchema(app, 'GET', '/users', userListResponseSchema, { env })
    expect(Array.isArray(result.parsed.users)).toBe(true)
    expect(result.parsed.users[0].pubkey).toBe(MOCK_PUBKEY)
  })

  it('GET /users/:pubkey — conforms to userResponseSchema', async () => {
    const mockIdentity = {
      getUser: vi.fn().mockResolvedValue(mockUser),
    }

    const { app, env } = buildApp('/users', usersRoutes, {
      services: { identity: mockIdentity },
      permissions: ['users:read'],
    })

    const result = await assertConformsToSchema(app, 'GET', `/users/${MOCK_PUBKEY}`, userResponseSchema, { env })
    expect(result.parsed.pubkey).toBe(MOCK_PUBKEY)
    expect(typeof result.parsed.active).toBe('boolean')
  })
})

// ---------------------------------------------------------------------------
// Shifts Routes
// ---------------------------------------------------------------------------

describe('Shifts Routes — response conformance', () => {
  it('GET /shifts/my-status — conforms to myStatusResponseSchema', async () => {
    const mockShifts = {
      getMyStatus: vi.fn().mockResolvedValue({
        onShift: false,
        currentShift: null,
        nextShift: null,  // Required field — nullable but must be present
      }),
    }

    const { app, env } = buildApp('/shifts', shiftsRoutes, {
      services: { shifts: mockShifts },
    })

    const result = await assertConformsToSchema(app, 'GET', '/shifts/my-status', myStatusResponseSchema, { env })
    expect(typeof result.parsed.onShift).toBe('boolean')
    expect(result.parsed.nextShift).toBeNull()
  })
})
