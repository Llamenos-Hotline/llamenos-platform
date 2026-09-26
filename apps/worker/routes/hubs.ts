// Hub routes are not migrated to the entity-router factory — access control
// (super-admin vs member-filtered) and hub construction logic cannot be
// expressed in factory config. All CRUD handlers remain hand-written.
import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '../types'
import { requirePermission, requireAnyPermission, checkPermission } from '../middleware/permission-guard'
import { createHubBodySchema, updateHubBodySchema, addHubMemberBodySchema, hubKeyEnvelopesBodySchema, hubResponseSchema, hubListResponseSchema, hubDetailResponseSchema, hubKeyEnvelopeResponseSchema, rotateHubKeyBodySchema, rotateHubKeyResponseSchema } from '@protocol/schemas/hubs'
import { okResponseSchema } from '@protocol/schemas/common'
import { authErrors, notFoundError } from '../openapi/helpers'
import type { Hub } from '@shared/types'
import { ServiceError } from '../services/settings'
import { audit } from '../services/audit'
import { encryptStorageCredential } from '../lib/crypto'
import type { StorageManager } from '../lib/storage-manager'

const routes = new Hono<AppEnv>()

// Hub routes are not migrated to the entity-router factory — access control
// and hub construction logic cannot be expressed in factory config. Hub
// creation uses inline crypto.randomUUID() + slug generation; GET / and
// GET /:hubId have non-standard access control checks (isSuperAdmin OR
// hasHubAccess) that cannot be expressed via the factory's single domain prefix.

