/**
 * Metrics endpoints.
 *
 * Two formats:
 * - GET /api/metrics              — JSON summary (admin-only, for dashboards)
 * - GET /api/metrics/prometheus   — Prometheus text exposition (for scrapers)
 *
 * Metrics are collected in-memory and reset on process restart.
 */
import { Hono } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import type { AppEnv } from '../types'
import { getErrorSummary } from '../lib/error-counter'
import { auth } from '../middleware/auth'
import { requirePermission } from '../middleware/permission-guard'
import { getAllCircuitBreakerMetrics } from '../lib/circuit-breaker'
import { renderWorkerLivenessMetrics } from '../metrics/worker-liveness'
import { metricsResponseSchema } from '@protocol/schemas/metrics'
import { authErrors } from '../openapi/helpers'

const metrics = new Hono<AppEnv>()

// ---------------------------------------------------------------------------
// In-memory metric stores
// ---------------------------------------------------------------------------

const counters: Map<string, number> = new Map()
const gauges: Map<string, number> = new Map()

// Histogram: name → { buckets: [le, count][], sum, count }
const HISTOGRAM_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]

interface HistogramData {
  buckets: Map<number, number>  // le → cumulative count
  sum: number
  count: number
}

const histograms: Map<string, HistogramData> = new Map()

const startTime = Date.now()

// ---------------------------------------------------------------------------
// Public API for middleware / services to record metrics
// ---------------------------------------------------------------------------

function labelStr(labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) return ''
  return `{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',')}}`
}

/** Increment a counter metric */
export function incCounter(name: string, labels?: Record<string, string>): void {
  const key = name + labelStr(labels)
  counters.set(key, (counters.get(key) ?? 0) + 1)
}

/** Set a gauge metric to an absolute value */
export function setGauge(name: string, value: number, labels?: Record<string, string>): void {
  const key = name + labelStr(labels)
  gauges.set(key, value)
}

/** Increment a gauge */
export function incGauge(name: string, labels?: Record<string, string>): void {
  const key = name + labelStr(labels)
  gauges.set(key, (gauges.get(key) ?? 0) + 1)
}

/** Decrement a gauge */
export function decGauge(name: string, labels?: Record<string, string>): void {
  const key = name + labelStr(labels)
  gauges.set(key, (gauges.get(key) ?? 0) - 1)
}

/** Record a histogram observation (value in seconds) */
export function observeHistogram(name: string, value: number, labels?: Record<string, string>): void {
  const key = name + labelStr(labels)
  let data = histograms.get(key)
  if (!data) {
    data = { buckets: new Map(HISTOGRAM_BUCKETS.map(le => [le, 0])), sum: 0, count: 0 }
    histograms.set(key, data)
  }
  for (const le of HISTOGRAM_BUCKETS) {
    if (value <= le) data.buckets.set(le, (data.buckets.get(le) ?? 0) + 1)
  }
  data.sum += value
  data.count += 1
}

// ---------------------------------------------------------------------------
// Domain-specific metric helpers (called by routes / services)
// ---------------------------------------------------------------------------

/** Record an HTTP request (called by metrics middleware in app.ts) */
export function recordHttpRequest(method: string, path: string, status: number, durationSec: number): void {
  const statusClass = `${Math.floor(status / 100)}xx`
  incCounter('llamenos_http_requests_total', { method, status: String(status), status_class: statusClass })
  observeHistogram('llamenos_http_request_duration_seconds', durationSec, { method, path, status: String(status) })
}

/** Update active call count */
export function setActiveCalls(count: number): void {
  setGauge('llamenos_active_calls', count)
}

/** Update active conversation count */
export function setActiveConversations(count: number): void {
  setGauge('llamenos_active_conversations', count)
}

/** Update SIP bridge status per hub (1=up, 0=down) */
export function setSipBridgeStatus(hubId: string, up: boolean): void {
  setGauge('llamenos_sip_bridge_status', up ? 1 : 0, { hub_id: hubId })
}

/** Update backup age in seconds (from last successful backup timestamp) */
export function setBackupAge(seconds: number): void {
  setGauge('llamenos_backup_age_seconds', seconds)
}

