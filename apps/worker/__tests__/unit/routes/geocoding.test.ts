/**
 * Unit tests for routes/geocoding.ts
 *
 * Tests: permission enforcement (notes:read-own gate), rate limiting,
 * autocomplete, forward geocode, reverse geocode.
 */
import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'
import geocodingRoutes from '@worker/routes/geocoding'
import { createGeocodingAdapter } from '@worker/geocoding/factory'
import { checkRateLimit } from '@worker/lib/helpers'

// Mock the geocoding factory so we don't need a real provider configured
vi.mock('@worker/geocoding/factory', () => ({
  createGeocodingAdapter: vi.fn(),
}))

// Mock rate limit helper
vi.mock('@worker/lib/helpers', () => ({
  checkRateLimit: vi.fn().mockResolvedValue(false), // false = not rate-limited by default
}))

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

function makeApp(opts: {
  permissions?: string[]
  pubkey?: string
  services?: Record<string, unknown>
  adapterMock?: Record<string, unknown>
} = {}) {
  const {
    permissions = ['notes:read-own'],
    pubkey = 'a'.repeat(64),
    services = {},
    adapterMock = {},
  } = opts

  const mockGeocodingAdapter = {
    autocomplete: vi.fn().mockResolvedValue([]),
    geocode: vi.fn().mockResolvedValue(null),
    reverse: vi.fn().mockResolvedValue(null),
    ...adapterMock,
  }

  const mockSettings = {
    getGeocodingConfigAdmin: vi.fn().mockResolvedValue({ provider: 'nominatim' }),
    checkRateLimit: vi.fn().mockResolvedValue(false),
    ...(services.settings as Record<string, unknown> ?? {}),
  }

  // Override factory to return our mock adapter
  vi.mocked(createGeocodingAdapter).mockReturnValue(mockGeocodingAdapter)

  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('pubkey', pubkey)
    c.set('permissions', permissions)
    c.set('services', {
      settings: mockSettings,
      ...(services as Record<string, unknown>),
    } as unknown as AppEnv['Variables']['services'])
    c.set('requestId', 'test-req')
    await next()
  })
  app.route('/', geocodingRoutes)

  return { app, mockGeocodingAdapter, mockSettings }
}

// ---------------------------------------------------------------------------
// Permission gate — notes:read-own required
// ---------------------------------------------------------------------------

