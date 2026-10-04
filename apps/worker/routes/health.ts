import { safeFetch } from '../lib/safe-fetch'
import { Hono } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import type { AppEnv } from '../types'
import { healthResponseSchema, livenessResponseSchema, readinessResponseSchema } from '@protocol/schemas/health'

declare const __BUILD_VERSION__: string

const health = new Hono<AppEnv>()

interface CheckResult {
  status: 'ok' | 'failing'
  latencyMs?: number
  detail?: string
}

interface HealthResult {
  status: 'ok' | 'degraded'
  checks: Record<string, CheckResult>
}

async function checkPostgres(): Promise<CheckResult> {
  const t0 = Date.now()
  try {
    const { getDb } = await import('../db')
    const db = getDb()
    const { sql } = await import('drizzle-orm')
    await db.execute(sql`SELECT 1`)
    return { status: 'ok', latencyMs: Date.now() - t0 }
  } catch (err) {
    return { status: 'failing', latencyMs: Date.now() - t0, detail: err instanceof Error ? err.message : 'Connection failed' }
  }
}

async function checkStorage(env: Record<string, unknown>): Promise<CheckResult | null> {
  const endpoint = env.STORAGE_ENDPOINT as string | undefined
  if (!endpoint) return null  // Not configured — skip (optional in CI/test environments)
  const t0 = Date.now()
  try {
    // RustFS returns 403 on unauthenticated paths — this still proves reachability.
    // A 403 still proves the server is running and reachable.
    const url = `${endpoint.replace(/\/$/, '')}/`
    const res = await safeFetch(url, { timeoutMs: 5_000, ssrfGuard: false })
    if (res.ok || res.status === 403) return { status: 'ok', latencyMs: Date.now() - t0 }
    return { status: 'failing', latencyMs: Date.now() - t0, detail: `HTTP ${res.status}` }
  } catch (err) {
    return { status: 'failing', latencyMs: Date.now() - t0, detail: err instanceof Error ? err.message : 'Unreachable' }
  }
}

async function checkRelay(env: Record<string, unknown>): Promise<CheckResult | null> {
  // Native WebSocket relay is in-process — if the server is running, the relay is running.
  // Only requires SERVER_SECRET to be set (used for relay auth key derivation).
  const serverSecret = env.SERVER_SECRET
  if (!serverSecret) return null  // Not configured — skip (relay disabled)
  return { status: 'ok' }
}

async function checkSipBridge(env: Record<string, unknown>): Promise<CheckResult | null> {
  const bridgeUrl = env.SIP_BRIDGE_URL as string | undefined
  if (!bridgeUrl) return null  // Not configured — skip
  const t0 = Date.now()
  try {
    const res = await safeFetch(`${bridgeUrl.replace(/\/$/, '')}/health`, { timeoutMs: 5_000, ssrfGuard: false })
    if (!res.ok) return { status: 'failing', latencyMs: Date.now() - t0, detail: `HTTP ${res.status}` }
    return { status: 'ok', latencyMs: Date.now() - t0 }
  } catch (err) {
    return { status: 'failing', latencyMs: Date.now() - t0, detail: err instanceof Error ? err.message : 'Unreachable' }
  }
}

async function checkSignalNotifier(env: Record<string, unknown>): Promise<CheckResult | null> {
  const notifierUrl = (env.SIGNAL_NOTIFIER_URL ?? env.NOTIFIER_URL) as string | undefined
  if (!notifierUrl) return null  // Not configured — skip
  const t0 = Date.now()
  try {
    const res = await safeFetch(`${notifierUrl.replace(/\/$/, '')}/health`, { timeoutMs: 5_000, ssrfGuard: false })
    if (!res.ok) return { status: 'failing', latencyMs: Date.now() - t0, detail: `HTTP ${res.status}` }
    const body = await res.json() as { ok?: boolean; error?: string }
    if (!body.ok) {
      return { status: 'failing', latencyMs: Date.now() - t0, detail: body.error ?? 'Signal notifier reported unhealthy' }
    }
    return { status: 'ok', latencyMs: Date.now() - t0 }
  } catch (err) {
    return { status: 'failing', latencyMs: Date.now() - t0, detail: err instanceof Error ? err.message : 'Unreachable' }
  }
}

