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

/**
 * A dependency whose configuration is MISSING, reported as a failing check
 * rather than left out of the response.
 *
 * Every one of these checks used to return `null` when its configuration
 * variable was unset, and `runChecks` then dropped the key entirely. An
 * unconfigured dependency was therefore indistinguishable, in the response,
 * from one that had never been asked about — and the overall `status` stayed
 * `ok`, so the absence read as success.
 *
 * That is not hypothetical. On a deployed host `SIP_BRIDGE_URL` went
 * unrendered, `checkSipBridge` returned null, and `/api/health/ready` answered
 * 200 with THREE checks and `"status":"ok"` where it should have carried four
 * and `sipBridge: failing`. Nothing anywhere said the call path was dead,
 * because the probe that would have said so had removed itself.
 *
 * So: a probe can no longer omit itself. A missing variable is a `failing`
 * check naming the variable. Whether that failure matters is a question about
 * the DEPLOYMENT, not about the app — a hotline that never deployed Signal is
 * not broken — and the deployment is where it is answered: the smoke check
 * reads these values back and applies its own fatal/advisory ruling per
 * dependency (deploy/ansible/playbooks/smoke-check.yml). What the app owes it
 * is a complete report. See issue #1636.
 *
 * Readiness GATING is unchanged (#1418): only postgres, storage and relay can
 * make this instance unable to serve, so only they turn the response 503. An
 * unconfigured optional integration is reported and does not 503 — it must
 * not, or every deployment without the `signal` profile would be permanently
 * `unhealthy` to its orchestrator.
 */
function unconfigured(variable: string, consequence: string): CheckResult {
  return { status: 'failing', detail: `${variable} is not set — ${consequence}` }
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

// The same resolution lib/storage-manager.ts uses, so this check probes the
// endpoint the app will ACTUALLY read and write — including the default it
// falls back to. Reporting "not configured" for an unset STORAGE_ENDPOINT
// would be a different lie from the one being fixed here: the app does not
// stop using storage when the variable is absent, it uses localhost.
const STORAGE_ENDPOINT_DEFAULT = 'http://localhost:9000'

async function checkStorage(env: Record<string, unknown>): Promise<CheckResult> {
  const configured = env.STORAGE_ENDPOINT as string | undefined
  const endpoint = configured || STORAGE_ENDPOINT_DEFAULT
  const where = configured ? '' : ` (STORAGE_ENDPOINT unset — probed the default ${STORAGE_ENDPOINT_DEFAULT})`
  const t0 = Date.now()
  try {
    // RustFS returns 403 on unauthenticated paths — this still proves reachability.
    // A 403 still proves the server is running and reachable.
    const url = `${endpoint.replace(/\/$/, '')}/`
    const res = await safeFetch(url, { timeoutMs: 5_000, ssrfGuard: false })
    if (res.ok || res.status === 403) return { status: 'ok', latencyMs: Date.now() - t0 }
    return { status: 'failing', latencyMs: Date.now() - t0, detail: `HTTP ${res.status}${where}` }
  } catch (err) {
    return { status: 'failing', latencyMs: Date.now() - t0, detail: `${err instanceof Error ? err.message : 'Unreachable'}${where}` }
  }
}

async function checkRelay(env: Record<string, unknown>): Promise<CheckResult> {
  // Native WebSocket relay is in-process — if the server is running, the relay is running.
  // Only requires SERVER_SECRET to be set (used for relay auth key derivation).
  const serverSecret = env.SERVER_SECRET
  if (!serverSecret) {
    return unconfigured('SERVER_SECRET', 'the relay cannot derive its auth keys, so no client receives a live event')
  }
  return { status: 'ok' }
}

async function checkSipBridge(env: Record<string, unknown>): Promise<CheckResult> {
  const bridgeUrl = env.SIP_BRIDGE_URL as string | undefined
  if (!bridgeUrl) {
    // The measured instance of the omission this file used to allow: this
    // exact variable went unrendered on a deployed host and the check vanished
    // from the response instead of reporting the dead call path.
    return unconfigured('SIP_BRIDGE_URL', 'no self-hosted SIP bridge is reachable, so a call cannot route to a volunteer')
  }
  const t0 = Date.now()
  try {
    const res = await safeFetch(`${bridgeUrl.replace(/\/$/, '')}/health`, { timeoutMs: 5_000, ssrfGuard: false })
    if (!res.ok) return { status: 'failing', latencyMs: Date.now() - t0, detail: `HTTP ${res.status}` }
    return { status: 'ok', latencyMs: Date.now() - t0 }
  } catch (err) {
    return { status: 'failing', latencyMs: Date.now() - t0, detail: err instanceof Error ? err.message : 'Unreachable' }
  }
}

async function checkSignalNotifier(env: Record<string, unknown>): Promise<CheckResult> {
  const notifierUrl = (env.SIGNAL_NOTIFIER_URL ?? env.NOTIFIER_URL) as string | undefined
  if (!notifierUrl) {
    return unconfigured('SIGNAL_NOTIFIER_URL', 'Signal notifications are unavailable')
  }
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

  // Every check, unconditionally. No `if (x !== null)` — that conditional IS
  // the defect: it let a probe delete itself from its own report, and an
  // absent measurement then read as a healthy one. See `unconfigured` above.
  const checks: Record<string, CheckResult> = { postgres, storage, relay, sipBridge, signalNotifier }

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
