import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '../types'
import { auth } from '../middleware/auth'
import { rateLimit } from '../middleware/rate-limit'
import { publicErrors, authErrors } from '../openapi/helpers'
import { ServiceError } from '../services/settings'
import { createLogger } from '../lib/logger'
import { okResponseSchema } from '@protocol/schemas/common'
import { createRoomBodySchema, roomPayloadBodySchema, provisionRoomResponseSchema, provisionRoomStatusResponseSchema } from '@protocol/schemas/provisioning'

const log = createLogger('provisioning')

const provisioning = new Hono<AppEnv>()

/**
 * Device provisioning relay — enables Signal-style device linking.
 *
 * Protocol:
 * 1. New device: POST /rooms → creates room with ephemeral pubkey
 * 2. New device: displays QR/code with { roomId, token }
 * 3. Primary device (authenticated): POST /rooms/:id/payload → sends encrypted nsec
 * 4. New device: GET /rooms/:id → polls for encrypted payload
 */

// Per-room brute-force protection (#1789): only FAILED token presentations
// count. A conforming poller presenting the correct token is never charged,
// so the specified poll-until-ready flow cannot exhaust the budget, while
// grinding the 128-bit token locks the room after 3 wrong guesses. Keyed by
// room (not IP): an attacker rotating IPs is still bounded, and the two
// devices of a link flow behind one NAT do not share a failure budget.
const PROVISION_ROOM_MAX_FAILURES = 3
const PROVISION_ROOM_WINDOW_MS = 10 * 60 * 1000

// Create provisioning room (public — new device has no auth yet)
provisioning.post('/rooms',
  describeRoute({
    tags: ['Provisioning'],
    summary: 'Create a device provisioning room',
    responses: {
      200: {
        description: 'Room created with ID and token',
        content: {
          'application/json': {
            schema: resolver(provisionRoomResponseSchema),
          },
        },
      },
      429: { description: 'Rate limit exceeded' },
      ...publicErrors,
    },
  }),
  rateLimit('strict'),
  validator('json', createRoomBodySchema),
  async (c) => {
    const services = c.get('services')
    const body = c.req.valid('json')
    const result = await services.identity.createProvisionRoom(body.ephemeralPubkey)
    return c.json(result)
  })

// Get room status (public — the new device polls this on a 1–2s interval, so
// it mounts the `poll` tier, not the auth-endpoint `strict` tier: #1789)
provisioning.get('/rooms/:id',
  describeRoute({
    tags: ['Provisioning'],
    summary: 'Poll provisioning room status',
    responses: {
      ...publicErrors,
      200: {
        description: 'Room status and optional encrypted payload',
        content: {
          'application/json': {
            schema: resolver(provisionRoomStatusResponseSchema),
          },
        },
      },
      400: { description: 'Missing token' },
      429: { description: 'Rate limited' },
    },
  }),
  rateLimit('poll'),
  async (c) => {
    const services = c.get('services')
    const id = c.req.param('id')
    const token = c.req.query('token')
    if (!token) return c.json({ error: 'Missing token' }, 400)

    const failureKey = `provision:room-failures:${id}`

    // Peek (no increment): a room under active grinding short-circuits here,
    // before any room lookup. Fail open on store errors — rate limiting is
    // defense-in-depth, matching the tier middleware's failure policy.
    try {
      const peek = await services.settings.peekApiRateLimit(
        failureKey,
        PROVISION_ROOM_MAX_FAILURES,
        PROVISION_ROOM_WINDOW_MS,
      )
      if (peek.limited) {
        c.header('Retry-After', String(peek.retryAfterSeconds))
        return c.json({ error: 'Rate limited' }, 429)
      }
    } catch (err) {
      log.error('Per-room rate limit peek failed, allowing request', { error: String(err) })
    }

    try {
      const result = await services.identity.getProvisionRoom(id, token)
      return c.json(result)
    } catch (err) {
      // Only a wrong token on an existing room consumes the brute-force
      // budget. 404s (consumed/expired/unknown room) and validation errors
      // are not guesses at the token and never count.
      if (err instanceof ServiceError && err.status === 403) {
        try {
          await services.settings.checkApiRateLimit(
            failureKey,
            PROVISION_ROOM_MAX_FAILURES,
            PROVISION_ROOM_WINDOW_MS,
          )
        } catch (limitErr) {
          log.error('Per-room failure counter increment failed', { error: String(limitErr) })
        }
      }
      throw err
    }
  })

// Send encrypted payload (authenticated — primary device)
provisioning.post('/rooms/:id/payload', auth, rateLimit('write'),
  describeRoute({
    tags: ['Provisioning'],
    summary: 'Send encrypted provisioning payload to room',
    responses: {
      200: {
        description: 'Payload delivered',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      429: { description: 'Rate limit exceeded' },
      ...authErrors,
    },
  }),
  validator('json', roomPayloadBodySchema),
  async (c) => {
    const services = c.get('services')
    const id = c.req.param('id')
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')
    await services.identity.setProvisionPayload(id, { ...body, senderPubkey: pubkey })
    return c.json({ ok: true })
  })

export default provisioning
