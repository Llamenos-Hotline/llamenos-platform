/**
 * Device registration API routes.
 *
 * GET    /api/devices         — List current user's registered devices.
 * POST   /api/devices/register — Register/update device (push token + Phase 6 crypto keys;
 *                                desktop: X25519 key only, no push token — #1548 groundwork).
 * DELETE /api/devices/:id     — Deregister a specific device (triggers PUK rotation).
 * DELETE /api/devices         — Remove all devices for current user (logout).
 */

import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '../types'
import { authErrors } from '../openapi/helpers'
import { registerDeviceBodySchema, voipTokenBodySchema, deviceDetailListResponseSchema, renameDeviceBodySchema, revokeDeviceBodySchema, verifyDeviceBodySchema, clearPushTokenBodySchema, renameDeviceResponseSchema, revokeDeviceResponseSchema, verifyDeviceResponseSchema } from '@protocol/schemas/devices'
import { requirePermission } from '../middleware/permission-guard'
import { rateLimit } from '../middleware/rate-limit'
import { classifyNtfyEndpoint, configuredOrigin, ntfyOriginPolicyFromEnv } from '../lib/ntfy-origin'
import type { Env } from '../types'

const devicesRoutes = new Hono<AppEnv>()

/**
 * #960: a UnifiedPush endpoint is later POSTed wake signals by the server. Accept it only
 * on an origin the operator configured (NTFY_URL / NTFY_PUBLIC_URL / NTFY_ALLOWED_ORIGINS),
 * otherwise a default ntfy install (public ntfy.sh) would leak who is woken, when and how often.
 * Returns an ErrorResponse (packages/protocol common.ts) or null when the endpoint is trusted.
 */
function pushEndpointRejection(env: Env, endpoint: string): { error: string; code: string } | null {
  const policy = ntfyOriginPolicyFromEnv(env)
  if (policy.own.length === 0) {
    return {
      error: 'This hotline has no push relay configured, so Android push endpoints are not accepted',
      code: 'PUSH_RELAY_NOT_CONFIGURED',
    }
  }
  if (classifyNtfyEndpoint(endpoint, policy) !== 'rejected') return null
  // Point the user at the hotline's own relay: prefer the device-facing URL over the internal one.
  const relay = configuredOrigin(env.NTFY_PUBLIC_URL) ?? policy.own[0]
  return {
    error: `Your push distributor points at a server this hotline does not trust. Set its server to ${relay}`,
    code: 'PUSH_ENDPOINT_NOT_TRUSTED',
  }
}

/**
 * GET /api/devices
 * List all registered devices for the authenticated user.
 */
