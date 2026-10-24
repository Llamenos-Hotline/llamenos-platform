/**
 * Firehose routes — CRUD for firehose connections, buffer/health status,
 * notification opt-outs, and agent lifecycle control.
 */
import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '../types'
import { requirePermission } from '../middleware/permission-guard'
import { LABEL_FIREHOSE_AGENT_SEAL } from '@shared/crypto-labels'
import {
  createFirehoseConnectionSchema,
  updateFirehoseConnectionSchema,
  firehoseConnectionSchema,
  type FirehoseConnectionStatus,
} from '@protocol/schemas/firehose'
import { z } from 'zod'
import { authErrors } from '../openapi/helpers'
import { generateAgentKeypair } from '../lib/agent-identity'
import { backgroundTask } from '../lib/hono-compat'
import { createLogger } from '../lib/logger'
import { audit } from '../services/audit'
import { assertInHub, resourceInPathHub } from '../lib/hub-scope'
import { ServiceError } from '../services/settings'

const log = createLogger('routes.firehose')

type FirehoseConnectionRow = typeof import('../db/schema/firehose').firehoseConnections.$inferSelect

/** Map a DB row to the API response shape (strips sealedAgentKey). */
function mapConnection(row: FirehoseConnectionRow) {
  return {
    id: row.id,
    hubId: row.hubId,
    signalGroupId: row.signalGroupId,
    displayName: row.displayName,
    encryptedDisplayName: row.encryptedDisplayName ?? undefined,
    reportTypeId: row.reportTypeId,
    agentPubkey: row.agentPubkey,
    geoContext: row.geoContext,
    geoContextCountryCodes: row.geoContextCountryCodes,
    inferenceEndpoint: row.inferenceEndpoint,
    extractionIntervalSec: row.extractionIntervalSec,
    systemPromptSuffix: row.systemPromptSuffix,
    bufferTtlDays: row.bufferTtlDays,
    notifyViaSignal: row.notifyViaSignal,
    status: row.status as FirehoseConnectionStatus,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  }
}

const firehose = new Hono<AppEnv>()

// Inside /hubs/:hubId every /:id route may only touch a connection of that hub
// (#2011). Activating, pausing or deleting another hub's connection starts and
// stops its agent; it is a 404, the same as a missing one.
firehose.use('/:id/*', resourceInPathHub({
  param: 'id',
  skip: new Set(['status']),
  load: async (services, id, hubId) => {
    const connection = await services.firehose.getConnection(id)
    if (!connection) throw new ServiceError(404, 'Firehose connection not found')
    return assertInHub(connection, hubId, 'Firehose connection not found')
  },
}))

// ---------------------------------------------------------------------------
// GET /status — health status for all connections (BEFORE /:id)
// ---------------------------------------------------------------------------

firehose.get('/status',
  requirePermission('firehose:read'),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? 'global'

    const connections = await services.firehose.listConnections(hubId)
    const statuses = await Promise.all(
      connections.map(async (conn) => {
        const bufferSize = await services.firehose.getBufferSize(conn.id)
        return {
          id: conn.id,
          status: conn.status as FirehoseConnectionStatus,
          lastMessageReceived: null,
          lastReportSubmitted: null,
          bufferSize,
          extractionCount: 0,
          inferenceHealthMs: null,
        }
      }),
    )

    return c.json({ statuses })
  },
)

// ---------------------------------------------------------------------------
// GET / — list connections for hub
// ---------------------------------------------------------------------------

firehose.get('/',
  requirePermission('firehose:read'),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? 'global'
    const rows = await services.firehose.listConnections(hubId)
    const connections = rows.map(mapConnection)
    return c.json({ connections })
  },
)

// ---------------------------------------------------------------------------
// POST / — create connection
// ---------------------------------------------------------------------------