describe('geocoding routes — permission gate', () => {
  it('returns 403 without notes:read-own on autocomplete', async () => {
    const { app } = makeApp({ permissions: [] })

    const res = await app.request('/autocomplete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'Main St' }),
    })

    expect(res.status).toBe(403)
  })

  it('returns 403 without notes:read-own on geocode', async () => {
    const { app } = makeApp({ permissions: [] })

    const res = await app.request('/geocode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: '123 Main St' }),
    })

    expect(res.status).toBe(403)
  })

  it('returns 403 without notes:read-own on reverse', async () => {
    const { app } = makeApp({ permissions: [] })

    const res = await app.request('/reverse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: 40.7, lon: -74.0 }),
    })

    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// POST /autocomplete
// ---------------------------------------------------------------------------

describe('POST /autocomplete', () => {
  it('returns address suggestions', async () => {
    const suggestions = [
      { displayName: '123 Main St, Springfield', lat: 40.1, lon: -74.1 },
      { displayName: '124 Main Ave, Springfield', lat: 40.2, lon: -74.2 },
    ]
    const { app, mockGeocodingAdapter } = makeApp()
    mockGeocodingAdapter.autocomplete.mockResolvedValue(suggestions)

    const res = await app.request('/autocomplete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'Main', limit: 2 }),
    })

    expect(res.status).toBe(200)
    const json = await res.json() as unknown[]
    expect(json).toHaveLength(2)
    expect(mockGeocodingAdapter.autocomplete).toHaveBeenCalledWith('Main', { limit: 2 })
  })

  it('uses default limit 5 when not specified', async () => {
    const { app, mockGeocodingAdapter } = makeApp()
    mockGeocodingAdapter.autocomplete.mockResolvedValue([])

    const res = await app.request('/autocomplete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'Main' }),
    })

    expect(res.status).toBe(200)
    expect(mockGeocodingAdapter.autocomplete).toHaveBeenCalledWith('Main', { limit: 5 })
  })

  it('returns 400 when query is empty', async () => {
    const { app } = makeApp()

    const res = await app.request('/autocomplete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '' }),
    })

    expect(res.status).toBe(400)
  })

  it('returns 400 when query exceeds max length', async () => {
    const { app } = makeApp()

    const res = await app.request('/autocomplete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'x'.repeat(201) }),
    })

    expect(res.status).toBe(400)
  })

  it('returns 429 when rate limited', async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce(true)

    const { app } = makeApp()

    const res = await app.request('/autocomplete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'Main' }),
    })

    expect(res.status).toBe(429)
  })

  it('rejects limit > 10', async () => {
    const { app } = makeApp()

    const res = await app.request('/autocomplete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'Main', limit: 11 }),
    })

    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// POST /geocode
// ---------------------------------------------------------------------------

describe('POST /geocode', () => {
  it('returns geocoded result', async () => {
    const result = { displayName: '123 Main St', lat: 40.1, lon: -74.1 }
    const { app, mockGeocodingAdapter } = makeApp()
    mockGeocodingAdapter.geocode.mockResolvedValue(result)

    const res = await app.request('/geocode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: '123 Main St' }),
    })

    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect(json.lat).toBe(40.1)
    expect(mockGeocodingAdapter.geocode).toHaveBeenCalledWith('123 Main St')
  })

  it('returns null when address not found', async () => {
    const { app, mockGeocodingAdapter } = makeApp()
    mockGeocodingAdapter.geocode.mockResolvedValue(null)

    const res = await app.request('/geocode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: 'Nowhere Land' }),
    })

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toBeNull()
  })

  it('returns 400 when address is empty', async () => {
    const { app } = makeApp()

    const res = await app.request('/geocode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: '' }),
    })

    expect(res.status).toBe(400)
  })

  it('returns 429 when rate limited', async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce(true)

    const { app } = makeApp()

    const res = await app.request('/geocode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: '123 Main St' }),
    })

    expect(res.status).toBe(429)
  })
})

// ---------------------------------------------------------------------------
// POST /reverse
// ---------------------------------------------------------------------------

describe('POST /reverse', () => {
  it('returns reverse-geocoded address', async () => {
    const result = { displayName: '123 Main St, City', lat: 40.7, lon: -74.0 }
    const { app, mockGeocodingAdapter } = makeApp()
    mockGeocodingAdapter.reverse.mockResolvedValue(result)

    const res = await app.request('/reverse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: 40.7, lon: -74.0 }),
    })

    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect(json.displayName).toBe('123 Main St, City')
    expect(mockGeocodingAdapter.reverse).toHaveBeenCalledWith(40.7, -74.0)
  })

  it('returns null when no address found', async () => {
    const { app, mockGeocodingAdapter } = makeApp()
    mockGeocodingAdapter.reverse.mockResolvedValue(null)

    const res = await app.request('/reverse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: 0, lon: 0 }),
    })

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toBeNull()
  })

  it('returns 400 when lat is out of range', async () => {
    const { app } = makeApp()

    const res = await app.request('/reverse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: 91, lon: 0 }),
    })

    expect(res.status).toBe(400)
  })

  it('returns 400 when lon is out of range', async () => {
    const { app } = makeApp()

    const res = await app.request('/reverse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: 0, lon: 181 }),
    })

    expect(res.status).toBe(400)
  })

  it('returns 400 when coordinates are missing', async () => {
    const { app } = makeApp()

    const res = await app.request('/reverse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
  })

  it('returns 429 when rate limited', async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce(true)

    const { app } = makeApp()

    const res = await app.request('/reverse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: 40.7, lon: -74.0 }),
    })

    expect(res.status).toBe(429)
  })
})
