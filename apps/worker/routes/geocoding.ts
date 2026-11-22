import { Hono } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import { validator } from '../openapi/validator'
import type { AppEnv } from '../types'
import { requirePermission } from '../middleware/permission-guard'
import { checkRateLimit } from '../lib/helpers'
import {
  locationResultSchema,
} from '@protocol/schemas/geocoding'
import { z } from 'zod'
import { createGeocodingAdapter } from '../geocoding/factory'
import { authErrors } from '../openapi/helpers'

const geocoding = new Hono<AppEnv>()

// All geocoding endpoints require at least volunteer-level access
geocoding.use('*', requirePermission('notes:read-own'))

const autocompleteBodySchema = z.object({
  query: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(10).optional().default(5),
})

const geocodeBodySchema = z.object({
  address: z.string().min(1).max(500),
})

const reverseBodySchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
})

geocoding.post('/autocomplete',
  describeRoute({
    tags: ['Geocoding'],
    summary: 'Autocomplete address query',
    responses: {
      200: { description: 'Address suggestions', content: { 'application/json': { schema: resolver(z.array(locationResultSchema)) } } },
      ...authErrors,
    },
  }),
  validator('json', autocompleteBodySchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const limited = await checkRateLimit(c.get('services').rateLimits, `geocoding:auto:${pubkey}`, 60)
    if (limited) return c.json({ error: 'Rate limited' }, 429)

    const { query, limit } = c.req.valid('json')
    const config = await c.get('services').platformSettings.getGeocodingConfigAdmin()
    const adapter = createGeocodingAdapter(config)
    const results = await adapter.autocomplete(query, { limit })
    return c.json(results)
  },
)

geocoding.post('/geocode',
  describeRoute({
    tags: ['Geocoding'],
    summary: 'Forward geocode an address to coordinates',
    responses: {
      200: { description: 'Geocoded result or null', content: { 'application/json': { schema: resolver(locationResultSchema.nullable()) } } },
      ...authErrors,
    },
  }),
  validator('json', geocodeBodySchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const limited = await checkRateLimit(c.get('services').rateLimits, `geocoding:fwd:${pubkey}`, 20)
    if (limited) return c.json({ error: 'Rate limited' }, 429)

    const { address } = c.req.valid('json')
    const config = await c.get('services').platformSettings.getGeocodingConfigAdmin()
    const adapter = createGeocodingAdapter(config)
    const result = await adapter.geocode(address)
    return c.json(result)
  },
)

geocoding.post('/reverse',
  describeRoute({
    tags: ['Geocoding'],
    summary: 'Reverse geocode coordinates to address',
    responses: {
      200: { description: 'Resolved address or null', content: { 'application/json': { schema: resolver(locationResultSchema.nullable()) } } },
      ...authErrors,
    },
  }),
  validator('json', reverseBodySchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const limited = await checkRateLimit(c.get('services').rateLimits, `geocoding:rev:${pubkey}`, 20)
    if (limited) return c.json({ error: 'Rate limited' }, 429)

    const { lat, lon } = c.req.valid('json')
    const config = await c.get('services').platformSettings.getGeocodingConfigAdmin()
    const adapter = createGeocodingAdapter(config)
    const result = await adapter.reverse(lat, lon)
    return c.json(result)
  },
)

export default geocoding