firehose.post('/',
  describeRoute({
    tags: ['Firehose'],
    summary: 'Create a firehose connection',
    responses: {
      201: {
        description: 'Connection created',
        content: { 'application/json': { schema: resolver(z.object({ connection: firehoseConnectionSchema })) } },
      },
      ...authErrors,
    },
  }),
  requirePermission('firehose:manage'),
  validator('json', createFirehoseConnectionSchema),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? 'global'
    const pubkey = c.get('pubkey')

    const data = c.req.valid('json')

    // Seal key must be configured
    const sealKey = c.env.FIREHOSE_AGENT_SEAL_KEY
    if (!sealKey) {
      return c.json({ error: 'Firehose agent seal key not configured' }, 503)
    }

    // Use client-supplied ID or generate one for deterministic keypair derivation
    const connectionId = data.id ?? crypto.randomUUID()

    // Generate keypair before persisting — avoids orphaned 'pending' rows on failure
    const { pubkey: agentPubkey, sealedAgentKey } = generateAgentKeypair(
      connectionId,
      sealKey,
      LABEL_FIREHOSE_AGENT_SEAL,
    )

    const row = await services.firehose.createConnection(hubId, {
      id: connectionId,
      displayName: data.displayName?.trim() ?? '',
      encryptedDisplayName: data.encryptedDisplayName?.trim(),
      reportTypeId: data.reportTypeId,
      agentPubkey,
      sealedAgentKey,
      geoContext: data.geoContext ?? null,
      geoContextCountryCodes: data.geoContextCountryCodes ?? null,
      inferenceEndpoint: data.inferenceEndpoint ?? null,
      extractionIntervalSec: data.extractionIntervalSec,
      systemPromptSuffix: data.systemPromptSuffix ?? null,
      bufferTtlDays: data.bufferTtlDays,
      notifyViaSignal: data.notifyViaSignal,
      status: 'pending',
    })

    backgroundTask(c,
      audit(services.audit, 'firehoseConnectionCreated', pubkey, {
        connectionId: row.id,
      }, undefined, hubId),
    )

    return c.json({ connection: mapConnection(row) }, 201)
  },
)

// ---------------------------------------------------------------------------
// GET /:id — get connection by ID
// ---------------------------------------------------------------------------

firehose.get('/:id',
  requirePermission('firehose:read'),
  async (c) => {
    const services = c.get('services')
    const id = c.req.param('id')
    const hubId = c.get('hubId') ?? 'global'

    const row = await services.firehose.getConnection(id)
    if (!row || row.hubId !== hubId) {
      return c.json({ error: 'Firehose connection not found' }, 404)
    }
    return c.json({ connection: mapConnection(row) })
  },
)

// ---------------------------------------------------------------------------
// PATCH /:id — update connection
// ---------------------------------------------------------------------------

firehose.patch('/:id',
  describeRoute({
    tags: ['Firehose'],
    summary: 'Update a firehose connection',
    responses: {
      200: {
        description: 'Connection updated',
        content: { 'application/json': { schema: resolver(z.object({ connection: firehoseConnectionSchema })) } },
      },
      404: { description: 'Connection not found' },
      ...authErrors,
    },
  }),
  requirePermission('firehose:manage'),
  validator('json', updateFirehoseConnectionSchema),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? 'global'
    const pubkey = c.get('pubkey')
    const id = c.req.param('id')

    const data = c.req.valid('json')

    const existing = await services.firehose.getConnection(id)
    if (!existing) {
      return c.json({ error: 'Firehose connection not found' }, 404)
    }

    const row = await services.firehose.updateConnection(id, {
      ...(data.displayName !== undefined && data.encryptedDisplayName === undefined
        ? { displayName: data.displayName.trim() }
        : {}),
      ...(data.encryptedDisplayName !== undefined
        ? { encryptedDisplayName: data.encryptedDisplayName.trim() }
        : {}),
      ...(data.reportTypeId !== undefined ? { reportTypeId: data.reportTypeId } : {}),
      ...(data.geoContext !== undefined ? { geoContext: data.geoContext } : {}),
      ...(data.geoContextCountryCodes !== undefined
        ? { geoContextCountryCodes: data.geoContextCountryCodes }
        : {}),
      ...(data.inferenceEndpoint !== undefined
        ? { inferenceEndpoint: data.inferenceEndpoint }
        : {}),
      ...(data.extractionIntervalSec !== undefined
        ? { extractionIntervalSec: data.extractionIntervalSec }
        : {}),
      ...(data.systemPromptSuffix !== undefined
        ? { systemPromptSuffix: data.systemPromptSuffix }
        : {}),
      ...(data.bufferTtlDays !== undefined ? { bufferTtlDays: data.bufferTtlDays } : {}),
      ...(data.notifyViaSignal !== undefined ? { notifyViaSignal: data.notifyViaSignal } : {}),
      ...(data.status !== undefined ? { status: data.status } : {}),
    })

    if (!row) {
      return c.json({ error: 'Firehose connection not found' }, 404)
    }

    // Stop/start agent based on status change
    if (data.status === 'paused' || data.status === 'disabled') {
      services.firehoseAgent?.stopAgent(id)
    } else if (data.status === 'active' && existing.status !== 'active') {
      services.firehoseAgent
        ?.startAgent(id)
        .catch((err) => log.error('Failed to start agent after update', {
          connectionId: id,
          error: err instanceof Error ? err.message : String(err),
        }))
    }

    backgroundTask(c,
      audit(services.audit, 'firehoseConnectionUpdated', pubkey, {
        connectionId: id,
      }, undefined, hubId),
    )

    return c.json({ connection: mapConnection(row) })
  },
)

// ---------------------------------------------------------------------------
// DELETE /:id — delete connection
// ---------------------------------------------------------------------------

