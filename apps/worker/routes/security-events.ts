/**
 * Security event API routes.
 *
 * GET /api/security-events — List security events for authenticated user.
 * GET /api/admin/security-events — Admin: list all security events.
 * POST /api/security-events — UNAUTHENTICATED client-reported events (cert pin mismatch).
 */

import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '../types'
import { requirePermission } from '../middleware/permission-guard'
import { rateLimit } from '../middleware/rate-limit'
import { listSecurityEventsQuerySchema } from '@protocol/schemas/devices'
import {
  submitClientSecurityEventsBodySchema,
  submitClientSecurityEventsResponseSchema,
} from '../schemas/client-security-events'
import { publicErrors } from '../openapi/helpers'
import { routeRateLimitClient } from '../lib/route-rate-limit'
import { checkRateLimit } from '../lib/helpers'
import { createLogger } from '../lib/logger'

const log = createLogger('routes.security-events')

/** Submissions per minute per client IP. A pin failure is rare; a flood is abuse. */
const SUBMIT_MAX_PER_MINUTE = 5
/** 20 events × 16 pins × ~64 chars stays well under this; anything larger is rejected pre-parse. */
const SUBMIT_MAX_BODY_BYTES = 16 * 1024
/** At most one admin Signal alert per window, regardless of how many submissions arrive. */
const ADMIN_ALERT_WINDOW_MS = 15 * 60_000

const securityEventsRoutes = new Hono<AppEnv>()

/**
 * GET /api/security-events
 * List security events for the authenticated user (own events only).
 */
securityEventsRoutes.get('/',
  rateLimit('read'),
  validator('query', listSecurityEventsQuerySchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const { limit, offset } = c.req.valid('query')
    const services = c.get('services')

    const { events, total } = await services.identity.listSecurityEvents(pubkey, limit, offset)

    return c.json({
      events: events.map(e => ({
        id: e.id,
        eventType: e.eventType,
        deviceId: e.deviceId,
        metadata: e.metadata,
        ipHash: e.ipHash,
        createdAt: e.createdAt.toISOString(),
      })),
      total,
    })
  })

export default securityEventsRoutes

// --- Admin security events (separate router, mounted at /api/admin/security-events) ---

export const adminSecurityEventsRoutes = new Hono<AppEnv>()

adminSecurityEventsRoutes.get('/',
  rateLimit('read'),
  requirePermission('audit:read'),
  validator('query', listSecurityEventsQuerySchema),
  async (c) => {
    const { limit, offset } = c.req.valid('query')
    const services = c.get('services')

    const { events, total } = await services.identity.listAllSecurityEvents(limit, offset)

    return c.json({
      events: events.map(e => ({
        id: e.id,
        eventType: e.eventType,
        deviceId: e.deviceId,
        metadata: e.metadata,
        ipHash: e.ipHash,
        createdAt: e.createdAt.toISOString(),
      })),
      total,
    })
  })

// --- Unauthenticated client submission (mounted at /api/security-events, before auth) ---

export const publicSecurityEventsRoutes = new Hono<AppEnv>()

/**
 * POST /api/security-events
 *
 * Accepts certificate-pin-mismatch reports from clients that cannot authenticate
 * (the pin failure happens before login). Privacy: neither the client IP nor any
 * device identifier is stored on the event — the IP is only HMAC-hashed into a
 * short-lived rate-limit bucket key.
 */
publicSecurityEventsRoutes.post('/',
  describeRoute({
    tags: ['Security'],
    summary: 'Report client-observed security events (unauthenticated)',
    responses: {
      202: {
        description: 'Events recorded',
        content: { 'application/json': { schema: resolver(submitClientSecurityEventsResponseSchema) } },
      },
      413: { description: 'Body too large' },
      429: { description: 'Rate limit exceeded' },
      ...publicErrors,
    },
  }),
  // Always enforced (unlike rateLimit('strict'), which is skipped in development) and
  // counted before validation so malformed floods are throttled too.
  async (c, next) => {
    const ipKey = `security-events-submit:${routeRateLimitClient(c)}`
    if (await checkRateLimit(c.get('services').settings, ipKey, SUBMIT_MAX_PER_MINUTE)) {
      return c.json({ error: 'Too many requests. Try again later.' }, 429)
    }
    return next()
  },
  bodyLimit({
    maxSize: SUBMIT_MAX_BODY_BYTES,
    onError: (c) => c.json({ error: 'Payload too large' }, 413),
  }),
  validator('json', submitClientSecurityEventsBodySchema),
  async (c) => {
    const services = c.get('services')
    const { events } = c.req.valid('json')

    for (const event of events) {
      await services.identity.emitSecurityEvent(null, event.event_type, null, {
        source: 'client',
        occurredAt: event.occurred_at,
        appVersion: event.app_version,
        osVersion: event.os_version,
        pinIdentifiers: event.pin_identifiers,
      })
    }
    await services.audit.log('cert_pin_mismatch_reported', 'system', { eventCount: events.length })

    // Alert admins, throttled globally so an unauthenticated flood cannot spam Signal.
    // Fire-and-forget: the client must not wait on notifier retries.
    void alertAdmins(services, events.length).catch((err) => {
      log.error('Failed to dispatch cert pin mismatch alert', { err: String(err) })
    })

    return c.json({ accepted: events.length }, 202)
  })

async function alertAdmins(services: AppEnv['Variables']['services'], eventCount: number): Promise<void> {
  const throttle = await services.settings.checkApiRateLimit('security-events-admin-alert', 1, ADMIN_ALERT_WINDOW_MS)
  if (throttle.limited) return
  const adminPubkeys = await services.identity.listActiveSuperAdminPubkeys()
  await Promise.allSettled(
    adminPubkeys.map((pubkey) =>
      services.userNotifications.sendAlert(pubkey, { type: 'cert_pin_mismatch', eventCount }),
    ),
  )
}
