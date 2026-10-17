import { Hono } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import { z } from 'zod'
import type { AppEnv } from '../types'
import { requirePermission } from '../middleware/permission-guard'
import { authErrors } from '../openapi/helpers'
import type { MemberDirectoryEntry } from '../services/identity'

// Mounted twice, like the users router: unscoped at /api/identity and
// hub-scoped at /api/hubs/:hubId/identity. Under a hub, hubContext has replaced
// `permissions` with the hub-resolved set and set `hubId`, so the guard and the
// listing are both confined to that hub.
const identity = new Hono<AppEnv>()

/**
 * `GET /members` (#1701). Route-local because it is the shape the iOS admin
 * client already decodes (`UsersListResponse` / `ClientUser`), and the
 * `satisfies` binds it to the service's projection at compile time.
 */
const memberDirectoryResponseSchema = z.object({
  members: z.array(z.object({
    id: z.string(),
    pubkey: z.string(),
    displayName: z.string().nullable(),
    role: z.enum(['admin', 'volunteer']),
    status: z.enum(['active', 'inactive']),
    createdAt: z.string(),
  })),
}) satisfies z.ZodType<{ members: MemberDirectoryEntry[] }>

identity.get('/members',
  describeRoute({
    tags: ['Users'],
    summary: 'Admin member directory: every member with display name, admin/volunteer role and status',
    responses: {
      200: {
        description: 'Members',
        content: {
          'application/json': {
            schema: resolver(memberDirectoryResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  // The same authority as GET /api/users, which lists the same people: names
  // are admin-only PII, and a volunteer's role grants no `users:read`.
  requirePermission('users:read'),
  async (c) => {
    const result = await c.get('services').identity.getMemberDirectory(c.get('allRoles'), c.get('hubId'))
    return c.json(result)
  },
)

export default identity
