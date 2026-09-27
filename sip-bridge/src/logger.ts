/**
 * Structured logger for sip-bridge with level-based filtering.
 * Respects the LOG_LEVEL environment variable (debug | info | warn | error).
 * Default level is 'info'.
 *
 * This logger deals in plain message strings (not structured key/value
 * extras like apps/worker/lib/logger.ts), so redaction here is pattern-based
 * over the final formatted string rather than key-based. A debug flag must
 * not be a privacy switch: `LOG_LEVEL=debug` is the single most likely
 * production troubleshooting step, so caller phone numbers must never reach
 * this logger unredacted at ANY level, not just the ones enabled by default.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const currentLevel = (process.env.LOG_LEVEL as LogLevel) ?? 'info'
const currentLevelNum = LOG_LEVELS[currentLevel] ?? LOG_LEVELS.info

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= currentLevelNum
}

function formatMessage(level: LogLevel, prefix: string, message: string): string {
  const ts = new Date().toISOString()
  return `[${ts}] [${level.toUpperCase()}] ${prefix} ${message}`
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

// ---------------------------------------------------------------------------
// Redaction — same E.164-aware phone matching as apps/worker/lib/logger.ts
// (duplicated deliberately: sip-bridge is a dependency-free package that
// must not import across the apps/worker package boundary).
// ---------------------------------------------------------------------------

const PHONE_RE = /\+\d{7,15}\b|\(?\d{2,4}\)?(?:[\s.-]\d{2,4}){1,4}\b|\b\d{7,15}\b/g
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g

function redactMessage(message: string): string {
  return message.replace(PHONE_RE, '[REDACTED:PHONE]').replace(EMAIL_RE, '[REDACTED:EMAIL]')
}

export const logger = {
  debug(prefix: string, message: string, err?: unknown): void {
    if (shouldLog('debug')) {
      const full = err !== undefined ? `${message} — ${formatError(err)}` : message
      console.debug(formatMessage('debug', prefix, redactMessage(full)))
    }
  },

  info(prefix: string, message: string, err?: unknown): void {
    if (shouldLog('info')) {
      const full = err !== undefined ? `${message} — ${formatError(err)}` : message
      console.info(formatMessage('info', prefix, redactMessage(full)))
    }
  },

  warn(prefix: string, message: string, err?: unknown): void {
    if (shouldLog('warn')) {
      const full = err !== undefined ? `${message} — ${formatError(err)}` : message
      console.warn(formatMessage('warn', prefix, redactMessage(full)))
    }
  },

  error(prefix: string, message: string, err?: unknown): void {
    if (shouldLog('error')) {
      const full = err !== undefined ? `${message} — ${formatError(err)}` : message
      console.error(formatMessage('error', prefix, redactMessage(full)))
    }
  },
}
