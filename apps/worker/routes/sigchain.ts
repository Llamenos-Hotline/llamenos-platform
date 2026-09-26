/**
 * Sigchain API routes — Phase 6 key management.
 *
 * GET  /api/users/:targetPubkey/sigchain — Fetch full sigchain (admin or self).
 * POST /api/users/:targetPubkey/sigchain — Append a signed link (self only).
 */
import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '../types'
import { checkPermission } from '../middleware/permission-guard'
import { authErrors } from '../openapi/helpers'
import { CryptoKeyError } from '../services/crypto-keys'
import {
  appendSigchainLinkBodySchema,
  sigchainLinkSchema,
  sigchainResponseSchema,
} from '@protocol/schemas/sigchain'

const sigchainRoutes = new Hono<AppEnv>()

// ---------------------------------------------------------------------------
// GET /api/users/:targetPubkey/sigchain
// ---------------------------------------------------------------------------

sigchainRoutes.get('/',
  describeRoute({
    tags: ['Sigchain'],
    summary: 'Fetch full sigchain for a user',
    description: 'Admins may fetch any user\'s sigchain. Volunteers may only fetch their own.',
    responses: {
      200: {
        description: 'Sigchain links ordered by seqNo ascending',
        content: {
          'application/json': {
            schema: resolver(sigchainResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  // No requirePermission here — the route has inline access control:
  // users may read their own sigchain, admins may read any sigchain.
  async (c) => {
    const callerPubkey = c.get('pubkey')
    const permissions = c.get('permissions')
    const targetPubkey = c.req.param('targetPubkey') ?? ''

    if (!targetPubkey) return c.json({ error: 'Missing targetPubkey' }, 400)

    // Admins (users:read-all permission via '*') can see any sigchain.
    // Volunteers may only see their own.
    const isAdmin = checkPermission(permissions, '*')
    if (!isAdmin && callerPubkey !== targetPubkey) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    const services = c.get('services')
    const links = await services.cryptoKeys.getSigchain(targetPubkey)
    return c.json({ links })
  },
)

// ---------------------------------------------------------------------------
// POST /api/users/:targetPubkey/sigchain
// ---------------------------------------------------------------------------

sigchainRoutes.post('/',
  describeRoute({
    tags: ['Sigchain'],
    summary: 'Append a signed sigchain link',
    description: 'Users may only append to their own sigchain. The server validates link semantics (genesis only at seq 1, payload.type matches linkType), hash-chain continuity (seqNo, prevHash), the recomputed entry hash and the Ed25519 signature before persisting.',
    responses: {
      201: {
        description: 'Link appended',
        content: {
          'application/json': {
            schema: resolver(sigchainLinkSchema),
          },
        },
      },
      ...authErrors,
      400: { ...authErrors[400], description: 'Validation error: invalid link semantics, payload shape or entry hash' },
      409: { description: 'Hash-chain continuity violation (seqNo or prevHash mismatch)' },
    },
  }),
  validator('json', appendSigchainLinkBodySchema),
  async (c) => {
    const callerPubkey = c.get('pubkey')
    const targetPubkey = c.req.param('targetPubkey') ?? ''

    if (!targetPubkey) return c.json({ error: 'Missing targetPubkey' }, 400)

    // Users may only append to their own sigchain
    if (callerPubkey !== targetPubkey) {
      return c.json({ error: 'Forbidden: cannot write to another user\'s sigchain' }, 403)
    }

    const body = c.req.valid('json')
    const services = c.get('services')

    try {
      const link = await services.cryptoKeys.appendSigchainLink(targetPubkey, body)
      return c.json(link, 201)
    } catch (err) {
      if (err instanceof CryptoKeyError) {
        return c.json({ error: err.message }, err.status)
      }
      throw err
    }
  },
)

export default sigchainRoutes
