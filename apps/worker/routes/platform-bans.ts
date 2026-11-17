import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '../types'
import { requirePermission } from '../middleware/permission-guard'
import { okResponseSchema } from '@protocol/schemas/common'
import {
  createPlatformBanBodySchema,
  bulkPlatformBanBodySchema,
  platformBanListResponseSchema,
  searchBansResponseSchema,
  promoteBanBodySchema,
  banDigestEvaluateBodySchema,
  banDigestEvaluateResponseSchema,
  searchBansEvaluateBodySchema,
  searchBansEvaluateResponseSchema,
  searchBansBodySchema,
} from '@protocol/schemas/bans'
import { authErrors } from '../openapi/helpers'
import { audit } from '../services/audit'
import { banBlindEvaluate } from '../lib/crypto'
import { scopeOfRow } from '../lib/owner-scope'
import { checkRateLimit } from '../lib/helpers'
import { hubScope, PLATFORM_SCOPE, type OwnerScope } from '@shared/owner-scope'

/**
 * Platform bans never see a number (#2759). Every body here carries ban digests that an
 * admin's client computed from the number it was given, by blinding it and asking
 * `/evaluate` (or `/search/evaluate`) to evaluate the blinded element under the scope's key —
 * RFC 9497 OPRF, `packages/crypto/src/ban_digest.rs`. The server holds the key, so it matches an
 * inbound caller's number against the same digest; no client holds it, so no one with the
 * stored column but not BAN_HASH_KEY can enumerate the numbers behind it.
 */
const platformBans = new Hono<AppEnv>()

/**
 * The evaluate endpoints are the one way to learn a number's digest, so they are what stands
 * between an admin account and an enumeration of the ban list: one online request per batch,
 * per admin, rate-limited and audited. Offline enumeration needs BAN_HASH_KEY, which no client
 * ever holds. `BAN_EVALUATIONS_PER_MINUTE` x 100 elements bounds what one account can test.
 */
const BAN_EVALUATIONS_PER_MINUTE = 10

/**
 * A blinded element that is not a valid ristretto255 encoding fails evaluation. That is the
 * client's malformed input, not a server fault, so it answers 400.
 */
function evaluateOrNull(evaluate: () => string): string | null {
  try {
    return evaluate()
  } catch {
    return null
  }
}

