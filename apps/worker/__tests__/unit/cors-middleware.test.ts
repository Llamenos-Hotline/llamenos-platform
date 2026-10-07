/**
 * Unit tests for apps/worker/middleware/cors.ts
 *
 * Validates: origin allowlist, preflight handling, credentials mode,
 * wildcard rejection, environment-based permissiveness.
 */
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { cors } from '@worker/middleware/cors'
import type { AppEnv } from '@worker/types/infra'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApp(env: Partial<AppEnv['Bindings']> = {}) {
  const app = new Hono<AppEnv>()
  app.use('*', cors)
  app.get('/test', (c) => c.json({ ok: true }))
  return { app, env: { ENVIRONMENT: 'production', ...env } as AppEnv['Bindings'] }
}

async function req(
  app: ReturnType<typeof makeApp>['app'],
  env: AppEnv['Bindings'],
  origin: string,
  method = 'GET',
) {
  return app.request('/test', {
    method,
    headers: { Origin: origin },
  }, env as unknown as Record<string, string>)
}

async function preflight(
  app: ReturnType<typeof makeApp>['app'],
  env: AppEnv['Bindings'],
  origin: string,
) {
  return app.request('/test', {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
    },
  }, env as unknown as Record<string, string>)
}

// ---------------------------------------------------------------------------
// Production defaults
// ---------------------------------------------------------------------------

