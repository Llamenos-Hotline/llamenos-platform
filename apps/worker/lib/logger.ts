/**
 * Structured JSON logger for production observability.
 *
 * Outputs JSON lines to stdout for consumption by log aggregators
 * (Loki, Elasticsearch, CloudWatch, etc.).
 *
 * Features:
 * - Namespace filtering via LOG_NAMESPACES env var (glob patterns, comma-separated)
 *   e.g. LOG_NAMESPACES="services.*,telephony.*" to enable only those namespaces
 * - Structured JSON output: { timestamp, level, namespace, message, correlationId, ...context }
 * - Correlation ID propagation via AsyncLocalStorage (bound by request-logger middleware)
 * - Automatic redaction of sensitive fields (phone numbers, emails, keys, secrets, tokens)
 * - Per-level rate limiting via LOG_RATE_LIMITS env var (JSON, e.g. {"debug":100})
 * - Log levels: trace, debug, info, warn, error, fatal
 * - MIN_LOG_LEVEL env var (default: info)
 */

import { AsyncLocalStorage } from 'node:async_hooks'

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
}

const isSelfHosted = typeof process !== 'undefined' && process.env?.PLATFORM === 'bun'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface RateLimits {
  trace?: number
  debug?: number
  info?: number
  warn?: number
  error?: number
  fatal?: number
}

interface LoggerConfig {
  minLevel: LogLevel
  namespaces: string[]
  rateLimits: Required<RateLimits>
  stripStacks: boolean
}

const DEFAULT_RATE_LIMITS: Required<RateLimits> = {
  trace: 50,
  debug: 100,
  info: 200,
  warn: 500,
  error: Number.POSITIVE_INFINITY,
  fatal: Number.POSITIVE_INFINITY,
}

function parseRateLimits(env: string | undefined): Required<RateLimits> {
  if (!env) return DEFAULT_RATE_LIMITS
  try {
    const parsed = JSON.parse(env) as Partial<RateLimits>
    return { ...DEFAULT_RATE_LIMITS, ...parsed }
  } catch (err) {
    process.stderr.write(
      `{"level":"warn","namespace":"logger","message":"Invalid LOG_RATE_LIMITS JSON, using defaults","error":"${err instanceof Error ? err.message : String(err)}"}\n`
    )
    return DEFAULT_RATE_LIMITS
  }
}

function loadConfig(): LoggerConfig {
  const rawLevel = (isSelfHosted ? process.env.MIN_LOG_LEVEL : undefined) as LogLevel | undefined
  const minLevel = rawLevel && LEVEL_PRIORITY[rawLevel] !== undefined ? rawLevel : 'info'

  const namespaces = (isSelfHosted ? process.env.LOG_NAMESPACES : undefined) || '*'
  const parsedNamespaces = namespaces
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  return {
    minLevel,
    namespaces: parsedNamespaces.length ? parsedNamespaces : ['*'],
    rateLimits: parseRateLimits(isSelfHosted ? process.env.LOG_RATE_LIMITS : undefined),
    stripStacks: isSelfHosted ? process.env.LOG_STACKS !== 'true' : true,
  }
}

let config: LoggerConfig = loadConfig()

/** Reset configuration and rate limiter — exposed for tests only. */
export function _setLoggerConfigForTests(next: LoggerConfig): void {
  config = next
  rateLimiter = createRateLimiter(next.rateLimits)
}

// ---------------------------------------------------------------------------
// Namespace filtering (glob patterns)
// ---------------------------------------------------------------------------

function globMatches(namespace: string, pattern: string): boolean {
  if (pattern === '*') return true
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -2)
    return namespace === prefix || namespace.startsWith(`${prefix}.`)
  }
  return namespace === pattern
}

function namespaceAllowed(ns: string): boolean {
  return config.namespaces.some((p) => globMatches(ns, p))
}

function levelAllowed(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[config.minLevel]
}

// ---------------------------------------------------------------------------
// Correlation ID via AsyncLocalStorage
// ---------------------------------------------------------------------------

interface CorrelationContext {
  correlationId?: string
  requestId?: string
}

const correlationStorage = new AsyncLocalStorage<CorrelationContext>()

/** Run a function with correlation context bound (use in request middleware) */
export function withCorrelation<T>(ctx: CorrelationContext, fn: () => T): T {
  return correlationStorage.run(ctx, fn)
}

/** Get the current correlation context (returns empty object outside a request) */
export function getCorrelation(): CorrelationContext {
  return correlationStorage.getStore() ?? {}
}

