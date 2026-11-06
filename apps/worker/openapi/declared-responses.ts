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
 * It also CONFORMS the response before judging it — see `conformBody`. The
 * server's persistence layer speaks `null` for "no value" (a nullable column);
 * the protocol schemas speak "absent" (`.optional()`), and Swift/Kotlin are
 * generated from the schema. Every route that returned a raw row crossed that
 * gap on its own, so most of the first 78 ledger entries were the same
 * `null`-where-absent defect repeated per route (#2521). The one place that
 * sees both the body and the declaration is here, so the translation lives
 * here: a `null` the schema rejects, where dropping the key makes the schema
 * accept it, is sent as an absent key. A `null` the schema ACCEPTS
 * (`.nullable()`) is never touched, and a `null` in a required field stays and
 * is reported — the server has no value to send, which is a real violation.
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
 *    production must not turn a schema drift into an outage. Conforming still
 *    runs (only on a body containing a `null`): it is how the response gets
 *    its declared shape, not a check on it.
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

function issueSegments(issue: SchemaIssue): PropertyKey[] {
  return (issue.path ?? []).map(seg => (typeof seg === 'object' && seg !== null ? seg.key : seg))
}

function issuePath(issue: SchemaIssue): string {
  return issueSegments(issue).map(String).join('.')
}

function isPlainObject(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The object holding the value at `path`, and the key it sits under. */
function locate(body: unknown, path: readonly PropertyKey[]): { parent: Record<PropertyKey, unknown>; key: PropertyKey } | undefined {
  if (path.length === 0) return undefined
  let parent: unknown = body
  for (const seg of path.slice(0, -1)) {
    if (typeof parent !== 'object' || parent === null) return undefined
    parent = (parent as Record<PropertyKey, unknown>)[seg]
  }
  if (!isPlainObject(parent)) return undefined
  return { parent, key: path[path.length - 1] }
}

/** Dropping `null`s the schema rejects can expose more of them one level in. */
const MAX_CONFORM_PASSES = 8

/**
 * Translate persistence `null` into the protocol's "absent", driven by the
 * schema itself. Validates `body`; for every issue sitting on a `null` object
 * member, drops the key and validates again. A drop that did not satisfy the
 * schema (the field is required, so absent is no better than `null`) is
 * undone, leaving the body as the route sent it and the issue reported.
 *
 * Mutates `body` in place. Returns the issues that remain and whether any
 * key stayed dropped.
 */
export async function conformBody(validate: Validate, body: unknown): Promise<{ issues: readonly SchemaIssue[]; conformed: boolean }> {
  const dropped: { parent: Record<PropertyKey, unknown>; key: PropertyKey; path: string }[] = []
  let result = await validate(body)
  for (let pass = 0; pass < MAX_CONFORM_PASSES && result.issues?.length; pass++) {
    let progressed = false
    for (const issue of result.issues) {
      const segments = issueSegments(issue)
      const at = locate(body, segments)
      if (at && at.parent[at.key] === null) {
        delete at.parent[at.key]
        dropped.push({ ...at, path: segments.map(String).join('.') })
        progressed = true
      }
    }
    if (!progressed) break
    result = await validate(body)
  }
  if (result.issues?.length && dropped.length > 0) {
    const failing = new Set(result.issues.map(issuePath))
    const useless = dropped.filter(d => failing.has(d.path))
    for (const d of useless) d.parent[d.key] = null
    if (useless.length > 0) result = await validate(body)
    return { issues: result.issues ?? [], conformed: dropped.length > useless.length }
  }
  return { issues: result.issues ?? [], conformed: dropped.length > 0 }
}

/** A copy of `res` carrying `body`, with every header but the now-wrong length. */
function withBody(res: Response, body: unknown): Response {
  const headers = new Headers(res.headers)
  headers.delete('content-length')
  return new Response(JSON.stringify(body), { status: res.status, statusText: res.statusText, headers })
}

/**
 * Conform the finished response to the schema its route declared for its
 * status (replacing `c.res` when keys were dropped), then judge it. Undefined
 * when it conforms, when the route declared nothing for this status, or when
 * the body is not JSON. `report` is false in `off` mode, which conforms but
 * does not judge.
 */
export async function checkDeclaredResponse(c: Context, opts: { report?: boolean } = {}): Promise<ResponseViolation | undefined> {
  const report = opts.report ?? true
  const res = c.res
  if (!res.headers.get('content-type')?.includes('application/json')) return undefined
  const declared = declaredResponse(c, res.status)
  if (!declared) return undefined
  const where = { method: c.req.method, route: declared.route, status: res.status }
  if (!declared.validate) {
    return report
      ? { ...where, issues: [{ path: '', message: 'route declares a JSON response schema that registerDeclaredResponses never captured' }] }
      : undefined
  }

  let text: string
  try {
    text = await res.clone().text()
  } catch {
    return report ? { ...where, issues: [{ path: '', message: 'body is not valid JSON' }] } : undefined
  }
  // Without a `null` anywhere there is nothing to conform; when only
  // conforming (production) there is nothing to do.
  if (!report && !text.includes('null')) return undefined
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return report ? { ...where, issues: [{ path: '', message: 'body is not valid JSON' }] } : undefined
  }

  const { issues, conformed } = await conformBody(declared.validate, body)
  if (conformed) c.res = withBody(res, body)
  if (!report || issues.length === 0) return undefined
  return { ...where, issues: issues.map(i => ({ path: issuePath(i), message: i.message })) }
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
    const violation = await checkDeclaredResponse(c, { report: mode !== 'off' })
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