async function runChecks(env: Record<string, unknown>): Promise<HealthResult> {
  const [postgres, storage, relay, sipBridge, signalNotifier] = await Promise.all([
    checkPostgres(),
    checkStorage(env),
    checkRelay(env),
    checkSipBridge(env),
    checkSignalNotifier(env),
  ])

  const checks: Record<string, CheckResult> = { postgres }
  if (storage !== null) checks.storage = storage
  if (relay !== null) checks.relay = relay
  if (sipBridge !== null) checks.sipBridge = sipBridge
  if (signalNotifier !== null) checks.signalNotifier = signalNotifier

  // Readiness answers one question: can this instance serve traffic? Only
  // dependencies that make the answer "no" may gate it.
  //
  // `postgres`, `storage` and `relay` are load-bearing — without them the app
  // cannot take a call or store a note, so a failure there is correctly 503.
  //
  // `sipBridge` and `signalNotifier` are OPTIONAL integrations. A hotline whose
  // Signal sidecar is down still answers the phone, and one that never deployed
  // Signal is not broken at all. Letting either gate readiness left the app
  // container `unhealthy` forever on any deployment not running the `signal`
  // profile, and hung `first-run.sh` on a condition that could never become
  // true (#1418). Their status is still REPORTED in `checks`, so a
  // configured-but-failing sidecar stays visible to an operator — it just no
  // longer claims the whole instance cannot serve.
  const GATING = ['postgres', 'storage', 'relay']
  const status = Object.entries(checks)
    .filter(([name]) => GATING.includes(name))
    .every(([, v]) => v.status === 'ok') ? 'ok' : 'degraded'
  return { status, checks }
}

function measureEventLoopLag(): Promise<number> {
  return new Promise(resolve => {
    const start = performance.now()
    setImmediate(() => resolve(performance.now() - start))
  })
}

// Full health check — dependency status
health.get('/',
  describeRoute({
    tags: ['Health'],
    summary: 'Full health check with dependency status',
    responses: {
      200: {
        description: 'All dependencies healthy',
        content: {
          'application/json': {
            schema: resolver(healthResponseSchema),
          },
        },
      },
      503: { description: 'One or more dependencies degraded or failing' },
    },
  }),
  async (c) => {
    const { status, checks } = await runChecks(c.env as unknown as Record<string, unknown>)
    const mem = typeof process !== 'undefined' ? process.memoryUsage() : null
    const demoMode = (c.env as unknown as Record<string, unknown>).DEMO_MODE === 'true'

    return c.json({
      status,
      checks,
      version: typeof __BUILD_VERSION__ !== 'undefined' ? __BUILD_VERSION__ : 'dev',
      uptime: typeof process !== 'undefined' ? Math.floor(process.uptime()) : undefined,
      demoMode,
      ...(mem && {
        memory: {
          heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
          heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
          rssMb: Math.round(mem.rss / 1024 / 1024),
        },
      }),
    }, status === 'ok' ? 200 : 503)
  },
)

// Kubernetes liveness probe — lightweight process check (memory + event loop lag)
health.get('/live',
  describeRoute({
    tags: ['Health'],
    summary: 'Kubernetes liveness probe',
    responses: {
      200: {
        description: 'Process is alive',
        content: {
          'application/json': {
            schema: resolver(livenessResponseSchema),
          },
        },
      },
    },
  }),
  async (c) => {
    const lagMs = await measureEventLoopLag()
    const mem = typeof process !== 'undefined' ? process.memoryUsage() : null

    return c.json({
      status: 'ok',
      eventLoopLagMs: Math.round(lagMs),
      ...(mem && {
        heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
      }),
    })
  },
)

// Kubernetes readiness probe — verifies all dependencies are reachable
health.get('/ready',
  describeRoute({
    tags: ['Health'],
    summary: 'Kubernetes readiness probe with dependency verification',
    responses: {
      200: {
        description: 'All dependencies ready',
        content: {
          'application/json': {
            schema: resolver(readinessResponseSchema),
          },
        },
      },
      503: { description: 'One or more dependencies not ready' },
    },
  }),
  async (c) => {
    const { status, checks } = await runChecks(c.env as unknown as Record<string, unknown>)
    const demoMode = (c.env as unknown as Record<string, unknown>).DEMO_MODE === 'true'

    return c.json({
      status,
      checks,
      version: typeof __BUILD_VERSION__ !== 'undefined' ? __BUILD_VERSION__ : 'dev',
      demoMode,
    }, status === 'ok' ? 200 : 503)
  },
)

export default health
