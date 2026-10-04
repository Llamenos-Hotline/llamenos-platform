import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '../types'
import { requirePermission, checkPermission } from '../middleware/permission-guard'
import { audit } from '../services/audit'
import { withRetry, isRetryableError } from '../lib/retry'
import { getCircuitBreaker } from '../lib/circuit-breaker'
import { incCounter } from './metrics'
import { shareFileBodySchema, fileEnvelopesResponseSchema, fileMetadataResponseSchema } from '@protocol/schemas/files'
import { okResponseSchema } from '@protocol/schemas/common'
import { authErrors } from '../openapi/helpers'
import { createLogger } from '../lib/logger'

const logger = createLogger('routes.files')

const files = new Hono<AppEnv>()

// Download encrypted file content
files.get('/:id/content',
  describeRoute({
    tags: ['Files'],
    summary: 'Download encrypted file content',
    responses: {
      ...authErrors,
      200: { description: 'Encrypted file binary content' },
      400: { description: 'File upload not complete' },
      403: { description: 'Forbidden' },
      404: { description: 'File not found' },
    },
  }),
  async (c) => {
    const fileId = c.req.param('id')
    const pubkey = c.get('pubkey')
    const permissions = c.get('permissions')
    const services = c.get('services')

    // Get file record to verify access
    const fileRecord = await services.conversations.getFile(fileId)

    if (fileRecord.status !== 'complete') {
      return c.json({ error: 'File upload not complete' }, 400)
    }

    // Verify the requester has an envelope (is an authorized recipient)
    const envelopes = (fileRecord.recipientEnvelopes ?? []) as Array<{ pubkey: string }>
    const hasAccess = checkPermission(permissions, 'files:download-all') ||
      fileRecord.uploadedBy === pubkey ||
      envelopes.some(e => e.pubkey === pubkey)

    if (!hasAccess) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    const storageBreaker = getCircuitBreaker({
      name: 'blob:r2',
      failureThreshold: 5,
      resetTimeoutMs: 30_000,
    })
    const obj = await storageBreaker.execute(() =>
      withRetry(
        () => c.env.BLOB_STORAGE.get(`files/${fileId}/content`),
        {
          maxAttempts: 3,
          baseDelayMs: 200,
          maxDelayMs: 2000,
          isRetryable: isRetryableError,
          onRetry: (attempt, error) => {
            logger.warn(`blob get retry ${attempt} for ${fileId}`, { error })
            incCounter('llamenos_retry_attempts_total', { service: 'blob', operation: 'get' })
          },
        },
      )
    )
    if (!obj) {
      return c.json({ error: 'File content not found' }, 404)
    }

    return new Response(obj.body, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(obj.size),
        'Cache-Control': 'private, no-cache',
      },
    })
  })

// Get file envelopes (recipient key wrappers)
files.get('/:id/envelopes',
  describeRoute({
    tags: ['Files'],
    summary: 'Get file key envelopes',
    responses: {
      ...authErrors,
      200: {
        description: 'File key envelopes for authorized recipients',
        content: {
          'application/json': {
            schema: resolver(fileEnvelopesResponseSchema),
          },
        },
      },
      403: { description: 'Forbidden' },
      404: { description: 'File not found' },
    },
  }),
  async (c) => {
    const fileId = c.req.param('id')
    const pubkey = c.get('pubkey')
    const permissions = c.get('permissions')
    const services = c.get('services')

    const fileRecord = await services.conversations.getFile(fileId)
    const envelopes = (fileRecord.recipientEnvelopes ?? []) as Array<{ pubkey: string }>

    const hasAccess = checkPermission(permissions, 'files:download-all') ||
      fileRecord.uploadedBy === pubkey ||
      envelopes.some(e => e.pubkey === pubkey)

    if (!hasAccess) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    // Return only the envelope for the requesting user (or all for users with download-all)
    if (checkPermission(permissions, 'files:download-all')) {
      return c.json({ envelopes })
    }

    const myEnvelope = envelopes.find(e => e.pubkey === pubkey)
    return c.json({ envelopes: myEnvelope ? [myEnvelope] : [] })
  })

// Get encrypted file metadata
files.get('/:id/metadata',
  describeRoute({
    tags: ['Files'],
    summary: 'Get encrypted file metadata',
    responses: {
      ...authErrors,
      200: {
        description: 'Encrypted metadata for authorized recipients',
        content: {
          'application/json': {
            schema: resolver(fileMetadataResponseSchema),
          },
        },
      },
      403: { description: 'Forbidden' },
      404: { description: 'File not found' },
    },
  }),
  async (c) => {
    const fileId = c.req.param('id')
    const pubkey = c.get('pubkey')
    const permissions = c.get('permissions')
    const services = c.get('services')

    const fileRecord = await services.conversations.getFile(fileId)
    const envelopes = (fileRecord.recipientEnvelopes ?? []) as Array<{ pubkey: string }>
    const metadataEntries = (fileRecord.encryptedMetadata ?? []) as Array<{ pubkey: string }>

    const hasAccess = checkPermission(permissions, 'files:download-all') ||
      fileRecord.uploadedBy === pubkey ||
      envelopes.some(e => e.pubkey === pubkey)

    if (!hasAccess) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    // Return only the metadata blob for the requesting user (or all for users with download-all)
    if (checkPermission(permissions, 'files:download-all')) {
      return c.json({ metadata: metadataEntries })
    }

    const myMeta = metadataEntries.find(m => m.pubkey === pubkey)
    return c.json({ metadata: myMeta ? [myMeta] : [] })
  })

// Share file with a new recipient (requires files:share — admin re-encrypts the file key for a volunteer)
files.post('/:id/share', requirePermission('files:share'),
  describeRoute({
    tags: ['Files'],
    summary: 'Share file with a new recipient',
    responses: {
      200: {
        description: 'File shared successfully',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      500: { description: 'Failed to share file' },
      ...authErrors,
    },
  }),
  validator('json', shareFileBodySchema),
  async (c) => {
    const fileId = c.req.param('id')
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')
    const services = c.get('services')

    // Add the new envelope to the file record via service
    await services.conversations.addFileRecipient(fileId, body.envelope, body.encryptedMetadata)

    await audit(services.audit, 'fileShared', pubkey, { fileId, sharedWith: body.envelope.pubkey }, undefined, null)

    return c.json({ ok: true })
  })

export default files
