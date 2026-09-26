import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  request,
  ApiError,
  NetworkError,
  OfflineQueuedError,
  isNetworkError,
  getAuthHeadersForReplay,
  setOnAuthExpired,
  setOnApiActivity,
  setActiveHub,
  bootstrapAdmin,
} from './api'
import * as keyManager from './key-manager'
import { offlineQueue } from './offline-queue'

vi.mock('./platform', () => ({
  createAuthToken: vi.fn(async () => JSON.stringify({ timestamp: Date.now(), token: 'mock-token' })),
  lockCrypto: vi.fn(async () => {}),
  decryptWithPin: vi.fn(async () => null),
}))

vi.mock('./hub-key-manager', () => ({
  encryptDraft: vi.fn(async (text: string) => text),
  decryptDraft: vi.fn(async (text: string) => text),
}))

describe('ApiError', () => {
  it('stores status and body', () => {
    const err = new ApiError(404, 'Not found')
    expect(err.status).toBe(404)
    expect(err.body).toBe('Not found')
    expect(err.message).toBe('API error 404: Not found')
    expect(err.name).toBe('ApiError')
  })
})

describe('NetworkError', () => {
  it('stores message and optional cause', () => {
    const cause = new Error('underlying')
    const err = new NetworkError('network failed', cause)
    expect(err.message).toBe('network failed')
    expect(err.cause).toBe(cause)
    expect(err.name).toBe('NetworkError')
  })

  it('works without cause', () => {
    const err = new NetworkError('timeout')
    expect(err.cause).toBeUndefined()
  })
})

describe('isNetworkError', () => {
  it('returns true for NetworkError', () => {
    expect(isNetworkError(new NetworkError('fail'))).toBe(true)
  })

  it('returns false for regular Error', () => {
    expect(isNetworkError(new Error('fail'))).toBe(false)
  })

  it('returns false for ApiError', () => {
    expect(isNetworkError(new ApiError(500, 'fail'))).toBe(false)
  })

  it('returns false for non-errors', () => {
    expect(isNetworkError('string')).toBe(false)
    expect(isNetworkError(null)).toBe(false)
    expect(isNetworkError(42)).toBe(false)
  })
})

describe('OfflineQueuedError', () => {
  it('stores path and method', () => {
    const err = new OfflineQueuedError('/notes', 'POST')
    expect(err.path).toBe('/notes')
    expect(err.method).toBe('POST')
    expect(err.name).toBe('OfflineQueuedError')
  })
})

describe('bootstrapAdmin', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // Regression: Rust's createAuthToken generates a nonce internally and signs it
  // into the token; the server rebuilds the auth message with body.nonce. If the
  // client drops the nonce, verifyAuthToken can't reconstruct the signed message
  // and bootstrap auth fails. bootstrapAdmin MUST forward the nonce.
  it('forwards the nonce in the request body when provided', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockResolvedValue(new Response('{"ok":true,"roles":["admin"]}', { status: 200 }))

    await bootstrapAdmin('pubkey-hex', 1234, 'token-sig', 'nonce-abc')

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body).toMatchObject({ pubkey: 'pubkey-hex', timestamp: 1234, token: 'token-sig', nonce: 'nonce-abc' })
  })

  it('omits the nonce key when not provided', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockResolvedValue(new Response('{"ok":true,"roles":["admin"]}', { status: 200 }))

    await bootstrapAdmin('pubkey-hex', 1234, 'token-sig')

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body).not.toHaveProperty('nonce')
  })
})

