import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '../types'
import { checkRateLimit } from '../lib/helpers'
import { hashIP, getClientIp } from '../lib/crypto'
import { verifyAuthToken, consumeAuthToken } from '../lib/auth'
import { auth as authMiddleware } from '../middleware/auth'
import { requirePermission } from '../middleware/permission-guard'
import { redeemInviteBodySchema, createInviteBodySchema, inviteResponseSchema, inviteValidationResponseSchema, inviteListResponseSchema } from '@protocol/schemas/invites'
import { okResponseSchema } from '@protocol/schemas/common'
import { publicErrors, authErrors } from '../openapi/helpers'
import { audit } from '../services/audit'
import { permissionGranted } from '@shared/permissions'
import type { Role } from '@shared/permissions'
import { createEntityRouter } from '../lib/entity-router'

const invites = new Hono<AppEnv>()

// --- Public routes (no auth) ---

invites.get('/validate/:code',
  describeRoute({
    tags: ['Invites'],
    summary: 'Validate an invite code',
    responses: {
      200: {
        description: 'Invite validation result',
        content: {
          'application/json': {
            schema: resolver(inviteValidationResponseSchema),
          },
        },
      },
      ...publicErrors,
    },
  }),
  async (c) => {
    const services = c.get('services')
    const code = c.req.param('code')
    // Rate limit invite validation to prevent enumeration
    const clientIp = getClientIp(c.req.raw)
    const limited = await checkRateLimit(services.settings, `invite-validate:${hashIP(clientIp, c.env.HMAC_SECRET)}`, 5)
    if (limited) return c.json({ error: 'Too many requests' }, 429)
    const result = await services.identity.validateInvite(code)
    return c.json(result)
  },
)

invites.post('/redeem',
  describeRoute({
    tags: ['Invites'],
    summary: 'Redeem an invite code to register',
    responses: {
      200: {
        description: 'Invite redeemed',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      ...publicErrors,
    },
  }),
  validator('json', redeemInviteBodySchema),
  async (c) => {
    const services = c.get('services')
    const body = c.req.valid('json')

    // Verify the Ed25519 auth token signature, then burn it: a redemption binds a
    // new device key to an identity, so each signed request is single-use (#1367).
    // It is consumed before the rate limit and the redemption itself, so a signed
    // request that is refused for any later reason still cannot be replayed.
    const inviteUrl = new URL(c.req.url)
    const authPayload = { pubkey: body.pubkey, timestamp: body.timestamp, token: body.token, nonce: body.nonce }
    if (!verifyAuthToken(authPayload, c.req.method, inviteUrl.pathname)) {
      return c.json({ error: 'Authentication failed' }, 401)
    }
    if (!(await consumeAuthToken(authPayload, services.identity))) {
      return c.json({ error: 'Authentication failed' }, 401)
    }

    // Rate limit redemption attempts
    const clientIp = getClientIp(c.req.raw)
    const limited = await checkRateLimit(services.settings, `invite-redeem:${hashIP(clientIp, c.env.HMAC_SECRET)}`, 5)
    if (limited) return c.json({ error: 'Too many requests' }, 429)

    const result = await services.identity.redeemInvite({ code: body.code, pubkey: body.pubkey })
    return c.json(result)
  },
)

// --- Authenticated routes (require invites permissions) ---
invites.use('/', authMiddleware, requirePermission('invites:read'))
invites.use('/:code', authMiddleware, requirePermission('invites:read'))

// GET / via factory
const inviteListRouter = createEntityRouter({
  tag: 'Invites',
  domain: 'invites',
  service: 'identity',
  listResponseSchema: inviteListResponseSchema,
  itemResponseSchema: inviteResponseSchema,
  disableGet: true,
  disableDelete: true,
  methods: {
    list: 'getInvites',
  },
})
invites.route('/', inviteListRouter)

invites.post('/',
  describeRoute({
    tags: ['Invites'],
    summary: 'Create a new invite',
    responses: {
      201: {
        description: 'Invite created',
        content: {
          'application/json': {
            schema: resolver(inviteResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('invites:create'),
  validator('json', createInviteBodySchema),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')

    // Validate that the creator can grant all requested roles (prevent privilege escalation)
    if (body.roleIds && body.roleIds.length > 0) {
      const creatorPermissions = c.get('permissions') as string[]
      if (!permissionGranted(creatorPermissions, '*')) {
        const allRoles = c.get('allRoles') as Role[]
        for (const roleId of body.roleIds) {
          const role = allRoles.find(r => r.id === roleId)
          if (!role) {
            return c.json({ error: `Unknown role: ${roleId}` }, 400)
          }
          for (const perm of role.permissions) {
            if (!permissionGranted(creatorPermissions, perm)) {
              return c.json({ error: `Cannot grant role '${role.name}' — you lack permission '${perm}'` }, 403)
            }
          }
        }
      }
    }

    const result = await services.identity.createInvite({ ...body, createdBy: pubkey })
    await audit(services.audit, 'inviteCreated', pubkey, { name: body.name }, undefined, null)
    return c.json(result, 201)
  },
)

invites.delete('/:code',
  describeRoute({
    tags: ['Invites'],
    summary: 'Revoke an invite',
    responses: {
      200: {
        description: 'Invite revoked',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('invites:revoke'),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const code = c.req.param('code')
    await services.identity.revokeInvite(code)
    await audit(services.audit, 'inviteRevoked', pubkey, { code }, undefined, null)
    return c.json({ ok: true })
  },
)

export default invites