// List hubs (filtered by user's membership, super admin sees all)
routes.get('/',
  describeRoute({
    tags: ['Hubs'],
    summary: 'List hubs visible to the current user',
    responses: {
      200: {
        description: 'List of hubs',
        content: {
          'application/json': {
            schema: resolver(hubListResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('hubs:read'),
  async (c) => {
    const services = c.get('services')
    const user = c.get('user')
    const permissions = c.get('permissions')

    const { hubs } = await services.settings.getHubs()

    // Super admin sees all
    if (checkPermission(permissions, '*')) {
      return c.json({ hubs: hubs.filter(h => h.status === 'active') })
    }

    // Others see only their hubs
    const userHubIds = new Set((user.hubRoles || []).map(hr => hr.hubId))
    return c.json({ hubs: hubs.filter(h => h.status === 'active' && userHubIds.has(h.id)) })
  },
)

// Create hub (super admin only)
routes.post('/',
  describeRoute({
    tags: ['Hubs'],
    summary: 'Create a new hub',
    responses: {
      201: {
        description: 'Hub created',
        content: {
          'application/json': {
            schema: resolver(hubDetailResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requireAnyPermission('system:manage-hubs', 'system:create-hub'),
  validator('json', createHubBodySchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const services = c.get('services')
    const body = c.req.valid('json')

    const name = body.name.trim()
    const slug = body.slug?.trim() || name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    if (!slug || slug === '-') {
      return c.json({ error: 'Generated slug is empty. Provide a non-empty name or explicit slug.' }, 400)
    }

    const hub: Hub = {
      id: crypto.randomUUID(),
      name,
      slug,
      description: body.description?.trim(),
      status: 'active',
      phoneNumber: body.phoneNumber?.trim(),
      createdBy: pubkey,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    try {
      await services.settings.createHub(hub)
    } catch (err) {
      if (err instanceof ServiceError) {
        return c.json({ error: err.message }, err.status as 400 | 409 | 500)
      }
      const message = err instanceof Error ? err.message : 'Failed to create hub'
      return c.json({ error: message }, 500)
    }

    // Auto-add the creator as hub admin
    try {
      await services.identity.setHubRole({
        pubkey,
        hubId: hub.id,
        roleIds: ['role-hub-admin'],
      })
    } catch (hubRoleErr) {
      console.warn(`[hubs] Failed to add creator as hub admin for ${hub.id}:`, hubRoleErr)
    }

    // Provision hub-scoped storage buckets and IAM
    const storageManager = (c.env as unknown as Record<string, unknown>).STORAGE_MANAGER as StorageManager | undefined
    if (storageManager) {
      try {
        const creds = await storageManager.provisionHub(hub.id)
        if (creds) {
          const hmacSecret = (c.env as unknown as Record<string, unknown>).HMAC_SECRET as string
          await services.settings.storeHubStorageCredentials({
            hubId: hub.id,
            accessKeyId: creds.accessKeyId,
            encryptedSecretKey: encryptStorageCredential(creds.secretAccessKey, hmacSecret),
            policyName: creds.policyName,
            userName: creds.userName,
          })
        }
      } catch (storageErr) {
        console.warn(`[hubs] Storage provisioning failed for hub ${hub.id}:`, storageErr)
      }
    }

    return c.json({ hub }, 201)
  },
)

// Get hub details
routes.get('/:hubId',
  describeRoute({
    tags: ['Hubs'],
    summary: 'Get hub details',
    responses: {
      200: {
        description: 'Hub details',
        content: {
          'application/json': {
            schema: resolver(hubDetailResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('hubs:read'),
  async (c) => {
    const hubId = c.req.param('hubId')
    const services = c.get('services')
    const user = c.get('user')
    const permissions = c.get('permissions')

    try {
      const { hub } = await services.settings.getHub(hubId)

      // Check access
      const isSuperAdmin = checkPermission(permissions, '*')
      const hasHubAccess = (user.hubRoles || []).some(hr => hr.hubId === hubId)
      if (!isSuperAdmin && !hasHubAccess) {
        return c.json({ error: 'Access denied' }, 403)
      }

      return c.json({ hub })
    } catch {
      return c.json({ error: 'Hub not found' }, 404)
    }
  },
)

// Update hub
routes.patch('/:hubId',
  describeRoute({
    tags: ['Hubs'],
    summary: 'Update a hub',
    responses: {
      200: {
        description: 'Hub updated',
        content: {
          'application/json': {
            schema: resolver(hubResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('system:manage-hubs'),
  validator('json', updateHubBodySchema),
  async (c) => {
    const hubId = c.req.param('hubId')
    const services = c.get('services')
    const body = c.req.valid('json')

    try {
      const result = await services.settings.updateHub(hubId, body)
      return c.json(result)
    } catch {
      return c.json({ error: 'Failed to update hub' }, 500)
    }
  },
)

// Add member to hub
routes.post('/:hubId/members',
  describeRoute({
    tags: ['Hubs'],
    summary: 'Add a member to a hub',
    responses: {
      200: {
        description: 'Member added',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('hubs:manage-members'),
  validator('json', addHubMemberBodySchema),
  async (c) => {
    const hubId = c.req.param('hubId')
    const services = c.get('services')
    const body = c.req.valid('json')

    const pubkey = c.get('pubkey')
    try {
      const result = await services.identity.setHubRole({
        pubkey: body.pubkey,
        hubId,
        roleIds: body.roleIds,
      })
      await audit(services.audit, 'userAdded', pubkey, { target: body.pubkey, roles: body.roleIds }, undefined, hubId)
      return c.json(result)
    } catch {
      return c.json({ error: 'Failed to add member' }, 500)
    }
  },
)

// Remove member from hub
routes.delete('/:hubId/members/:pubkey',
  describeRoute({
    tags: ['Hubs'],
    summary: 'Remove a member from a hub',
    responses: {
      200: {
        description: 'Member removed',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('hubs:manage-members'),
  async (c) => {
    const hubId = c.req.param('hubId')
    const targetPubkey = c.req.param('pubkey')
    const actorPubkey = c.get('pubkey')
    const services = c.get('services')

    try {
      await services.identity.removeHubRole({ pubkey: targetPubkey, hubId })
      await audit(services.audit, 'userRemoved', actorPubkey, { target: targetPubkey }, undefined, hubId)
      return c.json({ ok: true })
    } catch {
      return c.json({ error: 'Failed to remove member' }, 500)
    }
  },
)

// Delete hub (super admin only — permanent, cascades all hub data)
routes.delete('/:hubId',
  describeRoute({
    tags: ['Hubs'],
    summary: 'Permanently delete a hub and all its data',
    responses: {
      200: {
        description: 'Hub deleted',
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
  requirePermission('system:manage-hubs'),
  async (c) => {
    const hubId = c.req.param('hubId')
    const services = c.get('services')

    try {
      // Destroy hub-scoped storage buckets and IAM before deleting the hub
      const storageManager = (c.env as unknown as Record<string, unknown>).STORAGE_MANAGER as StorageManager | undefined
      if (storageManager) {
        const creds = await services.settings.getHubStorageCredentials(hubId)
        await storageManager.destroyHub(hubId, creds?.userName)
      }

      await services.settings.deleteHub(hubId)
      return c.json({ ok: true })
    } catch (err) {
      if (err instanceof ServiceError) {
        return c.json({ error: err.message }, err.status as 404 | 500)
      }
      const message = err instanceof Error ? err.message : 'Failed to delete hub'
      return c.json({ error: message }, 500)
    }
  },
)

// --- Hub Key Management ---

// Get my hub key envelope (any hub member)
routes.get('/:hubId/key',
  describeRoute({
    tags: ['Hubs'],
    summary: 'Get hub key envelope for current user',
    responses: {
      200: {
        description: 'Hub key envelope',
        content: {
          'application/json': {
            schema: resolver(hubKeyEnvelopeResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('hubs:read'),
  async (c) => {
    const hubId = c.req.param('hubId')
    const pubkey = c.get('pubkey')
    const services = c.get('services')
    const user = c.get('user')
    const permissions = c.get('permissions')

    // CRIT-H1: Verify caller is a member of this specific hub (or is super-admin)
    const isSuperAdmin = checkPermission(permissions, '*')
    const hasHubAccess = (user.hubRoles || []).some((hr: { hubId: string }) => hr.hubId === hubId)
    if (!isSuperAdmin && !hasHubAccess) {
      return c.json({ error: 'Access denied' }, 403)
    }

    try {
      const { envelopes, generation } = await services.settings.getHubKeyEnvelopes(hubId)

      // Return only the envelope for this user
      const myEnvelope = envelopes.find(e => e.pubkey === pubkey)
      if (!myEnvelope) return c.json({ error: 'No key envelope for this user' }, 404)

      return c.json({ envelope: myEnvelope, generation })
    } catch {
      return c.json({ error: 'Hub not found' }, 404)
    }
  },
)

const hubKeyConflict = {
  409: { description: 'The write is not for the hub\'s current key generation, or a rotation does not cover every hub-key-encrypted record; nothing was changed' },
}

function hubKeyErrorResponse(c: { json: (body: { error: string }, status: 404 | 409 | 500) => Response }, err: unknown, fallback: string): Response {
  if (err instanceof ServiceError && (err.status === 404 || err.status === 409)) {
    return c.json({ error: err.message }, err.status)
  }
  const message = err instanceof Error ? err.message : fallback
  return c.json({ error: message }, 500)
}

// Store the envelopes of the first key, or re-distribute the CURRENT key to
// the current member set. Refused (409) for any other generation, so a stale
// key set can never replace a newer one.
routes.put('/:hubId/key',
  describeRoute({
    tags: ['Hubs'],
    summary: 'Set hub key envelopes for the current key generation',
    responses: {
      200: {
        description: 'Hub key envelopes set',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
      ...hubKeyConflict,
    },
  }),
  requirePermission('hubs:manage-keys'),
  validator('json', hubKeyEnvelopesBodySchema),
  async (c) => {
    const hubId = c.req.param('hubId')
    const services = c.get('services')
    const body = c.req.valid('json')

    try {
      await services.settings.setHubKeyEnvelopes(hubId, body)
      return c.json({ ok: true })
    } catch (err) {
      return hubKeyErrorResponse(c, err, 'Failed to set hub key')
    }
  },
)

// Rotate the hub key: new envelopes + every hub-key-encrypted record
// re-encrypted under the new key, committed atomically.
routes.post('/:hubId/key/rotate',
  describeRoute({
    tags: ['Hubs'],
    summary: 'Rotate the hub key and re-encrypt hub data in one atomic commit',
    responses: {
      200: {
        description: 'Hub key rotated',
        content: {
          'application/json': {
            schema: resolver(rotateHubKeyResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
      ...hubKeyConflict,
    },
  }),
  requirePermission('hubs:manage-keys'),
  validator('json', rotateHubKeyBodySchema),
  async (c) => {
    const hubId = c.req.param('hubId')
    const services = c.get('services')
    const body = c.req.valid('json')

    try {
      const { generation } = await services.settings.rotateHubKey(hubId, body)
      return c.json({ generation })
    } catch (err) {
      return hubKeyErrorResponse(c, err, 'Failed to rotate hub key')
    }
  },
)

export default routes
