import { createMiddleware } from 'hono/factory'
import { matchedRoutes } from 'hono/route'
import type { AppEnv } from '../types'
import { withCorrelation } from '../lib/logger'
import { createLogger } from '../lib/logger'

const logger = createLogger('request-logger')

export const requestLogger = createMiddleware<AppEnv>(async (c, next) => {
  const incoming = c.req.header('X-Request-Id')
  const id = incoming ?? crypto.randomUUID()

  c.set('requestId', id)

  const method = c.req.method
  // The matched route pattern, never the URL: `/api/calls/:callId/answer` carries the provider's
  // identifier for the call, which joins to the provider's CDR and its caller's number (#2333).
  // An unmatched request logs its wildcard (`/api/*`), so a scanner's URL is not echoed either.
  const path = matchedRoutes(c).at(-1)?.path ?? '[unrouted]'

  logger.info('Request started', { method, path, correlationId: id, requestId: id })

  const t0 = performance.now()

  await withCorrelation({ correlationId: id, requestId: id }, async () => {
    await next()
  })

  const durationMs = Math.round(performance.now() - t0)
  const status = c.res.status

  logger.info('Request completed', { method, path, status, durationMs, correlationId: id, requestId: id })

  c.header('X-Request-Id', id)
})
