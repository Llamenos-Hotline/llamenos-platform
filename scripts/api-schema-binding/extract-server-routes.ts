/**
 * extract-server-routes.ts — deterministically derive the server's full
 * route -> schema binding table by walking the committed Hono route
 * definitions with the TypeScript compiler API. No model involvement, no
 * dependency on the gitignored `packages/protocol/openapi-snapshot.json`
 * (which is written by the dev server on startup and is not a build-time
 * input). To cross-check this tool's output against that snapshot: start the
 * dev server once (`bun run dev:server`) to regenerate it, then diff its
 * `paths` object against `bind-report.ts`'s output for the same routes —
 * there is no automated diff here, this is a manual, occasional sanity
 * check, not something either tool depends on at build time.
 *
 * Algorithm
 * ---------
 * 1. Parse every route file into a per-file graph of:
 *      - Hono router variables (`const x = new Hono()`, including the
 *        `createEntityRouter({...})` factory, whose CRUD routes are
 *        synthesized from its config object rather than walked as calls)
 *      - route registrations on those variables (`x.post('/path', ...)`)
 *      - mounts of one router variable onto another (`x.route('/prefix', y)`)
 *      - the file's export map (default export, named `export const`, and
 *        the recovery-group-style `export default { public, authenticated }`)
 * 2. Parse `apps/worker/app.ts` the same way, plus its import declarations
 *    (local identifier -> module file + exported symbol).
 * 3. BFS from the `app` variable in app.ts, following both intra-file mounts
 *    and import-resolved cross-file mounts, accumulating path prefixes,
 *    until every reachable route is enumerated with its full path.
 *
 * Known limitations (documented, not silently papered over):
 * - A handful of files export more than one router (events.ts,
 *   security-events.ts, recovery-group.ts). Routes are attributed per
 *   variable name, which is precise for these three files as they're
 *   written today, but a file with two identically-named-pattern local
 *   Hono vars sharing routes via a shared helper would not be disambiguated.
 * - Only `validator('json', schema)` is captured as the body schema; query
 *   validators are ignored (out of scope — the client binding report only
 *   asks for request/response *body* types).
 * - A route path built from anything other than a string/template literal
 *   (e.g. a variable) is skipped and counted in the report's "server routes
 *   not statically resolvable" line.
 */
import { existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import {
  calleeName,
  findCalls,
  getObjectProperty,
  lineOf,
  parseFile,
  templateToPattern,
  textOf,
} from './ast-utils'

const WORKER_ROOT = resolve(import.meta.dirname, '../../apps/worker')
const APP_ENTRY = join(WORKER_ROOT, 'app.ts')
// `all` is a real verb for the contract guard (`telephony.all('/wait-music')` answers every method).
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'all'] as const
type HttpMethod = (typeof HTTP_METHODS)[number]

export interface ServerRoute {
  method: HttpMethod
  /** Path relative to the file's own router root, e.g. `/`, `/:id`. */
  localPath: string
  bodySchema?: string
  responses: { status: string; schema: string }[]
  sourceFile: string
  sourceLine: number
  origin: 'direct' | 'entity-router-factory'
}

interface FileGraph {
  /** router-variable-name -> routes registered directly on it */
  varRoutes: Map<string, ServerRoute[]>
  /** router-variable-name -> [{ prefix, targetRef }], targetRef is raw source text of the 2nd .route() arg */
  varMounts: Map<string, { prefix: string; targetRef: string }[]>
  /** export key ('default' | named | 'default.prop') -> local var name */
  exports: Map<string, string>
  /** local import name -> module specifier as written */
  imports: Map<string, { moduleSpecifier: string; importedName: string }>
}

const fileCache = new Map<string, FileGraph>()

function resolveModule(fromFile: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined // only first-party relative route files matter here
  const base = resolve(dirname(fromFile), spec)
  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

function ensureVar(graph: FileGraph, name: string) {
  if (!graph.varRoutes.has(name)) graph.varRoutes.set(name, [])
  if (!graph.varMounts.has(name)) graph.varMounts.set(name, [])
}

/** Extract `{status: {content: {'application/json': {schema: resolver(X)}}}}` pairs from a describeRoute(...) arg. */
function extractResponses(sf: ts.SourceFile, describeRouteArg: ts.Expression): { status: string; schema: string }[] {
  const out: { status: string; schema: string }[] = []
  for (const call of findCalls(describeRouteArg, 'resolver')) {
    const schemaArg = call.arguments[0]
    if (!schemaArg) continue
    // Walk up to the nearest PropertyAssignment whose key looks like a status code.
    let status = '?'
    let node: ts.Node | undefined = call
    while (node && node !== describeRouteArg) {
      if (ts.isPropertyAssignment(node)) {
        const keyText = ts.isNumericLiteral(node.name) || ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)
          ? node.name.text
          : undefined
        if (keyText && /^\d{3}$/.test(keyText)) {
          status = keyText
          break
        }
      }
      node = node.parent
    }
    out.push({ status, schema: textOf(sf, schemaArg) })
  }
  return out
}

