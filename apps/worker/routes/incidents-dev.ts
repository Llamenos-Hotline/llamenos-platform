/**
 * Test-only incident producer (B-INCIDENTS, #2341).
 *
 * The core ships no real producer — B-CAPTCHA, B-INCIDENT-PROVIDER-MEDIA and
 * #2323 wire those — so the backend BDD suite drives the service through these
 * routes. Behind the same two gates as every `/api/test-*` route: this host
 * serves the dev surface (`devSurfacesEnabled`, refused unconditionally in
 * production) AND the caller presents the shared secret. Both answer 404.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../types/infra'
import { incidentCategorySchema } from '@protocol/schemas/incidents'
import { devSurfacesEnabled, devSurfaceSecretPresented } from '../lib/dev-surfaces'

const incidentsDev = new Hono<AppEnv>()

incidentsDev.use('/test-incidents/*', async (c, next) => {
  if (!devSurfacesEnabled(c.env) || !devSurfaceSecretPresented(c.env, c.req.header('X-Test-Secret'))) {
    return c.json({ error: 'Not Found' }, 404)
  }
  return next()
})

const signalBodySchema = z.object({
  hubId: z.string().min(1),
  category: incidentCategorySchema,
  kind: z.string().min(1),
  n: z.number().int().positive().optional().default(1),
  /** Signal this many times, one call each — exercises the rate rules. */
  repeat: z.number().int().positive().max(500).optional().default(1),
})

/** Signal an incident as a defence would. */
incidentsDev.post('/test-incidents/signal', async (c) => {
  const parsed = signalBodySchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
  const { hubId, category, kind, n, repeat } = parsed.data
  const services = c.get('services')
  let incident
  for (let i = 0; i < repeat; i++) {
    incident = await services.incidents.signal(hubId, category, kind, n)
  }
  return c.json({ incident })
})

const sweepBodySchema = z.object({
  hubId: z.string().min(1),
  /** Run the closer as if this many milliseconds had passed — scoped to one hub so parallel scenarios never close each other's incidents. */
  advanceMs: z.number().int().nonnegative(),
})

/** Run the incident closer for one hub at a shifted clock. */
incidentsDev.post('/test-incidents/sweep', async (c) => {
  const parsed = sweepBodySchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
  const services = c.get('services')
  const result = await services.incidents.closeQuiet({
    hubId: parsed.data.hubId,
    asOf: new Date(Date.now() + parsed.data.advanceMs),
  })
  return c.json(result)
})

export default incidentsDev
