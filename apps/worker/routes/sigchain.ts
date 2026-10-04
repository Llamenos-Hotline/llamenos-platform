/**
 * Sigchain API routes — Phase 6 key management.
 *
 * GET  /api/users/:targetPubkey/sigchain — Fetch full sigchain (admin or self).
 * POST /api/users/:targetPubkey/sigchain — Append a signed link (self only).
 */
import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import { z } from 'zod'
import type { AppEnv } from '../types'
import { checkPermission } from '../middleware/permission-guard'
import { authErrors } from '../openapi/helpers'
import { CryptoKeyError, findSigchainBreak } from '../services/crypto-keys'

const sigchainRoutes = new Hono<AppEnv>()

// ---------------------------------------------------------------------------
// Zod schemas (inline — small surface, not worth a separate protocol file yet)
// ---------------------------------------------------------------------------

const sigchainLinkSchema = z.object({
  id: z.string(),
  userPubkey: z.string(),
  seqNo: z.number().int().nonnegative(),
  linkType: z.string(),
  payload: z.unknown(),
  signature: z.string(),
  prevHash: z.string(),
  hash: z.string(),
  signerDeviceId: z.string(),
  signerPubkey: z.string(),
  createdAt: z.string(),
})

const sigchainResponseSchema = z.object({
  links: z.array(sigchainLinkSchema),
  /**
   * Set when the chain's prevHash linkage is broken (a fork, a seqNo gap, or
   * tampering) rather than silently returning the forked chain as if it were
   * valid (#1146). Readers verifying the chain MUST check this before
   * trusting `links`.
   */
  integrityBreak: z.object({
    seqNo: z.number().int(),
    reason: z.string(),
  }).nullable(),
})

const appendLinkBodySchema = z.object({
  seqNo: z.number().int().nonnegative(),
  linkType: z.enum(['genesis', 'device_add', 'device_remove', 'key_rotate', 'puk_epoch']),
  payload: z.record(z.string(), z.unknown()),
  /** Ed25519 signature over entry hash, hex. */
  signature: z.string().regex(/^[0-9a-f]{128}$/i, 'Must be 64-byte Ed25519 signature in hex'),
  /** SHA-256 hash of the previous link (hex). Empty string for genesis. */
  prevHash: z.string().regex(/^([0-9a-f]{64}|)$/i, 'Must be SHA-256 hex or empty string'),
  /** SHA-256 hash of this link's canonical form (hex). Server recomputes and verifies. */
  hash: z.string().regex(/^[0-9a-f]{64}$/i, 'Must be SHA-256 hex'),
  /** Device ID of the signing device. */
  signerDeviceId: z.string().min(1),
  /** Ed25519 pubkey of the signing device (hex). */
  signerPubkey: z.string().regex(/^[0-9a-f]{64}$/i, 'Must be 32-byte Ed25519 pubkey in hex'),
  /** ISO-8601 timestamp of link creation. */
  timestamp: z.string().min(1),
})

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
    const integrityBreak = findSigchainBreak(links)
    return c.json({ links, integrityBreak })
  },
)

// ---------------------------------------------------------------------------
// POST /api/users/:targetPubkey/sigchain
// ---------------------------------------------------------------------------

sigchainRoutes.post('/',
  describeRoute({
    tags: ['Sigchain'],
    summary: 'Append a signed sigchain link',
    description: 'Users may only append to their own sigchain. The server validates hash-chain continuity (seqNo, prevHash) and Ed25519 signature integrity before persisting.',
    responses: {
      201: {
        description: 'Link appended',
        content: {
          'application/json': {
            schema: resolver(sigchainLinkSchema),
          },
        },
      },
      409: { description: 'Hash-chain continuity violation (seqNo or prevHash mismatch)' },
      ...authErrors,
    },
  }),
  validator('json', appendLinkBodySchema),
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
