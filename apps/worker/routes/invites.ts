import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '../types'
import { checkRateLimit } from '../lib/helpers'
import { hashIP, getClientIp } from '../lib/crypto'
import { verifyAuthToken } from '../lib/auth'
import { auth as authMiddleware } from '../middleware/auth'
import { requirePermission } from '../middleware/permission-guard'
import { redeemInviteBodySchema, createInviteBodySchema, inviteResponseSchema, inviteValidationResponseSchema, inviteListResponseSchema } from '@protocol/schemas/invites'
import { okResponseSchema } from '@protocol/schemas/common'
import { publicErrors, authErrors } from '../openapi/helpers'
import { audit } from '../services/audit'
import { permissionGranted, resolveHubPermissions } from '@shared/permissions'
import type { Role } from '@shared/permissions'
import { createEntityRouter } from '../lib/entity-router'
import { resolveHubDefaultMemberRoles } from '../lib/hub-default-role'
import { ServiceError } from '../services/settings'

const invites = new Hono<AppEnv>()

/**
 * The hub an invite admits into when the client did not name one.
 *
 * `'ambiguous'` means there is a real choice to make and the caller has to
 * make it; `null` means there is nothing to choose from yet. Nothing here
 * guesses: admitting a volunteer into a hub nobody chose is the failure #1037
 * is about.
 *
 *  - exactly one active hub — the R1 shape, and the same rule `GET /api/config`
 *    uses for `defaultHubId`
 *  - several, but the creator belongs to exactly one of them
 *  - NO active hub yet: the setup wizard invites a volunteer at step 5 and
 *    creates the hub at step 6, so the invite legitimately predates its hub.
 *    It is stored without one and `redeemInvite` resolves it at redemption,
 *    by which time the wizard has finished.
 *  - otherwise ambiguous
 */
async function resolveInviteHubId(
  services: { settings: { getHubs(): Promise<{ hubs: Array<{ id: string; status: string }> }> } },
  user: { hubRoles?: Array<{ hubId: string }> },
): Promise<string | null | 'ambiguous'> {
  const { hubs } = await services.settings.getHubs()
  const active = hubs.filter(h => h.status === 'active')
  if (active.length === 0) return null
  if (active.length === 1) return active[0].id

  const memberships = [...new Set((user.hubRoles ?? []).map(hr => hr.hubId))]
    .filter(id => active.some(h => h.id === id))
  return memberships.length === 1 ? memberships[0] : 'ambiguous'
}

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

    // Verify Ed25519 auth token signature
    const inviteUrl = new URL(c.req.url)
    const isValid = await verifyAuthToken({ pubkey: body.pubkey, timestamp: body.timestamp, token: body.token }, c.req.method, inviteUrl.pathname)
    if (!isValid) {
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
    const user = c.get('user')
    const allRoles = c.get('allRoles') as Role[]

    // Every invite names a hub. Without one, redemption produced a user with
    // no hub membership — invisible to the operator, unschedulable, unrungable
    // (#1037). This route is not mounted under /hubs/:hubId, and the desktop
    // dialog does not yet send a hub, so resolve it here and refuse rather
    // than mint a hub-less invite.
    const resolved = body.hubId ?? await resolveInviteHubId(services, user)
    if (resolved === 'ambiguous') {
      return c.json({
        error: 'hubId is required: this server has several hubs and none is implied by your membership',
      }, 400)
    }
    const hubId: string | null = resolved

    // The hub must exist, and the creator must be able to invite within it.
    if (hubId) {
      try {
        await services.settings.getHub(hubId)
      } catch (err) {
        if (err instanceof ServiceError && err.status === 404) {
          return c.json({ error: 'Hub not found' }, 404)
        }
        throw err
      }
      const hubPermissions = resolveHubPermissions(user.roles, user.hubRoles ?? [], allRoles, hubId)
      if (!permissionGranted(hubPermissions, 'invites:create')) {
        return c.json({ error: 'Access denied' }, 403)
      }
    }

    // Roles the redeemer gets. The inviter's explicit choice wins; otherwise
    // the hub's template decides, and a template naming none grants none.
    const requested = body.roleIds ?? []
    const roleIds = requested.length > 0 || !hubId
      ? requested
      : await resolveHubDefaultMemberRoles(services.settings, hubId)

    // Validate that the creator can grant all requested roles (prevent privilege escalation)
    if (roleIds.length > 0) {
      const creatorPermissions = c.get('permissions') as string[]
      if (!permissionGranted(creatorPermissions, '*')) {
        for (const roleId of roleIds) {
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

    const result = await services.identity.createInvite({
      name: body.name,
      phone: body.phone,
      roleIds,
      hubId,
      createdBy: pubkey,
    })

    await audit(services.audit, 'inviteCreated', pubkey, { name: body.name, hubId }, undefined, null)
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
