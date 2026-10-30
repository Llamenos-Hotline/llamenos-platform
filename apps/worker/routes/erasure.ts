import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '../types'
import { requirePermission } from '../middleware/permission-guard'
import { okResponseSchema } from '@protocol/schemas/common'
import {
  erasureRequestResponseSchema,
  erasureRequestListResponseSchema,
  createSelfErasureBodySchema,
  createEmergencySelfErasureBodySchema,
  adminErasureBodySchema,
  deviceWipeBodySchema,
  reEncryptionJobListResponseSchema,
  erasureConfigResponseSchema,
  updateErasureConfigBodySchema,
  abandonErasureBodySchema,
} from '@protocol/schemas/erasure'
import { platformSettingsSchema } from '@protocol/schemas/platform-settings'
import { authErrors } from '../openapi/helpers'
import { audit } from '../services/audit'
import { ServiceError } from '../services/settings'
import { permissionGranted } from '@shared/permissions'
import { PLATFORM_INCIDENT_PERMISSION } from '../services/incidents-categories'
import { getConnectionManager } from '../lib/ws-manager'
import { revokeVolunteerSipIdentity } from '../telephony/registrar'

const erasure = new Hono<AppEnv>()

type EffectiveErasureConfig = Awaited<
  ReturnType<AppEnv['Variables']['services']['erasure']['getEffectiveConfig']>
>

function serializeConfig(config: EffectiveErasureConfig) {
  return {
    hubId: config.hubId,
    delayHours: config.delayHours,
    emergencyOverrideEnabled: config.emergencyOverrideEnabled,
    updatedAt: config.updatedAt?.toISOString() ?? null,
    updatedBy: config.updatedBy,
  }
}

type ErasureRequestRow = Awaited<ReturnType<AppEnv['Variables']['services']['erasure']['getRequest']>> & {}

function serializeRequest(r: ErasureRequestRow) {
  return {
    id: r.id,
    userId: r.userId,
    status: r.status,
    requestedBy: r.requestedBy,
    requestedAt: r.requestedAt?.toISOString() ?? '',
    executeAt: r.executeAt?.toISOString() ?? '',
    executedAt: r.executedAt?.toISOString() ?? null,
    justification: r.justification,
    emergencyOverride: r.emergencyOverride,
    coApproverPubkey: r.coApproverPubkey,
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
  }
}

/**
 * May the caller retry or abandon this request (#2347)? Decided from the
 * request's own attribution, by permission string only:
 *  - a request that concerns a hub is for that hub's `erasure:admin` holders,
 *    acting inside that hub (`permissions` is hub-resolved on the hub-scoped
 *    mount, so this cannot be satisfied from a foreign hub);
 *  - a request whose subject belongs to NO hub is for holders of the platform
 *    permission — the same ones the platform incident reaches.
 * Returns the audit chain the action belongs to (the acting hub, or null for
 * the platform chain), or the status to refuse with.
 */
async function authorizeRequestAction(
  c: { get: <K extends 'services' | 'permissions' | 'hubId'>(key: K) => AppEnv['Variables'][K] },
  request: ErasureRequestRow,
): Promise<{ ok: true; auditHubId: string | null } | { ok: false; status: 403 }> {
  const permissions = c.get('permissions')
  const concerned = await c.get('services').erasure.hubsConcerning(request)
  if (concerned.length === 0) {
    return permissionGranted(permissions, PLATFORM_INCIDENT_PERMISSION)
      ? { ok: true, auditHubId: null }
      : { ok: false, status: 403 }
  }
  const hubId = c.get('hubId')
  if (hubId && concerned.includes(hubId) && permissionGranted(permissions, 'erasure:admin')) {
    return { ok: true, auditHubId: hubId }
  }
  return { ok: false, status: 403 }
}

// --- Self-service routes ---

