/**
 * The declared-response check (#2118): a route that returns a body its own
 * `describeRoute` schema rejects must fail, wherever it is mounted, without the
 * route opting in.
 */
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import { z } from 'zod'
import { enforceDeclaredResponses, responseContractMode } from '@worker/openapi/declared-responses'

const pageSchema = z.object({ items: z.array(z.string()), total: z.number(), page: z.number(), limit: z.number() })

/** A router built the way apps/worker/routes/* are, returning `body` from a route that declares `pageSchema`. */
function routerReturning(body: unknown, status: 200 | 201 = 200) {
  const r = new Hono()
  r.get('/',
    describeRoute({ responses: { [status]: { description: 'page', content: { 'application/json': { schema: resolver(pageSchema) } } } } }),
    c => c.json(body, status),
  )
  r.get('/undeclared', c => c.json({ anything: true }))
  r.get('/error',
    describeRoute({ responses: { 200: { description: 'page', content: { 'application/json': { schema: resolver(pageSchema) } } } } }),
    c => c.json({ error: 'nope' }, 404),
  )
  return r
}

/** Mounted under a parameterised sub-router, as app.ts mounts hub-scoped routes. */
function appWith(router: Hono, env: Record<string, string> = { ENVIRONMENT: 'development' }) {
  const api = new Hono()
  api.use('*', enforceDeclaredResponses())
  const hubScoped = new Hono()
  hubScoped.route('/things', router)
  api.route('/hubs/:hubId', hubScoped)
  const app = new Hono()
  app.route('/api', api)
  return { request: (path: string) => app.request(path, {}, env) }
}

describe('enforceDeclaredResponses', () => {
  it('fails a response missing a field its schema requires — the #2118 shape', async () => {
    const res = await appWith(routerReturning({ items: ['a'], total: 1 })).request('/api/hubs/h1/things')
    expect(res.status).toBe(500)
    const body = await res.json() as { violation: { route: string; issues: { path: string }[] } }
    expect(body.violation.route).toBe('/api/hubs/:hubId/things')
    expect(body.violation.issues.map(i => i.path).sort()).toEqual(['limit', 'page'])
  })

  it('fails a field of the wrong type (null where the schema declares absent)', async () => {
    const strict = new Hono()
    strict.get('/',
      describeRoute({ responses: { 200: { description: 'x', content: { 'application/json': { schema: resolver(z.object({ assignedTo: z.string().optional() })) } } } } }),
      c => c.json({ assignedTo: null }),
    )
    const res = await appWith(strict).request('/api/hubs/h1/things')
    expect(res.status).toBe(500)
  })

  it('passes a conforming response through unchanged', async () => {
    const res = await appWith(routerReturning({ items: ['a'], total: 1, page: 1, limit: 50 })).request('/api/hubs/h1/things')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ items: ['a'], total: 1, page: 1, limit: 50 })
  })

  it('checks the status the route actually returned, against what it declared for that status', async () => {
    const res = await appWith(routerReturning({ items: [] }, 201)).request('/api/hubs/h1/things')
    expect(res.status).toBe(500)
  })

  it('leaves alone a status the route declared no schema for, and a route that declares nothing', async () => {
    const app = appWith(routerReturning({}))
    expect((await app.request('/api/hubs/h1/things/error')).status).toBe(404)
    expect((await app.request('/api/hubs/h1/things/undeclared')).status).toBe(200)
  })

  it('is off in production, and reports without failing when asked to', async () => {
    const bad = routerReturning({ items: [] })
    expect((await appWith(bad, { ENVIRONMENT: 'production' }).request('/api/hubs/h1/things')).status).toBe(200)
    expect((await appWith(bad, { ENVIRONMENT: 'development', RESPONSE_CONTRACT: 'report' }).request('/api/hubs/h1/things')).status).toBe(200)
  })
})

describe('responseContractMode', () => {
  it('enforces everywhere but production unless told otherwise', () => {
    expect(responseContractMode({ ENVIRONMENT: 'development' })).toBe('enforce')
    expect(responseContractMode({})).toBe('enforce')
    expect(responseContractMode({ ENVIRONMENT: 'staging' })).toBe('enforce')
    expect(responseContractMode({ ENVIRONMENT: 'production' })).toBe('off')
    expect(responseContractMode({ ENVIRONMENT: 'production', RESPONSE_CONTRACT: 'report' })).toBe('report')
  })

  it('refuses a mode it does not know rather than silently picking one', () => {
    expect(() => responseContractMode({ RESPONSE_CONTRACT: 'enforced' })).toThrow(/RESPONSE_CONTRACT/)
  })
})
