/**
 * Signal-specific admin routes for identity trust management
 * and message queue monitoring.
 *
 * All routes require admin permissions.
 */

import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import { z } from 'zod'
import type { AppEnv } from '../types'
import { requirePermission } from '../middleware/permission-guard'
import { SignalIdentityService } from '../messaging/signal/identity'
import { SignalMessageQueue } from '../messaging/signal/queue'
import { getDb } from '../db'
import { audit } from '../services/audit'
import {
  signalIdentityRecordSchema,
  signalQueueStatsSchema,
  signalTrustLevelSchema,
} from '@protocol/schemas/signal-notification'
import { authErrors } from '../openapi/helpers'

const signal = new Hono<AppEnv>()

// --- Identity Trust Management ---

signal.get('/identities',
  describeRoute({
    tags: ['Signal'],
    summary: 'List all Signal identity records for a hub',
    responses: {
      200: {
        description: 'Identity records with trust levels',
        content: {
          'application/json': {
            schema: resolver(z.object({ identities: z.array(signalIdentityRecordSchema) })),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-messaging'),
  async (c) => {
    const hubId = c.req.query('hub') || ''
    const db = getDb()
    const identityService = new SignalIdentityService(db)
    const identities = await identityService.getIdentities(hubId)
    return c.json({ identities })
  })

signal.get('/identities/untrusted',
  describeRoute({
    tags: ['Signal'],
    summary: 'List untrusted Signal identity records requiring review',
    responses: {
      200: {
        description: 'Untrusted identity records',
        content: {
          'application/json': {
            schema: resolver(z.object({ identities: z.array(signalIdentityRecordSchema) })),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-messaging'),
  async (c) => {
    const hubId = c.req.query('hub') || ''
    const db = getDb()
    const identityService = new SignalIdentityService(db)
    const identities = await identityService.getUntrustedIdentities(hubId)
    return c.json({ identities })
  })

const trustBodySchema = z.object({
  uuid: z.string().min(1),
  trustLevel: signalTrustLevelSchema,
  hubId: z.string().optional(),
})

signal.post('/identities/trust',
  describeRoute({
    tags: ['Signal'],
    summary: 'Set trust level for a Signal identity',
    responses: {
      200: {
        description: 'Trust level updated',
        content: { 'application/json': { schema: resolver(z.object({ success: z.boolean() })) } },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-messaging'),
  validator('json', trustBodySchema),
  async (c) => {
    const body = c.req.valid('json')
    const { uuid, trustLevel, hubId } = body
    const user = c.get('user')

    const services = c.get('services')
    const db = getDb()
    const identityService = new SignalIdentityService(db)

    const success = await identityService.setTrustLevel({
      hubId: hubId || '',
      uuid,
      trustLevel,
      verifierPubkey: user.pubkey,
    })

    if (success) {
      await audit(services.audit, 'signalIdentityTrustChanged', user.pubkey, {
        uuid: uuid.slice(0, 8),
        trustLevel,
      }, undefined, c.get('hubId') ?? null)
    }

    return c.json({ success })
  })

// --- Message Queue Monitoring ---

signal.get('/queue/stats',
  describeRoute({
    tags: ['Signal'],
    summary: 'Get Signal message queue statistics',
    responses: {
      200: {
        description: 'Queue counts by status',
        content: { 'application/json': { schema: resolver(signalQueueStatsSchema) } },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-messaging'),
  async (c) => {
    const hubId = c.req.query('hub') || undefined
    const db = getDb()
    const queue = new SignalMessageQueue(db, c.env.HMAC_SECRET)
    const stats = await queue.getStats(hubId)
    return c.json(stats)
  })

signal.get('/queue/dead-letters',
  describeRoute({
    tags: ['Signal'],
    summary: 'List dead-letter Signal messages that exceeded retry limit',
    responses: {
      200: {
        description: 'Dead-letter queue entries',
        content: { 'application/json': { schema: resolver(z.object({ deadLetters: z.array(z.unknown()) })) } },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-messaging'),
  async (c) => {
    const hubId = c.req.query('hub') || undefined
    const db = getDb()
    const queue = new SignalMessageQueue(db, c.env.HMAC_SECRET)
    const deadLetters = await queue.getDeadLetters(hubId)
    return c.json({ deadLetters })
  })

signal.post('/queue/retry/:id',
  describeRoute({
    tags: ['Signal'],
    summary: 'Retry a dead-letter Signal message',
    responses: {
      200: {
        description: 'Retry enqueued',
        content: { 'application/json': { schema: resolver(z.object({ success: z.boolean() })) } },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-messaging'),
  async (c) => {
    const messageId = c.req.param('id')
    const services = c.get('services')
    const db = getDb()
    const queue = new SignalMessageQueue(db, c.env.HMAC_SECRET)
    const success = await queue.retryDeadLetter(messageId)

    if (success) {
      const user = c.get('user')
      await audit(services.audit, 'signalQueueMessageRetried', user.pubkey, { messageId }, undefined, c.get('hubId') ?? null)
    }

    return c.json({ success })
  })

export default signal
