import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../types'
import { isAllowedOrigin } from '../lib/allowed-origins'

const ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS'
const ALLOW_HEADERS = 'Content-Type, Authorization, X-API-Version'
const EXPOSE_HEADERS = 'X-Min-Version, X-Current-Version'
// 2 hours — balances preflight cache hits against policy change propagation
const MAX_AGE = '7200'

export const cors = createMiddleware<AppEnv>(async (c, next) => {
  const requestOrigin = c.req.header('Origin') || ''
  const allowed = isAllowedOrigin(requestOrigin, c.env)

  if (c.req.method === 'OPTIONS') {
    if (!allowed) {
      // Reject preflight for disallowed origins — do not reveal allowed methods or headers
      return new Response(null, {
        status: 403,
        headers: { 'Vary': 'Origin' },
      })
    }
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': requestOrigin,
        'Access-Control-Allow-Methods': ALLOW_METHODS,
        'Access-Control-Allow-Headers': ALLOW_HEADERS,
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Max-Age': MAX_AGE,
        'Vary': 'Origin',
      },
    })
  }

  await next()

  if (allowed) {
    c.header('Access-Control-Allow-Origin', requestOrigin)
    c.header('Access-Control-Allow-Credentials', 'true')
    c.header('Access-Control-Expose-Headers', EXPOSE_HEADERS)
  }
  c.header('Vary', 'Origin')
})