// ---------------------------------------------------------------------------
// Sensitive field redaction
// ---------------------------------------------------------------------------

// Field names the telephony/messaging code actually uses for caller/callee
// identifiers, in addition to the generic "phone"/"email" style names.
// `caller`/`called` are unanchored so they also catch compound names like
// `callerNumber`, `callerLast4`, `calledNumber`. `from`/`to`/`number`/`address`
// are anchored to whole-key matches (like the pre-existing `^pin$`) so we don't
// blanket-redact unrelated fields such as `fromDate`/`toDate`/`pageNumber`
// (the latter is already covered by the `phone` alternative for phone-ish uses).
const SENSITIVE_KEY_RE =
  /phone|email|nsec|secret|token|ciphertext|encrypted|content|recovery|^pin$|password|credential|apikey|auth_token|access_key|secret_key|private_key|server_secret|sid|signature|jwt|nonce|cookie|session|bearer|^from$|^to$|caller|called|msisdn|^number$|recipient|^address$/i

// Anchored allowlist of "*name" keys that carry a person's or organisation's
// display name — organisational structure (hub/volunteer names) is
// implicating data under this project's scope rule, not just direct PII.
// Deliberately anchored (not a bare `/name$/i` suffix match) so it does not
// sweep up unrelated technical fields that happen to end in "name" —
// `errName`, `fileName`, `hostname`, `pathname`, `roleName`, `queueName`,
// `templateName`, `policyName`, `instanceName`, etc. — which the logger's
// own error-unwrapping path and other call sites rely on staying visible.
const NAME_KEY_RE = /^(first|last|full|display|user|volunteer|hub)?name$/i

const NSEC_RE = /nsec1[0-9a-z]{58}/g
const HEX_KEY_RE = /\b[0-9a-f]{64}\b/gi
// E.164-aware phone matcher. ITU E.164 numbers are `+` followed by 7-15
// digits with no internal separators — the previous regex only recognized a
// NANP-shaped "(optional +1) 3-3-4 digit" grouping, so any non-NANP or
// longer international number (the default case for this 22-locale,
// EU-oriented product) passed through unredacted. Three alternatives:
//   1. `+` followed by 7-15 digits (canonical E.164 wire format)
//   2. Human-formatted groups of 2-4 digits separated by space/dot/dash/parens
//      (NANP "(555) 123-4567" as well as non-NANP groupings like "030 12 34 56")
//   3. A bare, unformatted run of 7-15 digits (numbers logged with no
//      separators and no leading "+")
const PHONE_RE = /\+\d{7,15}\b|\(?\d{2,4}\)?(?:[\s.-]\d{2,4}){1,4}\b|\b\d{7,15}\b/g
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
const MAX_REDACT_DEPTH = 3

function redactString(s: string): string {
  return s
    .replace(NSEC_RE, '[REDACTED:nsec]')
    .replace(HEX_KEY_RE, '[REDACTED:hex64]')
    .replace(PHONE_RE, '[REDACTED:PHONE]')
    .replace(EMAIL_RE, '[REDACTED:EMAIL]')
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key) || NAME_KEY_RE.test(key)
}

function redactInner(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return redactString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) {
    return { errName: value.name, errMsg: redactString(value.message) }
  }
  if (typeof value !== 'object') return String(value)

  if (seen.has(value as object)) return '[circular]'
  seen.add(value as object)

  if (depth > MAX_REDACT_DEPTH) return '[truncated:depth]'

  if (Array.isArray(value)) {
    return value.map((v) => redactInner(v, depth + 1, seen))
  }

  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (isSensitiveKey(k)) {
      out[k] = '[REDACTED]'
    } else {
      try {
        out[k] = redactInner(v, depth + 1, seen)
      } catch {
        out[k] = '[redact-error]'
      }
    }
  }
  return out
}

/** Walks value up to depth 3, redacting sensitive keys and string patterns. */
export function redact<T>(value: T): T {
  return redactInner(value, 0, new WeakSet()) as T
}

// ---------------------------------------------------------------------------
// Rate limiting (token bucket per namespace+level)
// ---------------------------------------------------------------------------

interface Bucket {
  tokens: number
  windowStart: number
  suppressed: number
}

interface OverflowSummary {
  namespace: string
  level: LogLevel
  suppressed: number
}

interface RateLimiter {
  check(namespace: string, level: LogLevel): boolean
  drainOverflows(): OverflowSummary[]
}

