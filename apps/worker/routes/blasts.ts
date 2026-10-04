import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '../types'
import { requirePermission } from '../middleware/permission-guard'
import { listBlastsQuerySchema, listSubscribersQuerySchema, listDeliveriesQuerySchema, createBlastBodySchema, updateBlastBodySchema, scheduleBlastBodySchema, importSubscribersBodySchema, updateBlastSettingsBodySchema, blastResponseSchema, subscriberStatsResponseSchema, blastSettingsResponseSchema, subscriberListResponseSchema, blastListResponseSchema, blastDeliveryListResponseSchema, importSubscribersResponseSchema, blastDeliveryResponseSchema } from '@protocol/schemas/blasts'
import type { BlastContent, MultiBlastContent } from '@shared/types'
import { okResponseSchema } from '@protocol/schemas/common'
import { authErrors } from '../openapi/helpers'
import { createLogger } from '../lib/logger'
import { backgroundTask } from '../lib/hono-compat'
import { publishEvent } from '../lib/ws-events'
import { KIND_BLAST_PROGRESS } from '@shared/event-kinds'

const logger = createLogger('routes.blasts')

/**
 * Convert protocol schema content (uses `body` field) to shared type content (uses `text` field).
 * Handles both single-language and multi-language formats.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toStorageContent(input: any): BlastContent | MultiBlastContent {
  if (input && typeof input.body === 'string') {
    // Single-language: { body, mediaUrl? }
    return { text: input.body, mediaUrl: input.mediaUrl }
  }
  // Multi-language: Record<langCode, { body, mediaUrl? }>
  const result: MultiBlastContent = {}
  for (const [lang, entry] of Object.entries(input)) {
    const e = entry as { body: string; mediaUrl?: string }
    result[lang] = { text: e.body, mediaUrl: e.mediaUrl }
  }
  return result
}

const blasts = new Hono<AppEnv>()

// --- Subscribers (static paths BEFORE parameterized) ---
blasts.get('/subscribers/stats',
  describeRoute({
    tags: ['Blasts'],
    summary: 'Get subscriber statistics',
    responses: {
      200: {
        description: 'Subscriber stats',
        content: {
          'application/json': {
            schema: resolver(subscriberStatsResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('blasts:read'),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId')
    const stats = await services.blasts.getSubscriberStats(hubId)
    return c.json(stats)
  },
)

blasts.post('/subscribers/import',
  describeRoute({
    tags: ['Blasts'],
    summary: 'Import subscribers in bulk',
    responses: {
      200: {
        description: 'Import results',
        content: {
          'application/json': {
            schema: resolver(importSubscribersResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('blasts:manage'),
  validator('json', importSubscribersBodySchema),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const body = c.req.valid('json')
    const result = await services.blasts.importBulk(hubId, body.subscribers)
    return c.json(result)
  },
)

blasts.get('/subscribers',
  describeRoute({
    tags: ['Blasts'],
    summary: 'List blast subscribers',
    responses: {
      200: {
        description: 'List of subscribers',
        content: {
          'application/json': {
            schema: resolver(subscriberListResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('blasts:manage'),
  validator('query', listSubscribersQuerySchema),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId')
    const query = c.req.valid('query')

    const result = await services.blasts.listSubscribers({
      hubId,
      tag: query.tag,
      channel: query.channel,
      status: query.status,
      limit: query.limit,
      offset: (query.page - 1) * query.limit,
    })

    return c.json(result)
  },
)

blasts.delete('/subscribers/:id',
  describeRoute({
    tags: ['Blasts'],
    summary: 'Remove a subscriber',
    responses: {
      200: {
        description: 'Subscriber removed',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('blasts:manage'),
  async (c) => {
    const id = c.req.param('id')
    const services = c.get('services')
    await services.blasts.deleteSubscriber(id)
    return c.json({ ok: true })
  },
)

// --- Settings (BEFORE /:id wildcard) ---
blasts.get('/settings',
  describeRoute({
    tags: ['Blasts'],
    summary: 'Get blast settings',
    responses: {
      200: {
        description: 'Blast settings',
        content: {
          'application/json': {
            schema: resolver(blastSettingsResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('blasts:read'),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const settings = await services.blasts.getBlastSettings(hubId)
    return c.json(settings)
  },
)

blasts.patch('/settings',
  describeRoute({
    tags: ['Blasts'],
    summary: 'Update blast settings',
    responses: {
      200: {
        description: 'Blast settings updated',
        content: {
          'application/json': {
            schema: resolver(blastSettingsResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('blasts:manage'),
  validator('json', updateBlastSettingsBodySchema),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const body = c.req.valid('json')
    const settings = await services.blasts.updateBlastSettings(hubId, body)
    return c.json(settings)
  },
)

// --- Blasts ---
blasts.get('/',
  describeRoute({
    tags: ['Blasts'],
    summary: 'List blasts',
    responses: {
      200: {
        description: 'Paginated list of blasts',
        content: {
          'application/json': {
            schema: resolver(blastListResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('blasts:read'),
  validator('query', listBlastsQuerySchema),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId')
    const query = c.req.valid('query')

    let allBlasts = await services.blasts.listBlasts(hubId)

    // Apply status filter
    if (query.status) {
      allBlasts = allBlasts.filter(b => b.status === query.status)
    }

    // Apply pagination at route level (service returns all)
    const total = allBlasts.length
    const offset = (query.page - 1) * query.limit
    const paged = allBlasts.slice(offset, offset + query.limit)

    return c.json({ blasts: paged, total, page: query.page, limit: query.limit })
  },
)

blasts.post('/',
  describeRoute({
    tags: ['Blasts'],
    summary: 'Create a new blast',
    responses: {
      201: {
        description: 'Blast created',
        content: {
          'application/json': {
            schema: resolver(blastResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('blasts:send'),
  validator('json', createBlastBodySchema),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId')
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')
    let blast = await services.blasts.createBlast({
      hubId,
      name: body.name,
      content: toStorageContent(body.content),
      defaultLanguage: body.defaultLanguage,
      targetChannels: body.channels,
      createdBy: pubkey,
    })
    if (body.scheduledAt) {
      blast = await services.blasts.schedule(blast.id, body.scheduledAt)
    }
    return c.json({ blast }, 201)
  },
)

// --- Parameterized blast routes (/:id AFTER static paths) ---
blasts.get('/:id',
  describeRoute({
    tags: ['Blasts'],
    summary: 'Get a single blast',
    responses: {
      200: {
        description: 'Blast details',
        content: {
          'application/json': {
            schema: resolver(blastResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('blasts:read'),
  async (c) => {
    const id = c.req.param('id')
    const services = c.get('services')
    const blast = await services.blasts.getBlast(id)
    return c.json(blast)
  },
)

blasts.patch('/:id',
  describeRoute({
    tags: ['Blasts'],
    summary: 'Update a blast',
    responses: {
      200: {
        description: 'Blast updated',
        content: {
          'application/json': {
            schema: resolver(blastResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('blasts:send'),
  validator('json', updateBlastBodySchema),
  async (c) => {
    const id = c.req.param('id')
    const services = c.get('services')
    const body = c.req.valid('json')
    const updateInput: import('../services/blasts').UpdateBlastInput = {}
    if (body.name !== undefined) updateInput.name = body.name
    if (body.content !== undefined) updateInput.content = toStorageContent(body.content)
    if (body.defaultLanguage !== undefined) updateInput.defaultLanguage = body.defaultLanguage
    if (body.channels !== undefined) updateInput.targetChannels = body.channels
    const blast = await services.blasts.updateBlast(id, updateInput)
    return c.json({ blast })
  },
)

blasts.delete('/:id',
  describeRoute({
    tags: ['Blasts'],
    summary: 'Delete a blast',
    responses: {
      200: {
        description: 'Blast deleted',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('blasts:manage'),
  async (c) => {
    const id = c.req.param('id')
    const services = c.get('services')
    await services.blasts.deleteBlast(id)
    return c.json({ ok: true })
  },
)

blasts.post('/:id/send',
  describeRoute({
    tags: ['Blasts'],
    summary: 'Send a blast immediately',
    responses: {
      200: {
        description: 'Blast sent',
        content: {
          'application/json': {
            schema: resolver(blastResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('blasts:send'),
  async (c) => {
    const id = c.req.param('id')
    const services = c.get('services')
    const hubId = c.get('hubId')
    const blast = await services.blasts.send(id, hubId)

    // Expand blast into delivery rows (background)
    backgroundTask(c,
      services.blasts.expandBlast(id).catch((err) => {
        logger.error(`Failed to expand blast ${id}`, err)
      })
    )

    return c.json({ blast })
  },
)

blasts.post('/:id/schedule',
  describeRoute({
    tags: ['Blasts'],
    summary: 'Schedule a blast for later delivery',
    responses: {
      200: {
        description: 'Blast scheduled',
        content: {
          'application/json': {
            schema: resolver(blastResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('blasts:schedule'),
  validator('json', scheduleBlastBodySchema),
  async (c) => {
    const id = c.req.param('id')
    const services = c.get('services')
    const body = c.req.valid('json')
    const blast = await services.blasts.schedule(id, body.scheduledAt)
    return c.json({ blast })
  },
)

blasts.post('/:id/cancel',
  describeRoute({
    tags: ['Blasts'],
    summary: 'Cancel a scheduled blast',
    responses: {
      200: {
        description: 'Blast cancelled',
        content: {
          'application/json': {
            schema: resolver(blastResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('blasts:schedule'),
  async (c) => {
    const id = c.req.param('id')
    const services = c.get('services')
    const blast = await services.blasts.cancel(id)
    return c.json({ blast })
  },
)

// --- Delivery tracking ---
blasts.get('/:id/stats',
  describeRoute({
    tags: ['Blasts'],
    summary: 'Get live delivery stats for a blast',
    responses: {
      200: {
        description: 'Blast delivery stats',
        content: { 'application/json': { schema: resolver(subscriberStatsResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  requirePermission('blasts:read'),
  async (c) => {
    const id = c.req.param('id')
    const services = c.get('services')
    const stats = await services.blasts.computeBlastStats(id)
    return c.json(stats)
  },
)

blasts.get('/:id/deliveries',
  describeRoute({
    tags: ['Blasts'],
    summary: 'List deliveries for a blast (paginated)',
    responses: {
      200: {
        description: 'Delivery list',
        content: { 'application/json': { schema: resolver(blastDeliveryListResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  requirePermission('blasts:read'),
  validator('query', listDeliveriesQuerySchema),
  async (c) => {
    const id = c.req.param('id')
    const services = c.get('services')
    const query = c.req.valid('query')

    const result = await services.blasts.getDeliveries(id, {
      status: query.status,
      limit: query.limit,
      offset: (query.page - 1) * query.limit,
    })

    return c.json({ deliveries: result.deliveries, total: result.total, page: query.page, limit: query.limit })
  },
)

blasts.post('/:id/deliveries/:deliveryId/retry',
  describeRoute({
    tags: ['Blasts'],
    summary: 'Retry a single failed delivery',
    responses: {
      200: {
        description: 'Delivery reset to pending',
        content: {
          'application/json': {
            schema: resolver(blastDeliveryResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('blasts:send'),
  async (c) => {
    const blastId = c.req.param('id')
    const deliveryId = c.req.param('deliveryId')
    const hubId = c.get('hubId')
    const services = c.get('services')
    const delivery = await services.blasts.retryDelivery(blastId, deliveryId)
    // Emit progress event so UI updates in real-time
    backgroundTask(c,
      services.blasts.computeBlastStats(blastId).then((stats) => {
        publishEvent(c.env, KIND_BLAST_PROGRESS, { type: 'blast:progress', hubId, blastId, stats, batch: [] }, hubId ?? '')
      }).catch((err) => {
        logger.warn('Failed to emit blast progress after retryDelivery', err)
      })
    )
    return c.json({ ok: true, delivery })
  },
)

blasts.post('/:id/retry-failed',
  describeRoute({
    tags: ['Blasts'],
    summary: 'Retry all failed deliveries for a blast',
    responses: {
      200: {
        description: 'Failed deliveries reset to pending',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('blasts:send'),
  async (c) => {
    const blastId = c.req.param('id')
    const hubId = c.get('hubId')
    const services = c.get('services')
    const retriedCount = await services.blasts.retryFailedDeliveries(blastId)
    // Emit progress event so UI updates in real-time
    backgroundTask(c,
      services.blasts.computeBlastStats(blastId).then((stats) => {
        publishEvent(c.env, KIND_BLAST_PROGRESS, { type: 'blast:progress', hubId, blastId, stats, batch: [] }, hubId ?? '')
      }).catch((err) => {
        logger.warn('Failed to emit blast progress after retryFailedDeliveries', err)
      })
    )
    return c.json({ ok: true, retriedCount })
  },
)

export default blasts
