/**
 * Analytics routes — admin dashboard metrics.
 *
 * Mounted at both hub-scoped (/api/hubs/:hubId/analytics/*) and platform-scoped (/api/analytics/*).
 * Hub-scoped routes filter by hubId; platform-scoped routes aggregate cross-hub (hubId = undefined).
 * Most endpoints require `audit:read` permission. Platform-scoped access requires super-admin (*).
 * Date range via `?from=ISO&to=ISO` query params (default: last 30 days).
 */
import { Hono } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import { validator } from '../openapi/validator'
import type { AppEnv } from '../types'
import { requirePermission } from '../middleware/permission-guard'
import { AnalyticsService } from '../services/analytics'
import { authErrors } from '../openapi/helpers'
import {
  analyticsDateRangeQuerySchema,
  callMetricsResponseSchema,
  conversationMetricsResponseSchema,
  shiftMetricsResponseSchema,
  analyticsSystemHealthResponseSchema,
  hourlyDistributionResponseSchema,
  userStatsResponseSchema,
  personalStatsResponseSchema,
} from '@protocol/schemas/analytics'

const analytics = new Hono<AppEnv>()

function parseDateRange(query: { from?: string; to?: string }): Partial<{
  from: Date
  to: Date
}> {
  const result: Partial<{ from: Date; to: Date }> = {}
  if (query.from) result.from = new Date(query.from)
  if (query.to) result.to = new Date(query.to)
  return result
}

async function getAnalyticsService(): Promise<AnalyticsService> {
  const { getDb } = await import('../db')
  return new AnalyticsService(getDb())
}

// ── GET /api/analytics/calls ──

analytics.get(
  '/calls',
  describeRoute({
    tags: ['Analytics'],
    summary: 'Call volume, duration, and answer rate metrics',
    responses: {
      200: {
        description: 'Call metrics for the requested date range',
        content: { 'application/json': { schema: resolver(callMetricsResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  requirePermission('audit:read'),
  validator('query', analyticsDateRangeQuerySchema),
  async (c) => {
    const hubId = c.get('hubId') ?? undefined
    const service = await getAnalyticsService()
    const range = parseDateRange(c.req.valid('query'))
    return c.json(await service.getCallMetrics(hubId ?? '', range))
  },
)

// ── GET /api/analytics/conversations ──

analytics.get(
  '/conversations',
  describeRoute({
    tags: ['Analytics'],
    summary: 'Conversation and message statistics by channel',
    responses: {
      200: {
        description: 'Conversation metrics for the requested date range',
        content: { 'application/json': { schema: resolver(conversationMetricsResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  requirePermission('audit:read'),
  validator('query', analyticsDateRangeQuerySchema),
  async (c) => {
    const hubId = c.get('hubId') ?? undefined
    const service = await getAnalyticsService()
    const range = parseDateRange(c.req.valid('query'))
    return c.json(await service.getConversationMetrics(hubId ?? '', range))
  },
)

// ── GET /api/analytics/shifts ──

analytics.get(
  '/shifts',
  describeRoute({
    tags: ['Analytics'],
    summary: 'Shift coverage hours, gaps, and volunteer availability',
    responses: {
      200: {
        description: 'Shift coverage metrics',
        content: { 'application/json': { schema: resolver(shiftMetricsResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  requirePermission('audit:read'),
  async (c) => {
    const hubId = c.get('hubId') ?? undefined
    const service = await getAnalyticsService()
    return c.json(await service.getShiftMetrics(hubId ?? ''))
  },
)

// ── GET /api/analytics/health ──

analytics.get(
  '/health',
  describeRoute({
    tags: ['Analytics'],
    summary: 'System health — active connections, queue depths, service status',
    responses: {
      200: {
        description: 'Current system health snapshot',
        content: { 'application/json': { schema: resolver(analyticsSystemHealthResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  requirePermission('audit:read'),
  async (c) => {
    const hubId = c.get('hubId') ?? undefined
    const service = await getAnalyticsService()
    return c.json(await service.getSystemHealth(hubId ?? ''))
  },
)

// ── GET /api/analytics/hours ──

analytics.get(
  '/hours',
  describeRoute({
    tags: ['Analytics'],
    summary: 'Hourly call distribution (24 buckets)',
    responses: {
      200: {
        description: 'Call counts grouped by hour of day',
        content: { 'application/json': { schema: resolver(hourlyDistributionResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  requirePermission('audit:read'),
  validator('query', analyticsDateRangeQuerySchema),
  async (c) => {
    const hubId = c.get('hubId') ?? undefined
    const service = await getAnalyticsService()
    const range = parseDateRange(c.req.valid('query'))
    return c.json(await service.getHourlyDistribution(hubId, range))
  },
)

// ── GET /api/analytics/users ──

analytics.get(
  '/users',
  describeRoute({
    tags: ['Analytics'],
    summary: 'Per-user call and note statistics',
    responses: {
      200: {
        description: 'User activity stats sorted by calls answered',
        content: { 'application/json': { schema: resolver(userStatsResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  requirePermission('audit:read'),
  validator('query', analyticsDateRangeQuerySchema),
  async (c) => {
    const hubId = c.get('hubId') ?? undefined
    const service = await getAnalyticsService()
    const range = parseDateRange(c.req.valid('query'))
    return c.json(await service.getUserStats(hubId, range))
  },
)

// ── GET /api/analytics/me ──
// Intentionally no requirePermission — any authenticated user may view their own stats

analytics.get(
  '/me',
  describeRoute({
    tags: ['Analytics'],
    summary: 'Personal call and note stats for the authenticated user',
    responses: {
      200: {
        description: 'Personal activity stats',
        content: { 'application/json': { schema: resolver(personalStatsResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  validator('query', analyticsDateRangeQuerySchema),
  async (c) => {
    const hubId = c.get('hubId') ?? ''
    const userPubkey = c.get('pubkey') ?? ''
    const service = await getAnalyticsService()
    const range = parseDateRange(c.req.valid('query'))
    return c.json(await service.getPersonalStats(hubId, userPubkey, range))
  },
)

export default analytics
