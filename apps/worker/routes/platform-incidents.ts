/**
 * GET /incidents/platform — incidents that belong to no hub (#2347).
 *
 * An erasure whose subject belongs to no hub has nowhere to open a hub
 * incident, so it opens one here. Read ONLY with the platform permission
 * (`system:manage-instance`), resolved from the caller's global roles — a hub
 * role never grants it, so a hub's erasure admins do not see these. Aggregate
 * counts only, like every incident.
 */
import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '../types/infra'
import { platformIncidentListResponseSchema, listIncidentsQuerySchema } from '@protocol/schemas/incidents'
import { requirePermission } from '../middleware/permission-guard'
import { PLATFORM_INCIDENT_PERMISSION } from '../services/incidents-categories'
import { authErrors } from '../openapi/helpers'

const platformIncidents = new Hono<AppEnv>()

platformIncidents.get('/',
  describeRoute({
    tags: ['Incidents'],
    summary: 'List the platform-level incidents (no hub)',
    description:
      'Open (and, unless open=true, recently closed) incidents that concern the instance rather than a hub. ' +
      'Requires the platform permission.',
    responses: {
      200: {
        description: 'Platform incidents',
        content: { 'application/json': { schema: resolver(platformIncidentListResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  requirePermission(PLATFORM_INCIDENT_PERMISSION),
  validator('query', listIncidentsQuerySchema),
  async (c) => {
    const { open } = c.req.valid('query')
    const incidents = await c.get('services').incidents.listPlatform({ openOnly: open === 'true' })
    return c.json({ incidents })
  },
)

export default platformIncidents
