import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'
import healthRoute from '@worker/routes/health'

vi.mock('@worker/db', () => ({
  getDb: vi.fn().mockReturnValue({
    execute: vi.fn().mockResolvedValue(undefined),
  }),
}))

function createTestApp(opts: {
  env?: Record<string, string | undefined>
} = {}) {
  const app = new Hono<AppEnv>()

  app.use('*', async (c, next) => {
    ;(c as any).env = {
      STORAGE_ENDPOINT: 'http://storage:9000',
      SERVER_SECRET: 'a'.repeat(64),
      SIP_BRIDGE_URL: 'http://sip-bridge:3000',
      SIGNAL_NOTIFIER_URL: 'http://signal-notifier:3100',
      ...opts.env,
    }
    await next()
  })

  app.route('/', healthRoute)
  return app
}

describe('health route', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url)
      if (urlStr.includes('storage:9000')) {
        return new Response(null, { status: 403 })
      }
      if (urlStr.includes('sip-bridge')) {
        return new Response('ok', { status: 200 })
      }
      if (urlStr.includes('signal-notifier')) {
        return new Response(JSON.stringify({ ok: true, registeredCount: 5 }), { status: 200 })
      }
      return new Response(null, { status: 500 })
    })
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  describe('GET /', () => {
    it('returns 200 when all dependencies are healthy', async () => {
      const app = createTestApp()

      const res = await app.request('/')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.status).toBe('ok')
      expect(body.checks.postgres.status).toBe('ok')
      expect(body.checks.storage.status).toBe('ok')
      expect(body.checks.relay.status).toBe('ok')
      expect(body.checks.sipBridge.status).toBe('ok')
      expect(body.checks.signalNotifier.status).toBe('ok')
      expect(body.version).toBeDefined()
      expect(body.uptime).toBeDefined()
      expect(body.demoMode).toBe(false)
    })

    it('reports demoMode=true when DEMO_MODE env is set', async () => {
      const app = createTestApp({ env: { DEMO_MODE: 'true' } })
      const res = await app.request('/')
      const body = await res.json()
      expect(body.demoMode).toBe(true)
    })

    it('returns 503 when postgres fails', async () => {
      const { getDb } = await import('@worker/db')
      vi.mocked(getDb).mockReturnValueOnce({
        execute: vi.fn().mockRejectedValue(new Error('Connection refused')),
      } as unknown as ReturnType<typeof getDb>)

      const app = createTestApp()
      const res = await app.request('/')
      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body.status).toBe('degraded')
      expect(body.checks.postgres.status).toBe('failing')
      expect(body.checks.postgres.detail).toContain('Connection refused')
    })

    it('returns 503 when storage is unreachable', async () => {
      fetchSpy.mockImplementation(async () => {
        return new Response(null, { status: 500 })
      })

      const app = createTestApp()
      const res = await app.request('/')
      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body.checks.storage.status).toBe('failing')
    })

    it('reports a failing sip bridge WITHOUT gating readiness', async () => {
      fetchSpy.mockImplementation(async (url: unknown) => {
        if (String(url).includes('sip-bridge')) {
          return new Response(null, { status: 500 })
        }
        return new Response(null, { status: 403 })
      })

      const app = createTestApp()
      const res = await app.request('/')
      // The SIP bridge is an OPTIONAL integration: a hotline whose bridge is
      // down can still store notes and serve its API, so this must not report
      // the instance as unable to serve. It must still be VISIBLE though —
      // silently dropping the check would hide a real outage from operators.
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.status).toBe('ok')
      expect(body.checks.sipBridge.status).toBe('failing')
    })

    it('skips sipBridge check when SIP_BRIDGE_URL not configured', async () => {
      const app = createTestApp({ env: { SIP_BRIDGE_URL: undefined } })
      const res = await app.request('/')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.checks.sipBridge).toBeUndefined()
    })

    it('reports a failing signal notifier WITHOUT gating readiness', async () => {
      fetchSpy.mockImplementation(async (url: unknown) => {
        const urlStr = String(url)
        if (urlStr.includes('signal-notifier')) {
          return new Response(JSON.stringify({ ok: false, error: 'DB connection failed' }), { status: 503 })
        }
        if (urlStr.includes('storage:9000')) return new Response(null, { status: 403 })
        if (urlStr.includes('sip-bridge')) return new Response('ok', { status: 200 })
        return new Response(null, { status: 500 })
      })

      const app = createTestApp()
      const res = await app.request('/')
      // Optional integration — see #1418. Gating on this left the container
      // `unhealthy` forever on every deployment that did not run the `signal`
      // profile, and hung first-run.sh on a condition that could never pass.
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.status).toBe('ok')
      expect(body.checks.signalNotifier.status).toBe('failing')
    })

    it('marks signal notifier failing when it returns ok:false body', async () => {
      fetchSpy.mockImplementation(async (url: unknown) => {
        const urlStr = String(url)
        if (urlStr.includes('signal-notifier')) {
          return new Response(JSON.stringify({ ok: false, error: 'migration pending' }), { status: 200 })
        }
        if (urlStr.includes('storage:9000')) return new Response(null, { status: 403 })
        if (urlStr.includes('sip-bridge')) return new Response('ok', { status: 200 })
        return new Response(null, { status: 500 })
      })

      const app = createTestApp()
      const res = await app.request('/')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.status).toBe('ok')
      expect(body.checks.signalNotifier.status).toBe('failing')
      expect(body.checks.signalNotifier.detail).toContain('migration pending')
    })

    // The distinction this route now rests on, pinned directly. Without this,
    // a future change that made everything non-gating would pass every test
    // above — each of those only proves one check behaves one way.
    it('gates readiness on load-bearing deps but not on optional integrations', async () => {
      // Storage failing (load-bearing) alongside a healthy optional stack.
      fetchSpy.mockImplementation(async (url: unknown) => {
        const u = String(url)
        if (u.includes('signal-notifier')) return new Response(JSON.stringify({ ok: true }), { status: 200 })
        if (u.includes('sip-bridge')) return new Response('ok', { status: 200 })
        return new Response(null, { status: 500 }) // storage
      })
      let res = await createTestApp().request('/')
      expect(res.status).toBe(503)
      expect((await res.json()).status).toBe('degraded')

      // Now invert it: load-bearing healthy, BOTH optional integrations down.
      fetchSpy.mockImplementation(async (url: unknown) => {
        const u = String(url)
        if (u.includes('signal-notifier')) return new Response(null, { status: 500 })
        if (u.includes('sip-bridge')) return new Response(null, { status: 500 })
        if (u.includes('storage:9000')) return new Response(null, { status: 403 })
        return new Response('ok', { status: 200 })
      })
      res = await createTestApp().request('/')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.status).toBe('ok')
      // Still reported — non-gating must not mean invisible.
      expect(body.checks.sipBridge.status).toBe('failing')
      expect(body.checks.signalNotifier.status).toBe('failing')
    })

    it('skips signalNotifier check when SIGNAL_NOTIFIER_URL not configured', async () => {
      const app = createTestApp({ env: { SIGNAL_NOTIFIER_URL: undefined } })
      const res = await app.request('/')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.checks.signalNotifier).toBeUndefined()
    })

    it('falls back to NOTIFIER_URL when SIGNAL_NOTIFIER_URL not set', async () => {
      fetchSpy.mockImplementation(async (url: unknown) => {
        const urlStr = String(url)
        if (urlStr.includes('legacy-notifier')) {
          return new Response(JSON.stringify({ ok: true, registeredCount: 0 }), { status: 200 })
        }
        if (urlStr.includes('storage:9000')) return new Response(null, { status: 403 })
        if (urlStr.includes('sip-bridge')) return new Response('ok', { status: 200 })
        return new Response(null, { status: 500 })
      })

      const app = createTestApp({ env: { SIGNAL_NOTIFIER_URL: undefined, NOTIFIER_URL: 'http://legacy-notifier:3100' } })
      const res = await app.request('/')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.checks.signalNotifier.status).toBe('ok')
    })

    it('treats storage 403 as ok (RustFS unauthenticated path behavior)', async () => {
      fetchSpy.mockImplementation(async (url: unknown) => {
        const urlStr = String(url)
        if (urlStr.includes('storage:9000')) {
          return new Response(null, { status: 403 })
        }
        if (urlStr.includes('sip-bridge')) {
          return new Response('ok', { status: 200 })
        }
        if (urlStr.includes('signal-notifier')) {
          return new Response(JSON.stringify({ ok: true, registeredCount: 0 }), { status: 200 })
        }
        return new Response(null, { status: 500 })
      })

      const app = createTestApp()
      const res = await app.request('/')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.checks.storage.status).toBe('ok')
    })

    it('skips storage check when STORAGE_ENDPOINT not configured', async () => {
      const app = createTestApp({ env: { STORAGE_ENDPOINT: undefined } })
      const res = await app.request('/')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.checks.storage).toBeUndefined()
    })

    it('skips relay check when SERVER_SECRET not configured', async () => {
      const app = createTestApp({ env: { SERVER_SECRET: undefined } })
      const res = await app.request('/')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.checks.relay).toBeUndefined()
    })

    it('includes latency measurements for external checks', async () => {
      const app = createTestApp()
      const res = await app.request('/')
      const body = await res.json()
      expect(body.checks.postgres.latencyMs).toBeGreaterThanOrEqual(0)
      expect(body.checks.storage.latencyMs).toBeGreaterThanOrEqual(0)
      // relay check is in-process (no latency), sipBridge and signalNotifier are external
      expect(body.checks.sipBridge.latencyMs).toBeGreaterThanOrEqual(0)
      expect(body.checks.signalNotifier.latencyMs).toBeGreaterThanOrEqual(0)
    })

    it('includes memory usage when process.memoryUsage is available', async () => {
      const app = createTestApp()
      const res = await app.request('/')
      const body = await res.json()
      expect(body.memory).toBeDefined()
      expect(body.memory.heapUsedMb).toBeGreaterThanOrEqual(0)
      expect(body.memory.heapTotalMb).toBeGreaterThanOrEqual(0)
      expect(body.memory.rssMb).toBeGreaterThanOrEqual(0)
    })
  })

  describe('GET /live', () => {
    it('returns 200 with process status', async () => {
      const app = createTestApp()
      const res = await app.request('/live')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.status).toBe('ok')
      expect(body.eventLoopLagMs).toBeGreaterThanOrEqual(0)
      expect(body.heapUsedMb).toBeGreaterThanOrEqual(0)
    })
  })

  describe('GET /ready', () => {
    it('returns 200 when all dependencies ready', async () => {
      const app = createTestApp()
      const res = await app.request('/ready')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.status).toBe('ok')
      expect(body.checks).toBeDefined()
      expect(body.version).toBeDefined()
      expect(body.demoMode).toBe(false)
    })

    it('reports demoMode=true in readiness response when DEMO_MODE is set', async () => {
      const app = createTestApp({ env: { DEMO_MODE: 'true' } })
      const res = await app.request('/ready')
      const body = await res.json()
      expect(body.demoMode).toBe(true)
    })

    it('returns 503 when dependencies are degraded', async () => {
      const { getDb } = await import('@worker/db')
      vi.mocked(getDb).mockReturnValueOnce({
        execute: vi.fn().mockRejectedValue(new Error('DB down')),
      } as unknown as ReturnType<typeof getDb>)

      const app = createTestApp()
      const res = await app.request('/ready')
      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body.status).toBe('degraded')
    })

    it('omits memory metrics (not included in readiness)', async () => {
      const app = createTestApp()
      const res = await app.request('/ready')
      const body = await res.json()
      expect(body.memory).toBeUndefined()
    })
  })
})
