/**
 * The declared-response check (#2118): a route that returns a body its own
 * `describeRoute` schema rejects must fail, wherever it is mounted, without the
 * route opting in.
 */
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { describeRoute, generateSpecs, resolver } from 'hono-openapi'
import { z } from 'zod'
import { DECLARED_RESPONSE_CHECK_HEADER, enforceDeclaredResponses, registerDeclaredResponses } from '@worker/openapi/declared-responses'

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

/**
 * Mounted under a parameterised sub-router, as app.ts mounts hub-scoped
 * routes, and registered as app.ts registers the finished app.
 */
function appWith(router: Hono, env: Record<string, string> = { ENVIRONMENT: 'development' }, opts: { register?: boolean } = {}) {
  const api = new Hono()
  api.use('*', enforceDeclaredResponses())
  const hubScoped = new Hono()
  hubScoped.route('/things', router)
  api.route('/hubs/:hubId', hubScoped)
  const app = new Hono()
  app.route('/api', api)
  const registered = opts.register === false ? 0 : registerDeclaredResponses(app)
  return {
    app,
    api,
    registered,
    /** As the backend BDD suite asks: enforce. */
    request: (path: string) => app.request(path, { headers: { [DECLARED_RESPONSE_CHECK_HEADER]: 'enforce' } }, env),
    /** As every other client asks: nothing — so report. */
    requestPlain: (path: string) => app.request(path, {}, env),
  }
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

  it('judges a response by the route that produced it, not a later route whose pattern also matches', async () => {
    // GET /stats matches both '/stats' and '/:id'; only '/stats' ran.
    const r = new Hono()
    r.get('/stats',
      describeRoute({ responses: { 200: { description: 'stats', content: { 'application/json': { schema: resolver(z.object({ total: z.number() })) } } } } }),
      c => c.json({ total: 3 }),
    )
    r.get('/:id',
      describeRoute({ responses: { 200: { description: 'one', content: { 'application/json': { schema: resolver(z.object({ id: z.string() })) } } } } }),
      c => c.json({ id: c.req.param('id') }),
    )
    const app = appWith(r)
    expect((await app.request('/api/hubs/h1/things/stats')).status).toBe(200)
    expect((await app.request('/api/hubs/h1/things/abc')).status).toBe(200)
  })

  it('reports without failing a request that did not ask for enforcement', async () => {
    const res = await appWith(routerReturning({ items: [] })).requestPlain('/api/hubs/h1/things')
    expect(res.status).toBe(200)
  })

  it('is off in production, even when asked to enforce', async () => {
    const res = await appWith(routerReturning({ items: [] }), { ENVIRONMENT: 'production' }).request('/api/hubs/h1/things')
    expect(res.status).toBe(200)
  })

  it('passes the validator\'s own 400 (a ledgered cause) but not a route\'s own non-conforming 400', async () => {
    const r = new Hono()
    const declared400 = { 400: { description: 'bad', content: { 'application/json': { schema: resolver(z.object({ error: z.string() })) } } } }
    r.post('/v', describeRoute({ responses: declared400 }), c => c.json({ data: {}, error: [{ message: 'x' }], success: false }, 400))
    r.post('/own', describeRoute({ responses: declared400 }), c => c.json({ error: { nested: true } }, 400))
    const app = appWith(r)
    const post = (path: string) => app.app.request(path, { method: 'POST', headers: { [DECLARED_RESPONSE_CHECK_HEADER]: 'enforce' } }, { ENVIRONMENT: 'development' })
    expect((await post('/api/hubs/h1/things/v')).status).toBe(400)
    expect((await post('/api/hubs/h1/things/own')).status).toBe(500)
  })

  it('still catches a violation after the OpenAPI document was generated', async () => {
    // The dev server generates /api/openapi.json at startup, and generation
    // replaces every resolver() in the spec with its JSON Schema IN PLACE.
    // Read live, the check saw no validator after that and passed everything —
    // which is how a whole backend BDD run reported zero violations.
    const { api, request } = appWith(routerReturning({ items: ['a'], total: 1 }))
    await generateSpecs(api)
    expect((await request('/api/hubs/h1/things')).status).toBe(500)
  })

  it('fails loudly, rather than passing, a described route that was never registered', async () => {
    const res = await appWith(routerReturning({ items: ['a'], total: 1, page: 1, limit: 1 }), undefined, { register: false })
      .request('/api/hubs/h1/things')
    expect(res.status).toBe(500)
    const body = await res.json() as { violation: { issues: { message: string }[] } }
    expect(body.violation.issues[0].message).toMatch(/never captured/)
  })

  it('refuses to register a spec that generation has already stripped', async () => {
    const { api } = appWith(routerReturning({}), undefined, { register: false })
    await generateSpecs(api)
    expect(() => registerDeclaredResponses(api)).toThrow(/before the OpenAPI document is generated/)
  })
})
