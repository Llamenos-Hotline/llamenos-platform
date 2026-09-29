import { Hono } from 'hono'
import type { AppEnv } from './types'
import { cors } from './middleware/cors'
import { apiVersion } from './middleware/api-version'
import { auth } from './middleware/auth'
import { rateLimit } from './middleware/rate-limit'
import { createMiddleware } from 'hono/factory'
import configRoutes from './routes/config'
import devRoutes from './routes/dev'
import authRoutes from './routes/auth'
import webauthnRoutes from './routes/webauthn'
import usersRoutes from './routes/users'
import invitesRoutes from './routes/invites'
import shiftsRoutes from './routes/shifts'
import bansRoutes from './routes/bans'
import notesRoutes from './routes/notes'
import callsRoutes from './routes/calls'
import auditRoutes from './routes/audit'
import settingsRoutes from './routes/settings'
import telephonyRoutes from './routes/telephony'
import webrtcRoutes from './routes/webrtc'
import messagingRoutes from './messaging/router'
import conversationsRoutes from './routes/conversations'
import uploadsRoutes from './routes/uploads'
import filesRoutes from './routes/files'
import reportsRoutes from './routes/reports'
import setupRoutes from './routes/setup'
import provisioningRoutes from './routes/provisioning'
import hubRoutes from './routes/hubs'
import blastsRoutes from './routes/blasts'
import devicesRoutes from './routes/devices'
import sessionRoutes from './routes/sessions'
import securityEventsRoutes, { adminSecurityEventsRoutes, publicSecurityEventsRoutes } from './routes/security-events'
import accountRoutes from './routes/account'
import adminDevicesRoutes from './routes/admin/devices'
import contactsRoutes from './routes/contacts'
import contactsV2Routes from './routes/contacts-v2'
import recordsRoutes from './routes/records'
import eventsRoutes, { eventsAdminRouter } from './routes/events'
import healthRoutes from './routes/health'
import metricsRoutes from './routes/metrics'
import systemRoutes from './routes/system'
import entitySchemaRoutes from './routes/entity-schema'
import evidenceRoutes from './routes/evidence'
import demoRoutes from './routes/demo'
import geocodingRoutes from './routes/geocoding'
import analyticsRoutes from './routes/analytics'
import sigchainRoutes from './routes/sigchain'
import pukRoutes from './routes/puk'
import mlsRoutes from './routes/mls'
import signalRoutes from './routes/signal'
import firehoseRoutes from './routes/firehose'
import signalNotificationRoutes from './routes/signal-notification'
import providerSetupRoutes from './routes/provider-setup'
import providerTemplatesRoutes from './routes/provider-templates'
import hubOnboardRoutes from './routes/hub-onboard'
import erasureRoutes from './routes/erasure'
import retentionRoutes from './routes/retention'
import platformBansRoutes from './routes/platform-bans'
import platformSettingsRoutes from './routes/platform-settings'
import ringGroupsRoutes from './routes/ring-groups'
import demoTelephonyRoutes from './routes/demo-telephony'
import recoveryGroupRoutes from './routes/recovery-group'
import teamsRoutes from './routes/teams'
import tagsRoutes from './routes/tags'
import { hubContext } from './middleware/hub'
import { requestId } from './middleware/request-id'
import { requestLogger } from './middleware/request-logger'
import { recordHttpRequest } from './routes/metrics'
import { openAPIRouteHandler } from 'hono-openapi'
import { Scalar } from '@scalar/hono-api-reference'
import { openAPIConfig } from './openapi/config'
import { ServiceError } from './services/settings'
import { createLogger } from './lib/logger'
import { devSurfacesEnabled } from './lib/dev-surfaces'

const logger = createLogger('app')

const app = new Hono<AppEnv>()

// --- Global error handler ---
app.onError((err, c) => {
  if (err instanceof ServiceError) {
    return c.json({ error: err.message }, err.status as 400 | 401 | 403 | 404 | 409 | 410 | 429 | 500)
  }
  // Log full error server-side — NEVER expose internals to clients
  logger.error('Unhandled error', { error: err.message, stack: err.stack, path: c.req.path })
  return c.json({ error: 'Internal server error' }, 500)
})

// --- API routes: CORS on all /api/* ---
const api = new Hono<AppEnv>()

// Request ID middleware — first in chain for full correlation coverage
api.use('*', requestId)
api.use('*', requestLogger)

// HTTP metrics middleware — records request duration and counts for Prometheus
api.use('*', async (c, next) => {
  const t0 = performance.now()
  await next()
  const durationSec = (performance.now() - t0) / 1000
  const method = c.req.method
  // Normalize path: strip query params and collapse IDs for cardinality control
  const path = c.req.path.replace(/\/[0-9a-f-]{8,}(\/|$)/gi, '/:id$1')
  recordHttpRequest(method, path, c.res.status, durationSec)
})

