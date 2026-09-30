import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'
import shiftRoutes from '@worker/routes/shifts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestApp(opts: {
  permissions?: string[]
  hubId?: string
  pubkey?: string
  serviceMock?: Record<string, unknown>
} = {}) {
  const {
    permissions = ['*'],
    hubId,
    pubkey = 'a'.repeat(64),
    serviceMock = {},
  } = opts

  const services: Record<string, unknown> = {
    shifts: serviceMock.shifts || {},
    settings: serviceMock.settings || {},
    activeShifts: serviceMock.activeShifts || {},
    shiftAvailability: serviceMock.shiftAvailability || {},
    audit: serviceMock.audit || { log: vi.fn().mockResolvedValue(undefined) },
  }

  const app = new Hono<AppEnv>()

  app.use('*', async (c, next) => {
    c.set('pubkey', pubkey)
    c.set('permissions', permissions)
    c.set('services', services as unknown as AppEnv['Variables']['services'])
    c.set('allRoles', [])
    c.set('requestId', 'test-req-1')
    c.set('user', {
      pubkey,
      name: 'Test User',
      phone: '+1555000000',
      roles: permissions.includes('*') ? ['role-super-admin'] : ['role-volunteer'],
      active: true,
      createdAt: new Date().toISOString(),
      encryptedSecretKey: '',
      transcriptionEnabled: false,
      spokenLanguages: ['en'],
      uiLanguage: 'en',
      profileCompleted: true,
      onBreak: false,
      callPreference: 'phone',
    })
    if (hubId !== undefined) {
      c.set('hubId', hubId)
    }
    await next()
  })

  app.route('/shifts', shiftRoutes)

  return { app }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('shifts routes', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // GET /shifts/my-status — Any authenticated user
  // -------------------------------------------------------------------------

  describe('GET /shifts/my-status', () => {
    it('returns shift status for current user', async () => {
      const getMyStatusSpy = vi.fn().mockResolvedValue({
        onShift: true,
        currentShift: { id: 's1', encryptedName: 'Morning', startTime: '09:00', endTime: '12:00' },
        nextShift: null,
      })
      const { app } = createTestApp({
        permissions: ['shifts:read-own'],
        hubId: 'hub-1',
        serviceMock: { shifts: { getMyStatus: getMyStatusSpy } },
      })

      const res = await app.request('/shifts/my-status')
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.onShift).toBe(true)
      expect(getMyStatusSpy).toHaveBeenCalledWith('hub-1', 'a'.repeat(64))
    })

    it('uses empty string hubId when not set', async () => {
      const getMyStatusSpy = vi.fn().mockResolvedValue({
        onShift: false,
        currentShift: null,
        nextShift: null,
      })
      const { app } = createTestApp({
        permissions: ['shifts:read-own'],
        serviceMock: { shifts: { getMyStatus: getMyStatusSpy } },
      })

      const res = await app.request('/shifts/my-status')
      expect(res.status).toBe(200)
      expect(getMyStatusSpy).toHaveBeenCalledWith('', 'a'.repeat(64))
    })
  })

  // -------------------------------------------------------------------------
  // GET /shifts/fallback — Permission-gated
  // -------------------------------------------------------------------------

  describe('GET /shifts/fallback', () => {
    it('returns fallback group config', async () => {
      const getFallbackGroupSpy = vi.fn().mockResolvedValue({
        userPubkeys: ['b'.repeat(64), 'c'.repeat(64)],
      })
      const { app } = createTestApp({
        permissions: ['shifts:manage-fallback'],
        hubId: 'hub-1',
        serviceMock: { settings: { getFallbackGroup: getFallbackGroupSpy } },
      })

      const res = await app.request('/shifts/fallback')
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.userPubkeys).toEqual(['b'.repeat(64), 'c'.repeat(64)])
      expect(getFallbackGroupSpy).toHaveBeenCalledWith('hub-1')
    })

    it('requires shifts:manage-fallback permission', async () => {
      const { app } = createTestApp({ permissions: ['shifts:read'] })
      const res = await app.request('/shifts/fallback')
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // PUT /shifts/fallback — Permission-gated
  // -------------------------------------------------------------------------

  describe('PUT /shifts/fallback', () => {
    it('updates fallback group config', async () => {
      const setFallbackGroupSpy = vi.fn().mockResolvedValue({
        userPubkeys: ['d'.repeat(64), 'e'.repeat(64)],
      })
      const { app } = createTestApp({
        permissions: ['shifts:manage-fallback'],
        hubId: 'hub-1',
        serviceMock: { settings: { setFallbackGroup: setFallbackGroupSpy } },
      })

      const res = await app.request('/shifts/fallback', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userPubkeys: ['d'.repeat(64), 'e'.repeat(64)] }),
      })

      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.userPubkeys).toEqual(['d'.repeat(64), 'e'.repeat(64)])
      expect(setFallbackGroupSpy).toHaveBeenCalledWith({ userPubkeys: ['d'.repeat(64), 'e'.repeat(64)] }, 'hub-1')
    })

    it('requires shifts:manage-fallback permission', async () => {
      const { app } = createTestApp({ permissions: ['shifts:read'] })
      const res = await app.request('/shifts/fallback', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userPubkeys: ['d'.repeat(64)] }),
      })
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // GET /shifts — List (via entity-router)
  // -------------------------------------------------------------------------

  describe('GET /shifts', () => {
    it('lists shifts', async () => {
      const listSpy = vi.fn().mockResolvedValue({
        shifts: [{ id: 's1', encryptedName: 'Morning', startTime: '09:00', endTime: '12:00', days: [1, 2, 3], userPubkeys: ['b'.repeat(64)], ringGroupId: null, createdAt: new Date().toISOString() }],
      })
      const { app } = createTestApp({
        permissions: ['shifts:read'],
        hubId: 'hub-1',
        serviceMock: { shifts: { list: listSpy } },
      })

      const res = await app.request('/shifts')
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.shifts).toHaveLength(1)
      expect(listSpy).toHaveBeenCalledWith('hub-1')
    })

    it('narrows each roster to the caller for shifts:read-own', async () => {
      const self = 'a'.repeat(64)
      const other = 'b'.repeat(64)
      const listSpy = vi.fn().mockResolvedValue({
        shifts: [
          { id: 's1', encryptedName: 'Morning', startTime: '09:00', endTime: '12:00', days: [1], userPubkeys: [other, self], ringGroupId: null, createdAt: new Date().toISOString() },
          { id: 's2', encryptedName: 'Evening', startTime: '18:00', endTime: '22:00', days: [1], userPubkeys: [other], ringGroupId: null, createdAt: new Date().toISOString() },
        ],
      })
      const { app } = createTestApp({
        permissions: ['shifts:read-own'],
        hubId: 'hub-1',
        serviceMock: { shifts: { list: listSpy } },
      })

      const res = await app.request('/shifts')
      expect(res.status).toBe(200)
      const json = await res.json() as { shifts: Array<{ id: string; userPubkeys: string[] }> }
      expect(json.shifts.map(s => [s.id, s.userPubkeys])).toEqual([['s1', [self]], ['s2', []]])
    })

    it('requires shifts:read or shifts:read-own permission', async () => {
      const { app } = createTestApp({ permissions: ['other:read'] })
      const res = await app.request('/shifts')
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // DELETE /shifts/availability/:id — self-service unless shifts:manage
  // -------------------------------------------------------------------------

  describe('DELETE /shifts/availability/:id', () => {
    const block = (userPubkey: string) => ({
      id: 'blk-1', hubId: 'hub-1', userPubkey, startDate: '2026-09-01', endDate: '2026-09-07',
      encryptedReason: null, createdAt: new Date(),
    })

    it('deletes the caller\'s own block', async () => {
      const deleteSpy = vi.fn().mockResolvedValue({ ok: true })
      const { app } = createTestApp({
        permissions: ['shifts:set-availability'],
        hubId: 'hub-1',
        serviceMock: { shiftAvailability: { get: vi.fn().mockResolvedValue(block('a'.repeat(64))), delete: deleteSpy } },
      })

      const res = await app.request('/shifts/availability/blk-1', { method: 'DELETE' })
      expect(res.status).toBe(200)
      expect(deleteSpy).toHaveBeenCalledWith('hub-1', 'blk-1')
    })

    it('reports another user\'s block as not found and leaves it in place', async () => {
      const deleteSpy = vi.fn().mockResolvedValue({ ok: true })
      const { app } = createTestApp({
        permissions: ['shifts:set-availability'],
        hubId: 'hub-1',
        serviceMock: { shiftAvailability: { get: vi.fn().mockResolvedValue(block('b'.repeat(64))), delete: deleteSpy } },
      })

      const res = await app.request('/shifts/availability/blk-1', { method: 'DELETE' })
      expect(res.status).toBe(404)
      expect(deleteSpy).not.toHaveBeenCalled()
    })

    it('lets shifts:manage delete any user\'s block', async () => {
      const deleteSpy = vi.fn().mockResolvedValue({ ok: true })
      const getSpy = vi.fn().mockResolvedValue(block('b'.repeat(64)))
      const { app } = createTestApp({
        permissions: ['shifts:set-availability', 'shifts:manage'],
        hubId: 'hub-1',
        serviceMock: { shiftAvailability: { get: getSpy, delete: deleteSpy } },
      })

      const res = await app.request('/shifts/availability/blk-1', { method: 'DELETE' })
      expect(res.status).toBe(200)
      expect(deleteSpy).toHaveBeenCalledWith('hub-1', 'blk-1')
    })
  })

  // -------------------------------------------------------------------------
  // POST /shifts — Create (via entity-router)
  // -------------------------------------------------------------------------

  describe('POST /shifts', () => {
    it('creates a shift', async () => {
      const createSpy = vi.fn().mockResolvedValue({
        id: 's1',
        encryptedName: 'Morning',
        startTime: '09:00',
        endTime: '12:00',
        days: [1, 2, 3],
        ringGroupId: null,
        userPubkeys: ['b'.repeat(64)],
        createdAt: new Date().toISOString(),
      })
      const { app } = createTestApp({
        permissions: ['shifts:create'],
        hubId: 'hub-1',
        serviceMock: { shifts: { list: vi.fn(), create: createSpy } },
      })

      const res = await app.request('/shifts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: '550e8400-e29b-41d4-a716-446655440000', encryptedName: 'Morning', startTime: '09:00', endTime: '12:00', days: [1, 2, 3], userPubkeys: ['b'.repeat(64)] }),
      })

      expect(res.status).toBe(201)
      expect(createSpy).toHaveBeenCalledWith('hub-1', { id: '550e8400-e29b-41d4-a716-446655440000', encryptedName: 'Morning', startTime: '09:00', endTime: '12:00', days: [1, 2, 3], ringGroupId: null, userPubkeys: ['b'.repeat(64)] }, expect.objectContaining({ callerPubkey: expect.any(String), permissions: expect.any(Array) }))
    })

    it('requires shifts:create permission', async () => {
      const { app } = createTestApp({ permissions: ['shifts:read'] })
      const res = await app.request('/shifts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: '550e8400-e29b-41d4-a716-446655440000', encryptedName: 'Morning', startTime: '09:00', endTime: '12:00', days: [1, 2, 3], userPubkeys: ['b'.repeat(64)] }),
      })
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // PATCH /shifts/:id — Update (via entity-router)
  // -------------------------------------------------------------------------

  describe('PATCH /shifts/:id', () => {
    it('updates a shift', async () => {
      const updateSpy = vi.fn().mockResolvedValue({
        id: 's1',
        encryptedName: 'Evening',
        startTime: '18:00',
        endTime: '21:00',
        days: [1, 2],
        ringGroupId: null,
        userPubkeys: ['b'.repeat(64)],
        createdAt: new Date().toISOString(),
      })
      const { app } = createTestApp({
        permissions: ['shifts:update'],
        hubId: 'hub-1',
        serviceMock: { shifts: { list: vi.fn(), update: updateSpy } },
      })

      const res = await app.request('/shifts/s1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ encryptedName: 'Evening' }),
      })

      expect(res.status).toBe(200)
      expect(updateSpy).toHaveBeenCalledWith('hub-1', 's1', { encryptedName: 'Evening' }, expect.objectContaining({ callerPubkey: expect.any(String), permissions: expect.any(Array) }))
    })

    it('requires shifts:update permission', async () => {
      const { app } = createTestApp({ permissions: ['shifts:read'] })
      const res = await app.request('/shifts/s1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ encryptedName: 'Evening' }),
      })
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // DELETE /shifts/:id — Delete (via entity-router)
  // -------------------------------------------------------------------------

  describe('DELETE /shifts/:id', () => {
    it('deletes a shift', async () => {
      const deleteSpy = vi.fn().mockResolvedValue({ ok: true })
      const { app } = createTestApp({
        permissions: ['shifts:delete'],
        hubId: 'hub-1',
        serviceMock: { shifts: { list: vi.fn(), delete: deleteSpy } },
      })

      const res = await app.request('/shifts/s1', { method: 'DELETE' })
      expect(res.status).toBe(200)
      expect(deleteSpy).toHaveBeenCalledWith('hub-1', 's1', expect.objectContaining({ callerPubkey: expect.any(String), permissions: expect.any(Array) }))
    })

    it('requires shifts:delete permission', async () => {
      const { app } = createTestApp({ permissions: ['shifts:read'] })
      const res = await app.request('/shifts/s1', { method: 'DELETE' })
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // POST /shifts/clock-in — Clock in to active roster
  // -------------------------------------------------------------------------

  describe('POST /shifts/clock-in', () => {
    it('clocks in a volunteer and returns { ok: true }', async () => {
      const now = new Date()
      const clockInSpy = vi.fn().mockResolvedValue({
        pubkey: 'a'.repeat(64),
        hubId: 'hub-1',
        startedAt: now,
        lastHeartbeat: now,
      })
      const { app } = createTestApp({
        permissions: ['shifts:set-availability'],
        hubId: 'hub-1',
        serviceMock: { activeShifts: { clockIn: clockInSpy } },
      })

      const res = await app.request('/shifts/clock-in', { method: 'POST' })
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json).toEqual({ ok: true })
      expect(clockInSpy).toHaveBeenCalledWith('a'.repeat(64), 'hub-1')
    })

    it('clock-in is idempotent — already-clocked-in volunteer still returns { ok: true }', async () => {
      const now = new Date()
      // clockIn is an upsert; calling it again just updates lastHeartbeat
      const clockInSpy = vi.fn().mockResolvedValue({
        pubkey: 'a'.repeat(64),
        hubId: 'hub-1',
        startedAt: now,
        lastHeartbeat: now,
      })
      const { app } = createTestApp({
        permissions: ['shifts:set-availability'],
        hubId: 'hub-1',
        serviceMock: { activeShifts: { clockIn: clockInSpy } },
      })

      // First call
      await app.request('/shifts/clock-in', { method: 'POST' })
      // Second call — should succeed again (upsert semantics)
      const res = await app.request('/shifts/clock-in', { method: 'POST' })
      expect(res.status).toBe(200)
      expect((await res.json())).toEqual({ ok: true })
      expect(clockInSpy).toHaveBeenCalledTimes(2)
    })

    it('requires shifts:set-availability permission', async () => {
      const { app } = createTestApp({ permissions: ['shifts:read'] })
      const res = await app.request('/shifts/clock-in', { method: 'POST' })
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // POST /shifts/clock-out — Clock out of active roster
  // -------------------------------------------------------------------------

  describe('POST /shifts/clock-out', () => {
    it('clocks out a clocked-in volunteer and returns { ok: true }', async () => {
      const clockOutSpy = vi.fn().mockResolvedValue({ ok: true })
      const { app } = createTestApp({
        permissions: ['shifts:set-availability'],
        hubId: 'hub-1',
        serviceMock: { activeShifts: { clockOut: clockOutSpy } },
      })

      const res = await app.request('/shifts/clock-out', { method: 'POST' })
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json).toEqual({ ok: true })
      expect(clockOutSpy).toHaveBeenCalledWith('a'.repeat(64), 'hub-1')
    })

    it('requires shifts:set-availability permission', async () => {
      const { app } = createTestApp({ permissions: ['shifts:read'] })
      const res = await app.request('/shifts/clock-out', { method: 'POST' })
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // POST /shifts/heartbeat — Liveness heartbeat while clocked in
  // -------------------------------------------------------------------------

  describe('POST /shifts/heartbeat', () => {
    it('records heartbeat for a clocked-in volunteer and returns { ok: true }', async () => {
      const now = new Date()
      const heartbeatSpy = vi.fn().mockResolvedValue({
        pubkey: 'a'.repeat(64),
        hubId: 'hub-1',
        startedAt: now,
        lastHeartbeat: now,
      })
      const { app } = createTestApp({
        permissions: ['shifts:set-availability'],
        hubId: 'hub-1',
        serviceMock: { activeShifts: { heartbeat: heartbeatSpy } },
      })

      const res = await app.request('/shifts/heartbeat', { method: 'POST' })
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json).toEqual({ ok: true })
      expect(heartbeatSpy).toHaveBeenCalledWith('a'.repeat(64), 'hub-1')
    })

    it('requires shifts:set-availability permission', async () => {
      const { app } = createTestApp({ permissions: ['shifts:read'] })
      const res = await app.request('/shifts/heartbeat', { method: 'POST' })
      expect(res.status).toBe(403)
    })
  })
})
