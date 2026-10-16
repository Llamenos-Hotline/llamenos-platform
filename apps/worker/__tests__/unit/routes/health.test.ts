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

    // The measured defect (#1636). SIP_BRIDGE_URL went unrendered on a
    // deployed host, this check returned null, and `runChecks` dropped the key
    // — so /api/health/ready answered 200 with THREE checks and status "ok"
    // where it owed four and `sipBridge: failing`. Nothing reported the dead
    // call path, because the only probe that would have had removed itself.
    //
    // This test previously ASSERTED that omission, which is how the defect
    // survived a passing suite.
    it('reports sipBridge FAILING, never absent, when SIP_BRIDGE_URL is not configured', async () => {
      const app = createTestApp({ env: { SIP_BRIDGE_URL: undefined } })
      const res = await app.request('/')
      // Still 200: whether an unconfigured bridge matters is the deployment's
      // call, not the app's (#1418). But the report must be complete.
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.checks.sipBridge).toBeDefined()
      expect(body.checks.sipBridge.status).toBe('failing')
      expect(body.checks.sipBridge.detail).toContain('SIP_BRIDGE_URL')
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

    it('reports signalNotifier FAILING, never absent, when SIGNAL_NOTIFIER_URL is not configured', async () => {
      const app = createTestApp({ env: { SIGNAL_NOTIFIER_URL: undefined } })
      const res = await app.request('/')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.checks.signalNotifier).toBeDefined()
      expect(body.checks.signalNotifier.status).toBe('failing')
      expect(body.checks.signalNotifier.detail).toContain('SIGNAL_NOTIFIER_URL')
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

    // Storage is load-bearing AND has a fallback endpoint in
    // lib/storage-manager.ts, so an unset STORAGE_ENDPOINT does not mean "no
    // storage" — it means localhost. The check probes that same default and
    // reports what it found, rather than removing itself from the response.
    it('probes the default endpoint and reports storage failing when STORAGE_ENDPOINT is not configured', async () => {
      fetchSpy.mockImplementation(async (url: unknown) => {
        // Nothing listening on the default endpoint.
        if (String(url).includes('localhost:9000')) throw new Error('Connection refused')
        if (String(url).includes('sip-bridge')) return new Response('ok', { status: 200 })
        if (String(url).includes('signal-notifier')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        return new Response(null, { status: 500 })
      })

      const app = createTestApp({ env: { STORAGE_ENDPOINT: undefined } })
      const res = await app.request('/')
      // Load-bearing: this one DOES gate.
      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body.checks.storage).toBeDefined()
      expect(body.checks.storage.status).toBe('failing')
      expect(body.checks.storage.detail).toContain('STORAGE_ENDPOINT unset')
    })

    it('reports relay FAILING, never absent, when SERVER_SECRET is not configured', async () => {
      const app = createTestApp({ env: { SERVER_SECRET: undefined } })
      const res = await app.request('/')
      // The relay derives its auth keys from SERVER_SECRET, so without it no
      // client receives a live event — load-bearing, and it gates.
      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body.checks.relay).toBeDefined()
      expect(body.checks.relay.status).toBe('failing')
      expect(body.checks.relay.detail).toContain('SERVER_SECRET')
    })

    // The invariant, pinned once rather than inferred from the four tests
    // above: the SET of checks in the response does not depend on
    // configuration. Without this, a future change that dropped one key again
    // would only break whichever single test covered that key.
    it('reports the same set of checks whether or not anything is configured', async () => {
      const EXPECTED = ['postgres', 'storage', 'relay', 'sipBridge', 'signalNotifier']

      const configured = await (await createTestApp().request('/')).json()
      expect(Object.keys(configured.checks).sort()).toEqual([...EXPECTED].sort())

      fetchSpy.mockImplementation(async () => { throw new Error('Connection refused') })
      const bare = await (await createTestApp({
        env: {
          STORAGE_ENDPOINT: undefined,
          SERVER_SECRET: undefined,
          SIP_BRIDGE_URL: undefined,
          SIGNAL_NOTIFIER_URL: undefined,
          NOTIFIER_URL: undefined,
        },
      }).request('/')).json()
      expect(Object.keys(bare.checks).sort()).toEqual([...EXPECTED].sort())
      // And not one of them claims to be ok.
      for (const name of EXPECTED.filter(n => n !== 'postgres')) {
        expect(bare.checks[name].status).toBe('failing')
      }
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
