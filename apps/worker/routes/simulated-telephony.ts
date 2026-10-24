/**
 * Simulated telephony routes — admin-only, hub-scoped, OUTSIDE the dev router.
 *
 * Mounted at /hubs/:hubId/simulated-telephony. Lets an admin on a test instance select the
 * MockTelephonyAdapter for the hub and simulate an incoming call, so a tester can trigger,
 * answer and take a note on a call with no PSTN number, curl or shell.
 *
 * Unlike /test-* (dev router, 404 unless the dev surface is enabled AND the request carries
 * its shared secret), these are real authenticated routes: the caller needs
 * `settings:manage-telephony`, and the host must be one where the mock provider is selectable
 * at all — `isMockTelephonyAllowed`, i.e. `devSurfacesEnabled` (lib/dev-surfaces.ts), which
 * refuses ENVIRONMENT=production before reading any flag. The gate used to be DEMO_MODE=true +
 * DEMO_MODE_CONFIRM; demo mode was removed in #1604 and this is a test affordance, not a
 * product mode, so it moved onto the predicate that says "this host is a test target".
 */
import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import { z } from 'zod'
import type { AppEnv } from '../types'
import { requirePermission } from '../middleware/permission-guard'
import { audit } from '../services/audit'
import { authErrors } from '../openapi/helpers'
import { isValidE164 } from '../lib/helpers'
import { isMockTelephonyAllowed } from '../telephony/mock'
import { simulateIncomingCall, simulateCallerHangup, randomFictionalCallerNumber } from '../services/call-simulation'
import { ServiceError } from '../services/settings'

/** Fictional hotline number the mock answers for (555-01xx is reserved for fiction). */
const DEFAULT_MOCK_HOTLINE_NUMBER = '+15555550100'

const statusResponseSchema = z.object({
  available: z.boolean(),
  enabled: z.boolean(),
})
const toggleBodySchema = z.object({
  enabled: z.boolean(),
  phoneNumber: z.string().regex(/^\+\d{7,15}$/).optional(),
})
const simulateCallBodySchema = z.object({
  callerNumber: z.string().regex(/^\+\d{7,15}$/).optional(),
})
const simulateCallResponseSchema = z.object({
  ok: z.literal(true),
  callId: z.string(),
  status: z.literal('ringing'),
  callerLast4: z.string(),
  volunteersNotified: z.number(),
})
const hangupBodySchema = z.object({ callId: z.string().min(1) })
const hangupResponseSchema = z.object({
  ok: z.literal(true),
  callId: z.string(),
  status: z.literal('completed'),
})

const simulatedTelephony = new Hono<AppEnv>()

// Every route here is admin-only …
simulatedTelephony.use('*', requirePermission('settings:manage-telephony'))

// … and every mutating route additionally requires the host-level guard.
// /status stays reachable so a client can hide the affordance when it is unavailable;
// it reveals only a boolean, never why.
simulatedTelephony.use('*', async (c, next) => {
  if (c.req.path.endsWith('/status')) return next()
  if (!isMockTelephonyAllowed(c.env)) {
    return c.json({ error: 'Simulated telephony is not available on this host' }, 403)
  }
  return next()
})

simulatedTelephony.get('/status',
  describeRoute({
    tags: ['Simulated Telephony'],
    summary: 'Whether the mock telephony provider is available and enabled for this hub',
    responses: {
      200: { description: 'Status', content: { 'application/json': { schema: resolver(statusResponseSchema) } } },
      ...authErrors,
    },
  }),
  async (c) => {
    const hubId = c.get('hubId') ?? ''
    const available = isMockTelephonyAllowed(c.env)
    const enabled = available && await c.get('services').settings.isHubMockTelephonyEnabled(hubId)
    return c.json({ available, enabled })
  },
)

simulatedTelephony.put('/mock',
  describeRoute({
    tags: ['Simulated Telephony'],
    summary: 'Select (or deselect) the mock telephony provider for this hub',
    responses: {
      200: { description: 'Updated', content: { 'application/json': { schema: resolver(statusResponseSchema) } } },
      ...authErrors,
      409: { description: 'Hub already has a real telephony provider' },
    },
  }),
  validator('json', toggleBodySchema),
  async (c) => {
    const { enabled, phoneNumber } = c.req.valid('json')
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    try {
      if (enabled) {
        await services.settings.enableHubMockTelephony(hubId, phoneNumber ?? DEFAULT_MOCK_HOTLINE_NUMBER)
      } else {
        await services.settings.disableHubMockTelephony(hubId)
      }
    } catch (err) {
      if (err instanceof ServiceError) return c.json({ error: err.message }, err.status as 409)
      throw err
    }
    await audit(services.audit, 'mockTelephonyToggled', c.get('pubkey'), { enabled }, undefined, hubId)
    return c.json({ available: true, enabled })
  },
)

simulatedTelephony.post('/simulate/incoming-call',
  describeRoute({
    tags: ['Simulated Telephony'],
    summary: 'Simulate an incoming call through the real routing path',
    description: 'Runs ban check, shift/ring-group resolution and call:ring for an on-shift volunteer. Answer, hang up and notes then use the ordinary calls/notes endpoints.',
    responses: {
      200: { description: 'Call is ringing', content: { 'application/json': { schema: resolver(simulateCallResponseSchema) } } },
      ...authErrors,
      409: { description: 'Mock telephony is not enabled for this hub' },
      422: { description: 'No volunteers on shift or in the fallback group' },
    },
  }),
  validator('json', simulateCallBodySchema),
  async (c) => {
    const { callerNumber = randomFictionalCallerNumber() } = c.req.valid('json')
    if (!isValidE164(callerNumber)) return c.json({ error: 'callerNumber must be E.164' }, 400)
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''

    const result = await simulateIncomingCall({
      env: c.env,
      services,
      hubId,
      callerNumber,
      origin: new URL(c.req.url).origin,
    })
    if (!result.ok) return c.json({ error: result.code }, result.status)

    await audit(services.audit, 'callSimulated', c.get('pubkey'), {
      callId: result.callId,
      callerLast4: result.callerLast4,
      volunteersNotified: result.volunteersNotified,
    }, undefined, hubId)
    return c.json({
      ok: true as const,
      callId: result.callId,
      status: 'ringing' as const,
      callerLast4: result.callerLast4,
      volunteersNotified: result.volunteersNotified,
    })
  },
)

simulatedTelephony.post('/simulate/caller-hangup',
  describeRoute({
    tags: ['Simulated Telephony'],
    summary: 'Simulate the caller hanging up a simulated call',
    responses: {
      200: { description: 'Call ended', content: { 'application/json': { schema: resolver(hangupResponseSchema) } } },
      ...authErrors,
      404: { description: 'Call not found or already ended' },
      409: { description: 'Not a simulated call' },
    },
  }),
  validator('json', hangupBodySchema),
  async (c) => {
    const { callId } = c.req.valid('json')
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const result = await simulateCallerHangup({ env: c.env, services, hubId, callId })
    if (!result.ok) return c.json({ error: result.code }, result.status)
    await audit(services.audit, 'simulatedCallerHungUp', c.get('pubkey'), { callId }, undefined, hubId)
    return c.json({ ok: true as const, callId, status: 'completed' as const })
  },
)

export default simulatedTelephony
