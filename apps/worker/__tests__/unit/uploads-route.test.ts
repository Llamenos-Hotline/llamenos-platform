/**
 * Unit tests for routes/uploads.ts
 *
 * Tests: size limits, ownership checks, chunk validation, completion logic.
 *
 * Bug fixed: chunk upload previously used `files:download-all` to gate admin overrides,
 * now correctly uses `files:manage-all`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '../../types'
import uploadsRouter from '../../routes/uploads'

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

type FileRecordLike = {
  id: string
  uploadedBy: string
  status: string
  completedChunks: number
  totalChunks: number
  totalSize: number
  recipientEnvelopes?: unknown[]
  encryptedMetadata?: unknown[]
}

const BLOB_STUB = {
  put: vi.fn().mockResolvedValue(undefined),
  get: vi.fn(),
  delete: vi.fn().mockResolvedValue(undefined),
}

// Hono bindings — passed as 3rd arg to app.request() so that c.env.BLOB_STORAGE resolves
const BLOB_BINDINGS = { BLOB_STORAGE: BLOB_STUB }

function makeApp(opts: {
  permissions?: string[]
  pubkey?: string
  fileRecord?: FileRecordLike
} = {}) {
  const {
    permissions = ['files:upload'],
    pubkey = 'uploader-pub',
    fileRecord = {
      id: 'upload-1',
      uploadedBy: 'uploader-pub',
      status: 'uploading',
      completedChunks: 0,
      totalChunks: 3,
      totalSize: 1024,
      recipientEnvelopes: [],
      encryptedMetadata: [],
    },
  } = opts

  const mockAudit = { log: vi.fn().mockResolvedValue(undefined) }
  const mockConversations = {
    createFile: vi.fn().mockResolvedValue(undefined),
    getFile: vi.fn().mockResolvedValue(fileRecord),
    markChunkComplete: vi.fn().mockResolvedValue({ completedChunks: 1, totalChunks: fileRecord.totalChunks }),
    markFileComplete: vi.fn().mockResolvedValue(undefined),
  }

  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('pubkey', pubkey)
    c.set('permissions', permissions)
    c.set('requestId', 'req-test')
    c.set('services', {
      audit: mockAudit,
      conversations: mockConversations,
    } as unknown as AppEnv['Variables']['services'])
    await next()
  })
  app.route('/', uploadsRouter)

  // Wrap app.request to always inject BLOB_STORAGE as Hono bindings (c.env.BLOB_STORAGE)
  const request = (input: string, init?: RequestInit) =>
    app.request(input, init, BLOB_BINDINGS)

  return { app, request, mockConversations, mockAudit }
}

// ---------------------------------------------------------------------------
// Global permission gate
// ---------------------------------------------------------------------------

describe('uploads route — global permission gate (files:upload)', () => {
  it('rejects users without files:upload on POST /init', async () => {
    const { request } = makeApp({ permissions: [] })
    const res = await request('/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'c1', totalSize: 100, totalChunks: 1 }),
    })
    expect(res.status).toBe(403)
  })

  it('allows users with files:upload', async () => {
    const { request } = makeApp({ permissions: ['files:upload'] })
    const res = await request('/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'c1', totalSize: 100, totalChunks: 1 }),
    })
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// POST /init — size limits
// ---------------------------------------------------------------------------

describe('POST /uploads/init', () => {
  it('rejects files over 100 MB', async () => {
    const { request } = makeApp()
    const oversized = 100 * 1024 * 1024 + 1
    const res = await request('/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'c1', totalSize: oversized, totalChunks: 1 }),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/too large/)
  })

  it('accepts files exactly at 100 MB limit', async () => {
    const { request } = makeApp()
    const exactly100MB = 100 * 1024 * 1024
    const res = await request('/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'c1', totalSize: exactly100MB, totalChunks: 10 }),
    })
    expect(res.status).toBe(200)
  })

  it('returns uploadId and totalChunks', async () => {
    const { request } = makeApp()
    const res = await request('/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'c1', totalSize: 1024, totalChunks: 3 }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { uploadId: string; totalChunks: number }
    expect(typeof body.uploadId).toBe('string')
    expect(body.totalChunks).toBe(3)
  })

  it('stores file record via service', async () => {
    const { request, mockConversations } = makeApp({ pubkey: 'user-pub' })
    await request('/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'conv-1', totalSize: 500, totalChunks: 1 }),
    })
    expect(mockConversations.createFile).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        uploadedBy: 'user-pub',
        totalSize: 500,
        totalChunks: 1,
      }),
    )
  })

  it('audits upload start', async () => {
    const { request, mockAudit } = makeApp()
    await request('/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'c1', totalSize: 100, totalChunks: 1 }),
    })
    expect(mockAudit.log.mock.calls.some((call: unknown[]) => call[0] === 'fileUploadStarted')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// PUT /:id/chunks/:chunkIndex — chunk validation
// ---------------------------------------------------------------------------

describe('PUT /uploads/:id/chunks/:chunkIndex', () => {
  it('rejects invalid chunk index (NaN)', async () => {
    const { request } = makeApp()
    const res = await request('/upload-1/chunks/notanumber', {
      method: 'PUT',
      body: new Uint8Array([1, 2, 3]),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/Invalid chunk index/)
  })

  it('rejects negative chunk index', async () => {
    const { request } = makeApp()
    const res = await request('/upload-1/chunks/-1', {
      method: 'PUT',
      body: new Uint8Array([1, 2, 3]),
    })
    expect(res.status).toBe(400)
  })

  it('rejects empty chunk body', async () => {
    const { request } = makeApp()
    const res = await request('/upload-1/chunks/0', {
      method: 'PUT',
      body: new ArrayBuffer(0),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/Empty chunk/)
  })

  it('rejects chunk over 10 MB', async () => {
    const { request } = makeApp()
    const oversized = new Uint8Array(10 * 1024 * 1024 + 1)
    const res = await request('/upload-1/chunks/0', {
      method: 'PUT',
      body: oversized,
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/too large/)
  })

  it('rejects upload from non-owner (IDOR protection)', async () => {
    const { request } = makeApp({
      pubkey: 'attacker-pub',
      permissions: ['files:upload'],
      fileRecord: {
        id: 'upload-1',
        uploadedBy: 'victim-pub',
        status: 'uploading',
        completedChunks: 0,
        totalChunks: 1,
        totalSize: 100,
      },
    })
    const res = await request('/upload-1/chunks/0', {
      method: 'PUT',
      body: new Uint8Array([1, 2, 3]),
    })
    expect(res.status).toBe(403)
  })

  it('allows files:manage-all to bypass ownership check on chunks', async () => {
    const { request } = makeApp({
      pubkey: 'admin-pub',
      permissions: ['files:upload', 'files:manage-all'],
      fileRecord: {
        id: 'upload-1',
        uploadedBy: 'someone-else',
        status: 'uploading',
        completedChunks: 0,
        totalChunks: 1,
        totalSize: 100,
      },
    })
    const res = await request('/upload-1/chunks/0', {
      method: 'PUT',
      body: new Uint8Array([1, 2, 3]),
    })
    expect(res.status).toBe(200)
  })

  it('rejects files:download-all from bypassing upload ownership', async () => {
    const { request } = makeApp({
      pubkey: 'admin-pub',
      permissions: ['files:upload', 'files:download-all'],
      fileRecord: {
        id: 'upload-1',
        uploadedBy: 'someone-else',
        status: 'uploading',
        completedChunks: 0,
        totalChunks: 1,
        totalSize: 100,
      },
    })
    const res = await request('/upload-1/chunks/0', {
      method: 'PUT',
      body: new Uint8Array([1, 2, 3]),
    })
    expect(res.status).toBe(403)
  })

  it('accepts valid chunk from owner', async () => {
    const { request } = makeApp()
    const res = await request('/upload-1/chunks/0', {
      method: 'PUT',
      body: new Uint8Array([1, 2, 3]),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { chunkIndex: number; completedChunks: number }
    expect(body.chunkIndex).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// POST /:id/complete — completion logic
// ---------------------------------------------------------------------------

describe('POST /uploads/:id/complete', () => {
  beforeEach(() => {
    BLOB_STUB.get.mockReset()
    BLOB_STUB.put.mockReset()
    BLOB_STUB.delete.mockReset()
    BLOB_STUB.put.mockResolvedValue(undefined)
    BLOB_STUB.delete.mockResolvedValue(undefined)
  })

  it('rejects completion when not all chunks uploaded', async () => {
    const { request } = makeApp({
      fileRecord: {
        id: 'upload-1',
        uploadedBy: 'uploader-pub',
        status: 'uploading',
        completedChunks: 1,
        totalChunks: 3,
        totalSize: 300,
        recipientEnvelopes: [],
        encryptedMetadata: [],
      },
    })
    const res = await request('/upload-1/complete', { method: 'POST' })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string; completedChunks: number; totalChunks: number }
    expect(body.error).toMatch(/Not all chunks/)
    expect(body.completedChunks).toBe(1)
    expect(body.totalChunks).toBe(3)
  })

  it('returns 403 for non-owner trying to complete', async () => {
    const { request } = makeApp({
      pubkey: 'attacker',
      permissions: ['files:upload'],
      fileRecord: {
        id: 'upload-1',
        uploadedBy: 'victim',
        status: 'uploading',
        completedChunks: 2,
        totalChunks: 2,
        totalSize: 200,
        recipientEnvelopes: [],
        encryptedMetadata: [],
      },
    })
    const res = await request('/upload-1/complete', { method: 'POST' })
    expect(res.status).toBe(403)
  })

  it('allows files:manage-all to bypass ownership check on complete', async () => {
    const chunk0 = new Uint8Array([1, 2])
    BLOB_STUB.get.mockResolvedValueOnce({ arrayBuffer: () => Promise.resolve(chunk0.buffer) })
    BLOB_STUB.put.mockResolvedValue(undefined)
    BLOB_STUB.delete.mockResolvedValue(undefined)

    const { request } = makeApp({
      pubkey: 'admin-pub',
      permissions: ['files:upload', 'files:manage-all'],
      fileRecord: {
        id: 'upload-1',
        uploadedBy: 'someone-else',
        status: 'uploading',
        completedChunks: 1,
        totalChunks: 1,
        totalSize: 2,
        recipientEnvelopes: [],
        encryptedMetadata: [],
      },
    })
    const res = await request('/upload-1/complete', { method: 'POST' })
    expect(res.status).toBe(200)
  })

  it('rejects files:download-all from bypassing ownership on complete', async () => {
    const { request } = makeApp({
      pubkey: 'admin-pub',
      permissions: ['files:upload', 'files:download-all'],
      fileRecord: {
        id: 'upload-1',
        uploadedBy: 'someone-else',
        status: 'uploading',
        completedChunks: 2,
        totalChunks: 2,
        totalSize: 200,
        recipientEnvelopes: [],
        encryptedMetadata: [],
      },
    })
    const res = await request('/upload-1/complete', { method: 'POST' })
    expect(res.status).toBe(403)
  })

  it('returns 500 when a chunk is missing from blob storage', async () => {
    BLOB_STUB.get.mockResolvedValueOnce(null) // chunk 0 is missing
    const { request } = makeApp({
      fileRecord: {
        id: 'upload-1',
        uploadedBy: 'uploader-pub',
        status: 'uploading',
        completedChunks: 2,
        totalChunks: 2,
        totalSize: 200,
        recipientEnvelopes: [],
        encryptedMetadata: [],
      },
    })
    const res = await request('/upload-1/complete', { method: 'POST' })
    expect(res.status).toBe(500)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/Missing chunk/)
  })

  it('assembles chunks and marks file complete', async () => {
    const chunk0 = new Uint8Array([1, 2])
    const chunk1 = new Uint8Array([3, 4])
    BLOB_STUB.get
      .mockResolvedValueOnce({ arrayBuffer: () => Promise.resolve(chunk0.buffer) })
      .mockResolvedValueOnce({ arrayBuffer: () => Promise.resolve(chunk1.buffer) })

    const { request, mockConversations } = makeApp({
      fileRecord: {
        id: 'upload-1',
        uploadedBy: 'uploader-pub',
        status: 'uploading',
        completedChunks: 2,
        totalChunks: 2,
        totalSize: 4,
        recipientEnvelopes: [],
        encryptedMetadata: [],
      },
    })

    const res = await request('/upload-1/complete', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json() as { fileId: string; status: string }
    expect(body.fileId).toBe('upload-1')
    expect(body.status).toBe('complete')
    expect(mockConversations.markFileComplete).toHaveBeenCalledWith('upload-1')
  })
})

// ---------------------------------------------------------------------------
// GET /:id/status — upload status
// ---------------------------------------------------------------------------

describe('GET /uploads/:id/status', () => {
  it('returns upload status for the owner', async () => {
    const { request } = makeApp({
      pubkey: 'uploader-pub',
      fileRecord: {
        id: 'upload-1',
        uploadedBy: 'uploader-pub',
        status: 'uploading',
        completedChunks: 1,
        totalChunks: 3,
        totalSize: 300,
      },
    })
    const res = await request('/upload-1/status')
    expect(res.status).toBe(200)
    const body = await res.json() as { status: string; completedChunks: number }
    expect(body.status).toBe('uploading')
    expect(body.completedChunks).toBe(1)
  })

  it('returns 404 for non-owner (obfuscated as not found)', async () => {
    const { request } = makeApp({
      pubkey: 'stranger',
      permissions: ['files:upload'],
      fileRecord: {
        id: 'upload-1',
        uploadedBy: 'someone-else',
        status: 'uploading',
        completedChunks: 1,
        totalChunks: 3,
        totalSize: 300,
      },
    })
    const res = await request('/upload-1/status')
    expect(res.status).toBe(404)
  })

  it('allows files:manage-all to bypass ownership check on status', async () => {
    const { request } = makeApp({
      pubkey: 'admin-pub',
      permissions: ['files:upload', 'files:manage-all'],
      fileRecord: {
        id: 'upload-1',
        uploadedBy: 'someone-else',
        status: 'uploading',
        completedChunks: 2,
        totalChunks: 3,
        totalSize: 300,
      },
    })
    const res = await request('/upload-1/status')
    expect(res.status).toBe(200)
    const body = await res.json() as { status: string }
    expect(body.status).toBe('uploading')
  })

  it('rejects files:download-all from bypassing ownership on status', async () => {
    const { request } = makeApp({
      pubkey: 'admin-pub',
      permissions: ['files:upload', 'files:download-all'],
      fileRecord: {
        id: 'upload-1',
        uploadedBy: 'someone-else',
        status: 'uploading',
        completedChunks: 1,
        totalChunks: 3,
        totalSize: 300,
      },
    })
    const res = await request('/upload-1/status')
    expect(res.status).toBe(404)
  })
})
