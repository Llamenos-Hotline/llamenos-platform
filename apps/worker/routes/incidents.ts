/**
 * GET /hubs/:hubId/incidents — the persistent incident banner and panel
 * (B-INCIDENTS, #2341).
 *
 * Open to every member of the hub, and filtered to the categories the CALLER's
 * permissions in this hub reach: a member holding `settings:manage-spam` sees
 * spam incidents and nothing else; a member holding none of the category
 * permissions gets an empty list. The filter is on permissions, never on a
 * role. The relay event a member receives says only that something changed —
 * this endpoint is where the detail lives.
 */
import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '../types/infra'
import { hubIncidentListResponseSchema, listIncidentsQuerySchema } from '@protocol/schemas/incidents'
import { permissionGranted } from '@shared/permissions'
import { categoriesReachedBy } from '../services/incidents-categories'
import { authErrors } from '../openapi/helpers'

const incidents = new Hono<AppEnv>()

incidents.get('/',
  describeRoute({
    tags: ['Incidents'],
    summary: 'List the hub incidents the caller is responsible for',
    description:
      'Open (and, unless open=true, recently closed) incidents in this hub, limited to the categories the caller\'s ' +
      'permissions in this hub reach. Aggregate counts only.',
    responses: {
      200: {
        description: 'Incidents visible to the caller',
        content: { 'application/json': { schema: resolver(hubIncidentListResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  validator('query', listIncidentsQuerySchema),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId')
    if (!hubId) return c.json({ error: 'Hub context required' }, 400)
    const permissions = c.get('permissions')
    const categories = categoriesReachedBy((permission) => permissionGranted(permissions, permission))
    const { open } = c.req.valid('query')
    const list = await services.incidents.listForHub(hubId, categories, { openOnly: open === 'true' })
    return c.json({ incidents: list })
  },
)

export default incidents
