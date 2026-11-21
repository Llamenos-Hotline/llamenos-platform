import { Hono } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import { validator } from '../openapi/validator'
import { z } from 'zod'
import type { AppEnv } from '../types'
import { requirePermission } from '../middleware/permission-guard'
import { checkRateLimit } from '../lib/helpers'
import { authErrors } from '../openapi/helpers'
import { providerTemplateSchema } from '@protocol/schemas/provider-setup'
import { okResponseSchema } from '@protocol/schemas/common'
import { ProviderApiError } from '../services/provider-setup/types'

const providerTemplatesRoute = new Hono<AppEnv>()

// ── List Templates ─────────────────────────────────────────────────────────
providerTemplatesRoute.get('/',
  requirePermission('telephony:view-providers'),
  describeRoute({
    tags: ['Provider Templates'],
    summary: 'List active provider templates',
    responses: {
      200: {
        description: 'List of provider templates',
        content: {
          'application/json': {
            schema: resolver(z.object({ templates: z.array(providerTemplateSchema) })),
          },
        },
      },
      ...authErrors,
    },
  }),
  async (c) => {
    const services = c.get('services')
    const templates = await services.providerTemplates.listTemplates(true)
    return c.json({ templates })
  },
)

// ── Get Template ───────────────────────────────────────────────────────────
providerTemplatesRoute.get('/:id',
  requirePermission('telephony:view-providers'),
  describeRoute({
    tags: ['Provider Templates'],
    summary: 'Get a provider template by ID',
    responses: {
      200: {
        description: 'Provider template',
        content: {
          'application/json': {
            schema: resolver(z.object({ template: providerTemplateSchema })),
          },
        },
      },
      404: { description: 'Template not found' },
      ...authErrors,
    },
  }),
  async (c) => {
    const services = c.get('services')
    const id = c.req.param('id')
    const template = await services.providerTemplates.getTemplate(id)
    if (!template) {
      return c.json({ error: 'Template not found' }, 404)
    }
    return c.json({ template })
  },
)

// ── Create Template ────────────────────────────────────────────────────────
providerTemplatesRoute.post('/',
  requirePermission('system:manage-instance'),
  describeRoute({
    tags: ['Provider Templates'],
    summary: 'Create a provider template',
    responses: {
      201: {
        description: 'Template created',
        content: {
          'application/json': {
            schema: resolver(z.object({ template: providerTemplateSchema })),
          },
        },
      },
      409: { description: 'Slug already exists' },
      ...authErrors,
    },
  }),
  validator('json', z.object({
    name: z.string().min(1),
    slug: z.string().min(1),
    description: z.string().optional(),
    providerType: z.enum(['twilio', 'signalwire', 'vonage', 'plivo', 'asterisk', 'telnyx', 'bandwidth', 'freeswitch']),
    defaultChannels: z.array(z.enum(['voice', 'sms', 'email', 'signal', 'whatsapp', 'telegram', 'rcs'])).optional(),
    credentialHints: z.object({}).passthrough().optional(),
    recommendedSettings: z.object({}).passthrough().optional(),
    allowSubAccounts: z.boolean().optional(),
  })),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')

    const limited = await checkRateLimit(services.settings, `provider-template-create:${pubkey}`, 5)
    if (limited) {
      return c.json({ error: 'Rate limit exceeded' }, 429)
    }

    try {
      const template = await services.providerTemplates.createTemplate({
        ...body,
        createdBy: pubkey,
        isActive: true,
      })
      return c.json({ template }, 201)
    } catch (err) {
      if (err instanceof ProviderApiError) {
        return c.json({ error: err.message }, err.statusCode as 400 | 409)
      }
      throw err
    }
  },
)

// ── Update Template ────────────────────────────────────────────────────────
providerTemplatesRoute.put('/:id',
  requirePermission('system:manage-instance'),
  describeRoute({
    tags: ['Provider Templates'],
    summary: 'Update a provider template',
    responses: {
      200: {
        description: 'Template updated',
        content: {
          'application/json': {
            schema: resolver(z.object({ template: providerTemplateSchema })),
          },
        },
      },
      404: { description: 'Template not found' },
      ...authErrors,
    },
  }),
  validator('json', z.object({
    name: z.string().min(1).optional(),
    slug: z.string().min(1).optional(),
    description: z.string().optional(),
    providerType: z.enum(['twilio', 'signalwire', 'vonage', 'plivo', 'asterisk', 'telnyx', 'bandwidth', 'freeswitch']).optional(),
    defaultChannels: z.array(z.enum(['voice', 'sms', 'email', 'signal', 'whatsapp', 'telegram', 'rcs'])).optional(),
    credentialHints: z.object({}).passthrough().optional(),
    recommendedSettings: z.object({}).passthrough().optional(),
    allowSubAccounts: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })),
  async (c) => {
    const services = c.get('services')
    const id = c.req.param('id')
    const body = c.req.valid('json')

    try {
      const template = await services.providerTemplates.updateTemplate(id, body)
      return c.json({ template })
    } catch (err) {
      if (err instanceof ProviderApiError) {
        return c.json({ error: err.message }, err.statusCode as 404 | 409)
      }
      throw err
    }
  },
)

// ── Deactivate Template ────────────────────────────────────────────────────
providerTemplatesRoute.delete('/:id',
  requirePermission('system:manage-instance'),
  describeRoute({
    tags: ['Provider Templates'],
    summary: 'Deactivate a provider template',
    responses: {
      200: {
        description: 'Template deactivated',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      404: { description: 'Template not found' },
      ...authErrors,
    },
  }),
  async (c) => {
    const services = c.get('services')
    const id = c.req.param('id')

    try {
      await services.providerTemplates.deactivateTemplate(id)
      return c.json({ ok: true })
    } catch (err) {
      if (err instanceof ProviderApiError) {
        return c.json({ error: err.message }, err.statusCode as 404)
      }
      throw err
    }
  },
)

export default providerTemplatesRoute
