/**
 * Admin device oversight API routes.
 *
 * GET /api/admin/devices/overview — Paginated hub-scoped device overview with verification status.
 */

import { Hono } from 'hono'
import { validator } from '../../openapi/validator'
import type { AppEnv } from '../../types'
import { requirePermission } from '../../middleware/permission-guard'
import { rateLimit } from '../../middleware/rate-limit'
import { adminDeviceOverviewQuerySchema } from '@protocol/schemas/devices'

const adminDevicesRoutes = new Hono<AppEnv>()

/**
 * GET /api/admin/devices/overview
 * Paginated hub-scoped aggregate device stats per user.
 */
adminDevicesRoutes.get('/overview',
  rateLimit('read'),
  requirePermission('users:manage-devices'),
  validator('query', adminDeviceOverviewQuerySchema),
  async (c) => {
    const { hubId, limit, offset } = c.req.valid('query')
    const services = c.get('services')

    const result = await services.identity.getAdminDeviceOverview(hubId, limit, offset)

    return c.json(result)
  })

export default adminDevicesRoutes
