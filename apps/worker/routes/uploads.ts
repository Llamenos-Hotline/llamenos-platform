import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '../types'
import { requirePermission, checkPermission } from '../middleware/permission-guard'
import { uploadInitBodySchema, uploadInitResponseSchema, chunkUploadResponseSchema, uploadCompleteResponseSchema, uploadStatusResponseSchema } from '@protocol/schemas/uploads'
import { authErrors, notFoundError } from '../openapi/helpers'
import { audit } from '../services/audit'
import { withRetry, isRetryableError } from '../lib/retry'
import { getCircuitBreaker } from '../lib/circuit-breaker'
import { hubOnly, pathHubId } from '../lib/hub-scope'
import { isReport, verifyReportAccess } from '../lib/report-access'
import { incCounter } from './metrics'
import { createLogger } from '../lib/logger'

const logger = createLogger('routes.uploads')

const MAX_UPLOAD_SIZE = 100 * 1024 * 1024  // 100 MB
const MAX_CHUNK_SIZE = 10 * 1024 * 1024    // 10 MB

/**
 * Chunked, end-to-end encrypted uploads. Mounted ONLY under /hubs/:hubId
 * (#2462): the path hub is the file's hub, so `files:upload` is decided by the
 * caller's role in that hub — a hub member's grant lives in its hub role, never
 * in a global one (#2153) — and every file is created with a hub and a typed
 * parent inside it. Every file goes through this one path, including the value
 * of an entity's file field.
 */
const uploads = new Hono<AppEnv>()
uploads.use('*', hubOnly)
uploads.use('*', requirePermission('files:upload'))

