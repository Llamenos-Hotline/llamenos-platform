/**
 * MLS (Message Layer Security) message routing routes — Phase 6, hub-scoped.
 *
 * POST /api/hubs/:hubId/mls/commit       — Fan-out a Commit to all group members.
 * POST /api/hubs/:hubId/mls/welcome      — Deliver a Welcome to a new member device.
 * GET  /api/hubs/:hubId/mls/messages     — Fetch pending MLS messages for this device.
 * POST /api/hubs/:hubId/mls/key-packages — Upload MLS KeyPackages for this device.
 */
import { Hono } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import { validator } from '../openapi/validator'
import { z } from 'zod'
import type { AppEnv } from '../types'
import { authErrors } from '../openapi/helpers'

const mlsRoutes = new Hono<AppEnv>()

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

/** Opaque MLS message payload — TLS-serialised MLSMessage, base64url. */
const mlsPayloadSchema = z.string().min(1, 'payload must not be empty')

const mlsMessageSchema = z.object({
  id: z.string(),
  hubId: z.string(),
  recipientDeviceId: z.string(),
  messageType: z.string(),
  payload: z.unknown(),
  createdAt: z.string(),
})

const mlsMessagesResponseSchema = z.object({
  messages: z.array(mlsMessageSchema),
})

const commitBodySchema = z.object({
  /**
   * Device IDs of all current group members who must receive this Commit.
   * Caller is responsible for enumerating the group membership.
   */
  recipientDeviceIds: z.array(z.string()).min(1),
  /** TLS-serialised MLSMessage (Commit), base64url-encoded. */
  payload: mlsPayloadSchema,
})

const welcomeBodySchema = z.object({
  /** Device ID of the new group member receiving the Welcome. */
  recipientDeviceId: z.string().min(1),
  /** TLS-serialised MLSMessage (Welcome), base64url-encoded. */
  payload: mlsPayloadSchema,
})

const keyPackagesBodySchema = z.object({
  /**
   * One or more TLS-serialised KeyPackages (base64url-encoded).
   * Each KeyPackage is stored as a separate pending message of type 'key_package'.
   */
  keyPackages: z.array(mlsPayloadSchema).min(1),
})

// ---------------------------------------------------------------------------
// POST /mls/commit  (fan-out Commit to group members)
// ---------------------------------------------------------------------------

mlsRoutes.post('/commit',
  describeRoute({
    tags: ['MLS'],
    summary: 'Fan-out MLS Commit to group members',
    description: [
      'Queues a Commit message for delivery to each listed recipient device.',
      'The caller (committer) MUST be a member of the hub.',
      'Recipients fetch their messages via GET /mls/messages.',
    ].join(' '),
    responses: {
      204: { description: 'Commit queued for all recipients' },
      ...authErrors,
    },
  }),
  validator('json', commitBodySchema),
  async (c) => {
    const hubId = c.req.param('hubId') ?? c.get('hubId') ?? ''
    const body = c.req.valid('json')
    const services = c.get('services')

    // Validate all recipient device IDs belong to active hub members
    const hubDeviceIds = await services.identity.getHubMemberDeviceIds(hubId)
    const invalidIds = body.recipientDeviceIds.filter(id => !hubDeviceIds.has(id))
    if (invalidIds.length > 0) {
      return c.json({ error: 'One or more recipient devices are not active hub members' }, 403)
    }

    await services.cryptoKeys.enqueueMlsMessages(
      hubId,
      body.recipientDeviceIds.map(deviceId => ({
        recipientDeviceId: deviceId,
        messageType: 'commit',
        payload: body.payload,
      })),
    )

    return c.body(null, 204)
  },
)

// ---------------------------------------------------------------------------
// POST /mls/welcome  (point-to-point Welcome)
// ---------------------------------------------------------------------------