erasure.get(
  '/me',
  describeRoute({
    tags: ['Erasure'],
    summary: 'Check own erasure request status',
    responses: {
      200: {
        description: 'Erasure request status',
        content: {
          'application/json': {
            schema: resolver(erasureRequestResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('erasure:request-self'),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const request = await services.erasure.getMyRequest(pubkey)
    if (!request) {
      return c.json({ request: null })
    }
    return c.json({
      request: {
        id: request.id,
        userId: request.userId,
        status: request.status,
        requestedBy: request.requestedBy,
        requestedAt: request.requestedAt?.toISOString() ?? '',
        executeAt: request.executeAt?.toISOString() ?? '',
        executedAt: request.executedAt?.toISOString() ?? null,
        justification: request.justification,
        emergencyOverride: request.emergencyOverride,
        coApproverPubkey: request.coApproverPubkey,
        cancelledAt: request.cancelledAt?.toISOString() ?? null,
      },
    })
  },
)

erasure.post(
  '/me',
  describeRoute({
    tags: ['Erasure'],
    summary: 'Request own account erasure',
    responses: {
      200: {
        description: 'Erasure request created',
        content: {
          'application/json': {
            schema: resolver(erasureRequestResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('erasure:request-self'),
  validator('json', createSelfErasureBodySchema),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const hubId = c.get('hubId')
    const body = c.req.valid('json')

    const request = await services.erasure.createSelfRequest(
      pubkey,
      hubId ?? '',
      body.justification,
    )

    await audit(
      services.audit,
      'erasureRequested',
      pubkey,
      { requestId: request.id },
      undefined,
      hubId ?? null,
    )

    return c.json({
      request: {
        id: request.id,
        userId: request.userId,
        status: request.status,
        requestedBy: request.requestedBy,
        requestedAt: request.requestedAt?.toISOString() ?? '',
        executeAt: request.executeAt?.toISOString() ?? '',
        executedAt: null,
        justification: request.justification,
        emergencyOverride: request.emergencyOverride,
        coApproverPubkey: request.coApproverPubkey,
        cancelledAt: null,
      },
    })
  },
)

erasure.post(
  '/me/emergency',
  describeRoute({
    tags: ['Erasure'],
    summary: 'Request emergency account erasure with co-approver',
    responses: {
      200: {
        description: 'Emergency erasure request created',
        content: {
          'application/json': {
            schema: resolver(erasureRequestResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('erasure:request-self'),
  validator('json', createEmergencySelfErasureBodySchema),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const hubId = c.get('hubId')
    const body = c.req.valid('json')

    const request = await services.erasure.createSelfRequest(
      pubkey,
      hubId ?? '',
      body.justification,
      {
        coApproverPubkey: body.coApproverPubkey,
        coApproverSignature: body.coApproverSignature,
        timestamp: body.timestamp,
      },
    )

    await audit(
      services.audit,
      'erasureEmergencyRequested',
      pubkey,
      {
        requestId: request.id,
        coApproverPubkey: body.coApproverPubkey,
      },
      undefined,
      hubId ?? null,
    )

    return c.json({
      request: {
        id: request.id,
        userId: request.userId,
        status: request.status,
        requestedBy: request.requestedBy,
        requestedAt: request.requestedAt?.toISOString() ?? '',
        executeAt: request.executeAt?.toISOString() ?? '',
        executedAt: null,
        justification: request.justification,
        emergencyOverride: request.emergencyOverride,
        coApproverPubkey: request.coApproverPubkey,
        cancelledAt: null,
      },
    })
  },
)

erasure.delete(
  '/me',
  describeRoute({
    tags: ['Erasure'],
    summary: 'Cancel pending self-erasure request',
    responses: {
      200: {
        description: 'Erasure request cancelled',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('erasure:request-self'),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    await services.erasure.cancelSelfRequest(pubkey)
    await audit(services.audit, 'erasureCancelled', pubkey, {}, undefined, c.get('hubId') ?? null)
    return c.json({ ok: true })
  },
)

// --- Admin routes ---

erasure.get(
  '/requests',
  describeRoute({
    tags: ['Erasure'],
    summary: 'List all erasure requests',
    responses: {
      200: {
        description: 'Erasure requests list',
        content: {
          'application/json': {
            schema: resolver(erasureRequestListResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('erasure:admin'),
  async (c) => {
    const services = c.get('services')
    const status = c.req.query('status')
    const limit = Math.min(Number(c.req.query('limit') ?? 50), 200)
    const offset = Number(c.req.query('offset') ?? 0)

    const { requests, total } = await services.erasure.listRequests({
      status,
      limit,
      offset,
    })

    return c.json({
      requests: requests.map(serializeRequest),
      total,
    })
  },
)

erasure.post(
  '/requests/:id/retry',
  describeRoute({
    tags: ['Erasure'],
    summary: 'Retry a failed erasure request',
    description:
      'Puts a failed request back in the queue; the erasure worker claims it on its next tick. Allowed for ' +
      'erasure:admin holders of a hub the request concerns, or — when the subject belongs to no hub — for holders ' +
      'of the platform permission.',
    responses: {
      200: {
        description: 'The request, queued again',
        content: { 'application/json': { schema: resolver(erasureRequestResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  async (c) => {
    const services = c.get('services')
    const request = await services.erasure.getRequest(c.req.param('id'))
    if (!request) return c.json({ error: 'Erasure request not found' }, 404)
    const decision = await authorizeRequestAction(c, request)
    if (!decision.ok) return c.json({ error: 'Forbidden' }, decision.status)
    try {
      const updated = await services.erasure.retryFailed(request.id, c.get('pubkey'), services.audit, decision.auditHubId)
      return c.json({ request: serializeRequest(updated) })
    } catch (err) {
      if (err instanceof ServiceError) return c.json({ error: err.message }, err.status as 404 | 409)
      throw err
    }
  },
)

erasure.post(
  '/requests/:id/abandon',
  describeRoute({
    tags: ['Erasure'],
    summary: 'Abandon a failed erasure request',
    description:
      'Gives up on a failed request, recording who, when and why on the request and in the audit log. The request ' +
      'becomes abandoned — distinct from completed: nothing was erased. Same authorisation as retry.',
    responses: {
      200: {
        description: 'The request, abandoned',
        content: { 'application/json': { schema: resolver(erasureRequestResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  validator('json', abandonErasureBodySchema),
  async (c) => {
    const services = c.get('services')
    const request = await services.erasure.getRequest(c.req.param('id'))
    if (!request) return c.json({ error: 'Erasure request not found' }, 404)
    const decision = await authorizeRequestAction(c, request)
    if (!decision.ok) return c.json({ error: 'Forbidden' }, decision.status)
    const { justification } = c.req.valid('json')
    try {
      const updated = await services.erasure.abandonFailed(
        request.id,
        c.get('pubkey'),
        justification,
        services.audit,
        decision.auditHubId,
      )
      return c.json({ request: serializeRequest(updated) })
    } catch (err) {
      if (err instanceof ServiceError) return c.json({ error: err.message }, err.status as 404 | 409)
      throw err
    }
  },
)

erasure.get(
  '/config',
  describeRoute({
    tags: ['Erasure'],
    summary: 'Get hub erasure config',
    responses: {
      200: {
        description: 'Hub erasure config (defaults if never saved)',
        content: {
          'application/json': {
            schema: resolver(erasureConfigResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('erasure:admin'),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId')
    if (!hubId) {
      return c.json({ error: 'Hub context required' }, 400)
    }
    const config = await services.erasure.getEffectiveConfig(hubId)
    return c.json({ config: serializeConfig(config) })
  },
)

erasure.patch(
  '/config',
  describeRoute({
    tags: ['Erasure'],
    summary: 'Update hub erasure config',
    responses: {
      200: {
        description: 'Hub erasure config updated',
        content: {
          'application/json': {
            schema: resolver(erasureConfigResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('erasure:admin'),
  validator('json', updateErasureConfigBodySchema),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const hubId = c.get('hubId')
    if (!hubId) {
      return c.json({ error: 'Hub context required' }, 400)
    }
    const body = c.req.valid('json')

    const platform = platformSettingsSchema.parse(
      await services.settings.getPlatformSettings(),
    )
    await services.erasure.upsertConfig(
      hubId,
      body,
      pubkey,
      platform.erasurePlatformFloor.minDelayHours,
    )

    await audit(
      services.audit,
      'erasureConfigUpdated',
      pubkey,
      { ...body },
      undefined,
      hubId,
    )

    const config = await services.erasure.getEffectiveConfig(hubId)
    return c.json({ config: serializeConfig(config) })
  },
)

erasure.post(
  '/:userId',
  describeRoute({
    tags: ['Erasure'],
    summary: 'Execute immediate erasure for a user (admin)',
    responses: {
      200: {
        description: 'Erasure executed',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('erasure:admin'),
  validator('json', adminErasureBodySchema),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const targetUserId = c.req.param('userId')
    const body = c.req.valid('json')

    const { reEncryptionJobIds } = await services.erasure.executeErasure(
      targetUserId,
      pubkey,
      body.justification,
      services.audit,
    )

    // Erasure deactivates the account and wipes its devices, but a SIP
    // endpoint on our own PBX authenticates against the PBX, not against us:
    // it would keep registering. Tear it down with the rest (#1540).
    await revokeVolunteerSipIdentity(services, c.env.SERVER_KEK, targetUserId)

    const wsManager = getConnectionManager()
    if (wsManager) {
      wsManager.sendSignedWipeToUser(targetUserId, {
        type: 'device:wipe',
        targetUserId,
        reason: 'admin-erasure',
        timestamp: new Date().toISOString(),
      })
      wsManager.terminateUser(targetUserId)
    }

    return c.json({
      ok: true,
      reEncryptionJobIds,
    })
  },
)

erasure.post(
  '/:userId/wipe-device/:devicePubkey',
  describeRoute({
    tags: ['Erasure'],
    summary: 'Remote wipe a specific device',
    responses: {
      200: {
        description: 'Wipe command sent',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('erasure:admin'),
  validator('json', deviceWipeBodySchema),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const targetUserId = c.req.param('userId')
    const targetDevicePubkey = c.req.param('devicePubkey')

    const wsManager = getConnectionManager()
    if (wsManager) {
      wsManager.sendSignedWipeToUser(targetUserId, {
        type: 'device:wipe',
        targetDevicePubkey,
        reason: 'device-revocation',
        timestamp: new Date().toISOString(),
      })
    }

    await audit(services.audit, 'deviceWipeSent', pubkey, {
      targetUserId,
      targetDevicePubkey,
    }, undefined, c.get('hubId') ?? null)

    return c.json({ ok: true })
  },
)

erasure.get(
  '/re-encryption-jobs',
  describeRoute({
    tags: ['Erasure'],
    summary: 'List re-encryption jobs',
    responses: {
      200: {
        description: 'Re-encryption jobs list',
        content: {
          'application/json': {
            schema: resolver(reEncryptionJobListResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('erasure:admin'),
  async (c) => {
    const services = c.get('services')
    const userId = c.req.query('userId')
    const jobs = await services.erasure.listReEncryptionJobs(
      userId ?? undefined,
    )

    return c.json({
      jobs: jobs.map((j) => ({
        id: j.id,
        userId: j.userId,
        hubId: j.hubId,
        status: j.status,
        totalEnvelopes: j.totalEnvelopes,
        processedEnvelopes: j.processedEnvelopes,
        startedAt: j.startedAt?.toISOString() ?? null,
        completedAt: j.completedAt?.toISOString() ?? null,
        createdAt: j.createdAt?.toISOString() ?? '',
      })),
    })
  },
)

export default erasure
