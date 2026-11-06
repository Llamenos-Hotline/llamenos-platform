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
 * Modes (`RESPONSE_CONTRACT`):
 *  - `enforce` — a violating response is replaced by a 500 naming the route and
 *    the failing paths, so a test that exercises the route fails on it.
 *  - `report`  — the violation is logged and the response passes unchanged.
 *  - `off`     — nothing is checked.
 * Unset, it is `enforce` everywhere but production, where it is `off`: the check
 * is a development and test instrument, and production must not turn a schema
 * drift into an outage. See `responseContractMode`.
 */
import type { Context, MiddlewareHandler } from 'hono'
import { matchedRoutes } from 'hono/route'
import { findTargetHandler } from 'hono/utils/handler'
import { uniqueSymbol } from 'hono-openapi'
import { createLogger } from '../lib/logger'

const logger = createLogger('openapi.declared-responses')

export type ResponseContractMode = 'enforce' | 'report' | 'off'

const MODES: readonly ResponseContractMode[] = ['enforce', 'report', 'off']

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

interface DeclaredResponse {
  validate: Validate
  /** The route pattern that declared it, e.g. `/api/hubs/:hubId/conversations`. */
  route: string
}

export function responseContractMode(env: { ENVIRONMENT?: string; RESPONSE_CONTRACT?: string }): ResponseContractMode {
  const configured = env.RESPONSE_CONTRACT
  if (configured !== undefined && configured !== '') {
    if (!(MODES as readonly string[]).includes(configured)) {
      throw new Error(`RESPONSE_CONTRACT must be one of ${MODES.join(', ')}; got "${configured}"`)
    }
    return configured as ResponseContractMode
  }
  return env.ENVIRONMENT === 'production' ? 'off' : 'enforce'
}

/**
 * The schema the matched route declared for `status` as `application/json`,
 * or undefined when it declared none. When several matched handlers describe
 * the route (a sub-router's and the leaf's), the innermost — last matched —
 * wins, as it does in the OpenAPI document.
 */
export function declaredResponse(c: Context, status: number): DeclaredResponse | undefined {
  let found: DeclaredResponse | undefined
  for (const route of matchedRoutes(c)) {
    const described = (findTargetHandler(route.handler) as { [uniqueSymbol]?: DescribedRoute })[uniqueSymbol]
    const validate = described?.spec?.responses?.[String(status)]?.content?.['application/json']?.schema?.validate
    if (validate) found = { validate, route: route.path }
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
 * Mount once, ahead of every route (`api.use('*', enforceDeclaredResponses())`).
 * The mode is read per request from `c.env`, so a test can set it per app.
 */
export function enforceDeclaredResponses(): MiddlewareHandler {
  return async (c, next) => {
    await next()
    const mode = responseContractMode(c.env ?? {})
    if (mode === 'off') return
    const violation = await checkDeclaredResponse(c)
    if (!violation) return
    logger.error('Response does not satisfy its declared schema', { ...violation })
    if (mode === 'enforce') {
      c.res = c.json({ error: 'Response does not satisfy its declared schema', violation }, 500)
    }
  }
}
