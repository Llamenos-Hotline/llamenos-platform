import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '../types'
import { isValidE164 } from '../lib/helpers'
import { requirePermission } from '../middleware/permission-guard'
import { okResponseSchema } from '@protocol/schemas/common'
import { createBanBodySchema, bulkBanBodySchema, banListResponseSchema, bulkBanResponseSchema } from '@protocol/schemas/bans'
import { authErrors } from '../openapi/helpers'
import { audit } from '../services/audit'
import { createEntityRouter } from '../lib/entity-router'
import { banHash, PLATFORM_BAN_SCOPE } from '../lib/crypto'

const bans = new Hono<AppEnv>()

// A ban lives in the scope of the hub the request is made against; a request with no
// hub context addresses the platform list (hub_id NULL), and its hashes use that key.
const scopeOf = (hubId: string | undefined): string => hubId || PLATFORM_BAN_SCOPE

// GET / via factory
const banListRouter = createEntityRouter({
  tag: 'Bans',
  domain: 'bans',
  service: 'records',
  listResponseSchema: banListResponseSchema,
  itemResponseSchema: banListResponseSchema,
  hubScoped: true,
  disableGet: true,
  disableDelete: true,
  methods: {
    list: 'listBans',
  },
})
bans.route('/', banListRouter)

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
            schema: resolver(okResponseSchema),
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
    const hubId = c.get('hubId')
    const body = c.req.valid('json')
    if (!isValidE164(body.phone)) {
      return c.json({ error: 'Invalid phone number. Use E.164 format (e.g. +12125551234)' }, 400)
    }
    // Never store the number or any digits of it: only the scope-keyed hash that ban matching needs.
    const phoneHash = banHash(body.phone, scopeOf(hubId), c.env.BAN_HASH_KEY)
    const ban = await services.records.addBan({
      hubId,
      phoneHash,
      reason: body.reason ?? '',
      bannedBy: pubkey,
    })
    await audit(services.audit, 'numberBanned', pubkey, { phoneHash }, undefined, hubId ?? null)
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
    const hubId = c.get('hubId')
    const body = c.req.valid('json')
    const invalidPhones = body.phones.filter(p => !isValidE164(p))
    if (invalidPhones.length > 0) {
      return c.json({ error: `Invalid phone number(s): ${invalidPhones[0]}. Use E.164 format (e.g. +12125551234)` }, 400)
    }
    const scope = scopeOf(hubId)
    const phoneHashes = body.phones.map(p => banHash(p, scope, c.env.BAN_HASH_KEY))
    const added = await services.records.bulkAddBans(phoneHashes, body.reason ?? '', pubkey, hubId)
    await audit(services.audit, 'numberBanned', pubkey, { count: body.phones.length, bulk: true }, undefined, hubId ?? null)
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
    },
  }),
  requirePermission('bans:delete'),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const hubId = c.get('hubId')
    const phoneHash = c.req.param('phoneHash')
    // Only the opaque handle from the ban list: a raw number in the path would land in
    // access logs and proxy logs, and the client has no key to compute a hash itself.
    if (!/^[0-9a-f]{64}$/i.test(phoneHash)) {
      return c.json({ error: 'Invalid ban handle' }, 400)
    }
    await services.records.removeBan(phoneHash, hubId)
    await audit(services.audit, 'numberUnbanned', pubkey, {}, undefined, hubId ?? null)
    return c.json({ ok: true })
  },
)

export default bans