platformBans.post(
  '/evaluate',
  describeRoute({
    tags: ['Platform Bans'],
    summary: 'Evaluate blinded numbers under the platform ban key (oblivious; the number is never sent)',
    responses: {
      200: {
        description: 'Evaluated elements, in request order',
        content: {
          'application/json': {
            schema: resolver(banDigestEvaluateResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('bans:create-platform'),
  validator('json', banDigestEvaluateBodySchema),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')
    if (await checkRateLimit(services.settings, `ban-evaluate:${pubkey}`, BAN_EVALUATIONS_PER_MINUTE)) {
      return c.json({ error: 'Too many ban evaluations. Try again in a minute.' }, 429)
    }
    const evaluatedElements: string[] = []
    for (const blinded of body.blindedElements) {
      const evaluated = evaluateOrNull(() => banBlindEvaluate(blinded, PLATFORM_SCOPE, c.env.BAN_HASH_KEY))
      if (evaluated === null) return c.json({ error: 'Invalid blinded element' }, 400)
      evaluatedElements.push(evaluated)
    }
    await audit(services.audit, 'platformBanDigestsEvaluated', pubkey, {
      count: evaluatedElements.length,
    }, undefined, null)
    return c.json({ evaluatedElements })
  },
)

platformBans.get(
  '/',
  describeRoute({
    tags: ['Platform Bans'],
    summary: 'List platform-scoped bans',
    responses: {
      200: {
        description: 'Platform bans list',
        content: {
          'application/json': {
            schema: resolver(platformBanListResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('bans:read-platform'),
  async (c) => {
    const services = c.get('services')
    const limit = Math.max(1, Math.min(Number(c.req.query('limit') ?? 50) || 50, 200))
    const offset = Math.max(0, Number(c.req.query('offset') ?? 0) || 0)

    const [{ bans: rows, total }, reentries] = await Promise.all([
      services.records.listPlatformBans(limit, offset),
      // Bans that stopped enforcing and must be entered again (#2829) — shown, never silent.
      services.records.listBanReentries(PLATFORM_SCOPE),
    ])

    return c.json({
      bans: rows.map((b) => ({
        id: b.id,
        phoneHash: b.phone,
        reason: b.reason,
        bannedBy: b.bannedBy,
        bannedAt: b.bannedAt?.toISOString() ?? '',
      })),
      total,
      reentries,
    })
  },
)

platformBans.post(
  '/',
  describeRoute({
    tags: ['Platform Bans'],
    summary: 'Create a platform-scoped ban',
    responses: {
      200: {
        description: 'Ban created',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('bans:create-platform'),
  validator('json', createPlatformBanBodySchema),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')
    const phoneHash = body.phoneHash
    await services.records.addBan({
      scope: PLATFORM_SCOPE,
      phoneHash,
      reason: body.reason ?? '',
      bannedBy: pubkey,
    })
    await audit(
      services.audit,
      'platformBanCreated',
      pubkey,
      { phoneHash }, undefined, null,
    )
    return c.json({ ok: true })
  },
)

platformBans.post(
  '/bulk',
  describeRoute({
    tags: ['Platform Bans'],
    summary: 'Bulk import platform-scoped bans',
    responses: {
      200: {
        description: 'Bans imported',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('bans:create-platform'),
  validator('json', bulkPlatformBanBodySchema),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')
    const phoneHashes = body.phoneHashes
    const added = await services.records.bulkAddBans(
      PLATFORM_SCOPE,
      phoneHashes,
      body.reason ?? '',
      pubkey,
    )
    await audit(services.audit, 'platformBanBulkImport', pubkey, {
      count: phoneHashes.length,
    }, undefined, null)
    return c.json({ ok: true, count: added })
  },
)

platformBans.delete(
  '/reentries/:id',
  describeRoute({
    tags: ['Platform Bans'],
    summary: 'Dismiss a platform ban that had to be re-entered, once the number is banned again',
    responses: {
      200: {
        description: 'Reminder dismissed',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('bans:delete-platform'),
  async (c) => {
    const dismissed = await c.get('services').records.dismissBanReentry(PLATFORM_SCOPE, c.req.param('id'))
    if (!dismissed) {
      return c.json({ error: 'Re-entry not found' }, 404)
    }
    return c.json({ ok: true })
  },
)

platformBans.delete(
  '/:id',
  describeRoute({
    tags: ['Platform Bans'],
    summary: 'Remove a platform-scoped ban',
    responses: {
      200: {
        description: 'Ban removed',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('bans:delete-platform'),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const id = c.req.param('id')

    const deleted = await services.records.deletePlatformBan(id)
    if (!deleted) {
      return c.json({ error: 'Platform ban not found' }, 404)
    }

    await audit(services.audit, 'platformBanRemoved', pubkey, {
      banId: id,
    }, undefined, null)
    return c.json({ ok: true })
  },
)

platformBans.post(
  '/search/evaluate',
  describeRoute({
    tags: ['Platform Bans'],
    summary: 'Evaluate one blinded number under every scope\'s ban key, for a search',
    responses: {
      200: {
        description: 'One evaluation per scope (no hubId = the platform)',
        content: {
          'application/json': {
            schema: resolver(searchBansEvaluateResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('bans:read-platform'),
  validator('json', searchBansEvaluateBodySchema),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const { blindedElement } = c.req.valid('json')
    if (await checkRateLimit(services.settings, `ban-evaluate:${pubkey}`, BAN_EVALUATIONS_PER_MINUTE)) {
      return c.json({ error: 'Too many ban evaluations. Try again in a minute.' }, 429)
    }
    // Every scope has its own key, so the number is evaluated once per hub and once for the
    // platform. The client finalizes each into that scope's digest and searches with them.
    const { hubs } = await services.settings.getHubs()
    const scopes: { hubId?: string; scope: OwnerScope }[] = [
      { scope: PLATFORM_SCOPE },
      ...hubs.map((hub) => ({ hubId: hub.id, scope: hubScope(hub.id) })),
    ]
    const evaluations: { hubId?: string; evaluatedElement: string }[] = []
    for (const { hubId, scope } of scopes) {
      const evaluatedElement = evaluateOrNull(() => banBlindEvaluate(blindedElement, scope, c.env.BAN_HASH_KEY))
      if (evaluatedElement === null) return c.json({ error: 'Invalid blinded element' }, 400)
      evaluations.push(hubId === undefined ? { evaluatedElement } : { hubId, evaluatedElement })
    }
    await audit(services.audit, 'platformBanSearchEvaluated', pubkey, {
      scopes: evaluations.length,
    }, undefined, null)
    return c.json({ evaluations })
  },
)

platformBans.post(
  '/search',
  describeRoute({
    tags: ['Platform Bans'],
    summary: 'Search all bans by a number\'s per-scope ban digests',
    responses: {
      200: {
        description: 'Search results',
        content: {
          'application/json': {
            schema: resolver(searchBansResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('bans:read-platform'),
  validator('json', searchBansBodySchema),
  async (c) => {
    const services = c.get('services')
    const { lookups } = c.req.valid('json')
    // Each digest only selects rows of its own scope. Nothing is stored.
    const rows = await services.records.searchBans(
      lookups.map(({ hubId, phoneHash }) => ({
        scope: hubId === undefined ? PLATFORM_SCOPE : hubScope(hubId),
        phoneHash,
      })),
    )

    return c.json({
      bans: rows.map((b) => ({
        id: b.id,
        hubId: b.hubId,
        phoneHash: b.phone,
        reason: b.reason,
        bannedBy: b.bannedBy,
        bannedAt: b.bannedAt?.toISOString() ?? '',
      })),
    })
  },
)

platformBans.post(
  '/promote',
  describeRoute({
    tags: ['Platform Bans'],
    summary: 'Promote a hub-scoped ban to platform scope',
    responses: {
      200: {
        description: 'Ban promoted',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('bans:create-platform'),
  validator('json', promoteBanBodySchema),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')

    const sourceBan = await services.records.getBanById(body.banId)

    if (!sourceBan) {
      return c.json({ error: 'Source ban not found' }, 404)
    }
    const source = scopeOfRow(sourceBan)
    if (source.kind === 'platform') {
      return c.json({ error: 'Ban is already platform-scoped' }, 409)
    }

    // The hub's digest is keyed to that hub, so it cannot be turned into a platform digest:
    // the client re-enters the number and digests it under both keys. The hub digest must be
    // the one that hub stored, so a mistyped number cannot ban someone else. (The server
    // cannot tell whether the two digests share a number — that unlinkability is the point —
    // so the client derives both from one entry.)
    if (body.sourcePhoneHash !== sourceBan.phone) {
      return c.json({ error: 'Phone number does not match the ban being promoted' }, 400)
    }

    await services.records.addBan({
      scope: PLATFORM_SCOPE,
      phoneHash: body.phoneHash,
      reason: sourceBan.reason ?? '',
      bannedBy: pubkey,
    })

    await audit(services.audit, 'platformBanPromoted', pubkey, {
      sourceHubId: source.hubId,
      sourceBanId: sourceBan.id,
    }, undefined, null)

    return c.json({ ok: true })
  },
)

export default platformBans
