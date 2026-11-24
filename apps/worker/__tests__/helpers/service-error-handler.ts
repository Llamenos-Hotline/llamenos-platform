import type { Context } from 'hono'
import { ServiceError } from '../../services/service-error'

/**
 * `app.onError` for a route test app: the same mapping as the app's global
 * handler (`app.ts`) — a `ServiceError` carries its own status, anything else is
 * a 500 — so a guard that throws one is observable as the status a client sees.
 */
export function serviceErrorHandler(err: Error, c: Context) {
  return err instanceof ServiceError
    ? c.json({ error: err.message }, err.status as 400 | 403 | 404 | 422 | 503)
    : c.json({ error: 'Internal server error' }, 500)
}