/** Extract the `validator('json', X)` schema reference, if this call expression carries one. */
function extractBodySchema(sf: ts.SourceFile, routeCall: ts.CallExpression): string | undefined {
  for (const arg of routeCall.arguments) {
    if (ts.isCallExpression(arg) && calleeName(arg.expression) === 'validator') {
      const kind = arg.arguments[0]
      const schema = arg.arguments[1]
      if (kind && ts.isStringLiteral(kind) && kind.text === 'json' && schema) {
        return textOf(sf, schema)
      }
    }
  }
  return undefined
}

/** Synthesize the CRUD routes a `createEntityRouter({...})` call registers, from its config object literal. */
function synthesizeEntityRouterRoutes(sf: ts.SourceFile, configArg: ts.ObjectLiteralExpression, sourceLine: number, sourceFile: string): ServerRoute[] {
  const get = (key: string) => getObjectProperty(configArg, key)
  const textOrUndef = (expr: ts.Expression | undefined) => expr ? textOf(sf, expr) : undefined
  const boolLiteral = (expr: ts.Expression | undefined) => expr?.kind === ts.SyntaxKind.TrueKeyword

  const idParamExpr = get('idParam')
  const idParam = idParamExpr && ts.isStringLiteral(idParamExpr) ? idParamExpr.text : 'id'
  const disableList = boolLiteral(get('disableList'))
  const disableGet = boolLiteral(get('disableGet'))
  const disableDelete = boolLiteral(get('disableDelete'))
  const listResponseSchema = textOrUndef(get('listResponseSchema'))
  const itemResponseSchema = textOrUndef(get('itemResponseSchema'))
  const createBodySchema = textOrUndef(get('createBodySchema'))
  const updateBodySchema = textOrUndef(get('updateBodySchema'))
  const deleteResponseSchema = textOrUndef(get('deleteResponseSchema')) ?? 'okResponseSchema'

  const routes: ServerRoute[] = []
  const mk = (method: HttpMethod, localPath: string, bodySchema: string | undefined, status: string, schema: string | undefined): ServerRoute => ({
    method,
    localPath,
    bodySchema,
    responses: schema ? [{ status, schema }] : [],
    sourceFile,
    sourceLine,
    origin: 'entity-router-factory',
  })

  if (!disableList) routes.push(mk('get', '/', undefined, '200', listResponseSchema))
  if (!disableGet) routes.push(mk('get', `/:${idParam}`, undefined, '200', itemResponseSchema))
  if (createBodySchema) routes.push(mk('post', '/', createBodySchema, '201', itemResponseSchema))
  if (updateBodySchema) routes.push(mk('patch', `/:${idParam}`, updateBodySchema, '200', itemResponseSchema))
  if (!disableDelete) routes.push(mk('delete', `/:${idParam}`, undefined, '200', deleteResponseSchema))
  return routes
}

function parseRouteFile(filePath: string): FileGraph {
  const cached = fileCache.get(filePath)
  if (cached) return cached

  const sf = parseFile(filePath)
  const graph: FileGraph = { varRoutes: new Map(), varMounts: new Map(), exports: new Map(), imports: new Map() }
  fileCache.set(filePath, graph) // set before recursing to guard against (theoretical) import cycles

  // --- Pass 1: imports ---
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue
    const spec = stmt.moduleSpecifier.text
    const clause = stmt.importClause
    if (!clause) continue
    if (clause.name) graph.imports.set(clause.name.text, { moduleSpecifier: spec, importedName: 'default' })
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        const importedName = (el.propertyName ?? el.name).text
        graph.imports.set(el.name.text, { moduleSpecifier: spec, importedName })
      }
    }
  }

  // --- Pass 2: top-level `const x = new Hono(...)` / `const x = createEntityRouter({...})` declarations ---
  const isHonoNew = (init: ts.Expression): init is ts.NewExpression =>
    ts.isNewExpression(init) && calleeName(init.expression as ts.LeftHandSideExpression) === 'Hono'
  const isEntityFactory = (init: ts.Expression): init is ts.CallExpression =>
    ts.isCallExpression(init) && calleeName(init.expression) === 'createEntityRouter'

  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name)) {
      const varName = n.name.text
      const init = n.initializer
      if (isHonoNew(init)) {
        ensureVar(graph, varName)
      } else if (isEntityFactory(init)) {
        ensureVar(graph, varName)
        const configArg = init.arguments[0]
        if (configArg && ts.isObjectLiteralExpression(configArg)) {
          graph.varRoutes.get(varName)!.push(
            ...synthesizeEntityRouterRoutes(sf, configArg, lineOf(sf, n), relative(process.cwd(), filePath)),
          )
        }
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)

  // --- Pass 3: direct route registrations (`x.get('/path', ...)`) and mounts (`x.route('/prefix', y)`) ---
  const visitCalls = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const objExpr = n.expression.expression
      const method = n.expression.name.text
      if (ts.isIdentifier(objExpr) && graph.varRoutes.has(objExpr.text)) {
        const varName = objExpr.text
        if (method === 'route') {
          const [prefixArg, targetArg] = n.arguments
          const prefix = prefixArg ? templateToPattern(prefixArg) : undefined
          if (prefix !== undefined && targetArg) {
            graph.varMounts.get(varName)!.push({ prefix, targetRef: textOf(sf, targetArg) })
          }
        } else if ((HTTP_METHODS as readonly string[]).includes(method)) {
          const pathArg = n.arguments[0]
          const localPath = pathArg ? templateToPattern(pathArg) : undefined
          if (localPath !== undefined) {
            const describeCall = n.arguments.find(
              (a): a is ts.CallExpression => ts.isCallExpression(a) && calleeName(a.expression) === 'describeRoute',
            )
            const responses = describeCall?.arguments[0] ? extractResponses(sf, describeCall.arguments[0]) : []
            graph.varRoutes.get(varName)!.push({
              method: method as HttpMethod,
              localPath,
              bodySchema: extractBodySchema(sf, n),
              responses,
              sourceFile: relative(process.cwd(), filePath),
              sourceLine: lineOf(sf, n),
              origin: 'direct',
            })
          }
        }
      }
    }
    ts.forEachChild(n, visitCalls)
  }
  visitCalls(sf)

  // --- Pass 4: export map ---
  for (const stmt of sf.statements) {
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      // `export default X` or `export default { a: X, b: Y }`
      if (ts.isIdentifier(stmt.expression)) {
        graph.exports.set('default', stmt.expression.text)
      } else if (ts.isObjectLiteralExpression(stmt.expression)) {
        for (const prop of stmt.expression.properties) {
          if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && ts.isIdentifier(prop.initializer)) {
            graph.exports.set(`default.${prop.name.text}`, prop.initializer.text)
          }
        }
      }
    }
    if (ts.isVariableStatement(stmt) && stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && graph.varRoutes.has(decl.name.text)) {
          graph.exports.set(decl.name.text, decl.name.text)
        }
      }
    }
  }

  return graph
}

