/**
 * Unit tests for routes/files.ts
 *
 * Tests: envelope-based access control, uploader access, files:download-all bypass,
 * file sharing permission, metadata scoping.
 */
import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '../../types'
import filesRouter from '../../routes/files'

// ---------------------------------------------------------------------------
// Schema-valid test data helpers
// ---------------------------------------------------------------------------

const HEX64 = 'a'.repeat(64)
const HPKE_ENC = 'b'.repeat(64)

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

type FileRecordLike = {
  id: string
  uploadedBy: string
  status: string
  recipientEnvelopes?: Array<{ pubkey: string; enc: string; ct: string }>
  encryptedMetadata?: Array<{ pubkey: string; blob: string }>
}

const BLOB_STUB = {
  get: vi.fn(),
  put: vi.fn(),
}

// Hono bindings — passed as 3rd arg to app.request() so that c.env.BLOB_STORAGE resolves
const BLOB_BINDINGS = { BLOB_STORAGE: BLOB_STUB }

function makeApp(opts: {
  permissions?: string[]
  pubkey?: string
  fileRecord?: FileRecordLike
} = {}) {
  const {
    permissions = [],
    pubkey = 'my-pubkey',
    fileRecord = {
      id: 'file-1',
      uploadedBy: 'uploader-pub',
      status: 'complete',
      recipientEnvelopes: [{ pubkey: 'recipient-pub', enc: HEX64, ct: 'wk' }],
      encryptedMetadata: [{ pubkey: 'recipient-pub', blob: 'meta-blob' }],
    },
  } = opts

  const mockAudit = { log: vi.fn().mockResolvedValue(undefined) }
  const mockConversations = {
    getFile: vi.fn().mockResolvedValue(fileRecord),
    addFileRecipient: vi.fn().mockResolvedValue(undefined),
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
  app.route('/', filesRouter)

  // Wrap app.request to always inject BLOB_STORAGE as Hono bindings (c.env.BLOB_STORAGE)
  const request = (input: string, init?: RequestInit) =>
    app.request(input, init, BLOB_BINDINGS)

  return { app, request, mockConversations, mockAudit }
}

// ---------------------------------------------------------------------------
// GET /:id/content — download access control
// ---------------------------------------------------------------------------

describe('GET /files/:id/content', () => {
  it('returns 400 when file upload is not complete', async () => {
    const { request } = makeApp({
      fileRecord: { id: 'f1', uploadedBy: 'up', status: 'uploading' },
    })
    const res = await request('/f1/content')
    expect(res.status).toBe(400)
  })

  it('returns 403 for user without access', async () => {
    const { request } = makeApp({
      pubkey: 'stranger',
      fileRecord: {
        id: 'f1',
        uploadedBy: 'uploader',
        status: 'complete',
        recipientEnvelopes: [{ pubkey: 'someone-else', enc: HEX64, ct: 'k' }],
      },
    })
    const res = await request('/f1/content')
    expect(res.status).toBe(403)
  })

  it('allows the uploader to download their own file', async () => {
    BLOB_STUB.get.mockResolvedValueOnce({
      body: new ReadableStream(),
      size: 10,
    })
    const { request } = makeApp({
      pubkey: 'uploader-pub',
      fileRecord: {
        id: 'f1',
        uploadedBy: 'uploader-pub',
        status: 'complete',
        recipientEnvelopes: [],
      },
    })
    const res = await request('/f1/content')
    expect([200, 404]).toContain(res.status)
  })

  it('allows recipient in envelopes to download', async () => {
    BLOB_STUB.get.mockResolvedValueOnce({
      body: new ReadableStream(),
      size: 5,
    })
    const { request } = makeApp({
      pubkey: 'recipient-pub',
      fileRecord: {
        id: 'f1',
        uploadedBy: 'someone-else',
        status: 'complete',
        recipientEnvelopes: [{ pubkey: 'recipient-pub', enc: HEX64, ct: 'key' }],
      },
    })
    const res = await request('/f1/content')
    expect([200, 404]).toContain(res.status)
  })

  it('allows user with files:download-all to bypass envelope check', async () => {
    BLOB_STUB.get.mockResolvedValueOnce({
      body: new ReadableStream(),
      size: 5,
    })
    const { request } = makeApp({
      permissions: ['files:download-all'],
      pubkey: 'admin-pub',
      fileRecord: {
        id: 'f1',
        uploadedBy: 'someone',
        status: 'complete',
        recipientEnvelopes: [],
      },
    })
    const res = await request('/f1/content')
    expect([200, 404]).toContain(res.status)
  })

  it('returns 404 when the blob is not found', async () => {
    BLOB_STUB.get.mockResolvedValueOnce(null)
    const { request } = makeApp({
      pubkey: 'uploader-pub',
      fileRecord: {
        id: 'f1',
        uploadedBy: 'uploader-pub',
        status: 'complete',
        recipientEnvelopes: [],
      },
    })
    const res = await request('/f1/content')
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// GET /:id/envelopes — envelope access scoping
// ---------------------------------------------------------------------------

describe('GET /files/:id/envelopes', () => {
  it('returns 403 for unauthorized user', async () => {
    const { request } = makeApp({
      pubkey: 'stranger',
      fileRecord: {
        id: 'f1',
        uploadedBy: 'up',
        status: 'complete',
        recipientEnvelopes: [{ pubkey: 'someone-else', enc: HEX64, ct: 'k' }],
      },
    })
    const res = await request('/f1/envelopes')
    expect(res.status).toBe(403)
  })

  it("returns only the requesting user's envelope", async () => {
    const { request } = makeApp({
      pubkey: 'recipient-pub',
      fileRecord: {
        id: 'f1',
        uploadedBy: 'up',
        status: 'complete',
        recipientEnvelopes: [
          { pubkey: 'recipient-pub', enc: HEX64, ct: 'my-key' },
          { pubkey: 'other-pub', enc: HEX64, ct: 'other-key' },
        ],
      },
    })
    const res = await request('/f1/envelopes')
    expect(res.status).toBe(200)
    const body = await res.json() as { envelopes: Array<{ pubkey: string }> }
    expect(body.envelopes).toHaveLength(1)
    expect(body.envelopes[0].pubkey).toBe('recipient-pub')
  })

  it('returns all envelopes for users with files:download-all', async () => {
    const { request } = makeApp({
      permissions: ['files:download-all'],
      pubkey: 'admin',
      fileRecord: {
        id: 'f1',
        uploadedBy: 'up',
        status: 'complete',
        recipientEnvelopes: [
          { pubkey: 'pub-1', enc: HEX64, ct: 'k1' },
          { pubkey: 'pub-2', enc: HEX64, ct: 'k2' },
        ],
      },
    })
    const res = await request('/f1/envelopes')
    expect(res.status).toBe(200)
    const body = await res.json() as { envelopes: Array<{ pubkey: string }> }
    expect(body.envelopes).toHaveLength(2)
  })

  it('returns empty array when user has no envelope', async () => {
    const { request } = makeApp({
      pubkey: 'uploader-pub',
      fileRecord: {
        id: 'f1',
        uploadedBy: 'uploader-pub',
        status: 'complete',
        recipientEnvelopes: [{ pubkey: 'someone-else', enc: HEX64, ct: 'k' }],
      },
    })
    const res = await request('/f1/envelopes')
    expect(res.status).toBe(200)
    const body = await res.json() as { envelopes: Array<unknown> }
    expect(body.envelopes).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// GET /:id/metadata — metadata scoping
// ---------------------------------------------------------------------------

describe('GET /files/:id/metadata', () => {
  it('returns 403 for unauthorized user', async () => {
    const { request } = makeApp({
      pubkey: 'nobody',
      fileRecord: {
        id: 'f1',
        uploadedBy: 'up',
        status: 'complete',
        recipientEnvelopes: [{ pubkey: 'someone', enc: HEX64, ct: 'k' }],
        encryptedMetadata: [{ pubkey: 'someone', blob: 'b' }],
      },
    })
    const res = await request('/f1/metadata')
    expect(res.status).toBe(403)
  })

  it("returns only caller's metadata entry", async () => {
    const { request } = makeApp({
      pubkey: 'my-pub',
      fileRecord: {
        id: 'f1',
        uploadedBy: 'up',
        status: 'complete',
        recipientEnvelopes: [{ pubkey: 'my-pub', enc: HEX64, ct: 'k' }],
        encryptedMetadata: [
          { pubkey: 'my-pub', blob: 'my-blob' },
          { pubkey: 'other-pub', blob: 'other-blob' },
        ],
      },
    })
    const res = await request('/f1/metadata')
    expect(res.status).toBe(200)
    const body = await res.json() as { metadata: Array<{ pubkey: string }> }
    expect(body.metadata).toHaveLength(1)
    expect(body.metadata[0].pubkey).toBe('my-pub')
  })

  it('returns all metadata entries for files:download-all users', async () => {
    const { request } = makeApp({
      permissions: ['files:download-all'],
      pubkey: 'admin',
      fileRecord: {
        id: 'f1',
        uploadedBy: 'up',
        status: 'complete',
        recipientEnvelopes: [],
        encryptedMetadata: [
          { pubkey: 'p1', blob: 'b1' },
          { pubkey: 'p2', blob: 'b2' },
        ],
      },
    })
    const res = await request('/f1/metadata')
    expect(res.status).toBe(200)
    const body = await res.json() as { metadata: Array<unknown> }
    expect(body.metadata).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// POST /:id/share — requires files:share
// ---------------------------------------------------------------------------

describe('POST /files/:id/share', () => {
  // shareFileBodySchema requires fileKeyEnvelopeSchema (pubkey, enc, ct)
  // and encryptedMetadataEntrySchema (pubkey, encryptedContent, enc, ct)
  const shareBody = {
    envelope: { pubkey: HEX64, enc: HPKE_ENC, ct: 'encrypted-key-data' },
    encryptedMetadata: { pubkey: HEX64, encryptedContent: 'meta-content', enc: HPKE_ENC, ct: 'meta-ct' },
  }

  it('rejects without files:share permission', async () => {
    const { request } = makeApp({ permissions: [] })
    const res = await request('/f1/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(shareBody),
    })
    expect(res.status).toBe(403)
  })

  it('adds recipient envelope and audits', async () => {
    const { request, mockConversations, mockAudit } = makeApp({ permissions: ['files:share'] })
    const res = await request('/f1/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(shareBody),
    })
    expect(res.status).toBe(200)
    expect(mockConversations.addFileRecipient).toHaveBeenCalledWith(
      'f1',
      shareBody.envelope,
      shareBody.encryptedMetadata,
    )
    expect(mockAudit.log.mock.calls.some((call: unknown[]) => call[0] === 'fileShared')).toBe(true)
  })
})