// Health check — before CORS middleware (internal probes only, no external access needed)
api.route('/health', healthRoutes)
api.route('/metrics', metricsRoutes)

api.use('*', cors)

// Security headers — defense-in-depth for all API responses
api.use('*', async (c, next) => {
  await next()
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'no-referrer')
  c.header('Cross-Origin-Opener-Policy', 'same-origin')
})

api.use('*', apiVersion)

// Dev route guard — only available when ENVIRONMENT=development AND DEV_ROUTES_ENABLED=true (H04)
const devGuard = createMiddleware<AppEnv>(async (c, next) => {
  if (!devSurfacesEnabled(c.env)) {
    return c.json({ error: 'Not Found' }, 404)
  }
  return next()
})
api.use('/test-*', devGuard)

// --- Rate limiting (H03) — applied per-tier before route handlers ---
// Strict tier: auth/provisioning endpoints (by IP, 5 req/min)
api.use('/auth/*', rateLimit('strict'))
api.use('/webauthn/*', rateLimit('strict'))
api.use('/invites/*', rateLimit('strict'))
api.use('/provision/*', rateLimit('strict'))
api.use('/recovery-group/*', rateLimit('strict'))

// Webhook tier: provider callbacks (by IP, 300 req/min)
api.use('/telephony/*', rateLimit('webhook'))
api.use('/messaging/*', rateLimit('webhook'))

// Public routes (no auth)
api.route('/config', configRoutes)
api.route('/', devRoutes)
api.route('/auth', authRoutes)
api.route('/webauthn', webauthnRoutes)
api.route('/invites', invitesRoutes)

// Device provisioning (mixed auth — room creation is public, payload submission is authenticated)
api.route('/provision', provisioningRoutes)

// Recovery group — unauthenticated endpoints (initiate + verify)
api.route('/recovery-group', recoveryGroupRoutes.public)

// Telephony webhooks (validated by Twilio signature, not our auth)
api.route('/telephony', telephonyRoutes)

// Messaging webhooks (each adapter validates its own signature)
api.route('/messaging', messagingRoutes)

// Public preferences endpoint (no auth, token-validated)
api.get('/messaging/preferences', async (c) => {
  const token = c.req.query('token')
  if (!token) return c.json({ error: 'Token required' }, 400)
  const services = c.get('services')
  const result = await services.blasts.validatePreferenceToken(token)
  return c.json(result)
})

api.patch('/messaging/preferences', async (c) => {
  const token = c.req.query('token')
  if (!token) return c.json({ error: 'Token required' }, 400)
  const services = c.get('services')
  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }
  const result = await services.blasts.updatePreferences(token, body as { language?: string; status?: 'active' | 'paused' | 'unsubscribed'; tags?: string[] })
  return c.json(result)
})

// Client-reported security events (unauthenticated — cert pin failures precede login).
// Only POST is registered here; GET /security-events falls through to the authenticated router.
api.route('/security-events', publicSecurityEventsRoutes)

// Public IVR audio serve (Twilio fetches during calls)
api.get('/ivr-audio/:promptType/:language', async (c) => {
  const services = c.get('services')
  const promptType = c.req.param('promptType')
  const language = c.req.param('language')
  // Validate path params to prevent injection
  if (!/^[a-z_-]+$/.test(promptType) || !/^[a-z]{2,5}(-[A-Z]{2})?$/.test(language)) {
    return c.json({ error: 'Invalid parameters' }, 400)
  }
  const result = await services.settings.getIvrAudio(promptType, language)
  if (!result) return c.json({ error: 'Not found' }, 404)
  // Decode base64 audio to binary for streaming
  const binary = Uint8Array.from(atob(result.audio), c => c.charCodeAt(0))
  return new Response(binary, {
    headers: {
      'Content-Type': 'audio/wav',
      'Content-Length': String(binary.byteLength),
    },
  })
})

