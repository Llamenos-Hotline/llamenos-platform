import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '../types'
import { requirePermission } from '../middleware/permission-guard'
import { paginationSchema } from '@protocol/schemas/common'
import { contactTimelineListResponseSchema, contactTimelineDetailResponseSchema } from '@protocol/schemas/contacts'
import { authErrors } from '../openapi/helpers'
import { hubOnly, pathHubId } from '../lib/hub-scope'

const contacts = new Hono<AppEnv>()
// A contact timeline is a hub's notes and conversations, so this router is
// hub-only (#2395): outside /hubs/:hubId it listed every hub's contacts for a
// global `contacts:view` holder.
contacts.use('*', hubOnly)
contacts.use('*', requirePermission('contacts:view'))

// GET /contacts — list contacts with note counts
contacts.get('/',
  describeRoute({
    tags: ['Contacts'],
    summary: 'List contacts with aggregated counts',
    responses: {
      200: {
        description: 'Paginated list of contacts',
        content: {
          'application/json': {
            schema: resolver(contactTimelineListResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  validator('query', paginationSchema),
  async (c) => {
    const services = c.get('services')
    const hubId = pathHubId(c)
    const query = c.req.valid('query')
    const offset = ((query.page ?? 1) - 1) * (query.limit ?? 20)

    // Get contact data from RecordsService (notes with contactHash)
    const { contacts: noteContacts, total } = await services.records.listContacts(
      hubId,
      query.limit ?? 20,
      offset,
    )

    // Enrich with conversation data from ConversationsService
    const convSummaries = await services.conversations.getContactSummaries(hubId)

    // Merge data
    const merged = new Map<string, {
      contactHash: string; firstSeen: string; lastSeen: string
      callCount: number; conversationCount: number; noteCount: number; reportCount: number
    }>()

    for (const nc of noteContacts) {
      merged.set(nc.contactHash, {
        contactHash: nc.contactHash,
        firstSeen: nc.firstSeen.toISOString(),
        lastSeen: nc.lastSeen.toISOString(),
        callCount: 0,
        conversationCount: 0,
        noteCount: nc.noteCount,
        reportCount: 0,
      })
    }

    for (const cs of convSummaries) {
      const hash = cs.contactHash
      const csFirstSeen = cs.firstSeen.toISOString()
      const csLastSeen = cs.lastSeen.toISOString()
      const existing = merged.get(hash)
      if (existing) {
        existing.conversationCount = cs.conversationCount
        if (csFirstSeen < existing.firstSeen) existing.firstSeen = csFirstSeen
        if (csLastSeen > existing.lastSeen) existing.lastSeen = csLastSeen
      } else {
        merged.set(hash, {
          contactHash: hash,
          firstSeen: csFirstSeen,
          lastSeen: csLastSeen,
          callCount: 0,
          conversationCount: cs.conversationCount,
          noteCount: 0,
          reportCount: 0,
        })
      }
    }

    const contactsList = Array.from(merged.values())
      .sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime())

    return c.json({ contacts: contactsList, total: Math.max(total, contactsList.length) })
  },
)

// GET /contacts/:hash — unified timeline for a contact
contacts.get('/:hash',
  describeRoute({
    tags: ['Contacts'],
    summary: 'Get unified timeline for a contact',
    responses: {
      200: {
        description: 'Notes and conversations for the contact',
        content: {
          'application/json': {
            schema: resolver(contactTimelineDetailResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  async (c) => {
    const services = c.get('services')
    const hash = c.req.param('hash')
    // The hash is a blind index: the same caller hashes identically in every hub.
    // Inside /hubs/:hubId the timeline is that hub's alone.
    const hubId = pathHubId(c)

    // Parallel fetch from RecordsService (notes) and ConversationsService (conversations)
    const [notesResult, conversations] = await Promise.all([
      services.records.listNotes({ hubId, contactHash: hash }),
      services.conversations.getContactConversations(hash, hubId),
    ])

    return c.json({ notes: notesResult.notes, conversations })
  },
)

export default contacts
