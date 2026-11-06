/**
 * Declared-response enforcement (#2118).
 *
 * `describeRoute({ responses: { 200: { content: { 'application/json': { schema:
 * resolver(x) } } } } })` is the server's promise of what a route returns, and it
 * is the promise the clients are generated from: the same Zod schema becomes the
 * Kotlin `@Serializable` and Swift `Codable` types. hono-openapi uses it only to
 * WRITE the OpenAPI document — it never checks a response against it. Nothing
 * else did either: the endpoint-contract guard matches client calls to mounted
 * routes by method and path, the binding report checks the client's TypeScript
 * types against the declared schema, and the response-conformance test covers a
 * hand-picked list of routes. So `GET /hubs/:hubId/conversations` shipped
 * `{conversations, total}` against a schema requiring `page` and `limit`, and
 * Android's decoder threw on every call.
 *
 * This middleware closes that gap for every route at once. After the handler
 * runs it looks up the schema the matched route declared for the response's
 * status and validates the body against it — the same `validate` function
 * `resolver()` already carries. A new route is covered the moment it declares a
 * schema; nothing has to remember to add it to a list.
 *
 * The validators are CAPTURED once, by `registerDeclaredResponses(app)` after
 * every route is mounted, and never read from the spec at request time: the
 * first OpenAPI generation (the dev server writes the snapshot at startup)
 * replaces each `resolver()` object in the spec with its JSON Schema, in
 * place, and the `validate` with it. Read live, the check went blind before the
 * first request it was meant to judge. A described route that was never
 * captured is reported as a violation of its own, so the check cannot go blind
 * that way again without saying so.
 *
 * What a violation does, per request:
 *  - `enforce` — the response is replaced by a 500 naming the route and the
 *    failing paths, so the test that exercised the route fails on it. A
 *    request asks for this with `X-Declared-Response-Check: enforce`; the
 *    backend BDD suite sends it on every request (playwright.config.ts), so any
 *    route a scenario touches is held to its schema.
 *  - `report` — logged at error level, response unchanged. Every other
 *    request outside production: the desktop and mobile E2E suites exercise
 *    routes the backend suite does not, and their violations have not been
 *    measured yet, so they are reported rather than failed.
 *  - `off` — production. The check is a development and test instrument;
 *    production must not turn a schema drift into an outage.
 * A violation listed in `declared-response-ledger.ts` — measured when this
 * check landed, each owned by an issue — is logged as a warning and passes in
 * every mode, so the ledger can only shrink.
 */
import type { Context, MiddlewareHandler } from 'hono'
import { matchedRoutes } from 'hono/route'
import { findTargetHandler } from 'hono/utils/handler'
import { uniqueSymbol } from 'hono-openapi'
import { createLogger } from '../lib/logger'
import { knownViolation } from './declared-response-ledger'

const logger = createLogger('openapi.declared-responses')

/**
 * The Standard Schema `validate` that `resolver()` carries (the `~standard`
 * interface every Zod schema implements), narrowed to what is read here.
 */
type Validate = (value: unknown) =>
  | { issues?: readonly SchemaIssue[] }
  | Promise<{ issues?: readonly SchemaIssue[] }>

interface SchemaIssue {
  message: string
  path?: readonly (PropertyKey | { key: PropertyKey })[]
}

/** What `describeRoute` attaches to its middleware under `uniqueSymbol`. */
interface DescribedRoute {
  spec?: {
    responses?: Record<string, {
      content?: Record<string, { schema?: { validate?: Validate } }>
    }>
  }
}

/** status → the `application/json` validator declared for it. */
type DeclaredByStatus = ReadonlyMap<string, Validate>

/**
 * Keyed by the `describeRoute` middleware itself — Hono keeps that function
 * object when `route()` copies a sub-app's routes into its parent, so the key
 * survives every mount.
 */
const captured = new WeakMap<object, DeclaredByStatus>()

function describedSpec(handler: unknown): DescribedRoute['spec'] | undefined {
  const target = findTargetHandler(handler as Parameters<typeof findTargetHandler>[0]) as { [uniqueSymbol]?: DescribedRoute }
  return target[uniqueSymbol]?.spec
}

function hasJsonResponse(spec: NonNullable<DescribedRoute['spec']>): boolean {
  return Object.values(spec.responses ?? {}).some(r => r?.content?.['application/json']?.schema !== undefined)
}

/**
 * Capture the response validators of every route `app` serves. Call once,
 * after the last route is mounted and before anything can generate the
 * OpenAPI document. Idempotent; returns how many of `app`'s routes are
 * covered (declared at least one JSON response schema, now captured).
 *
 * Throws when a route's declaration has already lost its validator: capturing
 * after generation would leave the check silently blind.
 */
export function registerDeclaredResponses(app: { routes: readonly { handler: unknown; method: string; path: string }[] }): number {
  let routes = 0
  for (const route of app.routes) {
    const target = findTargetHandler(route.handler as Parameters<typeof findTargetHandler>[0])
    if (captured.has(target)) {
      routes++
      continue
    }
    const spec = describedSpec(route.handler)
    if (!spec?.responses) continue
    const byStatus = new Map<string, Validate>()
    for (const [status, response] of Object.entries(spec.responses)) {
      const schema = response?.content?.['application/json']?.schema
      if (schema === undefined) continue
      if (typeof schema.validate !== 'function') {
        throw new Error(
          `${route.method} ${route.path} declares a ${status} JSON schema with no validator — ` +
          'registerDeclaredResponses must run before the OpenAPI document is generated',
        )
      }
      byStatus.set(status, schema.validate)
    }
    if (byStatus.size === 0) continue
    captured.set(target, byStatus)
    routes++
  }
  return routes
}

