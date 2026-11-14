import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '../types'
import { isValidE164 } from '../lib/helpers'
import { requirePermission } from '../middleware/permission-guard'
import { okResponseSchema } from '@protocol/schemas/common'
import { createBanBodySchema, createBanResponseSchema, bulkBanBodySchema, banListResponseSchema, bulkBanResponseSchema } from '@protocol/schemas/bans'
import { authErrors, notFoundError } from '../openapi/helpers'
import { audit } from '../services/audit'
import { banHash } from '../lib/crypto'
import { hubOnly, pathHubId } from '../lib/hub-scope'
import { hubScope } from '@shared/owner-scope'

const bans = new Hono<AppEnv>()

// A hub's ban list. This router is mounted only under /hubs/:hubId, and every
// handler states the hub scope. The platform list is a different resource with
// its own permissions (`bans:*-platform`), served by routes/platform-bans.ts.
// It used to be reachable here as "the same router with no hub", gated only by
// the hub permissions. A missing hub never means "platform" (#2463).
bans.use('*', hubOnly)

bans.get('/',
  describeRoute({
    tags: ['Bans'],
    summary: "List the hub's bans",
    responses: {
      200: {
        description: 'Ban list',
        content: {
          'application/json': {
            schema: resolver(banListResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('bans:read'),
  async (c) => {
    const services = c.get('services')
    return c.json(await services.records.listBans(hubScope(pathHubId(c))))
  },
)

// MED-W2: Only admins (bans:create) can ban numbers — not volunteers (bans:report)
bans.post('/',
  describeRoute({
    tags: ['Bans'],
    summary: 'Ban a phone number',
    responses: {
      200: {
        description: 'Number banned',
        content: {
          'application/json': {
            schema: resolver(createBanResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('bans:create'),
  validator('json', createBanBodySchema),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const hubId = pathHubId(c)
    const scope = hubScope(hubId)
    const body = c.req.valid('json')
    if (!isValidE164(body.phone)) {
      return c.json({ error: 'Invalid phone number. Use E.164 format (e.g. +12125551234)' }, 400)
    }
    // Never store the number or any digits of it: only the scope-keyed hash that ban matching needs.
    const phoneHash = banHash(body.phone, scope, c.env.BAN_HASH_KEY)
    const ban = await services.records.addBan({
      scope,
      phoneHash,
      reason: body.reason ?? '',
      bannedBy: pubkey,
    })
    await audit(services.audit, 'numberBanned', pubkey, { phoneHash }, undefined, hubId)
    return c.json({ ban: { phoneHash: ban.phone, reason: ban.reason, bannedBy: ban.bannedBy, bannedAt: ban.bannedAt } })
  },
)

bans.post('/bulk',
  describeRoute({
    tags: ['Bans'],
    summary: 'Bulk ban phone numbers',
    responses: {
      200: {
        description: 'Numbers banned',
        content: {
          'application/json': {
            schema: resolver(bulkBanResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('bans:bulk-create'),
  validator('json', bulkBanBodySchema),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const hubId = pathHubId(c)
    const scope = hubScope(hubId)
    const body = c.req.valid('json')
    const invalidPhones = body.phones.filter(p => !isValidE164(p))
    if (invalidPhones.length > 0) {
      return c.json({ error: `Invalid phone number(s): ${invalidPhones[0]}. Use E.164 format (e.g. +12125551234)` }, 400)
    }
    const phoneHashes = body.phones.map(p => banHash(p, scope, c.env.BAN_HASH_KEY))
    const added = await services.records.bulkAddBans(scope, phoneHashes, body.reason ?? '', pubkey)
    await audit(services.audit, 'numberBanned', pubkey, { count: body.phones.length, bulk: true }, undefined, hubId)
    return c.json({ count: added })
  },
)

bans.delete('/:phoneHash',
  describeRoute({
    tags: ['Bans'],
    summary: 'Unban a phone number by the hash handle from the ban list',
    responses: {
      200: {
        description: 'Number unbanned',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('bans:delete'),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const hubId = pathHubId(c)
    const phoneHash = c.req.param('phoneHash')
    // Only the opaque handle from the ban list: a raw number in the path would land in
    // access logs and proxy logs, and the client has no key to compute a hash itself.
    if (!/^[0-9a-f]{64}$/i.test(phoneHash)) {
      return c.json({ error: 'Invalid ban handle' }, 400)
    }
    // Lifting a ban re-admits a caller the hub deliberately excluded, so the audit entry
    // names the same handle `numberBanned` recorded: an admin reading the log can pair
    // the unban with the ban it undid (#2575). Nothing lifted, nothing recorded.
    const removed = await services.records.removeBan(hubScope(hubId), phoneHash)
    if (!removed) {
      return c.json({ error: 'Ban not found' }, 404)
    }
    await audit(services.audit, 'numberUnbanned', pubkey, { phoneHash }, undefined, hubId)
    return c.json({ ok: true })
  },
)

export default bans
