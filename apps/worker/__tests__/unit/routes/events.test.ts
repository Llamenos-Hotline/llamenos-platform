/**
 * Unit tests for routes/events.ts
 *
 * Tests: permission enforcement, CRUD operations, event linking/unlinking,
 * sub-event listing, Nostr publish (fire-and-forget), audit logging.
 */
import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'
import eventsRouter from '@worker/routes/events'

// Mock event publish — it's fire-and-forget and shouldn't affect route behavior
vi.mock('@worker/lib/ws-events', () => ({
  publishEvent: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

function makeApp(opts: {
  permissions?: string[]
  pubkey?: string
  hubId?: string
  services?: Record<string, unknown>
} = {}) {
  const {
    permissions = ['*'],
    pubkey = 'a'.repeat(64),
    hubId = 'hub-1',
    services = {},
  } = opts

  const auditLog = vi.fn().mockResolvedValue(undefined)

  const mockCases = {
    listEvents: vi.fn().mockResolvedValue({ events: [], total: 0 }),
    getEvent: vi.fn(),
    createEvent: vi.fn(),
    updateEvent: vi.fn(),
    deleteEvent: vi.fn().mockResolvedValue(undefined),
    linkEvent: vi.fn(),
    unlinkEvent: vi.fn().mockResolvedValue(undefined),
    listEventRecords: vi.fn().mockResolvedValue([]),
    linkReportEvent: vi.fn(),
    unlinkReportEvent: vi.fn().mockResolvedValue(undefined),
    listEventReports: vi.fn().mockResolvedValue([]),
  }

  const mockSettings = {
    getEntityTypeById: vi.fn().mockRejectedValue(new Error('Not found')),
    generateCaseNumber: vi.fn().mockResolvedValue({ number: 'CASE-001' }),
  }

  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('pubkey', pubkey)
    c.set('permissions', permissions)
    c.set('hubId', hubId)
    c.set('services', {
      audit: { log: auditLog },
      cases: mockCases,
      settings: mockSettings,
      ...(services as Record<string, unknown>),
    } as unknown as AppEnv['Variables']['services'])
    c.set('requestId', 'test-req')
    c.env = {} as unknown as AppEnv['Bindings']
    await next()
  })
  app.route('/', eventsRouter)

  return { app, mockCases, mockSettings, auditLog }
}

const baseEvent = {
  id: 'ev-1',
  entityTypeId: 'type-demo',
  hubId: 'hub-1',
  createdBy: 'a'.repeat(64),
  caseNumber: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

// ---------------------------------------------------------------------------
// GET / — list events
// ---------------------------------------------------------------------------

describe('GET /events', () => {
  it('lists events for hub', async () => {
    const { app, mockCases } = makeApp({ permissions: ['events:read'] })
    mockCases.listEvents.mockResolvedValue({ events: [baseEvent], total: 1 })

    const res = await app.request('/')
    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect((json.events as unknown[]).length).toBe(1)
    expect(mockCases.listEvents).toHaveBeenCalledWith(
      expect.objectContaining({ hubId: 'hub-1' }),
    )
  })

  it('passes query filters to service', async () => {
    const { app, mockCases } = makeApp({ permissions: ['events:read'] })
    mockCases.listEvents.mockResolvedValue({ events: [], total: 0 })

    const res = await app.request('/?page=2&limit=10&eventTypeHash=eth123')
    expect(res.status).toBe(200)
    expect(mockCases.listEvents).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2, limit: 10, eventTypeHash: 'eth123' }),
    )
  })

  it('returns 403 without events:read', async () => {
    const { app } = makeApp({ permissions: ['events:create'] })
    const res = await app.request('/')
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// GET /:id — get single event
// ---------------------------------------------------------------------------

describe('GET /events/:id', () => {
  it('returns a single event', async () => {
    const { app, mockCases } = makeApp({ permissions: ['events:read'] })
    mockCases.getEvent.mockResolvedValue(baseEvent)

    const res = await app.request('/ev-1')
    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect(json.id).toBe('ev-1')
    expect(mockCases.getEvent).toHaveBeenCalledWith('ev-1')
  })

  it('returns 403 without events:read', async () => {
    const { app } = makeApp({ permissions: ['events:create'] })
    const res = await app.request('/ev-1')
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// POST / — create event
// ---------------------------------------------------------------------------

describe('POST /events', () => {
  const validBody = {
    entityTypeId: '550e8400-e29b-41d4-a716-446655440000',
    startDate: '2026-01-01',
    eventTypeHash: 'type-hash-abc',
    statusHash: 'status-hash-abc',
    encryptedDetails: 'encrypted-payload',
    detailEnvelopes: [{
      pubkey: 'a'.repeat(64),
      enc: 'b'.repeat(64),
      ct: 'wrapped-key-hex',
    }],
  }

  it('creates event and returns 201', async () => {
    const { app, mockCases, auditLog } = makeApp({ permissions: ['events:create'] })
    mockCases.createEvent.mockResolvedValue(baseEvent)

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })

    expect(res.status).toBe(201)
    const json = await res.json() as Record<string, unknown>
    expect(json.id).toBe('ev-1')
    expect(mockCases.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        entityTypeId: '550e8400-e29b-41d4-a716-446655440000',
        hubId: 'hub-1',
        createdBy: 'a'.repeat(64),
      }),
    )
    expect(auditLog).toHaveBeenCalledOnce()
  })

  it('generates case number when entity type has numbering enabled', async () => {
    const { app, mockCases, mockSettings } = makeApp({ permissions: ['events:create'] })
    mockSettings.getEntityTypeById.mockResolvedValue({
      numberingEnabled: true,
      numberPrefix: 'EVT',
    })
    mockCases.createEvent.mockResolvedValue({ ...baseEvent, caseNumber: 'EVT-001' })

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })

    expect(res.status).toBe(201)
    expect(mockSettings.generateCaseNumber).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: 'EVT', hubId: 'hub-1' }),
    )
    expect(mockCases.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ caseNumber: 'CASE-001' }),
    )
  })

  it('proceeds without case number when entity type fetch fails', async () => {
    const { app, mockCases } = makeApp({ permissions: ['events:create'] })
    mockCases.createEvent.mockResolvedValue(baseEvent)

    // mockSettings.getEntityTypeById already throws by default in makeApp
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })

    expect(res.status).toBe(201)
    expect(mockCases.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ caseNumber: undefined }),
    )
  })

  it('returns 403 without events:create', async () => {
    const { app } = makeApp({ permissions: ['events:read'] })

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })

    expect(res.status).toBe(403)
  })

  it('returns 400 on invalid body', async () => {
    const { app } = makeApp({ permissions: ['events:create'] })

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// PATCH /:id — update event
// ---------------------------------------------------------------------------

describe('PATCH /events/:id', () => {
  it('updates event and returns 200', async () => {
    const { app, mockCases, auditLog } = makeApp({ permissions: ['events:update'] })
    const updated = { ...baseEvent, updatedAt: new Date().toISOString() }
    mockCases.updateEvent.mockResolvedValue(updated)

    const res = await app.request('/ev-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ encryptedTitle: 'new-title', titleEnvelopes: [] }),
    })

    expect(res.status).toBe(200)
    expect(mockCases.updateEvent).toHaveBeenCalledWith('ev-1', expect.any(Object))
    expect(auditLog).toHaveBeenCalledOnce()
  })

  it('returns 403 without events:update', async () => {
    const { app } = makeApp({ permissions: ['events:read'] })

    const res = await app.request('/ev-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ encryptedTitle: 'x', titleEnvelopes: [] }),
    })

    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// DELETE /:id — delete event
// ---------------------------------------------------------------------------

describe('DELETE /events/:id', () => {
  it('deletes event and returns ok', async () => {
    const { app, mockCases, auditLog } = makeApp({ permissions: ['events:delete'] })

    const res = await app.request('/ev-1', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect(json.ok).toBe(true)
    expect(mockCases.deleteEvent).toHaveBeenCalledWith('ev-1')
    expect(auditLog).toHaveBeenCalledOnce()
  })

  it('returns 403 without events:delete', async () => {
    const { app } = makeApp({ permissions: ['events:read'] })

    const res = await app.request('/ev-1', { method: 'DELETE' })
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// GET /:id/subevents — list sub-events
// ---------------------------------------------------------------------------

describe('GET /events/:id/subevents', () => {
  it('lists sub-events by parentEventId', async () => {
    const { app, mockCases } = makeApp({ permissions: ['events:read'] })
    mockCases.listEvents.mockResolvedValue({ events: [{ id: 'sub-1' }], total: 1 })

    const res = await app.request('/ev-1/subevents')
    expect(res.status).toBe(200)
    expect(mockCases.listEvents).toHaveBeenCalledWith(
      expect.objectContaining({ parentEventId: 'ev-1', hubId: 'hub-1' }),
    )
  })

  it('returns 403 without events:read', async () => {
    const { app } = makeApp({ permissions: ['events:create'] })
    const res = await app.request('/ev-1/subevents')
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// POST /:id/records — link record to event
// ---------------------------------------------------------------------------

describe('POST /events/:id/records', () => {
  it('links record and returns 201', async () => {
    const { app, mockCases, auditLog } = makeApp({ permissions: ['events:link'] })
    const recordId = '550e8400-e29b-41d4-a716-446655440001'
    const linked = { id: 'link-1', eventId: 'ev-1', recordId }
    mockCases.linkEvent.mockResolvedValue(linked)

    const res = await app.request('/ev-1/records', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recordId }),
    })

    expect(res.status).toBe(201)
    expect(mockCases.linkEvent).toHaveBeenCalledWith(recordId, 'ev-1', 'a'.repeat(64), 'hub-1')
    expect(auditLog).toHaveBeenCalledOnce()
  })

  it('returns 403 without events:link', async () => {
    const { app } = makeApp({ permissions: ['events:read'] })

    const res = await app.request('/ev-1/records', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recordId: 'rec-1' }),
    })

    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// DELETE /:id/records/:recordId — unlink record from event
// ---------------------------------------------------------------------------

describe('DELETE /events/:id/records/:recordId', () => {
  it('unlinks record and returns ok', async () => {
    const { app, mockCases, auditLog } = makeApp({ permissions: ['events:link'] })

    const res = await app.request('/ev-1/records/rec-1', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect(json.ok).toBe(true)
    expect(mockCases.unlinkEvent).toHaveBeenCalledWith('rec-1', 'ev-1', 'hub-1')
    expect(auditLog).toHaveBeenCalledOnce()
  })

  it('returns 403 without events:link', async () => {
    const { app } = makeApp({ permissions: ['events:read'] })
    const res = await app.request('/ev-1/records/rec-1', { method: 'DELETE' })
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// GET /:id/records — list records linked to event
// ---------------------------------------------------------------------------

describe('GET /events/:id/records', () => {
  it('returns linked records', async () => {
    const { app, mockCases } = makeApp({ permissions: ['events:read'] })
    mockCases.listEventRecords.mockResolvedValue([{ id: 'link-1' }])

    const res = await app.request('/ev-1/records')
    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect((json.links as unknown[]).length).toBe(1)
    expect(mockCases.listEventRecords).toHaveBeenCalledWith('ev-1', 'hub-1')
  })

  it('returns 403 without events:read', async () => {
    const { app } = makeApp({ permissions: [] })
    const res = await app.request('/ev-1/records')
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// POST /:id/reports — link report to event
// ---------------------------------------------------------------------------

describe('POST /events/:id/reports', () => {
  it('links report and returns 201', async () => {
    const { app, mockCases, auditLog } = makeApp({ permissions: ['events:link'] })
    const linked = { id: 'rlink-1', eventId: 'ev-1', reportId: 'rpt-1' }
    mockCases.linkReportEvent.mockResolvedValue(linked)

    const res = await app.request('/ev-1/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reportId: 'rpt-1' }),
    })

    expect(res.status).toBe(201)
    expect(mockCases.linkReportEvent).toHaveBeenCalledWith('rpt-1', 'ev-1', 'a'.repeat(64), 'hub-1')
    expect(auditLog).toHaveBeenCalledOnce()
  })

  it('returns 403 without events:link', async () => {
    const { app } = makeApp({ permissions: ['events:read'] })

    const res = await app.request('/ev-1/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reportId: 'rpt-1' }),
    })

    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// DELETE /:id/reports/:reportId — unlink report from event
// ---------------------------------------------------------------------------

describe('DELETE /events/:id/reports/:reportId', () => {
  it('unlinks report and returns ok', async () => {
    const { app, mockCases, auditLog } = makeApp({ permissions: ['events:link'] })

    const res = await app.request('/ev-1/reports/rpt-1', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect(json.ok).toBe(true)
    expect(mockCases.unlinkReportEvent).toHaveBeenCalledWith('rpt-1', 'ev-1', 'hub-1')
    expect(auditLog).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// GET /:id/reports — list reports linked to event
// ---------------------------------------------------------------------------

describe('GET /events/:id/reports', () => {
  it('returns linked reports', async () => {
    const { app, mockCases } = makeApp({ permissions: ['events:read'] })
    mockCases.listEventReports.mockResolvedValue([{ id: 'rlink-1' }])

    const res = await app.request('/ev-1/reports')
    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect((json.links as unknown[]).length).toBe(1)
    expect(mockCases.listEventReports).toHaveBeenCalledWith('ev-1', 'hub-1')
  })

  it('returns 403 without events:read', async () => {
    const { app } = makeApp({ permissions: [] })
    const res = await app.request('/ev-1/reports')
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// GET /events (bare list) — deprecation 301 redirect
//
// The deprecation middleware matches on c.req.path.endsWith('/events'), which
// only exercises in production when the router is mounted at a path ending
// in 'events' (e.g. '/api/events', matching apps/worker/app.ts). The other
// describe blocks above mount via `app.route('/', eventsRouter)` and request
// '/', so they never hit this path — mount at '/events' here instead to
// actually cover the real routing shape.
// ---------------------------------------------------------------------------

describe('GET /events (bare list) — deprecation redirect', () => {
  function makeMountedApp(permissions: string[] = ['events:read']) {
    const mockCases = {
      listEvents: vi.fn().mockResolvedValue({ events: [], total: 0 }),
      getEvent: vi.fn().mockResolvedValue({ id: 'ev-1' }),
    }
    const app = new Hono<AppEnv>()
    app.use('*', async (c, next) => {
      c.set('pubkey', 'a'.repeat(64))
      c.set('permissions', permissions)
      c.set('hubId', 'hub-1')
      c.set('services', {
        audit: { log: vi.fn().mockResolvedValue(undefined) },
        cases: mockCases,
        settings: { getEntityTypeById: vi.fn().mockRejectedValue(new Error('not found')) },
      } as unknown as AppEnv['Variables']['services'])
      c.set('requestId', 'test-req')
      c.env = {} as unknown as AppEnv['Bindings']
      await next()
    })
    app.route('/events', eventsRouter)
    return { app, mockCases }
  }

  it('redirects GET /events to the records successor with a 301, without ever calling the service', async () => {
    const { app, mockCases } = makeMountedApp()
    const res = await app.request('/events', { redirect: 'manual' })

    expect(res.status).toBe(301)
    expect(res.headers.get('Location')).toContain('/api/records')
    expect(res.headers.get('Deprecation')).toBeTruthy()
    expect(mockCases.listEvents).not.toHaveBeenCalled()
  })

  it('redirects even with no permissions at all — the redirect itself discloses no data', async () => {
    const { app } = makeMountedApp([])
    const res = await app.request('/events', { redirect: 'manual' })
    expect(res.status).toBe(301)
  })

  it('does not redirect GET /events/:id — single-event reads keep working during the deprecation window', async () => {
    const { app } = makeMountedApp()
    const res = await app.request('/events/ev-1', { redirect: 'manual' })
    expect(res.status).toBe(200)
  })
})
