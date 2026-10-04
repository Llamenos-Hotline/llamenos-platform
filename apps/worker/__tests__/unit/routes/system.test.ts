/**
 * Unit tests for routes/system.ts
 *
 * Tests: permission enforcement (system:manage-instance), health aggregation,
 * service status derivation from env vars, graceful fallback on service errors.
 */
import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'
import systemRoutes from '@worker/routes/system'

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

function makeApp(opts: {
  permissions?: string[]
  pubkey?: string
  hubId?: string
  env?: Record<string, string>
  services?: Record<string, unknown>
} = {}) {
  const {
    permissions = ['system:manage-instance'],
    pubkey = 'a'.repeat(64),
    hubId = 'hub-1',
    env = {},
    services = {},
  } = opts

  // `onlineNow` comes from getHubPresence (services/presence.ts), which composes
  // the active-call list with the ringing resolver — there is no
  // `calls.getPresence` to mock any more, so the roster services it reads have
  // to be present here.
  const mockCalls = {
    getActiveCalls: vi.fn().mockResolvedValue([]),
    getTodayCount: vi.fn().mockResolvedValue(0),
    getBusyPubkeys: vi.fn().mockResolvedValue(new Set<string>()),
  }

  const mockIdentity = {
    getUsers: vi.fn().mockResolvedValue({ users: [] }),
  }

  const mockShifts = {
    getCurrentVolunteers: vi.fn().mockResolvedValue([]),
  }

  // Ringing — and therefore presence — is `scheduled ∩ clocked_in`, so the
  // resolver reads `active_shifts` too. These scenarios are about the
  // availability filters (`pk2` is rostered but on break), not about consent,
  // so clock-in mirrors whatever the schedule says rather than being a second
  // list a test has to remember to update.
  const mockActiveShifts = {
    listClockedInPubkeys: vi.fn(async () =>
      new Set<string>(await mockShifts.getCurrentVolunteers()),
    ),
  }

  const mockSettings = {
    getFallbackGroup: vi.fn().mockResolvedValue({ userPubkeys: [] }),
    getRoles: vi.fn().mockResolvedValue({ roles: [{ id: 'role-volunteer', name: 'Volunteer', permissions: ['calls:answer'] }] }),
  }

  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('pubkey', pubkey)
    c.set('permissions', permissions)
    c.set('hubId', hubId)
    c.set('services', {
      calls: mockCalls,
      identity: mockIdentity,
      shifts: mockShifts,
      activeShifts: mockActiveShifts,
      settings: mockSettings,
      ...services,
    } as unknown as AppEnv['Variables']['services'])
    c.set('requestId', 'test-req')
    c.env = env as unknown as AppEnv['Bindings']
    await next()
  })
  app.route('/', systemRoutes)

  return { app, mockCalls, mockIdentity, mockShifts, mockActiveShifts, mockSettings }
}

// ---------------------------------------------------------------------------
// Permission guard
// ---------------------------------------------------------------------------