export interface ResolvedServerRoute extends ServerRoute {
  fullPath: string
  /**
   * True when this path was reached by crossing the `/hubs/:hubId` hub-scoping wrapper
   * (`authenticated.route('/hubs/:hubId', hubScoped)`) rather than being the hubs
   * resource's own route. Path SHAPE alone can't tell these apart — `/hubs/:hubId/members`
   * is a hubs.ts route, `/hubs/:hubId/users` is `usersRoutes` reached through the wrapper —
   * so the binder needs this flag, set from the actual mount graph, to know which routes
   * have a schema-identical non-hub-scoped twin to collapse onto.
   */
  viaHubScopeWrapper: boolean
}

/** The one mount edge in app.ts whose prefix wraps every hub-scoped router underneath it. */
const HUB_SCOPE_WRAPPER_PREFIX_PATTERN = /^\/hubs\/:[^/]+$/

/** Resolve a `.route()` target expression's source text (e.g. `x` or `x.public`) to a local var name inside `file`. */
function resolveTargetInFile(file: string, graph: FileGraph, targetRef: string): { file: string; varName: string } | undefined {
  const [head, prop] = targetRef.split('.')
  if (graph.varRoutes.has(head) && !prop) return { file, varName: head }

  const imported = graph.imports.get(head)
  if (!imported) return undefined
  const targetFile = resolveModule(file, imported.moduleSpecifier)
  if (!targetFile) return undefined
  const targetGraph = parseRouteFile(targetFile)
  const exportKey = prop ? `${imported.importedName}.${prop}` : imported.importedName
  const varName = targetGraph.exports.get(exportKey)
  if (!varName) return undefined
  return { file: targetFile, varName }
}

function joinPath(prefix: string, suffix: string): string {
  const joined = `${prefix}/${suffix}`.replace(/\/{2,}/g, '/')
  return joined.length > 1 ? joined.replace(/\/$/, '') || '/' : joined
}

export function extractServerRoutes(): { routes: ResolvedServerRoute[]; unresolvedMounts: string[] } {
  const routes: ResolvedServerRoute[] = []
  const unresolvedMounts: string[] = []
  const visited = new Set<string>()

  function walk(file: string, varName: string, prefix: string, viaHubScopeWrapper: boolean) {
    const key = `${file}#${varName}#${prefix}`
    if (visited.has(key)) return
    visited.add(key)

    const graph = parseRouteFile(file)
    for (const route of graph.varRoutes.get(varName) ?? []) {
      routes.push({ ...route, fullPath: joinPath(prefix, route.localPath), viaHubScopeWrapper })
    }
    for (const mount of graph.varMounts.get(varName) ?? []) {
      const target = resolveTargetInFile(file, graph, mount.targetRef)
      if (!target) {
        unresolvedMounts.push(`${relative(process.cwd(), file)}: ${varName}.route('${mount.prefix}', ${mount.targetRef}) — could not resolve target`)
        continue
      }
      const crossesWrapper = viaHubScopeWrapper || HUB_SCOPE_WRAPPER_PREFIX_PATTERN.test(mount.prefix)
      walk(target.file, target.varName, joinPath(prefix, mount.prefix), crossesWrapper)
    }
  }

  walk(APP_ENTRY, 'app', '', false)
  return { routes, unresolvedMounts }
}