firehose.delete('/:id',
  requirePermission('firehose:manage'),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? 'global'
    const pubkey = c.get('pubkey')
    const id = c.req.param('id')

    const existing = await services.firehose.getConnection(id)
    if (!existing) {
      return c.json({ error: 'Firehose connection not found' }, 404)
    }

    // Stop running agent if any
    services.firehoseAgent?.stopAgent(id)

    await services.firehose.deleteConnection(id)

    backgroundTask(c,
      audit(services.audit, 'firehoseConnectionDeleted', pubkey, {
        connectionId: id,
      }, undefined, hubId),
    )

    return c.json({ ok: true })
  },
)

// ---------------------------------------------------------------------------
// POST /:id/activate — activate a pending/paused connection
// ---------------------------------------------------------------------------

firehose.post('/:id/activate',
  requirePermission('firehose:manage'),
  async (c) => {
    const services = c.get('services')
    const id = c.req.param('id')

    const conn = await services.firehose.getConnection(id)
    if (!conn) {
      return c.json({ error: 'Firehose connection not found' }, 404)
    }

    if (conn.status === 'active') {
      return c.json({ connection: mapConnection(conn) })
    }

    const updated = await services.firehose.updateConnection(id, { status: 'active' })

    // Start the agent
    try {
      await services.firehoseAgent?.startAgent(id)
    } catch (err) {
      log.error('Failed to start agent on activate', {
        connectionId: id,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    return c.json({ connection: mapConnection(updated!) })
  },
)

// ---------------------------------------------------------------------------
// POST /:id/pause — pause an active connection
// ---------------------------------------------------------------------------

firehose.post('/:id/pause',
  requirePermission('firehose:manage'),
  async (c) => {
    const services = c.get('services')
    const id = c.req.param('id')

    const conn = await services.firehose.getConnection(id)
    if (!conn) {
      return c.json({ error: 'Firehose connection not found' }, 404)
    }

    services.firehoseAgent?.stopAgent(id)
    const updated = await services.firehose.updateConnection(id, { status: 'paused' })

    return c.json({ connection: mapConnection(updated!) })
  },
)

// ---------------------------------------------------------------------------
// GET /:id/buffer — get buffer stats for a connection
// ---------------------------------------------------------------------------

firehose.get('/:id/buffer',
  requirePermission('firehose:read'),
  async (c) => {
    const services = c.get('services')
    const id = c.req.param('id')

    const conn = await services.firehose.getConnection(id)
    if (!conn) {
      return c.json({ error: 'Firehose connection not found' }, 404)
    }

    const bufferSize = await services.firehose.getBufferSize(id)
    const isAgentRunning = services.firehoseAgent?.isRunning(id) ?? false

    return c.json({
      connectionId: id,
      bufferSize,
      agentRunning: isAgentRunning,
      extractionIntervalSec: conn.extractionIntervalSec,
      bufferTtlDays: conn.bufferTtlDays,
    })
  },
)

// ---------------------------------------------------------------------------
// DELETE /:id/buffer — purge expired messages
// ---------------------------------------------------------------------------

firehose.delete('/:id/buffer',
  requirePermission('firehose:manage'),
  async (c) => {
    const services = c.get('services')
    const id = c.req.param('id')

    const conn = await services.firehose.getConnection(id)
    if (!conn) {
      return c.json({ error: 'Firehose connection not found' }, 404)
    }

    const purged = await services.firehose.purgeExpiredMessages()
    return c.json({ purged })
  },
)

// ---------------------------------------------------------------------------
// POST /:id/optout — opt out of Signal notifications
// ---------------------------------------------------------------------------

firehose.post('/:id/optout',
  requirePermission('firehose:read'),
  async (c) => {
    const services = c.get('services')
    const id = c.req.param('id')
    const pubkey = c.get('pubkey')

    const conn = await services.firehose.getConnection(id)
    if (!conn) {
      return c.json({ error: 'Firehose connection not found' }, 404)
    }

    const optout = await services.firehose.addOptout(id, pubkey)
    return c.json({
      id: optout.id,
      connectionId: optout.connectionId,
      userId: optout.userId,
      optedOutAt: optout.optedOutAt instanceof Date ? optout.optedOutAt.toISOString() : optout.optedOutAt,
    })
  },
)

// ---------------------------------------------------------------------------
// DELETE /:id/optout — re-enable Signal notifications
// ---------------------------------------------------------------------------

firehose.delete('/:id/optout',
  requirePermission('firehose:read'),
  async (c) => {
    const services = c.get('services')
    const id = c.req.param('id')
    const pubkey = c.get('pubkey')

    await services.firehose.removeOptout(id, pubkey)
    return c.json({ ok: true })
  },
)

export default firehose
