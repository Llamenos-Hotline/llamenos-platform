import { Hono } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import { validator } from '../openapi/validator'
import type { AppEnv } from '../types'
import { requirePermission } from '../middleware/permission-guard'
import {
  platformSettingsResponseSchema,
  updatePlatformSettingsBodySchema,
} from '@protocol/schemas/platform-settings'
import { authErrors } from '../openapi/helpers'
import { audit } from '../services/audit'

const platformSettings = new Hono<AppEnv>()

platformSettings.get(
  '/',
  describeRoute({
    tags: ['Platform Settings'],
    summary: 'Read platform settings',
    responses: {
      200: {
        description: 'Platform settings',
        content: {
          'application/json': {
            schema: resolver(platformSettingsResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('system:manage-instance'),
  async (c) => {
    const services = c.get('services')
    const settings = await services.platformSettings.getPlatformSettings()
    return c.json({ settings })
  },
)

platformSettings.patch(
  '/',
  describeRoute({
    tags: ['Platform Settings'],
    summary: 'Update platform settings',
    responses: {
      200: {
        description: 'Platform settings updated',
        content: {
          'application/json': {
            schema: resolver(platformSettingsResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('system:manage-instance'),
  validator('json', updatePlatformSettingsBodySchema),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')

    const updated = await services.platformSettings.updatePlatformSettings(
      body as Record<string, unknown>,
    )

    await audit(services.audit, 'platformSettingsUpdated', pubkey, {
      updatedSections: Object.keys(body),
    }, undefined, null)

    return c.json({ settings: updated })
  },
)

export default platformSettings