// Authenticated routes
const authenticated = new Hono<AppEnv>()
authenticated.use('*', auth)
// Default rate limiting: GET/HEAD/OPTIONS → read tier, mutations → write tier (H03)
authenticated.use('*', async (c, next) => {
  const method = c.req.method
  const tier = (method === 'GET' || method === 'HEAD' || method === 'OPTIONS')
    ? 'read' as const : 'write' as const
  return rateLimit(tier)(c, next)
})
authenticated.route('/users', usersRoutes)
authenticated.route('/volunteers', usersRoutes)
authenticated.route('/shifts', shiftsRoutes)
authenticated.route('/bans', bansRoutes)
authenticated.route('/notes', notesRoutes)
authenticated.route('/calls', callsRoutes)
authenticated.route('/audit', auditRoutes)
authenticated.route('/settings/cms', entitySchemaRoutes)
authenticated.route('/settings', settingsRoutes)
authenticated.route('/telephony', webrtcRoutes)
authenticated.route('/conversations', conversationsRoutes)
authenticated.route('/uploads', uploadsRoutes)
authenticated.route('/files', filesRoutes)
authenticated.route('/reports', reportsRoutes)
authenticated.route('/setup', setupRoutes)
authenticated.route('/hubs', hubRoutes)
authenticated.route('/blasts', blastsRoutes)
authenticated.route('/devices', devicesRoutes)
authenticated.route('/sessions', sessionRoutes)
authenticated.route('/security-events', securityEventsRoutes)
authenticated.route('/admin/security-events', adminSecurityEventsRoutes)
authenticated.route('/account', accountRoutes)
authenticated.route('/admin/devices', adminDevicesRoutes)
authenticated.route('/contacts', contactsRoutes)
authenticated.route('/directory', contactsV2Routes)
authenticated.route('/records', recordsRoutes)
authenticated.route('/events', eventsRoutes)
authenticated.route('/admin/events', eventsAdminRouter)
authenticated.route('/', evidenceRoutes)
authenticated.route('/system', systemRoutes)
authenticated.route('/demo', demoRoutes)
authenticated.route('/geocoding', geocodingRoutes)
authenticated.route('/analytics', analyticsRoutes)
// Phase 6: per-user sigchain (mounted at /users/:targetPubkey/sigchain via nested router)
authenticated.route('/users/:targetPubkey/sigchain', sigchainRoutes)
// Phase 6: PUK envelope distribution and retrieval
authenticated.route('/puk', pukRoutes)
authenticated.route('/messaging/signal', signalRoutes)
authenticated.route('/firehose', firehoseRoutes)
authenticated.route('/signal-notification', signalNotificationRoutes)
authenticated.route('/provider-setup', providerSetupRoutes)
authenticated.route('/provider-templates', providerTemplatesRoutes)
authenticated.route('/erasure', erasureRoutes)
authenticated.route('/bans/platform', platformBansRoutes)
authenticated.route('/retention', retentionRoutes)
authenticated.route('/settings/platform', platformSettingsRoutes)
authenticated.route('/ring-groups', ringGroupsRoutes)
authenticated.route('/recovery-group', recoveryGroupRoutes.authenticated)

// Hub-scoped authenticated routes
const hubScoped = new Hono<AppEnv>()
hubScoped.use('*', hubContext)
hubScoped.route('/users', usersRoutes)
hubScoped.route('/volunteers', usersRoutes)
hubScoped.route('/shifts', shiftsRoutes)
hubScoped.route('/bans', bansRoutes)
hubScoped.route('/notes', notesRoutes)
hubScoped.route('/calls', callsRoutes)
hubScoped.route('/audit', auditRoutes)
hubScoped.route('/conversations', conversationsRoutes)
hubScoped.route('/reports', reportsRoutes)
hubScoped.route('/blasts', blastsRoutes)
hubScoped.route('/contacts', contactsRoutes)
hubScoped.route('/directory', contactsV2Routes)
hubScoped.route('/records', recordsRoutes)
hubScoped.route('/events', eventsRoutes)
hubScoped.route('/settings/cms', entitySchemaRoutes)
hubScoped.route('/settings', settingsRoutes)
hubScoped.route('/analytics', analyticsRoutes)
hubScoped.route('/messaging/signal', signalRoutes)
hubScoped.route('/provider-setup', providerSetupRoutes)
hubScoped.route('/retention', retentionRoutes)
hubScoped.route('/erasure', erasureRoutes)
hubScoped.route('/', evidenceRoutes)
// Phase 6: MLS handshake message routing (hub-scoped)
hubScoped.route('/mls', mlsRoutes)
hubScoped.route('/firehose', firehoseRoutes)
hubScoped.route('/onboard', hubOnboardRoutes)
hubScoped.route('/ring-groups', ringGroupsRoutes)
hubScoped.route('/teams', teamsRoutes)
hubScoped.route('/tags', tagsRoutes)
hubScoped.route('/demo/telephony', demoTelephonyRoutes)

authenticated.route('/hubs/:hubId', hubScoped)

// OpenAPI spec + Scalar interactive docs — restricted to non-production (L3)
const openAPIGuard = createMiddleware<AppEnv>(async (c, next) => {
  if (c.env.ENVIRONMENT === 'production') {
    return c.json({ error: 'Not Found' }, 404)
  }
  return next()
})
api.get('/openapi.json', openAPIGuard, openAPIRouteHandler(api, openAPIConfig))
api.get('/docs', openAPIGuard, Scalar({ url: '/api/openapi.json' }))

api.route('/', authenticated)

// Mount API under /api
app.route('/api', api)

// Catch-all — no web frontend served here (Tauri desktop embeds its own)
app.all('*', (c) => c.json({ error: 'Not Found' }, 404))

export default app