mlsRoutes.post('/welcome',
  describeRoute({
    tags: ['MLS'],
    summary: 'Deliver MLS Welcome to a new member device',
    description: [
      'Queues a Welcome message for a single new group member.',
      'The Welcome is only readable by the recipient device\'s private key.',
    ].join(' '),
    responses: {
      204: { description: 'Welcome queued for delivery' },
      ...authErrors,
    },
  }),
  validator('json', welcomeBodySchema),
  async (c) => {
    const hubId = c.req.param('hubId') ?? c.get('hubId') ?? ''
    const body = c.req.valid('json')
    const services = c.get('services')

    // Validate recipient device belongs to an active hub member
    const hubDeviceIds = await services.identity.getHubMemberDeviceIds(hubId)
    if (!hubDeviceIds.has(body.recipientDeviceId)) {
      return c.json({ error: 'Recipient device is not an active hub member' }, 403)
    }

    await services.cryptoKeys.enqueueMlsMessages(hubId, [
      {
        recipientDeviceId: body.recipientDeviceId,
        messageType: 'welcome',
        payload: body.payload,
      },
    ])

    return c.body(null, 204)
  },
)

// ---------------------------------------------------------------------------
// GET /mls/messages  (fetch pending messages for caller's device)
// ---------------------------------------------------------------------------

mlsRoutes.get('/messages',
  describeRoute({
    tags: ['MLS'],
    summary: 'Fetch pending MLS messages for this device',
    description: [
      'Returns all pending MLS handshake messages (Commits, Welcomes, Proposals)',
      'addressed to the caller\'s device in this hub.',
      'Messages are deleted after retrieval (fetch-and-clear semantics).',
      'The device ID is passed as a query parameter.',
    ].join(' '),
    responses: {
      200: {
        description: 'Pending MLS messages',
        content: {
          'application/json': {
            schema: resolver(mlsMessagesResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  async (c) => {
    const hubId = c.req.param('hubId') ?? c.get('hubId') ?? ''
    const deviceId = c.req.query('deviceId')

    if (!deviceId) {
      return c.json({ error: 'deviceId query parameter is required' }, 400)
    }

    const callerPubkey = c.get('pubkey')
    const services = c.get('services')

    // Verify the requested device belongs to the authenticated user
    const isOwner = await services.identity.verifyDeviceOwnership(callerPubkey, deviceId)
    if (!isOwner) {
      return c.json({ error: 'Device does not belong to the authenticated user' }, 403)
    }

    const messages = await services.cryptoKeys.fetchAndClearMlsMessages(hubId, deviceId)
    return c.json({ messages })
  },
)

// ---------------------------------------------------------------------------
// POST /mls/key-packages  (upload KeyPackages)
// ---------------------------------------------------------------------------

mlsRoutes.post('/key-packages',
  describeRoute({
    tags: ['MLS'],
    summary: 'Upload MLS KeyPackages for this device',
    description: [
      'A device uploads its pre-generated KeyPackages so that group members',
      'can retrieve them when adding the device to a group via a Welcome.',
    ].join(' '),
    responses: {
      204: { description: 'KeyPackages stored' },
      ...authErrors,
    },
  }),
  validator('json', keyPackagesBodySchema),
  async (c) => {
    const hubId = c.req.param('hubId') ?? c.get('hubId') ?? ''
    const callerPubkey = c.get('pubkey')
    const body = c.req.valid('json')
    const services = c.get('services')

    const deviceIdParam = c.req.query('deviceId')
    if (!deviceIdParam) {
      return c.json({ error: 'deviceId query parameter is required' }, 400)
    }

    // Verify the device belongs to the authenticated user
    const isOwner = await services.identity.verifyDeviceOwnership(callerPubkey, deviceIdParam)
    if (!isOwner) {
      return c.json({ error: 'Device does not belong to the authenticated user' }, 403)
    }

    for (const pkg of body.keyPackages) {
      await services.cryptoKeys.uploadKeyPackage(hubId, deviceIdParam, pkg)
    }

    return c.body(null, 204)
  },
)

export default mlsRoutes
