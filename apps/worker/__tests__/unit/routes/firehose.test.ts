/**
 * Unit tests for routes/firehose.ts
 *
 * Tests: permission enforcement, CRUD operations, agent lifecycle (activate/pause),
 * buffer stats, optout management, seal key requirement.
 */
import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'
import firehoseRoutes from '@worker/routes/firehose'

// Mock agent-identity so we don't need real key material
vi.mock('@worker/lib/agent-identity', () => ({
  generateAgentKeypair: vi.fn().mockReturnValue({
    pubkey: 'agent-pubkey-hex',
    sealedAgentKey: 'sealed-agent-key-hex',
  }),
}))

// Mock hono-compat backgroundTask (fire-and-forget)
vi.mock('@worker/lib/hono-compat', () => ({
  backgroundTask: vi.fn(),
}))

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
    permissions = ['firehose:manage', 'firehose:read'],
    pubkey = 'a'.repeat(64),
    hubId = 'hub-1',
    env = { FIREHOSE_AGENT_SEAL_KEY: 'seal-key-hex' },
    services = {},
  } = opts

  const auditLog = vi.fn().mockResolvedValue(undefined)

  const mockFirehose = {
    listConnections: vi.fn().mockResolvedValue([]),
    // The hub guard (#2011) fetches the connection before any handler; by default
    // it is a connection of the app's own hub. Tests of the handlers override this.
    getConnection: vi.fn().mockResolvedValue(baseConn),
    createConnection: vi.fn(),
    setAgentKeypair: vi.fn(),
    updateConnection: vi.fn(),
    deleteConnection: vi.fn().mockResolvedValue(undefined),
    getBufferSize: vi.fn().mockResolvedValue(0),
    purgeExpiredMessages: vi.fn().mockResolvedValue(5),
    addOptout: vi.fn(),
    removeOptout: vi.fn().mockResolvedValue(undefined),
  }

  const mockFirehoseAgent = {
    startAgent: vi.fn().mockResolvedValue(undefined),
    stopAgent: vi.fn(),
    isRunning: vi.fn().mockReturnValue(false),
  }

  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('pubkey', pubkey)
    c.set('permissions', permissions)
    c.set('hubId', hubId)
    c.set('services', {
      audit: { log: auditLog },
      firehose: mockFirehose,
      firehoseAgent: mockFirehoseAgent,
      ...(services as Record<string, unknown>),
    } as unknown as AppEnv['Variables']['services'])
    c.set('requestId', 'test-req')
    c.env = env as unknown as AppEnv['Bindings']
    await next()
  })
  app.route('/', firehoseRoutes)

  return { app, auditLog, mockFirehose, mockFirehoseAgent }
}

const baseConn = {
  id: 'conn-1',
  hubId: 'hub-1',
  signalGroupId: 'grp-1',
  displayName: 'Test Connection',
  encryptedDisplayName: null,
  reportTypeId: 'rpt-type-1',
  agentPubkey: 'agent-pubkey-hex',
  sealedAgentKey: 'sealed-agent-key-hex',
  geoContext: null,
  geoContextCountryCodes: null,
  inferenceEndpoint: null,
  extractionIntervalSec: 300,
  systemPromptSuffix: null,
  bufferTtlDays: 7,
  notifyViaSignal: true,
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
}

// ---------------------------------------------------------------------------
// GET /status
// ---------------------------------------------------------------------------

