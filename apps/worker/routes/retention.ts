import { Hono } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import { validator } from '../openapi/validator'
import type { AppEnv } from '../types'
import { requirePermission } from '../middleware/permission-guard'
import {
  retentionSettingsResponseSchema,
  retentionFloorsResponseSchema,
  updateRetentionBodySchema,
  updateRetentionFloorsBodySchema,
} from '@protocol/schemas/retention'
import { authErrors } from '../openapi/helpers'
import { audit } from '../services/audit'

const retention = new Hono<AppEnv>()

retention.get(
  '/',
  describeRoute({
    tags: ['Retention'],
    summary: 'Get hub retention settings',
    responses: {
      200: {
        description: 'Hub retention settings',
        content: {
          'application/json': {
            schema: resolver(retentionSettingsResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('retention:manage'),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId')
    if (!hubId) {
      return c.json({ error: 'Hub context required' }, 400)
    }
    const settings = await services.retention.getSettings(hubId)
    return c.json({
      settings: settings.map((s) => ({
        hubId: s.hubId,
        category: s.category,
        retentionDays: s.retentionDays,
        updatedAt: s.updatedAt?.toISOString() ?? '',
        updatedBy: s.updatedBy,
      })),
    })
  },
)

retention.patch(
  '/',
  describeRoute({
    tags: ['Retention'],
    summary: 'Update hub retention settings',
    responses: {
      200: {
        description: 'Retention settings updated',
        content: {
          'application/json': {
            schema: resolver(retentionSettingsResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('retention:manage'),
  validator('json', updateRetentionBodySchema),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const hubId = c.get('hubId')
    if (!hubId) {
      return c.json({ error: 'Hub context required' }, 400)
    }
    const body = c.req.valid('json')

    await services.retention.upsertSettings(hubId, body.settings, pubkey)

    await audit(
      services.audit,
      'retentionSettingsUpdated',
      pubkey,
      { categories: body.settings.map((s: { category: string }) => s.category) },
      undefined,
      hubId,
    )

    const settings = await services.retention.getSettings(hubId)
    return c.json({
      settings: settings.map((s) => ({
        hubId: s.hubId,
        category: s.category,
        retentionDays: s.retentionDays,
        updatedAt: s.updatedAt?.toISOString() ?? '',
        updatedBy: s.updatedBy,
      })),
    })
  },
)

retention.get(
  '/platform-floors',
  describeRoute({
    tags: ['Retention'],
    summary: 'Get platform retention floors',
    responses: {
      200: {
        description: 'Platform retention floors',
        content: {
          'application/json': {
            schema: resolver(retentionFloorsResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('system:manage-instance'),
  async (c) => {
    const services = c.get('services')
    const floors = await services.retention.getFloors()
    return c.json({
      floors: floors.map((f) => ({
        category: f.category,
        minRetentionDays: f.minRetentionDays,
        updatedAt: f.updatedAt?.toISOString() ?? '',
        updatedBy: f.updatedBy,
      })),
    })
  },
)

retention.patch(
  '/platform-floors',
  describeRoute({
    tags: ['Retention'],
    summary: 'Update platform retention floors',
    responses: {
      200: {
        description: 'Platform floors updated',
        content: {
          'application/json': {
            schema: resolver(retentionFloorsResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('system:manage-instance'),
  validator('json', updateRetentionFloorsBodySchema),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')

    await services.retention.upsertFloors(body.floors, pubkey)

    await audit(services.audit, 'retentionFloorsUpdated', pubkey, {
      floors: body.floors,
    }, undefined, c.get('hubId') ?? null)

    const floors = await services.retention.getFloors()
    return c.json({
      floors: floors.map((f) => ({
        category: f.category,
        minRetentionDays: f.minRetentionDays,
        updatedAt: f.updatedAt?.toISOString() ?? '',
        updatedBy: f.updatedBy,
      })),
    })
  },
)

export default retention
