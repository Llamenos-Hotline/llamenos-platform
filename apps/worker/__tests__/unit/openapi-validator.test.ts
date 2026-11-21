/**
 * The worker's request validator (#2710): a request that fails its schema is
 * answered in the shape every route declares for its 400 — `errorResponseSchema`
 * — not hono-openapi's `{ success, data, error: Issue[] }`.
 */
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { z } from 'zod'
import { errorResponseSchema } from '@protocol/schemas/common'
import { validator, VALIDATION_FAILED_MESSAGE } from '@worker/openapi/validator'

const schema = z.object({
  type: z.enum(['twilio', 'vonage']),
  authToken: z.string().min(8),
  nested: z.object({ n: z.number() }).optional(),
})

function appWithHook(hook?: Parameters<typeof validator>[2]) {
  const app = new Hono()
  app.post('/p', validator('json', schema, hook), c => c.json({ ok: true }))
  return app
}

const post = (app: Hono, body: unknown) =>
  app.request('/p', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('validator', () => {
  it('passes a valid request through', async () => {
    const res = await post(appWithHook(), { type: 'twilio', authToken: 'a-long-secret' })
    expect(res.status).toBe(200)
  })

  it('answers a failed validation with the declared error envelope', async () => {
    const res = await post(appWithHook(), { type: 'nope', authToken: 'a-long-secret', nested: { n: 'x' } })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(errorResponseSchema.safeParse(body).success).toBe(true)
    expect(body.error).toBe(VALIDATION_FAILED_MESSAGE)
    expect(body.details.map((d: { field: string }) => d.field).sort()).toEqual(['nested.n', 'type'])
  })

  it('does not echo the request back', async () => {
    const res = await post(appWithHook(), { type: 'twilio', authToken: 'short' })
    expect(res.status).toBe(400)
    const text = await res.text()
    expect(text).not.toContain('short')
    expect(JSON.parse(text)).not.toHaveProperty('data')
    expect(JSON.parse(text)).not.toHaveProperty('success')
  })

  it('names the request part when the failure has no path', async () => {
    const res = await post(appWithHook(), 'not an object')
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.details).toEqual([expect.objectContaining({ field: 'json' })])
  })

  it('keeps a hook the route passes itself', async () => {
    const res = await post(appWithHook((result, c) => (result.success ? undefined : c.json({ error: 'custom' }, 422))), { type: 'x' })
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'custom' })
  })
})
