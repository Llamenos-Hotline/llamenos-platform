/**
 * Unit tests for apps/worker/routes/puk.ts
 *
 * Tests PUK envelope distribution and retrieval.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types/infra'

vi.mock('hono-openapi', () => ({
  describeRoute: () => async (_c: unknown, next: () => Promise<void>) => next(),
  resolver: (s: unknown) => s,
  validator: (_type: string, _schema: unknown) => {
    return async (c: { req: { json: () => Promise<unknown>; valid: (t: string) => unknown } }, next: () => Promise<void>) => {
      try { const body = await c.req.json(); const orig = c.req.valid.bind(c.req); c.req.valid = (t: string) => t === 'json' ? body : orig(t) } catch {}
      await next()
    }
  },
}))

import pukRoutes from '@worker/routes/puk'
import { CryptoKeyError } from '@worker/services/crypto-keys'
import type { PukHpkeEnvelope } from '@protocol/schemas/sigchain'

const ENVELOPE: PukHpkeEnvelope = { v: 3, labelId: 44, enc: 'enc-b64url', ct: 'ct-b64url' }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createApp(pubkey = 'user-pk-1') {
  const app = new Hono<AppEnv>()
  const services = {
    cryptoKeys: {
      distributePukEnvelopes: vi.fn(),
      getPukEnvelopeForDevice: vi.fn(),
    },
  }

  app.use('*', async (c, next) => {
    c.set('pubkey', pubkey as never)
    c.set('services', services as never)
    await next()
  })

  app.route('/puk', pukRoutes)

  return { app, services }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PUK routes', () => {
  beforeEach(() => vi.clearAllMocks())

  describe('POST /puk/envelopes', () => {
    it('distributes PUK envelopes', async () => {
      const { app, services } = createApp()
      const stored = [
        { id: 'env-1', userPubkey: 'user-pk-1', deviceId: 'dev-1', generation: 1, envelope: ENVELOPE, createdAt: '2026-01-01' },
      ]
      services.cryptoKeys.distributePukEnvelopes.mockResolvedValue(stored)

      const res = await app.request('/puk/envelopes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          envelopes: [{ deviceId: 'dev-1', generation: 1, envelope: ENVELOPE }],
        }),
      })

      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.distributed).toBe(1)
      expect(body.envelopes).toHaveLength(1)
    })

    it('passes authenticated user pubkey to service', async () => {
      const { app, services } = createApp('my-pubkey')
      services.cryptoKeys.distributePukEnvelopes.mockResolvedValue([])

      await app.request('/puk/envelopes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          envelopes: [{ deviceId: 'd1', generation: 1, envelope: ENVELOPE }],
        }),
      })

      expect(services.cryptoKeys.distributePukEnvelopes).toHaveBeenCalledWith(
        'my-pubkey',
        [{ deviceId: 'd1', generation: 1, envelope: ENVELOPE }],
      )
    })

    it('returns the service status for an envelope addressed to an unauthorised device', async () => {
      const { app, services } = createApp()
      services.cryptoKeys.distributePukEnvelopes.mockRejectedValue(
        new CryptoKeyError('PUK envelope addressed to a device the user\'s sigchain does not authorise: d9', 400),
      )

      const res = await app.request('/puk/envelopes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ envelopes: [{ deviceId: 'd9', generation: 1, envelope: ENVELOPE }] }),
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('does not authorise')
    })
  })

  describe('GET /puk/envelopes/:deviceId', () => {
    it('returns envelope for a device', async () => {
      const { app, services } = createApp()
      const envelope = {
        id: 'env-1',
        userPubkey: 'user-pk-1',
        deviceId: 'dev-1',
        generation: 2,
        envelope: ENVELOPE,
        createdAt: '2026-01-01',
      }
      services.cryptoKeys.getPukEnvelopeForDevice.mockResolvedValue(envelope)

      const res = await app.request('/puk/envelopes/dev-1')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.deviceId).toBe('dev-1')
      expect(body.generation).toBe(2)
    })

    it('returns 404 when no envelope exists', async () => {
      const { app, services } = createApp()
      services.cryptoKeys.getPukEnvelopeForDevice.mockResolvedValue(null)

      const res = await app.request('/puk/envelopes/unknown-dev')
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toContain('No PUK envelope')
    })

    it('scopes lookup to authenticated user', async () => {
      const { app, services } = createApp('owner-pk')
      services.cryptoKeys.getPukEnvelopeForDevice.mockResolvedValue(null)

      await app.request('/puk/envelopes/dev-1')
      expect(services.cryptoKeys.getPukEnvelopeForDevice).toHaveBeenCalledWith('owner-pk', 'dev-1')
    })
  })
})

// ---------------------------------------------------------------------------
// H09: concurrent envelope distribution (upsert idempotency)
// ---------------------------------------------------------------------------

describe('PUK envelope upsert idempotency (H09)', () => {
  it('handles concurrent distribution of the same generation — both requests succeed', async () => {
    const { app, services } = createApp()
    const stored = [
      { id: 'env-1', userPubkey: 'user-pk-1', deviceId: 'dev-1', generation: 2, envelope: 'enc-v2', createdAt: '2026-01-01' },
    ]
    // Both concurrent requests return the same record (upsert semantics: idempotent)
    services.cryptoKeys.distributePukEnvelopes
      .mockResolvedValueOnce(stored)
      .mockResolvedValueOnce(stored)

    const envelope = [{ deviceId: 'dev-1', generation: 2, envelope: 'enc-v2' }]
    const makeRequest = () => app.request('/puk/envelopes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ envelopes: envelope }),
    })

    const [res1, res2] = await Promise.all([makeRequest(), makeRequest()])
    expect(res1.status).toBe(201)
    expect(res2.status).toBe(201)
  })
})