export type DeclaredResponseMode = 'enforce' | 'report' | 'off'

/** The request header that asks for `enforce`. */
export const DECLARED_RESPONSE_CHECK_HEADER = 'X-Declared-Response-Check'

export function declaredResponseMode(c: Context): DeclaredResponseMode {
  if ((c.env as { ENVIRONMENT?: string } | undefined)?.ENVIRONMENT === 'production') return 'off'
  return c.req.header(DECLARED_RESPONSE_CHECK_HEADER) === 'enforce' ? 'enforce' : 'report'
}

/**
 * Every (method, route, status) of `app` with a captured JSON response schema —
 * the routes the check can judge. Used to keep the ledger honest.
 */
export function listDeclaredResponses(app: { routes: readonly { handler: unknown; method: string; path: string }[] }): { method: string; route: string; status: number }[] {
  const out: { method: string; route: string; status: number }[] = []
  for (const route of app.routes) {
    const byStatus = captured.get(findTargetHandler(route.handler as Parameters<typeof findTargetHandler>[0]))
    if (!byStatus) continue
    for (const status of byStatus.keys()) out.push({ method: route.method, route: route.path, status: Number(status) })
  }
  return out
}

interface DeclaredResponse {
  /** Undefined when the route declared a JSON schema that was never captured. */
  validate: Validate | undefined
  /** The route pattern that declared it, e.g. `/api/hubs/:hubId/conversations`. */
  route: string
}

/**
 * The schema the route that answered declared for `status` as
 * `application/json`, or undefined when it declared none.
 *
 * `matchedRoutes` lists every route whose PATTERN matches — `GET /stats` also
 * matches `GET /:id` registered after it — so only the routes the request was
 * actually dispatched through count: those up to `c.req.routeIndex`, which,
 * once `next()` has returned, is the handler that produced the response. Among
 * those, the innermost declaration wins, as it does in the OpenAPI document.
 */
export function declaredResponse(c: Context, status: number): DeclaredResponse | undefined {
  let found: DeclaredResponse | undefined
  for (const route of matchedRoutes(c).slice(0, c.req.routeIndex + 1)) {
    const target = findTargetHandler(route.handler)
    const byStatus = captured.get(target)
    if (byStatus) {
      const validate = byStatus.get(String(status))
      if (validate) found = { validate, route: route.path }
      continue
    }
    const spec = describedSpec(route.handler)
    if (spec && hasJsonResponse(spec)) found = { validate: undefined, route: route.path }
  }
  return found
}

export interface ResponseViolation {
  method: string
  /** The route pattern, not the concrete path — no ids in logs. */
  route: string
  status: number
  issues: { path: string; message: string }[]
}

function issuePath(issue: SchemaIssue): string {
  return (issue.path ?? [])
    .map(seg => String(typeof seg === 'object' && seg !== null ? seg.key : seg))
    .join('.')
}

/**
 * Check one finished response against its route's declaration. Undefined when
 * it conforms, when the route declared nothing for this status, or when the
 * body is not JSON.
 */
export async function checkDeclaredResponse(c: Context): Promise<ResponseViolation | undefined> {
  const res = c.res
  if (!res.headers.get('content-type')?.includes('application/json')) return undefined
  const declared = declaredResponse(c, res.status)
  if (!declared) return undefined
  const where = { method: c.req.method, route: declared.route, status: res.status }
  if (!declared.validate) {
    return { ...where, issues: [{ path: '', message: 'route declares a JSON response schema that registerDeclaredResponses never captured' }] }
  }

  let body: unknown
  try {
    body = await res.clone().json()
  } catch {
    return { ...where, issues: [{ path: '', message: 'body is not valid JSON' }] }
  }
  const result = await declared.validate(body)
  if (!result.issues) return undefined
  return {
    ...where,
    issues: result.issues.map(i => ({ path: issuePath(i), message: i.message })),
  }
}

/**
 * Mount once, ahead of every route (`api.use('*', enforceDeclaredResponses())`),
 * and call `registerDeclaredResponses` on the finished app. `ENVIRONMENT` is
 * read per request from `c.env`, so a test can set it per app.
 */
export function enforceDeclaredResponses(): MiddlewareHandler {
  return async (c, next) => {
    await next()
    const mode = declaredResponseMode(c)
    if (mode === 'off') return
    const violation = await checkDeclaredResponse(c)
    if (!violation) return
    const known = await knownViolation(violation, c.res)
    if (known) {
      logger.warn('Response does not satisfy its declared schema (known)', { ...violation, issue: known.issue })
      return
    }
    logger.error('Response does not satisfy its declared schema', { ...violation, mode })
    if (mode === 'enforce') {
      c.res = c.json({ error: 'Response does not satisfy its declared schema', violation }, 500)
    }
  }
}