describe('request retry logic', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
    sessionStorage.clear()
    keyManager.lock()
    setOnAuthExpired(null)
    setOnApiActivity(null)
    setActiveHub(null)
    offlineQueue.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns parsed JSON on success', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockResolvedValue(new Response('{"data":42}', { status: 200 }))

    const result = await request('/test')
    expect(result).toEqual({ data: 42 })
  })

  it('retries idempotent GET on 502', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock
      .mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))

    const result = await request('/test')
    expect(result).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries idempotent GET on 503', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock
      .mockResolvedValueOnce(new Response('Unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))

    const result = await request('/test')
    expect(result).toEqual({ ok: true })
  })

  it('retries idempotent GET on 504', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock
      .mockResolvedValueOnce(new Response('Timeout', { status: 504 }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))

    const result = await request('/test')
    expect(result).toEqual({ ok: true })
  })

  it('retries idempotent GET on 429', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock
      .mockResolvedValueOnce(new Response('Too Many', { status: 429 }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))

    const result = await request('/test')
    expect(result).toEqual({ ok: true })
  })

  it('does not retry non-idempotent POST on 502', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockImplementation(() => Promise.resolve(new Response('Bad Gateway', { status: 502 })))

    await expect(request('/test', { method: 'POST' })).rejects.toBeInstanceOf(ApiError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry non-idempotent POST on 503', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockImplementation(() => Promise.resolve(new Response('Unavailable', { status: 503 })))

    await expect(request('/test', { method: 'POST' })).rejects.toBeInstanceOf(ApiError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry non-idempotent POST on 504', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockImplementation(() => Promise.resolve(new Response('Timeout', { status: 504 })))

    await expect(request('/test', { method: 'POST' })).rejects.toBeInstanceOf(ApiError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry non-idempotent POST on 429', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockImplementation(() => Promise.resolve(new Response('Too Many', { status: 429 })))

    await expect(request('/test', { method: 'POST' })).rejects.toBeInstanceOf(ApiError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries GET up to 3 times then throws', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockImplementation(() => Promise.resolve(new Response('Bad Gateway', { status: 502 })))

    await expect(request('/test')).rejects.toBeInstanceOf(ApiError)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('throws ApiError with status and body on 4xx', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockResolvedValue(new Response('Bad Request', { status: 400 }))

    await expect(request('/test')).rejects.toMatchObject({
      status: 400,
      body: 'Bad Request',
    })
  })

  it('throws ApiError with status and body on 5xx', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockResolvedValue(new Response('Server Error', { status: 500 }))

    await expect(request('/test')).rejects.toMatchObject({
      status: 500,
      body: 'Server Error',
    })
  })

  it('calls onAuthExpired on 401 when unlocked', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockImplementation(async () => new Response('Unauthorized', { status: 401 }))

    keyManager.markUnlocked('test-pubkey')
    const cb = vi.fn()
    setOnAuthExpired(cb)

    await expect(request('/test')).rejects.toBeInstanceOf(ApiError)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('does not call onAuthExpired on 401 for auth paths', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockImplementation(async () => new Response('Unauthorized', { status: 401 }))

    keyManager.markUnlocked('test-pubkey')
    const cb = vi.fn()
    setOnAuthExpired(cb)

    await expect(request('/auth/login')).rejects.toBeInstanceOf(ApiError)
    expect(cb).not.toHaveBeenCalled()
  })

  it('calls onApiActivity on success', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 200 }))

    const cb = vi.fn()
    setOnApiActivity(cb)

    await request('/test')
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('does not call onApiActivity on failure', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockResolvedValue(new Response('Error', { status: 500 }))

    const cb = vi.fn()
    setOnApiActivity(cb)

    await expect(request('/test')).rejects.toBeInstanceOf(ApiError)
    expect(cb).not.toHaveBeenCalled()
  })

  it('uses session token auth when available', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 200 }))

    sessionStorage.setItem('llamenos-session-token', 'session-123')

    await request('/test')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/test',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Authorization': 'Session session-123',
        }),
      })
    )
  })

  it('uses Bearer auth when keyManager is unlocked and no session', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 200 }))

    keyManager.markUnlocked('test-pubkey')

    await request('/test')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/test',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Authorization': expect.stringMatching(/^Bearer /),
        }),
      })
    )
  })

  it('has no auth header when locked and no session', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 200 }))

    await request('/test')
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>
    expect(headers['Authorization']).toBeUndefined()
  })

  it('strips query params from auth path', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 200 }))

    keyManager.markUnlocked('test-pubkey')

    await request('/test?foo=bar')
    expect(fetchMock).toHaveBeenCalledWith('/api/test?foo=bar', expect.any(Object))
  })

  it('queues offline on network error for write operations', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    Object.defineProperty(navigator, 'onLine', { value: false, writable: true, configurable: true })

    await expect(request('/notes', { method: 'POST', body: '{}' })).rejects.toBeInstanceOf(OfflineQueuedError)
    expect(offlineQueue.pendingCount).toBe(1)

    Object.defineProperty(navigator, 'onLine', { value: true, writable: true, configurable: true })
  })

  it('does not queue offline for read operations', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    Object.defineProperty(navigator, 'onLine', { value: false, writable: true, configurable: true })

    await expect(request('/notes')).rejects.toBeInstanceOf(NetworkError)
    expect(offlineQueue.pendingCount).toBe(0)

    Object.defineProperty(navigator, 'onLine', { value: true, writable: true, configurable: true })
  })

  it('does not queue offline for non-queueable paths', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    Object.defineProperty(navigator, 'onLine', { value: false, writable: true, configurable: true })

    await expect(request('/auth/login', { method: 'POST', body: '{}' })).rejects.toBeInstanceOf(NetworkError)
    expect(offlineQueue.pendingCount).toBe(0)

    Object.defineProperty(navigator, 'onLine', { value: true, writable: true, configurable: true })
  })

  it('retries idempotent GET on network error', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))

    const result = await request('/test')
    expect(result).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws NetworkError after max retries on network error', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(request('/test')).rejects.toBeInstanceOf(NetworkError)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('throws ApiError on 426 without retry', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockResolvedValue(new Response('Upgrade Required', { status: 426 }))

    await expect(request('/test')).rejects.toMatchObject({ status: 426 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('merges custom headers', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 200 }))

    await request('/test', { headers: { 'X-Custom': 'value' } })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/test',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Custom': 'value',
          'Content-Type': 'application/json',
        }),
      })
    )
  })

  it('includes X-API-Version header', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 200 }))

    await request('/test')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/test',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-API-Version': expect.any(String),
        }),
      })
    )
  })

  it('uses AbortController signal in fetch', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 200 }))

    await request('/test')
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('checks version headers on success', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockResolvedValue(new Response('{"ok":true}', {
      status: 200,
      headers: { 'X-Min-Version': '9999', 'X-Current-Version': '9999' },
    }))

    await request('/test')
  })

  it('checks version headers on error', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockResolvedValue(new Response('Error', {
      status: 500,
      headers: { 'X-Min-Version': '9999' },
    }))

    await expect(request('/test')).rejects.toBeInstanceOf(ApiError)
  })

  it('respects custom retries option', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockImplementation(() => Promise.resolve(new Response('Bad Gateway', { status: 502 })))

    await expect(request('/test', { retries: 1 })).rejects.toBeInstanceOf(ApiError)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry when retries option is 0', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockImplementation(() => Promise.resolve(new Response('Bad Gateway', { status: 502 })))

    await expect(request('/test', { retries: 0 })).rejects.toBeInstanceOf(ApiError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('getAuthHeadersForReplay', () => {
  beforeEach(() => {
    sessionStorage.clear()
    keyManager.lock()
  })

  it('returns session auth when token exists', async () => {
    sessionStorage.setItem('llamenos-session-token', 'replay-token')
    const headers = await getAuthHeadersForReplay('POST', '/notes')
    expect(headers['Authorization']).toBe('Session replay-token')
  })

  it('returns empty when locked and no session', async () => {
    const headers = await getAuthHeadersForReplay('POST', '/notes')
    expect(Object.keys(headers).length).toBe(0)
  })
})
