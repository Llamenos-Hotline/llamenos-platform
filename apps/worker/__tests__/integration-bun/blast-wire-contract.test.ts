/**
 * Blast responses carry the content shape the clients are generated from
 * (#2572) — real router, real BlastsService, real PostgreSQL, Bun-native driver.
 *
 * MUST run under `bun test`, NOT vitest:
 *   bun test apps/worker/__tests__/integration-bun/blast-wire-contract.test.ts
 *
 * The defect: the route turned the wire `{ body, mediaUrl }` into storage
 * `{ text, mediaUrl }` on the way in and nothing turned it back, so create,
 * send, list and get answered `{ text }` against `blastResponseSchema`'s
 * `{ body }`. Android read `body` and desktop read `text`.
 *
 * Every body is parsed with the protocol schema itself — the same Zod the
 * generated Swift and Kotlin types come from — and the content is compared
 * exactly, so a `text` that leaks back out fails as surely as a missing `body`.
 *
 * Requires postgres at DATABASE_URL with migrations applied. Rows created here
 * are deleted on teardown.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import '../../db/pg-array-patch'
import { createDatabase } from '../../db'
import { blasts, hubs } from '../../db/schema'
import { BlastsService } from '../../services/blasts'
import { ServiceError } from '../../services/service-error'
import blastsRoutes from '../../routes/blasts'
import type { AppEnv } from '../../types'
import { blastEnvelopeResponseSchema, blastListResponseSchema, blastResponseSchema } from '@protocol/schemas/blasts'
import { requireDatabaseUrl } from '../helpers/database-url'

const db = createDatabase(requireDatabaseUrl())
const service = new BlastsService(db)

const suite = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const HUB = `hub-blastwire-${suite}`
const ADMIN = `ad${suite.replace(/\D/g, '')}`.padEnd(64, '0')

function app() {
  const app = new Hono<AppEnv>()
  app.onError((err, c) => {
    if (err instanceof ServiceError) return c.json({ error: err.message }, err.status as 400 | 403 | 404 | 409)
    throw err
  })
  const hubScoped = new Hono<AppEnv>()
  hubScoped.use('*', async (c, next) => {
    c.set('hubId', c.req.param('hubId') as string)
    c.set('pubkey', ADMIN)
    c.set('permissions', ['*'])
    c.set('services', { blasts: service } as unknown as AppEnv['Variables']['services'])
    await next()
  })
  hubScoped.route('/blasts', blastsRoutes)
  app.route('/api/hubs/:hubId', hubScoped)
  return app
}

async function call(method: string, path: string, body?: unknown) {
  const res = await app().request(`/api/hubs/${HUB}/blasts${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, { ENVIRONMENT: 'test', HMAC_SECRET: 'f'.repeat(64) })
  return { status: res.status, json: await res.json() as unknown }
}

beforeAll(async () => {
  await db.insert(hubs).values({ id: HUB, name: HUB, slug: HUB, createdBy: ADMIN })
})

afterAll(async () => {
  await db.delete(blasts).where(eq(blasts.hubId, HUB))
  await db.delete(hubs).where(eq(hubs.id, HUB))
})

describe('blast content on the wire (#2572)', () => {
  it('create, get, list and send all answer the single-language content as { body }', async () => {
    const created = await call('POST', '', {
      name: 'single', content: { body: 'Hello', mediaUrl: 'https://example.test/a.png' }, channels: ['sms'],
    })
    expect(created.status).toBe(201)
    const createdBlast = blastEnvelopeResponseSchema.parse(created.json).blast
    expect(createdBlast.content).toEqual({ body: 'Hello', mediaUrl: 'https://example.test/a.png' })

    const got = await call('GET', `/${createdBlast.id}`)
    expect(blastResponseSchema.parse(got.json).content).toEqual({ body: 'Hello', mediaUrl: 'https://example.test/a.png' })

    const listed = await call('GET', '')
    const inList = blastListResponseSchema.parse(listed.json).blasts.find(b => b.id === createdBlast.id)
    expect(inList?.content).toEqual({ body: 'Hello', mediaUrl: 'https://example.test/a.png' })

    const sent = await call('POST', `/${createdBlast.id}/send`)
    expect(sent.status).toBe(200)
    expect(blastEnvelopeResponseSchema.parse(sent.json).blast.content).toEqual({
      body: 'Hello', mediaUrl: 'https://example.test/a.png',
    })
  })

  it('answers multi-language content as { body } per language', async () => {
    const created = await call('POST', '', {
      name: 'multi', content: { en: { body: 'Hello' }, es: { body: 'Hola' } }, defaultLanguage: 'en', channels: ['sms'],
    })
    expect(created.status).toBe(201)
    const blast = blastEnvelopeResponseSchema.parse(created.json).blast
    expect(blast.content).toEqual({ en: { body: 'Hello' }, es: { body: 'Hola' } })

    const updated = await call('PATCH', `/${blast.id}`, { content: { body: 'Edited' } })
    expect(updated.status).toBe(200)
    expect(blastEnvelopeResponseSchema.parse(updated.json).blast.content).toEqual({ body: 'Edited' })
  })
})