function createRateLimiter(limits: Required<RateLimits>, clock: () => number = Date.now): RateLimiter {
  const buckets = new Map<string, Bucket>()

  function key(ns: string, level: LogLevel) {
    return `${ns}|${level}`
  }

  function getBucket(ns: string, level: LogLevel): Bucket {
    const k = key(ns, level)
    let b = buckets.get(k)
    const now = clock()
    if (!b) {
      b = { tokens: limits[level], windowStart: now, suppressed: 0 }
      buckets.set(k, b)
    } else if (now - b.windowStart >= 1000) {
      b.tokens = limits[level]
      b.windowStart = now
    }
    return b
  }

  return {
    check(namespace, level) {
      const b = getBucket(namespace, level)
      if (b.tokens === Number.POSITIVE_INFINITY) return true
      if (b.tokens > 0) {
        b.tokens -= 1
        return true
      }
      b.suppressed += 1
      return false
    },
    drainOverflows() {
      const out: OverflowSummary[] = []
      for (const [k, b] of buckets) {
        if (b.suppressed > 0) {
          const [namespace, level] = k.split('|') as [string, LogLevel]
          out.push({ namespace, level, suppressed: b.suppressed })
          b.suppressed = 0
        }
      }
      return out
    },
  }
}

let rateLimiter: RateLimiter = createRateLimiter(config.rateLimits)

// ---------------------------------------------------------------------------
// Circular reference safe JSON stringify
// ---------------------------------------------------------------------------

function circularReplacer() {
  const seen = new WeakSet<object>()
  return (_: string, value: unknown) => {
    if (value !== null && typeof value === 'object') {
      if (seen.has(value as object)) return '[circular]'
      seen.add(value as object)
    }
    return value
  }
}

// ---------------------------------------------------------------------------
// Core emit
// ---------------------------------------------------------------------------

interface UnwrappedError {
  errName: string
  errMsg: string
  stack?: string
}

function unwrapError(err: unknown, stripStacks: boolean): UnwrappedError {
  if (err instanceof Error) {
    const base: UnwrappedError = { errName: err.name, errMsg: err.message }
    if (!stripStacks) base.stack = err.stack
    return base
  }
  return { errName: 'Unknown', errMsg: String(err) }
}

function emit(entry: Record<string, unknown>, level: LogLevel): void {
  try {
    const line = `${JSON.stringify(entry, circularReplacer())}\n`
    if (level === 'error' || level === 'fatal') process.stderr.write(line)
    else process.stdout.write(line)
  } catch (emitErr) {
    const safeNamespace = typeof entry.namespace === 'string' ? entry.namespace : 'unknown'
    const safeMsg = typeof entry.message === 'string' ? entry.message.slice(0, 100) : 'unknown'
    process.stderr.write(
      `{"level":"error","namespace":"logger","message":"emit failed","failedNamespace":"${safeNamespace}","failedMsg":"${safeMsg}","error":"${emitErr instanceof Error ? emitErr.message : String(emitErr)}"}\n`
    )
  }
}

function buildEntry(
  level: LogLevel,
  namespace: string,
  message: string,
  extra?: Record<string, unknown>
): Record<string, unknown> {
  const correlation = getCorrelation()
  const redactedExtra = extra ? redact(extra) : {}

  return {
    timestamp: new Date().toISOString(),
    level,
    namespace,
    message,
    ...correlation,
    ...redactedExtra,
  }
}

function write(level: LogLevel, namespace: string, message: string, extra?: Record<string, unknown>): void {
  if (!levelAllowed(level)) return
  if (!namespaceAllowed(namespace)) return
  if (!rateLimiter.check(namespace, level)) return

  emit(buildEntry(level, namespace, message, extra), level)
}

// ---------------------------------------------------------------------------
// Public Logger interface
// ---------------------------------------------------------------------------

export interface Logger {
  trace: (msg: string, extra?: Record<string, unknown>) => void
  debug: (msg: string, extra?: Record<string, unknown>) => void
  info: (msg: string, extra?: Record<string, unknown>) => void
  warn: (msg: string, extra?: Record<string, unknown>) => void
  error: (msg: string, errOrExtra?: Error | Record<string, unknown> | unknown, extra?: Record<string, unknown> | unknown) => void
  fatal: (msg: string, errOrExtra?: Error | Record<string, unknown> | unknown, extra?: Record<string, unknown> | unknown) => void
  child: (context: Record<string, unknown>) => Logger
}