describe('CORS production defaults', () => {
  it('allows https://app.llamenos-hotline.org', async () => {
    const { app, env } = makeApp()
    const res = await req(app, env, 'https://app.llamenos-hotline.org')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.llamenos-hotline.org')
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true')
  })

  // https://demo.llamenos-platform.com was in the built-in origin set until
  // #1604. There is no demo deployment, so it is now refused like any other
  // unlisted origin — an allowlist entry for a host nobody runs is a standing
  // invitation to whoever registers it next.
  it('refuses https://demo.llamenos-platform.com', async () => {
    const { app, env } = makeApp()
    const res = await req(app, env, 'https://demo.llamenos-platform.com')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('allows tauri://localhost (desktop client)', async () => {
    const { app, env } = makeApp()
    const res = await req(app, env, 'tauri://localhost')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('tauri://localhost')
  })

  it('allows https://tauri.localhost (Tauri v2 webview)', async () => {
    const { app, env } = makeApp()
    const res = await req(app, env, 'https://tauri.localhost')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://tauri.localhost')
  })

  it('rejects unknown origin', async () => {
    const { app, env } = makeApp()
    const res = await req(app, env, 'https://evil.com')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  // Regression test for GHSA-88fw-hqm2-52qc (hono/cors reflecting any Origin
  // with credentials when `origin` defaults to the wildcard). This app never
  // uses hono's built-in `cors()` middleware — it has its own allow-list
  // implementation above — but this test asserts the boundary directly so a
  // future refactor toward hono/cors (or a regression in this file) cannot
  // silently reintroduce the same class of bug: a disallowed Origin must
  // never be reflected back, and must never receive credentialed CORS.
  it('does not reflect a disallowed Origin and does not grant credentials (GHSA-88fw-hqm2-52qc boundary)', async () => {
    const { app, env } = makeApp()
    const res = await req(app, env, 'https://evil.com')
    expect(res.headers.get('Access-Control-Allow-Origin')).not.toBe('https://evil.com')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(res.headers.get('Access-Control-Allow-Credentials')).not.toBe('true')
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull()
  })

  it('rejects http downgrade of allowed origin', async () => {
    const { app, env } = makeApp()
    const res = await req(app, env, 'http://app.llamenos-hotline.org')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('always sets Vary: Origin', async () => {
    const { app, env } = makeApp()
    const res = await req(app, env, 'https://evil.com')
    expect(res.headers.get('Vary')).toContain('Origin')
  })

  it('does not allow localhost in production', async () => {
    const { app, env } = makeApp({ ENVIRONMENT: 'production' })
    const res = await req(app, env, 'http://localhost:5173')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Credentials mode
// ---------------------------------------------------------------------------

describe('CORS credentials mode', () => {
  it('includes Access-Control-Allow-Credentials on allowed origin', async () => {
    const { app, env } = makeApp()
    const res = await req(app, env, 'https://app.llamenos-hotline.org')
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true')
  })

  it('does NOT include Access-Control-Allow-Credentials on rejected origin', async () => {
    const { app, env } = makeApp()
    const res = await req(app, env, 'https://attacker.example')
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Preflight (OPTIONS)
// ---------------------------------------------------------------------------

describe('CORS preflight', () => {
  it('returns 204 for allowed origin', async () => {
    const { app, env } = makeApp()
    const res = await preflight(app, env, 'https://app.llamenos-hotline.org')
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.llamenos-hotline.org')
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST')
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization')
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true')
    expect(res.headers.get('Access-Control-Max-Age')).toBeTruthy()
  })

  it('returns 403 for disallowed origin — no CORS info leaked', async () => {
    const { app, env } = makeApp()
    const res = await preflight(app, env, 'https://evil.com')
    expect(res.status).toBe(403)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(res.headers.get('Access-Control-Allow-Methods')).toBeNull()
    expect(res.headers.get('Access-Control-Allow-Headers')).toBeNull()
  })

  it('sets Vary: Origin on rejected preflight too', async () => {
    const { app, env } = makeApp()
    const res = await preflight(app, env, 'https://evil.com')
    expect(res.headers.get('Vary')).toContain('Origin')
  })
})

// ---------------------------------------------------------------------------
// CORS_ALLOWED_ORIGINS env override
// ---------------------------------------------------------------------------

describe('CORS_ALLOWED_ORIGINS env override', () => {
  it('uses custom origins when CORS_ALLOWED_ORIGINS is set', async () => {
    const { app, env } = makeApp({ CORS_ALLOWED_ORIGINS: 'https://custom.example.com' })
    const res = await req(app, env, 'https://custom.example.com')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://custom.example.com')
  })

  it('excludes production defaults when CORS_ALLOWED_ORIGINS is set', async () => {
    // When an explicit list is provided, production defaults are NOT auto-added
    const { app, env } = makeApp({ CORS_ALLOWED_ORIGINS: 'https://custom.example.com' })
    const res = await req(app, env, 'https://app.llamenos-hotline.org')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('Tauri origins are always allowed even with custom CORS_ALLOWED_ORIGINS', async () => {
    const { app, env } = makeApp({ CORS_ALLOWED_ORIGINS: 'https://custom.example.com' })
    const res = await req(app, env, 'tauri://localhost')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('tauri://localhost')
  })

  it('handles comma-separated list', async () => {
    const { app, env } = makeApp({
      CORS_ALLOWED_ORIGINS: 'https://a.example.com, https://b.example.com',
    })
    const resA = await req(app, env, 'https://a.example.com')
    const resB = await req(app, env, 'https://b.example.com')
    expect(resA.headers.get('Access-Control-Allow-Origin')).toBe('https://a.example.com')
    expect(resB.headers.get('Access-Control-Allow-Origin')).toBe('https://b.example.com')
  })
})

// ---------------------------------------------------------------------------
// Wildcard rejection
// ---------------------------------------------------------------------------

describe('CORS wildcard rejection', () => {
  it('ignores wildcard * in CORS_ALLOWED_ORIGINS', async () => {
    const { app, env } = makeApp({ CORS_ALLOWED_ORIGINS: '*, https://custom.example.com' })
    // Wildcard * should never match any actual origin string
    const resWild = await req(app, env, '*')
    expect(resWild.headers.get('Access-Control-Allow-Origin')).toBeNull()
    // The valid origin in the list should still work
    const resValid = await req(app, env, 'https://custom.example.com')
    expect(resValid.headers.get('Access-Control-Allow-Origin')).toBe('https://custom.example.com')
  })

  it('does not echo back wildcard * as an origin', async () => {
    const { app, env } = makeApp({ CORS_ALLOWED_ORIGINS: '*' })
    // Even if env contains only wildcard, no origin should be echoed back
    const res = await req(app, env, 'https://evil.com')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Development mode
// ---------------------------------------------------------------------------

describe('CORS development mode', () => {
  it('allows localhost:5173 in development', async () => {
    const { app, env } = makeApp({ ENVIRONMENT: 'development' })
    const res = await req(app, env, 'http://localhost:5173')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173')
  })

  it('allows localhost:1420 in development', async () => {
    const { app, env } = makeApp({ ENVIRONMENT: 'development' })
    const res = await req(app, env, 'http://localhost:1420')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:1420')
  })

  it('does NOT allow localhost in development when CORS_ALLOWED_ORIGINS is set', async () => {
    const { app, env } = makeApp({
      ENVIRONMENT: 'development',
      CORS_ALLOWED_ORIGINS: 'https://staging.example.com',
    })
    const res = await req(app, env, 'http://localhost:5173')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
})