// Initialize an upload — returns uploadId and chunk upload URLs
uploads.post('/init',
  describeRoute({
    tags: ['Uploads'],
    summary: 'Initialize a chunked upload',
    responses: {
      200: {
        description: 'Upload initialized with uploadId',
        content: {
          'application/json': {
            schema: resolver(uploadInitResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  validator('json', uploadInitBodySchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const services = c.get('services')
    const hubId = pathHubId(c)
    const body = c.req.valid('json')

    if (body.totalSize > MAX_UPLOAD_SIZE) {
      return c.json({ error: `File too large (max ${MAX_UPLOAD_SIZE / 1024 / 1024}MB)` }, 400)
    }

    // Attaching a file to a parent takes the right to add to that parent:
    // posting into a conversation (report access for a report), or registering
    // evidence on a case record — not merely `files:upload` somewhere in the hub.
    const permissions = c.get('permissions')
    const { owner } = body
    if (owner.kind === 'conversation') {
      const conv = await services.conversations.getByIdForHub(owner.conversationId, hubId)
      const mayAdd = isReport(conv)
        ? verifyReportAccess(conv, pubkey, permissions)
        : checkPermission(permissions, 'conversations:send-any') || conv.assignedTo === pubkey
      if (!mayAdd) return c.json({ error: 'Forbidden' }, 403)
    } else if (owner.kind === 'case_record' && !checkPermission(permissions, 'evidence:upload')) {
      return c.json({ error: 'Forbidden', required: 'evidence:upload' }, 403)
    }

    const uploadId = crypto.randomUUID()

    // The owner must exist inside the path hub (404 otherwise).
    await services.conversations.createFile({
      id: uploadId,
      hubId,
      owner: body.owner,
      uploadedBy: pubkey,
      recipientEnvelopes: body.recipientEnvelopes || [],
      encryptedMetadata: body.encryptedMetadata || [],
      totalSize: body.totalSize,
      totalChunks: body.totalChunks,
    })

    await audit(services.audit, 'fileUploadStarted', pubkey, {
      uploadId,
      owner: body.owner,
      totalSize: body.totalSize,
      totalChunks: body.totalChunks,
    }, undefined, hubId)

    return c.json({ uploadId, totalChunks: body.totalChunks })
  },
)

// Upload a chunk
uploads.put('/:id/chunks/:chunkIndex',
  describeRoute({
    tags: ['Uploads'],
    summary: 'Upload a single chunk',
    responses: {
      200: {
        description: 'Chunk uploaded',
        content: {
          'application/json': {
            schema: resolver(chunkUploadResponseSchema),
          },
        },
      },
      409: { description: 'Upload already completed' },
      413: { description: 'Chunk larger than 10 MB' },
      ...authErrors,
      ...notFoundError,
    },
  }),
  async (c) => {
    const pubkey = c.get('pubkey')
    const permissions = c.get('permissions')
    const uploadId = c.req.param('id')
    const chunkIndex = parseInt(c.req.param('chunkIndex'), 10)
    const services = c.get('services')

    if (isNaN(chunkIndex) || chunkIndex < 0) {
      return c.json({ error: 'Invalid chunk index' }, 400)
    }

    // Verify ownership before accepting chunk
    const fileRecord = await services.conversations.getFileInHub(uploadId, pathHubId(c))
    if (fileRecord.uploadedBy !== pubkey && !checkPermission(permissions, 'files:manage-all')) {
      return c.json({ error: 'Forbidden' }, 403)
    }
    // A completed file is immutable: evidence may already describe its bytes.
    if (fileRecord.status !== 'uploading') {
      return c.json({ error: 'Upload already completed' }, 409)
    }

    // Store chunk directly in blob storage
    const body = await c.req.arrayBuffer()
    if (!body || body.byteLength === 0) {
      return c.json({ error: 'Empty chunk' }, 400)
    }

    if (body.byteLength > MAX_CHUNK_SIZE) {
      return c.json({ error: `Chunk too large (max ${MAX_CHUNK_SIZE / 1024 / 1024}MB)` }, 413)
    }

    const blobKey = `files/${uploadId}/chunk-${String(chunkIndex).padStart(6, '0')}`
    const storageBreaker = getCircuitBreaker({
      name: 'blob:r2',
      failureThreshold: 5,
      resetTimeoutMs: 30_000,
    })
    await storageBreaker.execute(() =>
      withRetry(
        () => c.env.BLOB_STORAGE.put(blobKey, body),
        {
          maxAttempts: 3,
          baseDelayMs: 200,
          maxDelayMs: 2000,
          isRetryable: isRetryableError,
          onRetry: (attempt, error) => {
            logger.warn(`blob put retry ${attempt} for ${blobKey}`, { error })
            incCounter('llamenos_retry_attempts_total', { service: 'blob', operation: 'put' })
          },
        },
      )
    )

    // Update completion count via service
    const updated = await services.conversations.markChunkComplete(uploadId)

    return c.json({ chunkIndex, completedChunks: updated.completedChunks, totalChunks: updated.totalChunks })
  },
)

// Complete an upload — assembles chunks
uploads.post('/:id/complete',
  describeRoute({
    tags: ['Uploads'],
    summary: 'Complete a chunked upload',
    responses: {
      200: {
        description: 'Upload completed',
        content: {
          'application/json': {
            schema: resolver(uploadCompleteResponseSchema),
          },
        },
      },
      409: { description: 'Upload already completed' },
      ...authErrors,
      ...notFoundError,
    },
  }),
  async (c) => {
    const pubkey = c.get('pubkey')
    const permissions = c.get('permissions')
    const uploadId = c.req.param('id')
    const services = c.get('services')

    // Verify all chunks are uploaded
    const fileRecord = await services.conversations.getFileInHub(uploadId, pathHubId(c))

    if (fileRecord.uploadedBy !== pubkey && !checkPermission(permissions, 'files:manage-all')) {
      return c.json({ error: 'Forbidden' }, 403)
    }
    // Re-assembling a completed file would replace bytes evidence may describe.
    if (fileRecord.status !== 'uploading') {
      return c.json({ error: 'Upload already completed' }, 409)
    }

    if (fileRecord.completedChunks < fileRecord.totalChunks) {
      return c.json({
        error: 'Not all chunks uploaded',
        completedChunks: fileRecord.completedChunks,
        totalChunks: fileRecord.totalChunks,
      }, 400)
    }

    // Concatenate chunks into a single blob
    const chunks: Uint8Array[] = []
    for (let i = 0; i < fileRecord.totalChunks; i++) {
      const blobKey = `files/${uploadId}/chunk-${String(i).padStart(6, '0')}`
      const obj = await c.env.BLOB_STORAGE.get(blobKey)
      if (!obj) {
        return c.json({ error: `Missing chunk ${i}` }, 500)
      }
      chunks.push(new Uint8Array(await obj.arrayBuffer()))
    }

    // Write assembled file
    const totalLen = chunks.reduce((s, c) => s + c.length, 0)
    const assembled = new Uint8Array(totalLen)
    let offset = 0
    for (const chunk of chunks) {
      assembled.set(chunk, offset)
      offset += chunk.length
    }

    const completeStorageBreaker = getCircuitBreaker({
      name: 'blob:r2',
      failureThreshold: 5,
      resetTimeoutMs: 30_000,
    })

    await completeStorageBreaker.execute(() =>
      withRetry(
        () => c.env.BLOB_STORAGE.put(`files/${uploadId}/content`, assembled),
        {
          maxAttempts: 3,
          baseDelayMs: 300,
          maxDelayMs: 3000,
          isRetryable: isRetryableError,
          onRetry: (attempt, error) => {
            logger.warn(`blob put content retry ${attempt}`, { error })
            incCounter('llamenos_retry_attempts_total', { service: 'blob', operation: 'put' })
          },
        },
      )
    )

    // Store envelopes and metadata in blob storage
    await withRetry(
      async () => {
        await c.env.BLOB_STORAGE.put(`files/${uploadId}/envelopes`, JSON.stringify(fileRecord.recipientEnvelopes))
        await c.env.BLOB_STORAGE.put(`files/${uploadId}/metadata`, JSON.stringify(fileRecord.encryptedMetadata))
      },
      {
        maxAttempts: 3,
        baseDelayMs: 200,
        maxDelayMs: 2000,
        isRetryable: isRetryableError,
        onRetry: (attempt) => {
            logger.warn(`blob put envelopes/metadata retry ${attempt}`)
            incCounter('llamenos_retry_attempts_total', { service: 'blob', operation: 'put' })
        },
      },
    )

    // Clean up individual chunks
    for (let i = 0; i < fileRecord.totalChunks; i++) {
      const blobKey = `files/${uploadId}/chunk-${String(i).padStart(6, '0')}`
      await c.env.BLOB_STORAGE.delete(blobKey)
    }

    // Mark file as complete via service
    const completedAt = await services.conversations.markFileComplete(uploadId)

    await audit(services.audit, 'fileUploadCompleted', pubkey, { uploadId }, undefined, fileRecord.hubId)

    return c.json({
      fileId: uploadId,
      status: 'complete',
      completedAt: completedAt.toISOString(),
    })
  },
)

// Get upload status (for resume)
uploads.get('/:id/status',
  describeRoute({
    tags: ['Uploads'],
    summary: 'Get upload status for resume',
    responses: {
      200: {
        description: 'Upload status',
        content: {
          'application/json': {
            schema: resolver(uploadStatusResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  async (c) => {
    const pubkey = c.get('pubkey')
    const permissions = c.get('permissions')
    const uploadId = c.req.param('id')
    const services = c.get('services')

    const fileRecord = await services.conversations.getFileInHub(uploadId, pathHubId(c))

    // Only allow the uploader or users with files:manage-all to check status
    if (fileRecord.uploadedBy !== pubkey && !checkPermission(permissions, 'files:manage-all')) {
      return c.json({ error: 'Upload not found' }, 404)
    }
    return c.json({
      uploadId: fileRecord.id,
      status: fileRecord.status,
      completedChunks: fileRecord.completedChunks,
      totalChunks: fileRecord.totalChunks,
      totalSize: fileRecord.totalSize,
    })
  },
)

export default uploads