describe('GET /firehose/status', () => {
  it('returns status for all connections', async () => {
    const { app, mockFirehose } = makeApp({ permissions: ['firehose:read'] })
    mockFirehose.listConnections.mockResolvedValue([baseConn])
    mockFirehose.getBufferSize.mockResolvedValue(3)

    const res = await app.request('/status')
    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    const statuses = json.statuses as Array<Record<string, unknown>>
    expect(statuses).toHaveLength(1)
    expect(statuses[0].id).toBe('conn-1')
    expect(statuses[0].bufferSize).toBe(3)
  })

  it('returns 403 without firehose:read', async () => {
    const { app } = makeApp({ permissions: [] })
    const res = await app.request('/status')
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// GET / — list connections
// ---------------------------------------------------------------------------

describe('GET /firehose', () => {
  it('lists connections for hub', async () => {
    const { app, mockFirehose } = makeApp({ permissions: ['firehose:read'] })
    mockFirehose.listConnections.mockResolvedValue([baseConn])

    const res = await app.request('/')
    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    const connections = json.connections as Array<Record<string, unknown>>
    expect(connections).toHaveLength(1)
    expect(connections[0].id).toBe('conn-1')
    // sealedAgentKey should be stripped from response
    expect(connections[0].sealedAgentKey).toBeUndefined()
    expect(mockFirehose.listConnections).toHaveBeenCalledWith('hub-1')
  })

  it('returns 403 without firehose:read', async () => {
    const { app } = makeApp({ permissions: [] })
    const res = await app.request('/')
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// POST / — create connection
// ---------------------------------------------------------------------------

describe('POST /firehose', () => {
  const validBody = {
    displayName: 'Test Connection',
    reportTypeId: 'rpt-type-1',
    extractionIntervalSec: 300,
    bufferTtlDays: 7,
    notifyViaSignal: true,
  }

  it('creates connection with pre-generated keypair (atomic)', async () => {
    const { app, mockFirehose } = makeApp()
    mockFirehose.createConnection.mockResolvedValue({ ...baseConn })

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })

    expect(res.status).toBe(201)
    const json = await res.json() as Record<string, unknown>
    const conn = json.connection as Record<string, unknown>
    expect(conn.id).toBe('conn-1')
    expect(conn.agentPubkey).toBe('agent-pubkey-hex')
    // Keypair is generated before createConnection — no setAgentKeypair call needed
    expect(mockFirehose.setAgentKeypair).not.toHaveBeenCalled()
    // Verify createConnection received the real keypair, not 'pending'
    const createCall = mockFirehose.createConnection.mock.calls[0]
    expect(createCall[1].agentPubkey).toBe('agent-pubkey-hex')
    expect(createCall[1].sealedAgentKey).toBe('sealed-agent-key-hex')
  })

  it('returns 503 when seal key not configured', async () => {
    const { app } = makeApp({ env: {} }) // no FIREHOSE_AGENT_SEAL_KEY

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })

    expect(res.status).toBe(503)
    const json = await res.json() as Record<string, unknown>
    expect(json.error).toContain('seal key')
  })

  it('returns 403 without firehose:manage', async () => {
    const { app } = makeApp({ permissions: ['firehose:read'] })

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })

    expect(res.status).toBe(403)
  })

  it('returns 400 on invalid body', async () => {
    const { app } = makeApp()

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// GET /:id — get connection by ID
// ---------------------------------------------------------------------------

describe('GET /firehose/:id', () => {
  it('returns connection by ID', async () => {
    const { app, mockFirehose } = makeApp({ permissions: ['firehose:read'] })
    mockFirehose.getConnection.mockResolvedValue(baseConn)

    const res = await app.request('/conn-1')
    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    const conn = json.connection as Record<string, unknown>
    expect(conn.id).toBe('conn-1')
  })

  it('returns 404 when connection not found', async () => {
    const { app, mockFirehose } = makeApp({ permissions: ['firehose:read'] })
    mockFirehose.getConnection.mockResolvedValue(null)

    const res = await app.request('/conn-missing')
    expect(res.status).toBe(404)
  })

  it('returns 404 for connection in different hub (M6 hub-scoping)', async () => {
    const { app, mockFirehose } = makeApp({ permissions: ['firehose:read'], hubId: 'hub-2' })
    mockFirehose.getConnection.mockResolvedValue(baseConn) // baseConn.hubId = 'hub-1'

    const res = await app.request('/conn-1')
    expect(res.status).toBe(404)
  })

  it('returns 403 without firehose:read', async () => {
    const { app } = makeApp({ permissions: [] })
    const res = await app.request('/conn-1')
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// PATCH /:id — update connection
// ---------------------------------------------------------------------------

describe('PATCH /firehose/:id', () => {
  it('updates connection and returns updated data', async () => {
    const { app, mockFirehose } = makeApp()
    const updated = { ...baseConn, displayName: 'Updated Name' }
    mockFirehose.getConnection.mockResolvedValue(baseConn)
    mockFirehose.updateConnection.mockResolvedValue(updated)

    const res = await app.request('/conn-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Updated Name' }),
    })

    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    const conn = json.connection as Record<string, unknown>
    expect(conn.displayName).toBe('Updated Name')
  })

  it('returns 404 when connection not found', async () => {
    const { app, mockFirehose } = makeApp()
    mockFirehose.getConnection.mockResolvedValue(null)

    const res = await app.request('/conn-missing', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'X' }),
    })

    expect(res.status).toBe(404)
  })

  it('stops agent when status changed to paused', async () => {
    const { app, mockFirehose, mockFirehoseAgent } = makeApp()
    mockFirehose.getConnection.mockResolvedValue({ ...baseConn, status: 'active' })
    mockFirehose.updateConnection.mockResolvedValue({ ...baseConn, status: 'paused' })

    await app.request('/conn-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'paused' }),
    })

    expect(mockFirehoseAgent.stopAgent).toHaveBeenCalledWith('conn-1')
  })

  it('starts agent when status changed to active from non-active', async () => {
    const { app, mockFirehose, mockFirehoseAgent } = makeApp()
    mockFirehose.getConnection.mockResolvedValue({ ...baseConn, status: 'paused' })
    mockFirehose.updateConnection.mockResolvedValue({ ...baseConn, status: 'active' })

    await app.request('/conn-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    })

    expect(mockFirehoseAgent.startAgent).toHaveBeenCalledWith('conn-1')
  })

  it('returns 403 without firehose:manage', async () => {
    const { app } = makeApp({ permissions: ['firehose:read'] })

    const res = await app.request('/conn-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'X' }),
    })

    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// DELETE /:id — delete connection
// ---------------------------------------------------------------------------

describe('DELETE /firehose/:id', () => {
  it('deletes connection and stops agent', async () => {
    const { app, mockFirehose, mockFirehoseAgent } = makeApp()
    mockFirehose.getConnection.mockResolvedValue(baseConn)

    const res = await app.request('/conn-1', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect(json.ok).toBe(true)
    expect(mockFirehoseAgent.stopAgent).toHaveBeenCalledWith('conn-1')
    expect(mockFirehose.deleteConnection).toHaveBeenCalledWith('conn-1')
  })

  it('returns 404 when connection not found', async () => {
    const { app, mockFirehose } = makeApp()
    mockFirehose.getConnection.mockResolvedValue(null)

    const res = await app.request('/conn-missing', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  it('returns 403 without firehose:manage', async () => {
    const { app } = makeApp({ permissions: ['firehose:read'] })
    const res = await app.request('/conn-1', { method: 'DELETE' })
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// POST /:id/activate — activate connection
// ---------------------------------------------------------------------------

describe('POST /firehose/:id/activate', () => {
  it('activates a pending connection and starts agent', async () => {
    const { app, mockFirehose, mockFirehoseAgent } = makeApp()
    const pendingConn = { ...baseConn, status: 'pending' }
    const activeConn = { ...baseConn, status: 'active' }
    mockFirehose.getConnection.mockResolvedValue(pendingConn)
    mockFirehose.updateConnection.mockResolvedValue(activeConn)

    const res = await app.request('/conn-1/activate', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(mockFirehose.updateConnection).toHaveBeenCalledWith('conn-1', { status: 'active' })
    expect(mockFirehoseAgent.startAgent).toHaveBeenCalledWith('conn-1')
  })

  it('returns existing connection without update when already active', async () => {
    const { app, mockFirehose, mockFirehoseAgent } = makeApp()
    mockFirehose.getConnection.mockResolvedValue({ ...baseConn, status: 'active' })

    const res = await app.request('/conn-1/activate', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(mockFirehose.updateConnection).not.toHaveBeenCalled()
    expect(mockFirehoseAgent.startAgent).not.toHaveBeenCalled()
  })

  it('returns 404 when connection not found', async () => {
    const { app, mockFirehose } = makeApp()
    mockFirehose.getConnection.mockResolvedValue(null)

    const res = await app.request('/conn-missing/activate', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('returns 403 without firehose:manage', async () => {
    const { app } = makeApp({ permissions: ['firehose:read'] })
    const res = await app.request('/conn-1/activate', { method: 'POST' })
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// POST /:id/pause — pause connection
// ---------------------------------------------------------------------------

describe('POST /firehose/:id/pause', () => {
  it('pauses an active connection', async () => {
    const { app, mockFirehose, mockFirehoseAgent } = makeApp()
    mockFirehose.getConnection.mockResolvedValue(baseConn)
    mockFirehose.updateConnection.mockResolvedValue({ ...baseConn, status: 'paused' })

    const res = await app.request('/conn-1/pause', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(mockFirehoseAgent.stopAgent).toHaveBeenCalledWith('conn-1')
    expect(mockFirehose.updateConnection).toHaveBeenCalledWith('conn-1', { status: 'paused' })
  })

  it('returns 404 when connection not found', async () => {
    const { app, mockFirehose } = makeApp()
    mockFirehose.getConnection.mockResolvedValue(null)

    const res = await app.request('/conn-missing/pause', { method: 'POST' })
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// GET /:id/buffer — buffer stats
// ---------------------------------------------------------------------------

describe('GET /firehose/:id/buffer', () => {
  it('returns buffer stats', async () => {
    const { app, mockFirehose, mockFirehoseAgent } = makeApp({ permissions: ['firehose:read'] })
    mockFirehose.getConnection.mockResolvedValue(baseConn)
    mockFirehose.getBufferSize.mockResolvedValue(42)
    mockFirehoseAgent.isRunning.mockReturnValue(true)

    const res = await app.request('/conn-1/buffer')
    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect(json.bufferSize).toBe(42)
    expect(json.agentRunning).toBe(true)
    expect(json.connectionId).toBe('conn-1')
  })

  it('returns 404 when connection not found', async () => {
    const { app, mockFirehose } = makeApp({ permissions: ['firehose:read'] })
    mockFirehose.getConnection.mockResolvedValue(null)

    const res = await app.request('/conn-missing/buffer')
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// DELETE /:id/buffer — purge expired messages
// ---------------------------------------------------------------------------

describe('DELETE /firehose/:id/buffer', () => {
  it('purges expired messages', async () => {
    const { app, mockFirehose } = makeApp()
    mockFirehose.getConnection.mockResolvedValue(baseConn)
    mockFirehose.purgeExpiredMessages.mockResolvedValue(12)

    const res = await app.request('/conn-1/buffer', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect(json.purged).toBe(12)
  })

  it('returns 404 when connection not found', async () => {
    const { app, mockFirehose } = makeApp()
    mockFirehose.getConnection.mockResolvedValue(null)

    const res = await app.request('/conn-missing/buffer', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// POST /:id/optout — opt out of notifications
// ---------------------------------------------------------------------------

describe('POST /firehose/:id/optout', () => {
  it('creates optout record', async () => {
    const { app, mockFirehose } = makeApp({ permissions: ['firehose:read'] })
    mockFirehose.getConnection.mockResolvedValue(baseConn)
    const optout = {
      id: 'opt-1',
      connectionId: 'conn-1',
      userId: 'a'.repeat(64),
      optedOutAt: new Date(),
    }
    mockFirehose.addOptout.mockResolvedValue(optout)

    const res = await app.request('/conn-1/optout', { method: 'POST' })
    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect(json.id).toBe('opt-1')
    expect(json.connectionId).toBe('conn-1')
    expect(typeof json.optedOutAt).toBe('string')
  })

  it('returns 404 when connection not found', async () => {
    const { app, mockFirehose } = makeApp({ permissions: ['firehose:read'] })
    mockFirehose.getConnection.mockResolvedValue(null)

    const res = await app.request('/conn-missing/optout', { method: 'POST' })
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// DELETE /:id/optout — re-enable notifications
// ---------------------------------------------------------------------------

describe('DELETE /firehose/:id/optout', () => {
  it('removes optout record', async () => {
    const { app, mockFirehose } = makeApp({ permissions: ['firehose:read'] })
    mockFirehose.getConnection.mockResolvedValue(baseConn)

    const res = await app.request('/conn-1/optout', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect(json.ok).toBe(true)
    expect(mockFirehose.removeOptout).toHaveBeenCalledWith('conn-1', 'a'.repeat(64))
  })

  it('returns 404 when connection not found — the hub guard (#2011) resolves it before the route', async () => {
    const { app, mockFirehose } = makeApp({ permissions: ['firehose:read'] })
    mockFirehose.getConnection.mockResolvedValue(null)

    const res = await app.request('/conn-missing/optout', { method: 'DELETE' })
    expect(res.status).toBe(404)
    expect(mockFirehose.removeOptout).not.toHaveBeenCalled()
  })
})
