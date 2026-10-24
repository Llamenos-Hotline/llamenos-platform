import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'
import blastRoutes from '@worker/routes/blasts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBlast(overrides = {}): Record<string, unknown> {
  return {
    id: 'blast-1',
    name: 'Test Blast',
    status: 'draft',
    hubId: 'hub-1',
    content: { text: 'Hello', mediaUrl: undefined },
    targetChannels: ['sms'],
    createdBy: 'a'.repeat(64),
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

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

  const app = new Hono<AppEnv>()

  app.use('*', async (c, next) => {
    c.set('pubkey', pubkey)
    c.set('permissions', permissions)
    c.set('services', {
      blasts: {
        // The hub guard (#2011) fetches the row before any handler runs; by
        // default every id resolves to a row of the app's own hub. Tests that
        // care about the handler's own fetch override these.
        getBlast: async (id: string) => makeBlast({ id, hubId }),
        getSubscriberById: async (id: string) => ({ id, hubId }),
        ...(serviceMock.blasts as Record<string, unknown> | undefined),
      },
    } as unknown as AppEnv['Variables']['services'])
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

  app.route('/blasts', blastRoutes)

  return { app }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('blasts routes', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // GET /blasts — List blasts with pagination and status filter
  // -------------------------------------------------------------------------

  describe('GET /blasts', () => {
    it('lists blasts with hub scoping', async () => {
      const listBlastsSpy = vi.fn().mockResolvedValue([
        makeBlast({ id: 'b1', status: 'draft' }),
        makeBlast({ id: 'b2', status: 'sent' }),
      ])
      const { app } = createTestApp({
        permissions: ['blasts:read'],
        hubId: 'hub-1',
        serviceMock: { blasts: { listBlasts: listBlastsSpy } },
      })

      const res = await app.request('/blasts')
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.blasts).toHaveLength(2)
      expect(json.total).toBe(2)
      expect(listBlastsSpy).toHaveBeenCalledWith('hub-1')
    })

    it('filters by status query param', async () => {
      const listBlastsSpy = vi.fn().mockResolvedValue([
        makeBlast({ id: 'b1', status: 'draft' }),
        makeBlast({ id: 'b2', status: 'sent' }),
        makeBlast({ id: 'b3', status: 'draft' }),
      ])
      const { app } = createTestApp({
        permissions: ['blasts:read'],
        hubId: 'hub-1',
        serviceMock: { blasts: { listBlasts: listBlastsSpy } },
      })

      const res = await app.request('/blasts?status=draft')
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.blasts).toHaveLength(2)
      expect(json.blasts.every((b: { status: string }) => b.status === 'draft')).toBe(true)
    })

    it('applies pagination with page and limit params', async () => {
      const allBlasts = Array.from({ length: 10 }, (_, i) =>
        makeBlast({ id: `blast-${i}`, name: `Blast ${i}` }),
      )
      const listBlastsSpy = vi.fn().mockResolvedValue(allBlasts)
      const { app } = createTestApp({
        permissions: ['blasts:read'],
        hubId: 'hub-1',
        serviceMock: { blasts: { listBlasts: listBlastsSpy } },
      })

      const res = await app.request('/blasts?page=2&limit=3')
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.blasts).toHaveLength(3)
      expect(json.total).toBe(10)
      expect(json.page).toBe(2)
      expect(json.limit).toBe(3)
    })

    it('requires blasts:read permission', async () => {
      const { app } = createTestApp({ permissions: ['other:read'] })
      const res = await app.request('/blasts')
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // POST /blasts — Create a blast
  // -------------------------------------------------------------------------

  describe('POST /blasts', () => {
    it('creates a blast and returns 201', async () => {
      const createBlastSpy = vi.fn().mockResolvedValue(makeBlast())
      const { app } = createTestApp({
        permissions: ['blasts:send'],
        hubId: 'hub-1',
        pubkey: 'a'.repeat(64),
        serviceMock: { blasts: { createBlast: createBlastSpy } },
      })

      const res = await app.request('/blasts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Test Blast',
          content: { body: 'Hello', mediaUrl: undefined },
          channels: ['sms'],
        }),
      })

      expect(res.status).toBe(201)
      expect(createBlastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          hubId: 'hub-1',
          name: 'Test Blast',
          createdBy: 'a'.repeat(64),
          targetChannels: ['sms'],
        }),
      )
    })

    it('requires blasts:send permission', async () => {
      const { app } = createTestApp({ permissions: ['blasts:read'] })
      const res = await app.request('/blasts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Test',
          content: { body: 'Hello' },
          channels: ['sms'],
        }),
      })
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // GET /blasts/:id — Get single blast
  // -------------------------------------------------------------------------

  describe('GET /blasts/:id', () => {
    it('returns blast by ID', async () => {
      const getBlastSpy = vi.fn().mockResolvedValue(makeBlast({ id: 'blast-42' }))
      const { app } = createTestApp({
        permissions: ['blasts:read'],
        serviceMock: { blasts: { getBlast: getBlastSpy } },
      })

      const res = await app.request('/blasts/blast-42')
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.id).toBe('blast-42')
      expect(getBlastSpy).toHaveBeenCalledWith('blast-42')
    })

    it('requires blasts:read permission', async () => {
      const { app } = createTestApp({ permissions: ['blasts:send'] })
      const res = await app.request('/blasts/blast-1')
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // POST /blasts/:id/send — Send blast immediately
  // -------------------------------------------------------------------------

  describe('POST /blasts/:id/send', () => {
    it('sends blast and returns 200', async () => {
      const sendSpy = vi.fn().mockResolvedValue(makeBlast({ status: 'sending' }))
      const expandSpy = vi.fn().mockResolvedValue(undefined)
      const { app } = createTestApp({
        permissions: ['blasts:send'],
        hubId: 'hub-1',
        serviceMock: { blasts: { send: sendSpy, expandBlast: expandSpy } },
      })

      const res = await app.request('/blasts/blast-1/send', { method: 'POST' })
      expect(res.status).toBe(200)
      const json = await res.json()
      expect((json as { blast: { status: string } }).blast.status).toBe('sending')
      expect(sendSpy).toHaveBeenCalledWith('blast-1', 'hub-1')
    })

    it('requires blasts:send permission', async () => {
      const { app } = createTestApp({ permissions: ['blasts:read'] })
      const res = await app.request('/blasts/blast-1/send', { method: 'POST' })
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // POST /blasts/:id/schedule — Schedule blast
  // -------------------------------------------------------------------------

  describe('POST /blasts/:id/schedule', () => {
    it('schedules a blast for later delivery', async () => {
      const scheduleSpy = vi.fn().mockResolvedValue(makeBlast({ status: 'scheduled' }))
      const { app } = createTestApp({
        permissions: ['blasts:schedule'],
        serviceMock: { blasts: { schedule: scheduleSpy } },
      })

      const scheduledAt = '2026-06-01T10:00:00.000Z'
      const res = await app.request('/blasts/blast-1/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduledAt }),
      })

      expect(res.status).toBe(200)
      const json = await res.json()
      expect((json as { blast: { status: string } }).blast.status).toBe('scheduled')
      expect(scheduleSpy).toHaveBeenCalledWith('blast-1', scheduledAt)
    })

    it('requires blasts:schedule permission', async () => {
      const { app } = createTestApp({ permissions: ['blasts:send'] })
      const res = await app.request('/blasts/blast-1/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduledAt: '2026-06-01T10:00:00.000Z' }),
      })
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // POST /blasts/:id/cancel — Cancel scheduled blast
  // -------------------------------------------------------------------------

  describe('POST /blasts/:id/cancel', () => {
    it('cancels a scheduled blast', async () => {
      const cancelSpy = vi.fn().mockResolvedValue(makeBlast({ status: 'cancelled' }))
      const { app } = createTestApp({
        permissions: ['blasts:schedule'],
        serviceMock: { blasts: { cancel: cancelSpy } },
      })

      const res = await app.request('/blasts/blast-1/cancel', { method: 'POST' })
      expect(res.status).toBe(200)
      const json = await res.json()
      expect((json as { blast: { status: string } }).blast.status).toBe('cancelled')
      expect(cancelSpy).toHaveBeenCalledWith('blast-1')
    })

    it('requires blasts:schedule permission', async () => {
      const { app } = createTestApp({ permissions: ['blasts:send'] })
      const res = await app.request('/blasts/blast-1/cancel', { method: 'POST' })
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // DELETE /blasts/:id — Delete a blast
  // -------------------------------------------------------------------------

  describe('DELETE /blasts/:id', () => {
    it('deletes a blast and returns ok', async () => {
      const deleteBlastSpy = vi.fn().mockResolvedValue(undefined)
      const { app } = createTestApp({
        permissions: ['blasts:manage'],
        serviceMock: { blasts: { deleteBlast: deleteBlastSpy } },
      })

      const res = await app.request('/blasts/blast-1', { method: 'DELETE' })
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.ok).toBe(true)
      expect(deleteBlastSpy).toHaveBeenCalledWith('blast-1')
    })

    it('requires blasts:manage permission', async () => {
      const { app } = createTestApp({ permissions: ['blasts:send'] })
      const res = await app.request('/blasts/blast-1', { method: 'DELETE' })
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // GET /blasts/subscribers/stats — Subscriber statistics
  // -------------------------------------------------------------------------

  describe('GET /blasts/subscribers/stats', () => {
    it('returns subscriber stats for the hub', async () => {
      const getStatsSpy = vi.fn().mockResolvedValue({ total: 150, active: 140, unsubscribed: 10 })
      const { app } = createTestApp({
        permissions: ['blasts:read'],
        hubId: 'hub-1',
        serviceMock: { blasts: { getSubscriberStats: getStatsSpy } },
      })

      const res = await app.request('/blasts/subscribers/stats')
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.total).toBe(150)
      expect(getStatsSpy).toHaveBeenCalledWith('hub-1')
    })

    it('requires blasts:read permission', async () => {
      const { app } = createTestApp({ permissions: ['blasts:manage'] })
      const res = await app.request('/blasts/subscribers/stats')
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // GET /blasts/settings — Blast settings
  // -------------------------------------------------------------------------

  describe('GET /blasts/settings', () => {
    it('returns blast settings for hub', async () => {
      const getSettingsSpy = vi.fn().mockResolvedValue({
        defaultChannel: 'sms',
        rateLimitPerHour: 1000,
      })
      const { app } = createTestApp({
        permissions: ['blasts:read'],
        hubId: 'hub-1',
        serviceMock: { blasts: { getBlastSettings: getSettingsSpy } },
      })

      const res = await app.request('/blasts/settings')
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.defaultChannel).toBe('sms')
      expect(getSettingsSpy).toHaveBeenCalledWith('hub-1')
    })

    it('requires blasts:read permission', async () => {
      const { app } = createTestApp({ permissions: ['blasts:manage'] })
      const res = await app.request('/blasts/settings')
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // GET /blasts/:id/stats — Live delivery stats
  // -------------------------------------------------------------------------

  describe('GET /blasts/:id/stats', () => {
    it('returns delivery stats for a blast', async () => {
      const computeStatsSpy = vi.fn().mockResolvedValue({
        total: 100,
        delivered: 85,
        failed: 5,
        pending: 10,
      })
      const { app } = createTestApp({
        permissions: ['blasts:read'],
        serviceMock: { blasts: { computeBlastStats: computeStatsSpy } },
      })

      const res = await app.request('/blasts/blast-1/stats')
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.delivered).toBe(85)
      expect(computeStatsSpy).toHaveBeenCalledWith('blast-1')
    })
  })

  // -------------------------------------------------------------------------
  // POST /blasts/subscribers/import — Import subscribers
  // -------------------------------------------------------------------------

  describe('POST /blasts/subscribers/import', () => {
    it('imports subscribers and returns results', async () => {
      const importSpy = vi.fn().mockResolvedValue({ created: 3, updated: 1, failed: 0 })
      const { app } = createTestApp({
        permissions: ['blasts:manage'],
        hubId: 'hub-1',
        serviceMock: { blasts: { importBulk: importSpy } },
      })

      const res = await app.request('/blasts/subscribers/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subscribers: [
            { channel: 'sms', identifier: '+15551234567' },
            { channel: 'sms', identifier: '+15557654321' },
          ],
        }),
      })

      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.created).toBe(3)
      expect(importSpy).toHaveBeenCalledWith(
        'hub-1',
        expect.arrayContaining([
          expect.objectContaining({ identifier: '+15551234567' }),
        ]),
      )
    })

    it('requires blasts:manage permission', async () => {
      const { app } = createTestApp({ permissions: ['blasts:read'] })
      const res = await app.request('/blasts/subscribers/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscribers: [] }),
      })
      expect(res.status).toBe(403)
    })
  })
})