devicesRoutes.get('/',
  describeRoute({
    tags: ['Devices'],
    summary: 'List registered devices',
    responses: {
      200: {
        description: 'List of registered devices',
        content: {
          'application/json': {
            schema: resolver(deviceDetailListResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  async (c) => {
    const pubkey = c.get('pubkey')
    const sessionToken = c.get('sessionToken')
    const services = c.get('services')
    const deviceList = await services.identity.listDevices(pubkey)

    // Determine which device ID belongs to the current session
    let currentDeviceId: string | null = null
    if (sessionToken) {
      const sessionInfo = await services.identity.getSessionDeviceId(sessionToken)
      currentDeviceId = sessionInfo
    }

    return c.json({
      devices: deviceList.map(d => ({
        id: d.id,
        platform: d.platform,
        deviceName: d.deviceName ?? null,
        deviceModel: d.deviceModel ?? null,
        osVersion: d.osVersion ?? null,
        appVersion: d.appVersion ?? null,
        ed25519Pubkey: d.ed25519Pubkey,
        x25519Pubkey: d.x25519Pubkey,
        registeredAt: d.registeredAt.toISOString(),
        lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
        lastIpHash: d.lastIpHash ?? null,
        isCurrent: currentDeviceId !== null && d.id === currentDeviceId,
      })),
    })
  })

/**
 * POST /api/devices/register
 * Register or update a device push token for the authenticated volunteer.
 * Also accepts Phase 6 per-device crypto keys (ed25519Pubkey, x25519Pubkey).
 */
devicesRoutes.post('/register',
  describeRoute({
    tags: ['Devices'],
    summary: 'Register or update device push token and crypto keys',
    responses: {
      204: { description: 'Device registered' },
      429: { description: 'Rate limit exceeded (5/hour)' },
      500: { description: 'Failed to register device' },
      ...authErrors,
      400: { description: 'Invalid body, or push endpoint rejected (PUSH_ENDPOINT_NOT_TRUSTED: off the configured ntfy origin; PUSH_RELAY_NOT_CONFIGURED: no ntfy broker configured)' },
    },
  }),
  validator('json', registerDeviceBodySchema),
  rateLimit('strict'),
  async (c) => {
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')
    const services = c.get('services')

    // Only URL-format tokens (UnifiedPush endpoints) are fetched by the server —
    // opaque tokens (APNs, FCM) are not URLs and never leave the vendor APIs.
    // Desktop registrations (#1548) carry no push token at all.
    if (body.pushToken && body.pushToken.includes('://')) {
      const rejection = pushEndpointRejection(c.env, body.pushToken)
      if (rejection) return c.json(rejection, 400)
    }

    await services.identity.registerDevice(pubkey, {
      platform: body.platform,
      pushToken: body.pushToken ?? null,
      wakeKeyPublic: body.wakeKeyPublic,
      ed25519Pubkey: body.ed25519Pubkey,
      x25519Pubkey: body.x25519Pubkey,
      deviceName: body.deviceName,
      deviceModel: body.deviceModel,
      osVersion: body.osVersion,
      appVersion: body.appVersion,
    })

    // Emit security event
    await services.identity.emitSecurityEvent(pubkey, 'device_register', null, {
      platform: body.platform,
    })

    return c.body(null, 204)
  })

/**
 * POST /api/devices/voip-token
 * Register a VoIP-specific push token (PushKit on iOS, FCM on Android).
 * Stored separately from regular push tokens — used for high-priority call dispatch.
 *
 * NOTE: voip-token routes MUST be registered BEFORE /:id to prevent
 * the parameterized route from intercepting literal /voip-token requests.
 */
devicesRoutes.post('/voip-token',
  describeRoute({
    tags: ['Devices'],
    summary: 'Register VoIP push token',
    responses: {
      204: { description: 'VoIP token registered' },
      500: { description: 'Failed to register VoIP token' },
      ...authErrors,
      400: { description: 'Invalid body, or push endpoint rejected (PUSH_ENDPOINT_NOT_TRUSTED / PUSH_RELAY_NOT_CONFIGURED)' },
    },
  }),
  validator('json', voipTokenBodySchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')
    const services = c.get('services')

    if (body.voipToken.includes('://')) {
      const rejection = pushEndpointRejection(c.env, body.voipToken)
      if (rejection) return c.json(rejection, 400)
    }

    await services.identity.registerVoipToken(pubkey, {
      platform: body.platform,
      voipToken: body.voipToken,
    })

    return c.body(null, 204)
  })

/**
 * DELETE /api/devices/push-token
 * Deregister a specific push endpoint by token value.
 * Called when a UnifiedPush distributor (e.g. ntfy) unregisters the device.
 *
 * NOTE: This literal route MUST be registered BEFORE /:id to prevent
 * the parameterized route from intercepting /push-token requests.
 */
devicesRoutes.delete('/push-token',
  describeRoute({
    tags: ['Devices'],
    summary: 'Deregister a push endpoint by token value',
    responses: {
      204: { description: 'Push endpoint removed (or was not registered)' },
      ...authErrors,
    },
  }),
  validator('json', clearPushTokenBodySchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const { pushToken } = c.req.valid('json')
    const services = c.get('services')
    await services.identity.cleanupDevices(pubkey, [pushToken])
    return c.body(null, 204)
  })

/**
 * DELETE /api/devices/voip-token
 * Unregister VoIP push token for the current user.
 */
devicesRoutes.delete('/voip-token',
  describeRoute({
    tags: ['Devices'],
    summary: 'Unregister VoIP push token',
    responses: {
      204: { description: 'VoIP token removed' },
      ...authErrors,
    },
  }),
  async (c) => {
    const pubkey = c.get('pubkey')
    const services = c.get('services')

    await services.identity.deleteVoipToken(pubkey)

    return c.body(null, 204)
  })

/**
 * PATCH /api/devices/:id
 * Rename a device. Only the device owner can rename their own devices.
 */
devicesRoutes.patch('/:id',
  describeRoute({
    tags: ['Devices'],
    summary: 'Rename a device',
    responses: {
      200: {
        description: 'Device renamed',
        content: { 'application/json': { schema: resolver(renameDeviceResponseSchema) } },
      },
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
      ...authErrors,
      200: {
        description: 'Device revoked, hub key rotation needed',
        content: { 'application/json': { schema: resolver(revokeDeviceResponseSchema) } },
      },
      400: { description: 'Confirmation required' },
      404: { description: 'Device not found or not owned by caller' },
      429: { description: 'Rate limit exceeded (3/hour)' },
    },
  }),
  validator('json', revokeDeviceBodySchema),
  rateLimit('strict'),
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
      pukRotationNeeded: result.pukRotationNeeded,
    })
  })

/**
 * POST /api/devices/:id/verify
 * Store SAS emoji verification result. Admin only (users:manage-devices).
 */
devicesRoutes.post('/:id/verify',
  describeRoute({
    tags: ['Devices'],
    summary: 'Record SAS verification of a device',
    responses: {
      200: {
        description: 'Verification recorded',
        content: { 'application/json': { schema: resolver(verifyDeviceResponseSchema) } },
      },
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

/**
 * DELETE /api/devices/:id
 * Deregister a specific device. Device must belong to the authenticated user.
 * Callers should trigger PUK rotation after deregistering a device.
 *
 * NOTE: This parameterized route MUST come after literal routes
 * (like /voip-token) to prevent it from capturing their paths.
 */
devicesRoutes.delete('/:id',
  describeRoute({
    tags: ['Devices'],
    summary: 'Deregister a specific device',
    responses: {
      204: { description: 'Device deregistered' },
      404: { description: 'Device not found or not owned by caller' },
      ...authErrors,
    },
  }),
  async (c) => {
    const pubkey = c.get('pubkey')
    const deviceId = c.req.param('id')
    const services = c.get('services')

    const deleted = await services.identity.deleteDeviceById(pubkey, deviceId)
    if (!deleted) return c.json({ error: 'Device not found' }, 404)
    return c.body(null, 204)
  })

/**
 * DELETE /api/devices
 * Remove all registered devices for the current user (called on logout).
 */
devicesRoutes.delete('/',
  describeRoute({
    tags: ['Devices'],
    summary: 'Remove all registered devices',
    responses: {
      204: { description: 'All devices removed' },
      ...authErrors,
    },
  }),
  async (c) => {
    const pubkey = c.get('pubkey')
    const services = c.get('services')

    await services.identity.deleteAllDevices(pubkey)

    return c.body(null, 204)
  })

export default devicesRoutes
