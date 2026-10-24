import { Hono, type Context } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '../types'
import { requirePermission, checkPermission } from '../middleware/permission-guard'
import { listNotesQuerySchema, createNoteBodySchema, updateNoteBodySchema, createReplyBodySchema, noteResponseSchema, noteListResponseSchema, noteRepliesResponseSchema } from '@protocol/schemas/notes'
import { authErrors, notFoundError } from '../openapi/helpers'
import { audit } from '../services/audit'
import { createLogger } from '../lib/logger'
import { assertInHub, callerHasHubAccess, resourceInPathHub } from '../lib/hub-scope'
import { assertAdminCanRead } from '../lib/admin-envelopes'
import { ServiceError } from '../services/settings'
import type { Services } from '../services'

const logger = createLogger('routes.notes')

const notes = new Hono<AppEnv>()
// Require at least notes:read-own to access any notes endpoint
notes.use('*', requirePermission('notes:read-own'))

// Inside /hubs/:hubId every /:id route may only touch a note of that hub (#2011):
// reading or appending replies to another hub's note through this hub's URL is a
// 404, the same as a missing note. Registered before the handlers so none can
// opt out.
const noteInPathHub = resourceInPathHub({
  param: 'id',
  load: async (services, id, hubId) => assertInHub(await services.records.getNote(id), hubId, 'Note not found'),
})
notes.use('/:id/*', noteInPathHub)

/**
 * Refuse (404) a note filed under a call or conversation the caller cannot see
 * from this request (#2112).
 *
 * `callId` / `conversationId` were stored verbatim: a note could hang off an
 * invented id, or off a call that rang in ANOTHER hub, and the audit log then
 * recorded `noteCreated {callId}` as if it were real. Inside /hubs/:hubId the
 * target must live in that hub. On the unscoped mount there is no path hub, so
 * the target must exist and sit in a hub the caller holds a role in (a target
 * with no hub is global). A target of another hub and one that does not exist
 * answer identically, so the route cannot be used to probe which ids are real.
 */
async function assertNoteTargetVisible(
  c: Context<AppEnv>,
  services: Services,
  target: { callId?: string; conversationId?: string },
  hubId: string | undefined,
): Promise<void> {
  const visible = (rowHubId: string | null) => !rowHubId || callerHasHubAccess(c, rowHubId)

  if (target.callId) {
    const call = hubId
      ? (await services.calls.getActiveCallById(hubId, target.callId)) ?? (await services.calls.getCallRecord(hubId, target.callId))
      : (await services.calls.getActiveCallByCallId(target.callId)) ?? (await services.calls.getCallRecord('', target.callId))
    if (!call || !visible(call.hubId)) throw new ServiceError(404, 'Call not found')
  }

  if (target.conversationId) {
    const conversation = hubId
      ? await services.conversations.getByIdForHub(target.conversationId, hubId)
      : await services.conversations.getById(target.conversationId)
    if (!visible(conversation.hubId)) throw new ServiceError(404, 'Conversation not found')
  }
}