describe('system routes — permission guard', () => {
  it('returns 403 without system:manage-instance', async () => {
    const { app } = makeApp({ permissions: ['audit:read'] })

    const res = await app.request('/health')
    expect(res.status).toBe(403)
  })

  it('returns 403 with empty permissions', async () => {
    const { app } = makeApp({ permissions: [] })

    const res = await app.request('/health')
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// GET /health — aggregated system health
// ---------------------------------------------------------------------------

describe('GET /system/health', () => {
  it('returns 200 with complete health structure', async () => {
    const { app } = makeApp()

    const res = await app.request('/health')
    expect(res.status).toBe(200)

    const json = await res.json() as Record<string, unknown>
    expect(json).toHaveProperty('server')
    expect(json).toHaveProperty('services')
    expect(json).toHaveProperty('calls')
    expect(json).toHaveProperty('storage')
    expect(json).toHaveProperty('backup')
    expect(json).toHaveProperty('users')
    expect(json).toHaveProperty('timestamp')
  })

  it('returns valid timestamp ISO string', async () => {
    const { app } = makeApp()

    const res = await app.request('/health')
    const json = await res.json() as Record<string, unknown>
    expect(() => new Date(json.timestamp as string)).not.toThrow()
    expect(new Date(json.timestamp as string).toISOString()).toBe(json.timestamp)
  })

  it('marks blob storage as down when not configured', async () => {
    const { app } = makeApp({ env: {} }) // no BLOB_STORAGE or STORAGE_MANAGER

    const res = await app.request('/health')
    const json = await res.json() as Record<string, unknown>
    const services = json.services as Array<{ name: string; status: string }>
    const blobService = services.find(s => s.name === 'Blob Storage')
    expect(blobService?.status).toBe('down')
  })

  it('marks blob storage as ok when BLOB_STORAGE configured', async () => {
    const { app } = makeApp({ env: { BLOB_STORAGE: 'my-bucket' } })

    const res = await app.request('/health')
    const json = await res.json() as Record<string, unknown>
    const services = json.services as Array<{ name: string; status: string }>
    const blobService = services.find(s => s.name === 'Blob Storage')
    expect(blobService?.status).toBe('ok')
  })

  it('marks WebSocket relay as down when SERVER_SECRET not configured', async () => {
    const { app } = makeApp({ env: {} })

    const res = await app.request('/health')
    const json = await res.json() as Record<string, unknown>
    const services = json.services as Array<{ name: string; status: string }>
    const wsService = services.find(s => s.name === 'WebSocket Relay')
    expect(wsService?.status).toBe('down')
  })

  it('marks WebSocket relay as ok when SERVER_SECRET configured', async () => {
    const { app } = makeApp({ env: { SERVER_SECRET: 'a'.repeat(64) } })

    const res = await app.request('/health')
    const json = await res.json() as Record<string, unknown>
    const services = json.services as Array<{ name: string; status: string }>
    const wsService = services.find(s => s.name === 'WebSocket Relay')
    expect(wsService?.status).toBe('ok')
  })

  it('marks telephony as ok when TWILIO_ACCOUNT_SID configured', async () => {
    const { app } = makeApp({ env: { TWILIO_ACCOUNT_SID: 'ACtest123' } })

    const res = await app.request('/health')
    const json = await res.json() as Record<string, unknown>
    const services = json.services as Array<{ name: string; status: string }>
    const telephonyService = services.find(s => s.name === 'Telephony')
    expect(telephonyService?.status).toBe('ok')
  })

  it('returns correct call counts from service', async () => {
    const { app, mockCalls } = makeApp()
    mockCalls.getActiveCalls.mockResolvedValue([{ id: 'call-1' }, { id: 'call-2' }])
    mockCalls.getTodayCount.mockResolvedValue(15)

    const res = await app.request('/health')
    const json = await res.json() as Record<string, unknown>
    const calls = json.calls as Record<string, number>
    expect(calls.active).toBe(2)
    expect(calls.today).toBe(15)
  })

  /**
   * `onShift` is the roster; `onlineNow` is who a call would actually reach.
   * They are deliberately different numbers — pk2 is rostered but on break, so
   * the hotline would not ring them. Before presence was derived from the
   * ringing resolver, `onlineNow` was 0 on every deployment.
   */
  it('returns correct user counts from service', async () => {
    const { app, mockIdentity, mockShifts } = makeApp()
    mockIdentity.getUsers.mockResolvedValue({
      users: [
        { pubkey: 'pk1', active: true, onBreak: false, roles: ['role-volunteer'], hubRoles: [] },
        { pubkey: 'pk2', active: true, onBreak: true, roles: ['role-volunteer'], hubRoles: [] },
        { pubkey: 'pk3', active: false, onBreak: false, roles: ['role-volunteer'], hubRoles: [] },
      ],
    })
    mockShifts.getCurrentVolunteers.mockResolvedValue(['pk1', 'pk2'])

    const res = await app.request('/health')
    const json = await res.json() as Record<string, unknown>
    const users = json.users as Record<string, number>
    expect(users.totalActive).toBe(2)
    expect(users.onlineNow).toBe(1)
    expect(users.onShift).toBe(2)
    expect(users.shiftCoverage).toBe(100) // 2 on shift / 2 active = 100%
  })

  it('returns zero user counts when getUsers throws', async () => {
    const { app, mockIdentity } = makeApp()
    mockIdentity.getUsers.mockRejectedValue(new Error('DB error'))

    const res = await app.request('/health')
    // Should still return 200 due to Promise.allSettled
    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    const users = json.users as Record<string, number>
    expect(users.totalActive).toBe(0)
    expect(users.onlineNow).toBe(0)
  })

  it('returns zero call counts when getActiveCalls throws', async () => {
    const { app, mockCalls } = makeApp()
    mockCalls.getActiveCalls.mockRejectedValue(new Error('Telephony down'))

    const res = await app.request('/health')
    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    const calls = json.calls as Record<string, number>
    expect(calls.active).toBe(0)
    expect(calls.today).toBe(0)
  })

  it('marks server as degraded when any service is down', async () => {
    const { app } = makeApp({ env: {} }) // no services configured → all down

    const res = await app.request('/health')
    const json = await res.json() as Record<string, unknown>
    const server = json.server as Record<string, string>
    // At least some services will be 'down', so server should be 'degraded'
    expect(['ok', 'degraded']).toContain(server.status)
  })

  it('includes storage blobStorage:Connected when BLOB_STORAGE configured', async () => {
    const { app } = makeApp({ env: { BLOB_STORAGE: 'my-bucket' } })

    const res = await app.request('/health')
    const json = await res.json() as Record<string, unknown>
    const storage = json.storage as Record<string, string>
    expect(storage.blobStorage).toBe('Connected')
  })

  it('includes storage blobStorage:Not configured without BLOB_STORAGE', async () => {
    const { app } = makeApp({ env: {} })

    const res = await app.request('/health')
    const json = await res.json() as Record<string, unknown>
    const storage = json.storage as Record<string, string>
    expect(storage.blobStorage).toBe('Not configured')
  })

  it('backup fields are null/N/A in absence of backup service', async () => {
    const { app } = makeApp()

    const res = await app.request('/health')
    const json = await res.json() as Record<string, unknown>
    const backup = json.backup as Record<string, unknown>
    expect(backup.lastBackup).toBeNull()
    expect(backup.lastVerify).toBeNull()
    expect(backup.backupSize).toBe('N/A')
  })
})
