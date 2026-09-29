import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'

const resetDemoData = vi.hoisted(() => vi.fn())
vi.mock('@worker/services/demo-seeder', () => ({ resetDemoData }))

import demo from '@worker/routes/demo'

const SUMMARY = { hubId: 'hub-1', shifts: 3, calls: 12, notes: 8 }
const ACTOR = 'a'.repeat(64)

function createTestApp(opts: {
  permissions: string[]
  env: Record<string, string | undefined>
}) {
  const audit = { log: vi.fn().mockResolvedValue({}) }
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('pubkey', ACTOR)
    c.set('permissions', opts.permissions)
    c.set('services', { audit } as unknown as AppEnv['Variables']['services'])
    c.set('requestId', 'test-req-1')
    c.env = opts.env as unknown as AppEnv['Bindings']
    await next()
  })
  app.route('/demo', demo)
  return { app, audit }
}

const DEMO_ENV = { ENVIRONMENT: 'development', DEV_ROUTES_ENABLED: 'true', DEMO_MODE: 'true', DEMO_MODE_CONFIRM: 'DESTROY_ALL_DATA' }

describe('POST /demo/reset', () => {
  beforeEach(() => {
    resetDemoData.mockReset()
    resetDemoData.mockResolvedValue(SUMMARY)
  })

  it('resets, audit-logs the actor, and returns the seed summary for an instance admin', async () => {
    const { app, audit } = createTestApp({ permissions: ['*'], env: DEMO_ENV })
    const res = await app.request('/demo/reset', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, summary: SUMMARY })
    expect(resetDemoData).toHaveBeenCalledTimes(1)
    expect(audit.log).toHaveBeenCalledWith('demoReset', ACTOR, expect.objectContaining({ calls: 12 }), 'd3e0d3e0-0000-4000-8000-000000000001')
  })

  it.each([
    ['volunteer', ['calls:answer', 'notes:create']],
    ['hub admin', ['hubs:read', 'settings:read', 'audit:read']],
  ])('refuses a %s without touching data', async (_label, permissions) => {
    const { app, audit } = createTestApp({ permissions, env: DEMO_ENV })
    const res = await app.request('/demo/reset', { method: 'POST' })
    expect(res.status).toBe(403)
    expect(resetDemoData).not.toHaveBeenCalled()
    expect(audit.log).not.toHaveBeenCalled()
  })

  it.each([
    ['DEMO_MODE unset', { ...DEMO_ENV, DEMO_MODE: undefined }],
    ['confirmation unset', { ...DEMO_ENV, DEMO_MODE_CONFIRM: undefined }],
    ['wrong confirmation', { ...DEMO_ENV, DEMO_MODE_CONFIRM: 'yes' }],
    ['production with every flag set', { ...DEMO_ENV, ENVIRONMENT: 'production' }],
    ['a demo deployment with every demo flag set', { ...DEMO_ENV, ENVIRONMENT: 'demo', DEV_ROUTES_ENABLED: undefined }],
    ['a staging deployment with every flag set', { ...DEMO_ENV, ENVIRONMENT: 'staging' }],
    ['a development server without dev routes', { ...DEMO_ENV, DEV_ROUTES_ENABLED: undefined }],
  ])('refuses an admin when %s', async (_label, env) => {
    const { app, audit } = createTestApp({ permissions: ['*'], env })
    const res = await app.request('/demo/reset', { method: 'POST' })
    expect(res.status).toBe(403)
    expect(resetDemoData).not.toHaveBeenCalled()
    expect(audit.log).not.toHaveBeenCalled()
  })

  it('rejects a second reset while one is running', async () => {
    let release: () => void = () => {}
    resetDemoData.mockReturnValue(new Promise((resolve) => { release = () => resolve(SUMMARY) }))
    const { app } = createTestApp({ permissions: ['*'], env: DEMO_ENV })

    const first = app.request('/demo/reset', { method: 'POST' })
    await vi.waitFor(() => expect(resetDemoData).toHaveBeenCalledTimes(1))
    const second = await app.request('/demo/reset', { method: 'POST' })
    expect(second.status).toBe(409)

    release()
    expect((await first).status).toBe(200)
    // The lock is released afterwards
    expect((await app.request('/demo/reset', { method: 'POST' })).status).toBe(200)
  })

  it('releases the lock when the reset fails', async () => {
    resetDemoData.mockRejectedValueOnce(new Error('db down'))
    const { app } = createTestApp({ permissions: ['*'], env: DEMO_ENV })
    const failed = await app.request('/demo/reset', { method: 'POST' })
    expect(failed.status).toBe(500)
    expect((await app.request('/demo/reset', { method: 'POST' })).status).toBe(200)
  })
})