notes.get('/',
  describeRoute({
    tags: ['Notes'],
    summary: 'List notes for the authenticated user (or all if admin)',
    responses: {
      200: {
        description: 'Paginated list of notes',
        content: {
          'application/json': {
            schema: resolver(noteListResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  validator('query', listNotesQuerySchema),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const permissions = c.get('permissions')
    const canReadAll = checkPermission(permissions, 'notes:read-all')
    const query = c.req.valid('query')

    // When accessed via hub-scoped route (/api/hubs/:hubId/notes),
    // hubId is set by hubContext middleware — scope results to that hub.
    const hubId = c.get('hubId') as string | undefined

    const result = await services.records.listNotes({
      hubId,
      callId: query.callId,
      conversationId: query.conversationId,
      contactHash: query.contactHash,
      authorPubkey: canReadAll ? undefined : pubkey,
      limit: query.limit,
      offset: (query.page - 1) * query.limit,
    })

    return c.json({
      notes: result.notes,
      total: result.total,
      page: query.page,
      limit: query.limit,
    })
  },
)

notes.post('/',
  describeRoute({
    tags: ['Notes'],
    summary: 'Create a new encrypted note',
    responses: {
      201: {
        description: 'Note created',
        content: {
          'application/json': {
            schema: resolver(noteResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('notes:create'),
  validator('json', createNoteBodySchema),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')

    // When accessed via hub-scoped route (/api/hubs/:hubId/notes),
    // hubId is set by hubContext middleware — scope the note to that hub.
    const hubId = c.get('hubId') as string | undefined

    await assertNoteTargetVisible(c, services, body, hubId)
    await assertAdminCanRead(services, c.env, hubId, body.adminEnvelopes, 'A note', { authorPubkey: pubkey })

    const note = await services.records.createNote({
      hubId,
      authorPubkey: pubkey,
      encryptedContent: body.encryptedContent,
      callId: body.callId,
      conversationId: body.conversationId,
      contactHash: body.contactHash,
      authorEnvelope: body.authorEnvelope ?? {},
      adminEnvelopes: body.adminEnvelopes,
    })

    await audit(services.audit, 'noteCreated', pubkey, { callId: body.callId, conversationId: body.conversationId }, undefined, note.hubId ?? null)

    // Auto-create interaction linking note to case (Epic 323)
    const { caseId, interactionTypeHash } = body
    if (caseId && interactionTypeHash) {
      services.cases.createInteraction(caseId, pubkey, {
        interactionType: 'note',
        sourceId: note.id,
        interactionTypeHash,
      }).catch((e) => { logger.error('Failed to create case interaction', e) })
    }

    return c.json({ note }, 201)
  },
)

notes.patch('/:id',
  describeRoute({
    tags: ['Notes'],
    summary: 'Update an existing note',
    responses: {
      200: {
        description: 'Note updated',
        content: {
          'application/json': {
            schema: resolver(noteResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('notes:update-own'),
  validator('json', updateNoteBodySchema),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const id = c.req.param('id')
    const body = c.req.valid('json')

    // Optional optimistic-concurrency header (#1144): a client that has the
    // note's `updatedAt` (every note response includes it) can send it back
    // as `X-If-Unmodified-Since` to detect a lost-update race — see
    // RecordsService.updateNote. Not a standard HTTP date header on purpose:
    // the server's own ISO-8601 serialization is millisecond-precision and
    // we want an exact round-trip match, which the RFC 7231 HTTP-date
    // format (second precision) can't give us. Omitting the header keeps
    // the previous last-write-wins behavior for clients that haven't
    // adopted it yet.
    const ifUnmodifiedSinceHeader = c.req.header('x-if-unmodified-since')
    let expectedUpdatedAt: Date | undefined
    if (ifUnmodifiedSinceHeader) {
      const parsed = new Date(ifUnmodifiedSinceHeader)
      if (Number.isNaN(parsed.getTime())) {
        return c.json({ error: 'Invalid X-If-Unmodified-Since header' }, 400)
      }
      expectedUpdatedAt = parsed
    }

    // New content is sealed under a new key, so the set that arrives with it is
    // the ONLY one that can open it: the stored envelopes wrap the OLD key. An
    // edit that replaces the content without re-wrapping for an admin would
    // orphan the note exactly as an empty create does; a bare envelope swap is
    // checked too, since it can drop the admin.
    if (body.encryptedContent !== undefined || body.adminEnvelopes !== undefined) {
      const existing = await services.records.getNoteAuthoredBy(id, pubkey)
      await assertAdminCanRead(services, c.env, existing.hubId ?? undefined, body.adminEnvelopes, 'A note', { noteId: id, authorPubkey: pubkey })
    }

    const updated = await services.records.updateNote(id, {
      encryptedContent: body.encryptedContent ?? '',
      authorPubkey: pubkey,
      authorEnvelope: body.authorEnvelope,
      adminEnvelopes: body.adminEnvelopes,
      expectedUpdatedAt,
    })

    await audit(services.audit, 'noteEdited', pubkey, { noteId: id }, undefined, updated.hubId ?? null)
    return c.json({ note: updated })
  },
)

// --- Note Replies (Epic 123) ---

notes.get('/:id/replies',
  describeRoute({
    tags: ['Notes'],
    summary: 'List replies for a note',
    responses: {
      200: {
        description: 'List of replies',
        content: {
          'application/json': {
            schema: resolver(noteRepliesResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  async (c) => {
    const services = c.get('services')
    const id = c.req.param('id')
    const replies = await services.records.listReplies(id)
    return c.json({ replies })
  },
)

notes.post('/:id/replies',
  describeRoute({
    tags: ['Notes'],
    summary: 'Create a reply to a note',
    responses: {
      201: {
        description: 'Reply created',
        content: {
          'application/json': {
            schema: resolver(noteResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('notes:reply'),
  validator('json', createReplyBodySchema),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const id = c.req.param('id')
    const body = c.req.valid('json')

    const parentNote = await services.records.getNote(id)
    await assertAdminCanRead(services, c.env, parentNote.hubId ?? undefined, body.readerEnvelopes, 'A note reply', { noteId: id, authorPubkey: pubkey })

    const reply = await services.records.createReply(id, {
      ...body,
      authorPubkey: pubkey,
    })

    await audit(services.audit, 'noteReplyCreated', pubkey, { noteId: id }, undefined, parentNote.hubId ?? null)
    return c.json({ reply }, 201)
  },
)

export default notes
