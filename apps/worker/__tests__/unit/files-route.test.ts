/**
 * Unit tests for routes/files.ts
 *
 * Tests: hub scoping (#2462), envelope-based access control, uploader access,
 * files:download-all bypass, file sharing permission, metadata scoping.
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

const HUB = 'hub-1'

function makeApp(opts: {
  permissions?: string[]
  pubkey?: string
  fileRecord?: FileRecordLike
  /** The path hub hubContext would set; `null` = an unscoped mount. */
  hubId?: string | null
  /** X25519 keys the caller's devices registered. */
  deviceKeys?: string[]
} = {}) {
  const {
    deviceKeys = [],
    hubId = HUB,
    permissions = [],
    pubkey = 'my-pubkey',
    fileRecord = {
      id: 'file-1',
      uploadedBy: 'uploader-pub',
      status: 'complete',
      recipientEnvelopes: [{ pubkey: 'recipient-pub', enc: HEX64, ct: 'f2b2d628a0f021981accdbce3f4ad042b302ac3ed750902495f8eccf725fcfffa3046a8e9d7e111997c267114b20ba39' }],
      encryptedMetadata: [{ pubkey: 'recipient-pub', blob: 'meta-blob' }],
    },
  } = opts

  const mockAudit = { log: vi.fn().mockResolvedValue(undefined) }
  const mockConversations = {
    getFileInHub: vi.fn().mockResolvedValue({ hubId: HUB, ownerKind: 'entity_field', ...fileRecord }),
    addFileRecipient: vi.fn().mockResolvedValue(undefined),
  }

  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('pubkey', pubkey)
    c.set('permissions', permissions)
    if (hubId) c.set('hubId', hubId)
    c.set('requestId', 'req-test')
    c.set('services', {
      audit: mockAudit,
      conversations: mockConversations,
      identity: { getHpkeRecipients: vi.fn().mockResolvedValue(deviceKeys) },
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

describe('files route — hub scoping (#2462)', () => {
  it('is not served outside a hub', async () => {
    const { request, mockConversations } = makeApp({ hubId: null, permissions: ['*'] })
    const res = await request('/file-1/envelopes')
    expect(res.status).toBe(404)
    expect(mockConversations.getFileInHub).not.toHaveBeenCalled()
  })

  it('reads a file only through its path hub', async () => {
    const { request, mockConversations } = makeApp({ permissions: ['files:download-all'] })
    await request('/file-1/envelopes')
    expect(mockConversations.getFileInHub).toHaveBeenCalledWith('file-1', HUB)
  })
})

describe('files route — envelope addressing', () => {
  it('finds the caller\'s envelope by a device X25519 key, not only the identity key', async () => {
    // Envelopes are sealed to device keys (#1021): matching the identity key
    // alone hid a recipient's own envelope from them.
    const { request } = makeApp({ pubkey: 'identity-pub', deviceKeys: ['recipient-pub'] })
    const res = await request('/file-1/envelopes')
    expect(res.status).toBe(200)
    const body = await res.json() as { envelopes: Array<{ pubkey: string }> }
    expect(body.envelopes.map(e => e.pubkey)).toEqual(['recipient-pub'])
  })
})

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
        recipientEnvelopes: [{ pubkey: 'someone-else', enc: HEX64, ct: 'b4159f725074c88574403cac13fd483a30828a860293cd248fe7b12b3f57e727f5999fa95ca06c85d1a19bbc362c93fe' }],
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
        recipientEnvelopes: [{ pubkey: 'recipient-pub', enc: HEX64, ct: '7c63ea2ebd1ba2247b45073ad34df5a434f0f6b5773c8671c4572dc899a02971ff9de896ee6992574dc9c73eacc5d6f8' }],
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
        recipientEnvelopes: [{ pubkey: 'someone-else', enc: HEX64, ct: 'b4159f725074c88574403cac13fd483a30828a860293cd248fe7b12b3f57e727f5999fa95ca06c85d1a19bbc362c93fe' }],
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
          { pubkey: 'recipient-pub', enc: HEX64, ct: '0b2523e28e13744002c5b06788bba21c3a182fa13f6e256fb499c61fc3652c44f29a538d28f47c40249b8a3be2a06507' },
          { pubkey: 'other-pub', enc: HEX64, ct: 'fdd7fc167c839febfd0c5c2b76de1155ef1c540ea2383c80727986c825cbb5df661c7558751878989df644cad7bc42e9' },
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
          { pubkey: 'pub-1', enc: HEX64, ct: 'ca5b589907aec73f337c6d02d6dcda6aa91129adafae59c82b224d106439f5444801d376db96c81150377b877ad90958' },
          { pubkey: 'pub-2', enc: HEX64, ct: 'bb11594a4ab7bd7873373c24f08f5a8e2019c19f948c0bf1a99016a79792cea8faf401b585231c82c9997a971bb9a701' },
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
        recipientEnvelopes: [{ pubkey: 'someone-else', enc: HEX64, ct: 'b4159f725074c88574403cac13fd483a30828a860293cd248fe7b12b3f57e727f5999fa95ca06c85d1a19bbc362c93fe' }],
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
        recipientEnvelopes: [{ pubkey: 'someone', enc: HEX64, ct: 'b4159f725074c88574403cac13fd483a30828a860293cd248fe7b12b3f57e727f5999fa95ca06c85d1a19bbc362c93fe' }],
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
        recipientEnvelopes: [{ pubkey: 'my-pub', enc: HEX64, ct: 'b4159f725074c88574403cac13fd483a30828a860293cd248fe7b12b3f57e727f5999fa95ca06c85d1a19bbc362c93fe' }],
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
    envelope: { pubkey: HEX64, enc: HPKE_ENC, ct: '0c8f41f82e28d12d87a6d894e16bc83bd5b739fe3ae5152a405e385f875e0bfad1bf89556738d6ed568f4040c9ac53c9' },
    encryptedMetadata: { pubkey: HEX64, encryptedContent: 'ab'.repeat(40), enc: HPKE_ENC, ct: '3f7476de60dd77f5c187ea67e96175d499dc77c6adcbd977ef9c129a8977d401fbab3e8555e181827ae71e0ae485ca9f' },
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
    expect(mockConversations.getFileInHub).toHaveBeenCalledWith('f1', HUB)
    expect(mockConversations.addFileRecipient).toHaveBeenCalledWith(
      'f1',
      shareBody.envelope,
      shareBody.encryptedMetadata,
    )
    const shared = mockAudit.log.mock.calls.find((call: unknown[]) => call[0] === 'fileShared')
    expect(shared).toBeDefined()
    expect(shared).toContain(HUB)
  })

  it('does not share a file of another hub', async () => {
    const { request, mockConversations } = makeApp({ permissions: ['files:share'] })
    mockConversations.getFileInHub.mockRejectedValueOnce(
      Object.assign(new Error('File not found'), { status: 404 }),
    )
    const res = await request('/f1/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(shareBody),
    })
    expect(res.status).not.toBe(200)
    expect(mockConversations.addFileRecipient).not.toHaveBeenCalled()
  })
})
