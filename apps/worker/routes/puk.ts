/**
 * PUK (Per-User Key) distribution routes — Phase 6 key management.
 *
 * POST /api/puk/envelopes           — Store PUK seed envelopes (identity init + each rotation).
 * GET  /api/puk/envelopes/:deviceId — Fetch the latest PUK envelope for a device.
 */
import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '../types'
import { authErrors } from '../openapi/helpers'
import { CryptoKeyError } from '../services/crypto-keys'
import {
  distributePukEnvelopesBodySchema,
  distributePukEnvelopesResponseSchema,
  pukEnvelopeResponseSchema,
} from '@protocol/schemas/sigchain'

const pukRoutes = new Hono<AppEnv>()

// ---------------------------------------------------------------------------
// POST /api/puk/envelopes
// ---------------------------------------------------------------------------

pukRoutes.post('/envelopes',
  describeRoute({
    tags: ['PUK'],
    summary: 'Distribute PUK seed envelopes to devices',
    description: [
      'Called when the user\'s identity is initialised and after each PUK rotation.',
      'The caller provides one HPKE envelope per device, addressed by sigchain device ID;',
      'every address must be a device the caller\'s own sigchain authorises.',
      'Each device opens its own envelope with its X25519 private key.',
    ].join(' '),
    responses: {
      201: {
        description: 'Envelopes stored',
        content: {
          'application/json': {
            schema: resolver(distributePukEnvelopesResponseSchema),
          },
        },
      },
      ...authErrors,
      400: { ...authErrors[400], description: 'Validation error, or an envelope addressed to a device the user\'s sigchain does not authorise' },
    },
  }),
  validator('json', distributePukEnvelopesBodySchema),
  async (c) => {
    const userPubkey = c.get('pubkey')
    const body = c.req.valid('json')
    const services = c.get('services')

    try {
      const stored = await services.cryptoKeys.distributePukEnvelopes(
        userPubkey,
        body.envelopes,
      )
      return c.json({ distributed: stored.length, envelopes: stored }, 201)
    } catch (err) {
      if (err instanceof CryptoKeyError) {
        return c.json({ error: err.message }, err.status)
      }
      throw err
    }
  },
)

// ---------------------------------------------------------------------------
// GET /api/puk/envelopes/:deviceId
// ---------------------------------------------------------------------------

pukRoutes.get('/envelopes/:deviceId',
  describeRoute({
    tags: ['PUK'],
    summary: 'Fetch the latest PUK envelope for a specific device',
    description: [
      'Returns the highest-generation PUK envelope stored for this device.',
      'Only the device owner (authenticated user) may fetch their own envelopes.',
    ].join(' '),
    responses: {
      200: {
        description: 'PUK envelope for the device',
        content: {
          'application/json': {
            schema: resolver(pukEnvelopeResponseSchema),
          },
        },
      },
      404: { description: 'No envelope found for this device' },
      ...authErrors,
    },
  }),
  async (c) => {
    const userPubkey = c.get('pubkey')
    const deviceId = c.req.param('deviceId')
    const services = c.get('services')

    const envelope = await services.cryptoKeys.getPukEnvelopeForDevice(
      userPubkey,
      deviceId,
    )

    if (!envelope) {
      return c.json({ error: 'No PUK envelope found for this device' }, 404)
    }

    return c.json(envelope)
  },
)

export default pukRoutes