function buildLogger(namespace: string, boundContext: Record<string, unknown>): Logger {
  function log(level: LogLevel, msg: string, extra?: Record<string, unknown>) {
    write(level, namespace, msg, { ...boundContext, ...extra })
  }

  return {
    trace: (msg: string, extra?: Record<string, unknown>) => log('trace', msg, extra),
    debug: (msg: string, extra?: Record<string, unknown>) => log('debug', msg, extra),
    info: (msg: string, extra?: Record<string, unknown>) => log('info', msg, extra),
    warn: (msg: string, extra?: Record<string, unknown>) => log('warn', msg, extra),
    error: (msg: string, errOrExtra?: unknown, maybeExtra?: Record<string, unknown> | unknown) => {
      let errorFields: UnwrappedError | undefined
      let extraFields: Record<string, unknown> = {} as Record<string, unknown>

      if (errOrExtra instanceof Error) {
        errorFields = unwrapError(errOrExtra, config.stripStacks)
        extraFields = (maybeExtra as Record<string, unknown>) ?? ({} as Record<string, unknown>)
      } else if (
        errOrExtra !== null &&
        errOrExtra !== undefined &&
        typeof errOrExtra === 'object' &&
        !Array.isArray(errOrExtra)
      ) {
        extraFields = errOrExtra as Record<string, unknown>
      } else if (errOrExtra !== undefined && errOrExtra !== null) {
        errorFields = unwrapError(errOrExtra, config.stripStacks)
        extraFields = (maybeExtra as Record<string, unknown>) ?? ({} as Record<string, unknown>)
      } else {
        extraFields = (maybeExtra as Record<string, unknown>) ?? ({} as Record<string, unknown>)
      }

      log('error', msg, { ...extraFields, ...(errorFields ?? {}) })
    },
    fatal: (msg: string, errOrExtra?: unknown, maybeExtra?: Record<string, unknown> | unknown) => {
      let errorFields: UnwrappedError | undefined
      let extraFields: Record<string, unknown> = {} as Record<string, unknown>

      if (errOrExtra instanceof Error) {
        errorFields = unwrapError(errOrExtra, config.stripStacks)
        extraFields = (maybeExtra as Record<string, unknown>) ?? ({} as Record<string, unknown>)
      } else if (
        errOrExtra !== null &&
        errOrExtra !== undefined &&
        typeof errOrExtra === 'object' &&
        !Array.isArray(errOrExtra)
      ) {
        extraFields = errOrExtra as Record<string, unknown>
      } else if (errOrExtra !== undefined && errOrExtra !== null) {
        errorFields = unwrapError(errOrExtra, config.stripStacks)
        extraFields = (maybeExtra as Record<string, unknown>) ?? ({} as Record<string, unknown>)
      } else {
        extraFields = (maybeExtra as Record<string, unknown>) ?? ({} as Record<string, unknown>)
      }

      log('fatal', msg, { ...extraFields, ...(errorFields ?? {}) })
    },
    child: (context: Record<string, unknown>) => buildLogger(namespace, { ...boundContext, ...context }),
  } as Logger
}

/**
 * Create a namespaced structured logger.
 *
 * @example
 * const log = createLogger('services.blasts')
 * log.info('Blast sent', { blastId: '123' })
 * // -> {"timestamp":"...","level":"info","namespace":"services.blasts","message":"Blast sent","blastId":"123"}
 *
 * // With async correlation context (propagates automatically to all loggers in the request):
 * withCorrelation({ correlationId: 'xyz', requestId: 'abc' }, () => {
 *   log.info('Handling request')  // automatically includes correlationId + requestId
 * })
 */
export function createLogger(namespace: string): Logger {
  return buildLogger(namespace, {})
}

// ---------------------------------------------------------------------------
// Background overflow drain
// ---------------------------------------------------------------------------

let overflowInterval: ReturnType<typeof setInterval> | undefined

if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'test') {
  overflowInterval = setInterval(() => {
    const summaries = rateLimiter.drainOverflows()
    for (const s of summaries) {
      emit(
        {
          timestamp: new Date().toISOString(),
          level: 'warn',
          namespace: 'logger',
          message: `Suppressed ${s.suppressed} ${s.level} logs for ${s.namespace} in last 10s`,
        },
        'warn'
      )
    }
  }, 10_000)
  overflowInterval.unref?.()
}

export function _clearLoggerOverflowInterval(): void {
  if (overflowInterval) {
    clearInterval(overflowInterval)
    overflowInterval = undefined
  }
}
