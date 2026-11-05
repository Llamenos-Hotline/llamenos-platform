import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '../types'
import { requirePermission } from '../middleware/permission-guard'
import {
  ringGroupListResponseSchema,
  ringGroupDetailResponseSchema,
  createRingGroupBodySchema,
  updateRingGroupBodySchema,
  ringGroupMembersBodySchema,
} from '@protocol/schemas/ring-group'
import { okResponseSchema } from '@protocol/schemas/common'
import { authErrors, notFoundError } from '../openapi/helpers'
import { hubOnly, pathHubId } from '../lib/hub-scope'

const ringGroups = new Hono<AppEnv>()

// A ring group is part of a hub's ring set, so this router is served only under
// /hubs/:hubId (#2461). Registered first: a stray unscoped mount answers 404
// before any handler could create a group in no hub.
ringGroups.use('*', hubOnly)

// Map DB member row to protocol response shape
function mapMember(row: { userPubkey: string; addedBy: string; createdAt: Date }) {
  return {
    pubkey: row.userPubkey,
    addedBy: row.addedBy,
    createdAt: row.createdAt.toISOString(),
  }
}

function mapGroup(row: { id: string; hubId: string; encryptedName: string; createdAt: Date }, members: { userPubkey: string; addedBy: string; createdAt: Date }[]) {
  return {
    id: row.id,
    hubId: row.hubId,
    encryptedName: row.encryptedName,
    members: members.map(mapMember),
    createdAt: row.createdAt.toISOString(),
  }
}

ringGroups.get('/',
  describeRoute({
    tags: ['Ring Groups'],
    summary: 'List all ring groups for the hub',
    responses: {
      200: { description: 'Ring group list', content: { 'application/json': { schema: resolver(ringGroupListResponseSchema) } } },
      ...authErrors,
    },
  }),
  requirePermission('shifts:manage-ring-groups'),
  async (c) => {
    const services = c.get('services')
    const hubId = pathHubId(c)
    const { ringGroups: rows } = await services.ringGroups.list(hubId)
    return c.json({
      ringGroups: rows.map(row => ({
        id: row.id,
        hubId: row.hubId,
        encryptedName: row.encryptedName,
        memberCount: 0,
        createdAt: row.createdAt.toISOString(),
      })),
    })
  },
)

ringGroups.post('/',
  describeRoute({
    tags: ['Ring Groups'],
    summary: 'Create a ring group',
    responses: {
      200: { description: 'Created ring group', content: { 'application/json': { schema: resolver(ringGroupDetailResponseSchema) } } },
      ...authErrors,
    },
  }),
  requirePermission('shifts:manage-ring-groups'),
  validator('json', createRingGroupBodySchema),
  async (c) => {
    const services = c.get('services')
    const hubId = pathHubId(c)
    const body = c.req.valid('json')
    const row = await services.ringGroups.create(hubId, { encryptedName: body.encryptedName })
    return c.json(mapGroup(row, []))
  },
)

ringGroups.get('/:id',
  describeRoute({
    tags: ['Ring Groups'],
    summary: 'Get a ring group with its members',
    responses: {
      200: { description: 'Ring group detail', content: { 'application/json': { schema: resolver(ringGroupDetailResponseSchema) } } },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('shifts:manage-ring-groups'),
  async (c) => {
    const services = c.get('services')
    const hubId = pathHubId(c)
    const { id } = c.req.param()
    const { ringGroup, members } = await services.ringGroups.get(hubId, id)
    return c.json(mapGroup(ringGroup, members))
  },
)

ringGroups.put('/:id',
  describeRoute({
    tags: ['Ring Groups'],
    summary: 'Update a ring group',
    responses: {
      200: { description: 'Updated ring group', content: { 'application/json': { schema: resolver(ringGroupDetailResponseSchema) } } },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('shifts:manage-ring-groups'),
  validator('json', updateRingGroupBodySchema),
  async (c) => {
    const services = c.get('services')
    const hubId = pathHubId(c)
    const { id } = c.req.param()
    const body = c.req.valid('json')
    await services.ringGroups.update(hubId, id, body)
    const { ringGroup, members } = await services.ringGroups.get(hubId, id)
    return c.json(mapGroup(ringGroup, members))
  },
)

ringGroups.delete('/:id',
  describeRoute({
    tags: ['Ring Groups'],
    summary: 'Delete a ring group',
    responses: {
      200: { description: 'Deleted', content: { 'application/json': { schema: resolver(okResponseSchema) } } },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('shifts:manage-ring-groups'),
  async (c) => {
    const services = c.get('services')
    const hubId = pathHubId(c)
    const { id } = c.req.param()
    await services.ringGroups.delete(hubId, id)
    return c.json({ ok: true })
  },
)

ringGroups.post('/:id/members',
  describeRoute({
    tags: ['Ring Groups'],
    summary: 'Add members to a ring group',
    responses: {
      200: { description: 'Members added', content: { 'application/json': { schema: resolver(ringGroupDetailResponseSchema) } } },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('shifts:manage-ring-groups'),
  validator('json', ringGroupMembersBodySchema),
  async (c) => {
    const services = c.get('services')
    const hubId = pathHubId(c)
    const pubkey = c.get('pubkey')
    const { id } = c.req.param()
    const body = c.req.valid('json')
    for (const memberPubkey of body.pubkeys) {
      await services.ringGroups.addMember(hubId, id, memberPubkey, pubkey)
    }
    const { ringGroup, members } = await services.ringGroups.get(hubId, id)
    return c.json(mapGroup(ringGroup, members))
  },
)

ringGroups.delete('/:id/members',
  describeRoute({
    tags: ['Ring Groups'],
    summary: 'Remove members from a ring group',
    responses: {
      200: { description: 'Members removed', content: { 'application/json': { schema: resolver(ringGroupDetailResponseSchema) } } },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('shifts:manage-ring-groups'),
  validator('json', ringGroupMembersBodySchema),
  async (c) => {
    const services = c.get('services')
    const hubId = pathHubId(c)
    const { id } = c.req.param()
    const body = c.req.valid('json')
    for (const memberPubkey of body.pubkeys) {
      await services.ringGroups.removeMember(hubId, id, memberPubkey)
    }
    const { ringGroup, members } = await services.ringGroups.get(hubId, id)
    return c.json(mapGroup(ringGroup, members))
  },
)

export default ringGroups