// ---------------------------------------------------------------------------
// Prometheus text format renderer
// ---------------------------------------------------------------------------

function formatPrometheusMetrics(): string {
  const lines: string[] = []

  // Process uptime
  const uptimeSeconds = (Date.now() - startTime) / 1000
  lines.push('# HELP llamenos_uptime_seconds Process uptime in seconds')
  lines.push('# TYPE llamenos_uptime_seconds gauge')
  lines.push(`llamenos_uptime_seconds ${uptimeSeconds.toFixed(1)}`)

  // Error counters
  const summary = getErrorSummary()
  lines.push('# HELP llamenos_errors_total Total errors by category')
  lines.push('# TYPE llamenos_errors_total counter')
  for (const [category, count] of Object.entries(summary.errors)) {
    lines.push(`llamenos_errors_total{category="${category}"} ${count}`)
  }

  // HTTP request counters
  lines.push('# HELP llamenos_http_requests_total Total HTTP requests by method and status')
  lines.push('# TYPE llamenos_http_requests_total counter')
  for (const [key, value] of counters) {
    if (key.startsWith('llamenos_http_requests_total')) {
      lines.push(`${key} ${value}`)
    }
  }

  // HTTP request duration histograms
  lines.push('# HELP llamenos_http_request_duration_seconds HTTP request duration in seconds')
  lines.push('# TYPE llamenos_http_request_duration_seconds histogram')
  for (const [key, data] of histograms) {
    if (!key.startsWith('llamenos_http_request_duration_seconds')) continue
    const labelPart = key.includes('{') ? key.slice(key.indexOf('{'), key.indexOf('}') + 1) : ''
    const baseName = key.split('{')[0]
    // Buckets are already cumulative (each le stores count of observations ≤ le)
    for (const le of HISTOGRAM_BUCKETS) {
      const cumulativeCount = data.buckets.get(le) ?? 0
      const lePart = labelPart
        ? labelPart.slice(0, -1) + `,le="${le}"}`
        : `{le="${le}"}`
      lines.push(`${baseName}_bucket${lePart} ${cumulativeCount}`)
    }
    const infPart = labelPart
      ? labelPart.slice(0, -1) + ',le="+Inf"}'
      : '{le="+Inf"}'
    lines.push(`${baseName}_bucket${infPart} ${data.count}`)
    lines.push(`${baseName}_sum${labelPart} ${data.sum.toFixed(6)}`)
    lines.push(`${baseName}_count${labelPart} ${data.count}`)
  }

  // Active calls gauge
  lines.push('# HELP llamenos_active_calls Number of currently active calls')
  lines.push('# TYPE llamenos_active_calls gauge')
  lines.push(`llamenos_active_calls ${gauges.get('llamenos_active_calls') ?? 0}`)

  // Active conversations gauge
  lines.push('# HELP llamenos_active_conversations Number of currently active conversations')
  lines.push('# TYPE llamenos_active_conversations gauge')
  lines.push(`llamenos_active_conversations ${gauges.get('llamenos_active_conversations') ?? 0}`)

  // SIP bridge status (per hub)
  const sipEntries = [...gauges.entries()].filter(([k]) => k.startsWith('llamenos_sip_bridge_status'))
  if (sipEntries.length > 0) {
    lines.push('# HELP llamenos_sip_bridge_status SIP bridge connectivity status per hub (1=up, 0=down)')
    lines.push('# TYPE llamenos_sip_bridge_status gauge')
    for (const [key, value] of sipEntries) {
      lines.push(`${key} ${value}`)
    }
  }

  // Backup age
  const backupAge = gauges.get('llamenos_backup_age_seconds')
  if (backupAge !== undefined) {
    lines.push('# HELP llamenos_backup_age_seconds Seconds since last successful backup')
    lines.push('# TYPE llamenos_backup_age_seconds gauge')
    lines.push(`llamenos_backup_age_seconds ${backupAge}`)
  }

  // Scheduler worker liveness — judged out of process by the WorkerStalled
  // alert rule, since a worker cannot report its own absence (#2323).
  lines.push(...renderWorkerLivenessMetrics())

  // Circuit breaker metrics
  const cbMetrics = getAllCircuitBreakerMetrics()
  if (cbMetrics.length > 0) {
    lines.push('# HELP llamenos_circuit_breaker_state Circuit breaker state (0=closed, 1=open, 2=half_open)')
    lines.push('# TYPE llamenos_circuit_breaker_state gauge')
    lines.push('# HELP llamenos_circuit_breaker_requests_total Total requests through circuit breaker')
    lines.push('# TYPE llamenos_circuit_breaker_requests_total counter')
    lines.push('# HELP llamenos_circuit_breaker_failures_total Total failures recorded by circuit breaker')
    lines.push('# TYPE llamenos_circuit_breaker_failures_total counter')
    lines.push('# HELP llamenos_circuit_breaker_rejections_total Requests rejected by open circuit')
    lines.push('# TYPE llamenos_circuit_breaker_rejections_total counter')

    const stateValue = (state: string) => state === 'closed' ? 0 : state === 'open' ? 1 : 2

    for (const cb of cbMetrics) {
      const labels = `name="${cb.name}"`
      lines.push(`llamenos_circuit_breaker_state{${labels}} ${stateValue(cb.state)}`)
      lines.push(`llamenos_circuit_breaker_requests_total{${labels}} ${cb.totalRequests}`)
      lines.push(`llamenos_circuit_breaker_failures_total{${labels}} ${cb.totalFailures}`)
      lines.push(`llamenos_circuit_breaker_rejections_total{${labels}} ${cb.totalRejections}`)
    }
  }

  // Any additional custom counters
  for (const [key, value] of counters) {
    if (key.startsWith('llamenos_http_requests_total')) continue  // already emitted
    const name = key.split('{')[0]
    if (!lines.some(l => l.includes(`# TYPE ${name}`))) {
      lines.push(`# TYPE ${name} counter`)
    }
    lines.push(`${key} ${value}`)
  }

  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

// Prometheus text format — requires bearer token (METRICS_SCRAPE_TOKEN) or authenticated admin
metrics.get('/prometheus',
  describeRoute({
    tags: ['Metrics'],
    summary: 'Prometheus text exposition metrics',
    responses: {
      200: {
        description: 'Prometheus text format metrics',
        content: {
          'text/plain': { schema: { type: 'string' } },
        },
      },
      401: { description: 'Missing or invalid scrape token' },
    },
  }),
  (c) => {
    const authHeader = c.req.header('Authorization') ?? ''
    const scrapeToken = c.env.METRICS_SCRAPE_TOKEN
    if (scrapeToken) {
      const bearerToken = authHeader.replace(/^Bearer\s+/i, '')
      if (bearerToken !== scrapeToken) {
        return c.json({ error: 'Authentication failed' }, 401)
      }
    } else {
      const pubkey = c.get('pubkey')
      if (!pubkey) return c.json({ error: 'Authentication failed' }, 401)
      const permissions = c.get('permissions')
      if (!permissions?.includes('metrics:read') && !permissions?.includes('*')) {
        return c.json({ error: 'Forbidden' }, 403)
      }
    }
    return new Response(formatPrometheusMetrics(), {
      headers: { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' },
    })
  },
)

// JSON summary — admin-only
metrics.get('/',
  describeRoute({
    tags: ['Metrics'],
    summary: 'JSON metrics summary for admin dashboards',
    responses: {
      200: {
        description: 'JSON metrics including uptime, request counts, and errors',
        content: {
          'application/json': {
            schema: resolver(metricsResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  auth, requirePermission('metrics:read'), (c) => {
    const summary = getErrorSummary()
    const uptimeSeconds = (Date.now() - startTime) / 1000

    return c.json({
      uptime: {
        seconds: Math.floor(uptimeSeconds),
        formatted: formatUptime(uptimeSeconds),
      },
      requests: {
        total: summary.totalRequests,
      },
      errors: {
        total: summary.totalErrors,
        byCategory: summary.errors,
      },
      gauges: Object.fromEntries(gauges),
      counters: Object.fromEntries(counters),
    })
  },
)

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const parts: string[] = []
  if (d > 0) parts.push(`${d}d`)
  if (h > 0) parts.push(`${h}h`)
  parts.push(`${m}m`)
  return parts.join(' ')
}

export default metrics
