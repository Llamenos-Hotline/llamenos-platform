import { Hono } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import { validator } from '../openapi/validator'
import type { AppEnv } from '../types/infra'
import { requirePermission } from '../middleware/permission-guard'
import {
  tagListResponseSchema,
  tagResponseSchema,
  tagDeleteResponseSchema,
  createTagBodySchema,
  updateTagBodySchema,
} from '@protocol/schemas/tag'
import { authErrors, notFoundError } from '../openapi/helpers'
import { audit } from '../services/audit'

const tags = new Hono<AppEnv>()

// ---------------------------------------------------------------------------
// GET /tags — list all tags for hub
// ---------------------------------------------------------------------------

tags.get('/',
  describeRoute({
    tags: ['Tags'],
    summary: 'List hub tags',
    responses: {
      200: {
        description: 'Tag list',
        content: { 'application/json': { schema: resolver(tagListResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  requirePermission('tags:view'),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const rows = await services.tags.listTags(hubId)
    return c.json({
      tags: rows.map((t) => ({
        ...t,
        createdAt: t.createdAt.toISOString(),
      })),
    })
  },
)

// ---------------------------------------------------------------------------
// POST /tags — create tag
// ---------------------------------------------------------------------------

tags.post('/',
  describeRoute({
    tags: ['Tags'],
    summary: 'Create a tag',
    responses: {
      200: {
        description: 'Created tag',
        content: { 'application/json': { schema: resolver(tagResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  requirePermission('tags:create'),
  validator('json', createTagBodySchema),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')

    const tag = await services.tags.createTag({
      id: body.id,
      hubId,
      name: body.name,
      encryptedLabel: body.encryptedLabel,
      color: body.color,
      encryptedCategory: body.encryptedCategory,
      createdBy: pubkey,
    })

    await audit(services.audit, 'tagCreated', pubkey, { tagId: tag.id, name: tag.name }, undefined, hubId)

    return c.json({
      ...tag,
      createdAt: tag.createdAt.toISOString(),
    })
  },
)

// ---------------------------------------------------------------------------
// PATCH /tags/:tagId — update tag
// ---------------------------------------------------------------------------

tags.patch('/:tagId',
  describeRoute({
    tags: ['Tags'],
    summary: 'Update a tag',
    responses: {
      200: {
        description: 'Updated tag',
        content: { 'application/json': { schema: resolver(tagResponseSchema) } },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('tags:manage'),
  validator('json', updateTagBodySchema),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const tagId = c.req.param('tagId')
    const body = c.req.valid('json')

    const pubkey = c.get('pubkey')
    const tag = await services.tags.updateTag(tagId, hubId, body)
    await audit(services.audit, 'tagUpdated', pubkey, { tagId, name: tag.name }, undefined, hubId)
    return c.json({
      ...tag,
      createdAt: tag.createdAt.toISOString(),
    })
  },
)

// ---------------------------------------------------------------------------
// DELETE /tags/:tagId — delete tag
// ---------------------------------------------------------------------------

tags.delete('/:tagId',
  describeRoute({
    tags: ['Tags'],
    summary: 'Delete a tag',
    responses: {
      200: {
        description: 'Deleted',
        content: { 'application/json': { schema: resolver(tagDeleteResponseSchema) } },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('tags:manage'),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const pubkey = c.get('pubkey')
    const tagId = c.req.param('tagId')

    await services.tags.deleteTag(tagId, hubId)
    await audit(services.audit, 'tagDeleted', pubkey, { tagId }, undefined, hubId)
    // Tag–contact associations are stored in contacts.tagHashes (blind indexes)
    // and must be cleaned up by the caller. Return 0 for now (pre-production).
    return c.json({ removedFromContacts: 0 })
  },
)

export default tags
