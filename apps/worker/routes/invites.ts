import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '../types'
import { checkRateLimit } from '../lib/helpers'
import { routeRateLimitClient } from '../lib/route-rate-limit'
import { verifyAuthToken, consumeAuthToken } from '../lib/auth'
import { auth as authMiddleware } from '../middleware/auth'
import { redeemInviteBodySchema, createInviteBodySchema, inviteResponseSchema, inviteValidationResponseSchema, inviteListResponseSchema } from '@protocol/schemas/invites'
import { okResponseSchema } from '@protocol/schemas/common'
import { publicErrors, authErrors } from '../openapi/helpers'
import { audit } from '../services/audit'
import { permissionGranted, resolveHubPermissions } from '@shared/permissions'
import type { Role } from '@shared/permissions'
import { hubsWithPermission } from '../lib/hub-scope'
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
    const limited = await checkRateLimit(services.settings, `invite-validate:${routeRateLimitClient(c)}`, 5)
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
    //
    // `nonce` is optional in `redeemInviteBodySchema`. A client that sends none
    // signed the nonce-less message shape — a distinct domain-separation label
    // (`LABEL_DEVICE_AUTH_NO_NONCE`, #1509), which is what makes that token
    // useless against any other endpoint; this is the only route that opts into
    // the nonce-less domain, and everywhere else a missing nonce is a hard
    // rejection. A client that sends a nonce verifies in the canonical
    // nonce-ful domain instead. Either way the verified token is consumed
    // exactly once below.
    const inviteUrl = new URL(c.req.url)
    const authPayload = { pubkey: body.pubkey, timestamp: body.timestamp, token: body.token, nonce: body.nonce }
    const isValid = verifyAuthToken(
      authPayload,
      c.req.method,
      inviteUrl.pathname,
      { allowMissingNonce: true },
    )
    if (!isValid) {
      return c.json({ error: 'Authentication failed' }, 401)
    }
    if (!(await consumeAuthToken(authPayload, services.identity))) {
      return c.json({ error: 'Authentication failed' }, 401)
    }

    // Rate limit redemption attempts
    const limited = await checkRateLimit(services.settings, `invite-redeem:${routeRateLimitClient(c)}`, 5)
    if (limited) return c.json({ error: 'Too many requests' }, 429)

    const result = await services.identity.redeemInvite({ code: body.code, pubkey: body.pubkey })
    return c.json(result)
  },
)

// --- Authenticated routes (require invites permissions) ---
//
// Authority over invites is per hub: an invite belongs to the hub it admits into,
// and a hub admin's grant lives in `hubRoles` only (#2153), so the global
// permission set of the request says nothing about it. Each handler checks the
// caller's permission in the invite's hub; a super-admin holds it in every hub.
invites.use('/', authMiddleware)
invites.use('/:code', authMiddleware)

invites.get('/',
  describeRoute({
    tags: ['Invites'],
    summary: 'List invites',
    responses: {
      200: {
        description: 'Unused invites in the hubs the caller may read invites in',
        content: { 'application/json': { schema: resolver(inviteListResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  async (c) => {
    const identity = c.get('services').identity
    // A super-admin sees every invite, including one that names no hub yet;
    // anyone else sees the invites of the hubs they may read them in.
    const hubIds = hubsWithPermission(c, 'invites:read')
    if (hubIds === null) return c.json(await identity.getInvites())
    if (hubIds.length === 0) return c.json({ error: 'Forbidden', required: 'invites:read' }, 403)
    const perHub = await Promise.all(hubIds.map(hubId => identity.getInvites(hubId)))
    return c.json({ invites: perHub.flatMap(r => r.invites) })
  },
)

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

    // The authority the creator invites with: their permissions IN the invite's
    // hub — a hub admin's grant lives in `hubRoles` only, and a super-admin holds
    // everything in every hub. An invite that predates any hub (the setup
    // wizard) has no hub to resolve in, so only an instance-level caller —
    // global permissions, i.e. a super-admin — may mint one.
    let creatorPermissions = c.get('permissions') as string[]

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
      creatorPermissions = hubPermissions
    } else if (!permissionGranted(creatorPermissions, 'invites:create')) {
      return c.json({ error: 'Forbidden', required: 'invites:create' }, 403)
    }

    // Roles the redeemer gets. The inviter's explicit choice wins; otherwise
    // the hub's template decides, and a template naming none grants none.
    const requested = body.roleIds ?? []
    const roleIds = requested.length > 0 || !hubId
      ? requested
      : await resolveHubDefaultMemberRoles(services.settings, hubId)

    // Validate that the creator can grant all requested roles (prevent privilege escalation)
    if (roleIds.length > 0) {
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
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const code = c.req.param('code')
    // A super-admin may revoke any invite. Anyone else may revoke an invite of a
    // hub they hold invites:revoke in — and an invite of another hub is a 404,
    // exactly as if it did not exist.
    const hubIds = hubsWithPermission(c, 'invites:revoke')
    if (hubIds === null) {
      await services.identity.revokeInvite(code)
    } else {
      if (hubIds.length === 0) return c.json({ error: 'Forbidden', required: 'invites:revoke' }, 403)
      let revoked = false
      for (const hubId of hubIds) {
        try {
          await services.identity.revokeInvite(code, hubId)
          revoked = true
          break
        } catch (err) {
          if (!(err instanceof ServiceError && err.status === 404)) throw err
        }
      }
      if (!revoked) throw new ServiceError(404, 'Invite not found')
    }
    await audit(services.audit, 'inviteRevoked', pubkey, { code }, undefined, null)
    return c.json({ ok: true })
  },
)

export default invites
