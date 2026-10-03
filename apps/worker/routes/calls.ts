import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import { z } from 'zod'
import type { AppEnv } from '../types'
import { getTelephonyFromService } from '../lib/service-factories'

import { audit } from '../services/audit'
import { ServiceError } from '../services/settings'
import { resolveRingableVolunteers, cancelLosingLegs } from '../services/ringing'
import { publishEvent } from '../lib/ws-events'
import { KIND_CALL_UPDATE, KIND_PRESENCE_UPDATE } from '@shared/event-kinds'
import { requirePermission, checkPermission } from '../middleware/permission-guard'
import { callHistoryQuerySchema, callPresenceResponseSchema, banCallerBodySchema, activeCallsResponseSchema, todayCountResponseSchema, callerIdentifyResponseSchema, callActionResponseSchema, banCallResponseSchema, callHistoryResponseSchema } from '@protocol/schemas/calls'
import { okResponseSchema } from '@protocol/schemas/common'
import { authErrors, notFoundError } from '../openapi/helpers'

const calls = new Hono<AppEnv>()

calls.get('/active',
  describeRoute({
    tags: ['Calls'],
    summary: 'List active calls',
    responses: {
      200: {
        description: 'Active calls',
        content: {
          'application/json': {
            schema: resolver(activeCallsResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('calls:read-active'),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const permissions = c.get('permissions')
    const canSeeFullInfo = checkPermission(permissions, 'calls:read-active-full')
    const activeCalls = await services.calls.getActiveCalls(hubId)
    if (!canSeeFullInfo) {
      const redacted = activeCalls.map(call => ({ ...call, callerNumber: '[redacted]' }))
      return c.json({ calls: redacted })
    }
    return c.json({ calls: activeCalls })
  },
)

calls.get('/today-count',
  describeRoute({
    tags: ['Calls'],
    summary: 'Get today\'s call count',
    responses: {
      200: {
        description: 'Today\'s call count',
        content: {
          'application/json': {
            schema: resolver(todayCountResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('calls:read-active'),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const count = await services.calls.getTodayCount(hubId)
    return c.json({ count })
  },
)

calls.get('/presence',
  describeRoute({
    tags: ['Calls'],
    summary: 'Get call presence status',
    responses: {
      200: {
        description: 'Presence status',
        content: {
          'application/json': {
            schema: resolver(callPresenceResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('calls:read-presence'),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const result = await services.calls.getPresence(hubId)
    return c.json(result)
  },
)

calls.get('/history',
  describeRoute({
    tags: ['Calls'],
    summary: 'Paginated call history',
    responses: {
      200: {
        description: 'Paginated call records',
        content: {
          'application/json': {
            schema: resolver(callHistoryResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('calls:read-history'),
  validator('query', callHistoryQuerySchema),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const query = c.req.valid('query')
    const result = await services.calls.listCallHistory(hubId, {
      search: query.search,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      page: query.page,
      limit: query.limit,
    })
    return c.json(result)
  },
)

// --- Caller Identification (Epic 326 — screen pop) ---

calls.get('/identify/:identifierHash',
  describeRoute({
    tags: ['Calls'],
    summary: 'Identify a caller by identifier hash and return matching contact with active cases',
    responses: {
      200: {
        description: 'Contact identification result',
        content: {
          'application/json': {
            schema: resolver(callerIdentifyResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('calls:identify-caller'),
  async (c) => {
    const identifierHash = c.req.param('identifierHash')
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''

    // Look up contact in ContactsService
    const contact = await services.contacts.lookupByIdentifierHash(hubId, identifierHash)

    if (!contact) {
      return c.json({ contact: null, activeCaseCount: 0, recentCases: [] })
    }

    // Increment interaction count on identification
    try {
      await services.contacts.updateLastInteraction(contact.id)
      contact.interactionCount = (contact.interactionCount ?? 0) + 1
    } catch {
      // best-effort — don't fail the lookup if increment fails
    }

    // Fetch active cases linked to this contact
    let activeCaseCount = 0
    let recentCases: Array<{ id: string; caseNumber?: string; status: string }> = []

    try {
      const casesResult = await services.cases.listByContact(contact.id, hubId)
      activeCaseCount = casesResult.total
      recentCases = casesResult.records.slice(0, 5).map(r => ({
        id: r.id,
        caseNumber: r.caseNumber ?? undefined,
        status: r.statusHash ?? '',
      }))
    } catch {
      // Non-fatal
    }

    return c.json({ contact, activeCaseCount, recentCases })
  },
)

// Diagnostic endpoint (must be before /:callId to avoid param capture)
calls.get('/debug',
  describeRoute({
    tags: ['Calls'],
    summary: 'Debug call routing state',
    responses: {
      200: {
        description: 'Debug information',
        content: {
          'application/json': {
            schema: resolver(z.record(z.string(), z.unknown())),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('calls:debug'),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const result = await services.calls.debug(hubId)
    return c.json(result)
  },
)

// --- Get single call by ID ---

calls.get('/:callId',
  describeRoute({
    tags: ['Calls'],
    summary: 'Get a single call by ID (active or historical)',
    responses: {
      200: {
        description: 'Call record',
        content: {
          'application/json': {
            schema: resolver(callActionResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('calls:read-active'),
  async (c) => {
    const callId = c.req.param('callId')
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''

    // Try active calls first (hub-scoped if available, then global), fall back to history
    const activeCall = hubId
      ? await services.calls.getActiveCallById(hubId, callId)
      : await services.calls.getActiveCallByCallId(callId)
    if (activeCall) return c.json(activeCall)

    const historyRecord = await services.calls.getCallRecord(callId)
    if (historyRecord) return c.json(historyRecord)

    return c.json({ error: 'Call not found' }, 404)
  },
)

// --- Call Actions (REST endpoints for WS→Nostr migration) ---

// Answer a ringing call (volunteer)
calls.post('/:callId/answer',
  describeRoute({
    tags: ['Calls'],
    summary: 'Answer a ringing call',
    responses: {
      200: {
        description: 'Call answered',
        content: {
          'application/json': {
            schema: resolver(callActionResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('calls:answer'),
  async (c) => {
    const callId = c.req.param('callId')
    const pubkey = c.get('pubkey')
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''

    const existing = await services.calls.getActiveCallById(hubId, callId)
    if (!existing) return c.json({ error: 'Call not found' }, 404)
    if (existing.status !== 'ringing' || existing.answeredBy) {
      return c.json({ error: 'Call already answered' }, 409)
    }

    // Only a volunteer who was actually rung for this call may answer it.
    const ringable = await resolveRingableVolunteers(services, hubId)
    if (!ringable?.available.some(v => v.pubkey === pubkey)) {
      return c.json({ error: 'Not rung for this call' }, 403)
    }

    let result
    try {
      result = await services.calls.answerCall(hubId, callId, pubkey)
    } catch (err) {
      if (err instanceof ServiceError && err.status === 409) {
        return c.json({ error: 'Call already answered' }, 409)
      }
      if (err instanceof ServiceError && err.status === 404) {
        return c.json({ error: 'Call not found' }, 404)
      }
      return c.json({ error: 'Failed to answer call' }, 500)
    }

    await audit(services.audit, 'callAnswered', pubkey, {
      callerLast4: result.callerLast4 || '',
    }, undefined, result.hubId || hubId || null)

    publishEvent(c.env, KIND_CALL_UPDATE, {
      type: 'call:update',
      callId,
      status: 'in-progress',
    }, hubId)
    publishEvent(c.env, KIND_PRESENCE_UPDATE, {
      type: 'presence:summary',
      callId,
    }, hubId)

    // First pickup wins: stop every phone that is still ringing.
    await cancelLosingLegs(c.env, services, hubId, callId)

    return c.json({ call: result })
  },
)

// Hang up an active call (volunteer who answered it)
calls.post('/:callId/hangup',
  describeRoute({
    tags: ['Calls'],
    summary: 'Hang up an active call',
    responses: {
      200: {
        description: 'Call hung up',
        content: {
          'application/json': {
            schema: resolver(callActionResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('calls:hangup'),
  async (c) => {
    const callId = c.req.param('callId')
    const pubkey = c.get('pubkey')
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''

    // Verify the volunteer answered this call
    const call = await services.calls.getActiveCallById(hubId, callId)
    if (!call) return c.json({ error: 'Call not found' }, 404)
    if (call.answeredBy !== pubkey) return c.json({ error: 'Not your call' }, 403)

    try {
      const result = await services.calls.endCall(hubId, callId)
      return c.json({ call: result })
    } catch {
      return c.json({ error: 'Failed to hang up call' }, 500)
    }
  },
)

// Report a call as spam (volunteer who answered it)
calls.post('/:callId/spam',
  describeRoute({
    tags: ['Calls'],
    summary: 'Report a call as spam',
    responses: {
      200: {
        description: 'Call reported as spam',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('calls:report-spam'),
  async (c) => {
    const callId = c.req.param('callId')
    const pubkey = c.get('pubkey')
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''

    // Verify the volunteer answered this call
    const call = await services.calls.getActiveCallById(hubId, callId)
    if (!call) return c.json({ error: 'Call not found' }, 404)
    if (call.answeredBy !== pubkey) return c.json({ error: 'Not your call' }, 403)

    try {
      const result = await services.calls.reportSpam(hubId, callId, pubkey)
      return c.json(result)
    } catch {
      return c.json({ error: 'Failed to report spam' }, 500)
    }
  },
)

// Ban caller and hang up — server resolves phone number (volunteer never sees it)
calls.post('/:callId/ban',
  describeRoute({
    tags: ['Calls'],
    summary: 'Ban the caller and hang up',
    responses: {
      200: {
        description: 'Caller banned and call ended',
        content: {
          'application/json': {
            schema: resolver(banCallResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('bans:report'),
  validator('json', banCallerBodySchema),
  async (c) => {
    const callId = c.req.param('callId')
    const pubkey = c.get('pubkey')
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''

    // Look up by callId only — route may lack hub context (not mounted under hubScoped)
    const call = await services.calls.getActiveCallByCallId(callId)
    if (!call) return c.json({ error: 'Call not found' }, 404)

    if (call.answeredBy !== pubkey) {
      return c.json({ error: 'Not your call' }, 403)
    }

    const body = c.req.valid('json')

    // Ban the caller (server resolves phone number — volunteer never sees it)
    let banned = false
    try {
      await services.records.addBan({
        phone: call.callerNumber, // already HMAC-hashed at call ingestion
        phoneDisplay: call.callerLast4 ? `***${call.callerLast4}` : undefined,
        reason: body.reason || 'Banned during active call',
        bannedBy: pubkey,
        hubId: call.hubId ?? hubId ?? undefined,
      })
      banned = true
    } catch {
      // Ban failed
    }

    // Hang up the call
    try {
      await services.calls.endCall(call.hubId ?? '', callId)
    } catch {
      // End call failed
    }

    if (banned) {
      await audit(services.audit, 'numberBanned', pubkey, { callId }, undefined, call.hubId || hubId || null)
    }

    return c.json({ banned, hungUp: true })
  },
)

// Recording playback — admin or answering volunteer
calls.get('/:callId/recording',
  describeRoute({
    tags: ['Calls'],
    summary: 'Get call recording audio',
    responses: {
      200: { description: 'Audio WAV file' },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('calls:read-active'),
  async (c) => {
    const callId = c.req.param('callId')
    const services = c.get('services')
    const permissions = c.get('permissions')
    const pubkey = c.get('pubkey')

    // Check call record for recording info (try active calls first, then history)
    const activeCall = await services.calls.getActiveCallById(c.get('hubId') ?? '', callId)
    const historyRecord = activeCall ? null : await services.calls.getCallRecord(callId)
    const recordingSid = activeCall?.recordingSid ?? historyRecord?.recordingSid
    const hasRecording = activeCall?.hasRecording ?? historyRecord?.hasRecording
    const answeredBy = activeCall?.answeredBy ?? null

    if (!recordingSid || !hasRecording) {
      return c.json({ error: 'No recording available for this call' }, 404)
    }

    // Permission check: admin (calls:read-recording) or the volunteer who answered
    const isAdmin = checkPermission(permissions, 'calls:read-recording')
    const isAnsweringVolunteer = answeredBy === pubkey
    if (!isAdmin && !isAnsweringVolunteer) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    // Fetch recording audio from the telephony provider on demand
    const adapter = await getTelephonyFromService(c.env, services.settings)
    if (!adapter) return c.json({ error: 'Telephony provider not configured' }, 503)

    const audio = await adapter.getRecordingAudio(recordingSid)
    if (!audio) return c.json({ error: 'Recording not available from provider' }, 404)

    return new Response(audio, {
      headers: {
        'Content-Type': 'audio/wav',
        'Content-Length': String(audio.byteLength),
        'Cache-Control': 'private, no-store',
      },
    })
  },
)

export default calls
