/**
 * extract-client-calls.ts — deterministically extract, per exported function
 * in `src/client/lib/api.ts` and `src/client/lib/api/**`, the HTTP method,
 * request path, declared body type and declared response type — using the
 * TypeScript compiler API, not regex or a model.
 *
 * A function is only "resolved" here if it follows the two conventions this
 * codebase actually uses:
 *   - the path is a string or template literal, optionally wrapped in `hp(...)`, `activeHubPath(...)` or `hubPath(hubId, ...)`
 *   - the call is `request<T>(path, { method, body })` or, when the generic is
 *     omitted, `request(path, ...)` inside a function with an explicit
 *     `Promise<T>` return type (TypeScript's contextual typing fills in T —
 *     see `testProviderConnection` in provider-setup.ts for a real example)
 *
 * Anything else — raw `netFetch`/`fetch` calls, helpers with no HTTP call at
 * all, a path built from something other than a literal — is reported as
 * UNRESOLVED with the specific reason. That is a feature, not a gap: a
 * fabricated binding is worse than an honest "could not determine this".
 */
import { readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { findCalls, lineOf, parseFile, templateToPattern, textOf } from './ast-utils'

const CLIENT_LIB = resolve(import.meta.dirname, '../../src/client/lib')
const API_MONOLITH = join(CLIENT_LIB, 'api.ts')
const API_DIR = join(CLIENT_LIB, 'api')

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface TypeDescriptor {
  text: string
  isInline: boolean
  /** Top-level member names, when `text` is (or wraps, e.g. `Partial<{...}>`) an object type literal. */
  fields?: string[]
  /** Module specifier this type was imported from, when `text` is a bare imported identifier. */
  importedFrom?: string
}

export interface ClientCall {
  functionName: string
  file: string
  line: number
  method: HttpMethod
  /** Path pattern with `${expr}` substitutions rendered as `:param`, query string stripped. */
  pathPattern: string
  /** Whether a hub-scoping helper wrapped the path — i.e. this call is hub-scope-aware. */
  hubScoped: boolean
  bodyType?: TypeDescriptor
  responseType?: TypeDescriptor
  unresolvedReason?: string
}

/** module specifier -> imported type names, for every `import type {...} from '...'` in the file. */
export type TypeImportMap = Map<string, string>


function apiClientFiles(): string[] {
  const files = [API_MONOLITH]
  for (const entry of readdirSync(API_DIR, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(join(API_DIR, entry.name))
    }
  }
  return files
}

/**
 * Unwrap the hub-scoping helpers to the bare path: `hp(x)`, `activeHubPath(x)` and
 * `hubPath(hubId, x)`. Returns whether the path was wrapped.
 */
function unwrapHp(expr: ts.Expression): { inner: ts.Expression; hubScoped: boolean } {
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
    const name = expr.expression.text
    if ((name === 'hp' || name === 'activeHubPath') && expr.arguments[0]) {
      return { inner: expr.arguments[0], hubScoped: true }
    }
    if (name === 'hubPath' && expr.arguments[1]) {
      return { inner: expr.arguments[1], hubScoped: true }
    }
  }
  return { inner: expr, hubScoped: false }
}

function methodFromOptions(optionsArg: ts.Expression | undefined): HttpMethod {
  if (optionsArg && ts.isObjectLiteralExpression(optionsArg)) {
    for (const prop of optionsArg.properties) {
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === 'method' && ts.isStringLiteral(prop.initializer)) {
        return prop.initializer.text as HttpMethod
      }
    }
  }
  return 'GET'
}

/** Unwrap `Promise<X>` -> X; returns X unchanged if not a Promise type. */
function unwrapPromise(t: ts.TypeNode): ts.TypeNode {
  if (ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName) && t.typeName.text === 'Promise' && t.typeArguments?.[0]) {
    return t.typeArguments[0]
  }
  return t
}

function fieldsOfTypeLiteral(t: ts.TypeLiteralNode): string[] {
  return t.members
    .map(m => (m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)) ? m.name.text : undefined))
    .filter((x): x is string => !!x)
}

function describeType(sf: ts.SourceFile, t: ts.TypeNode): TypeDescriptor {
  const text = textOf(sf, t)
  if (ts.isTypeLiteralNode(t)) {
    return { text, isInline: true, fields: fieldsOfTypeLiteral(t) }
  }
  // Utility-wrapped inline shapes — `Partial<{...}>`, `Pick<{...}, 'a'>` etc. Still hand-written,
  // just one level down; surfacing its fields keeps the report's diff useful for these too.
  if (ts.isTypeReferenceNode(t) && t.typeArguments?.[0] && ts.isTypeLiteralNode(t.typeArguments[0])) {
    return { text, isInline: true, fields: fieldsOfTypeLiteral(t.typeArguments[0]) }
  }
  return { text, isInline: false }
}

/** Build a map of imported type name -> module specifier for a parsed file. */
function typeImportsOf(sf: ts.SourceFile): TypeImportMap {
  const map: TypeImportMap = new Map()
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue
    const clause = stmt.importClause
    if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue
    // Only `import type {...}` or individually-`type`-prefixed specifiers carry wire-format types here.
    for (const el of clause.namedBindings.elements) {
      if (clause.isTypeOnly || el.isTypeOnly) {
        map.set(el.name.text, stmt.moduleSpecifier.text)
      }
    }
  }
  return map
}

/** Trace a body-carrying `body: JSON.stringify(<expr>)` property to a declared type, if resolvable. */
function resolveBodyType(
  sf: ts.SourceFile,
  optionsArg: ts.Expression | undefined,
  params: ts.NodeArray<ts.ParameterDeclaration>,
): { text: string; isInline: boolean } | 'no-body' | 'unresolvable' {
  if (!optionsArg || !ts.isObjectLiteralExpression(optionsArg)) return 'no-body'
  const bodyProp = optionsArg.properties.find(
    (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'body',
  )
  if (!bodyProp) return 'no-body'
  const init = bodyProp.initializer
  // body: JSON.stringify(x) — the common case
  if (ts.isCallExpression(init) && ts.isPropertyAccessExpression(init.expression) &&
      ts.isIdentifier(init.expression.expression) && init.expression.expression.text === 'JSON' &&
      init.expression.name.text === 'stringify') {
    const arg = init.arguments[0]
    if (!arg) return 'unresolvable'
    // `JSON.stringify(paramName)` — look up paramName's declared parameter type.
    if (ts.isIdentifier(arg)) {
      const param = params.find(p => ts.isIdentifier(p.name) && p.name.text === arg.text)
      if (param?.type) return describeType(sf, param.type)
      return 'unresolvable'
    }
    // `JSON.stringify(x satisfies SomeType)` — the type assertion IS the body type, and it's
    // guaranteed structurally checked against SomeType even though the runtime value is inline.
    if (ts.isSatisfiesExpression(arg)) return describeType(sf, arg.type)
    // `JSON.stringify({ a, b, c })` — constructed ad hoc from multiple params, no single body type.
    if (ts.isObjectLiteralExpression(arg)) return 'unresolvable'
    return 'unresolvable'
  }
  return 'unresolvable'
}

export function extractClientCalls(): ClientCall[] {
  const out: ClientCall[] = []

  for (const filePath of apiClientFiles()) {
    const sf = parseFile(filePath)
    const relFile = relative(process.cwd(), filePath)
    const typeImports = typeImportsOf(sf)
    const attachImportSource = (d: TypeDescriptor | undefined) => {
      if (d && !d.isInline) d.importedFrom = typeImports.get(d.text)
      return d
    }

    for (const stmt of sf.statements) {
      if (!ts.isFunctionDeclaration(stmt) || !stmt.name) continue
      const isExported = stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
      if (!isExported || !stmt.body) continue
      const functionName = stmt.name.text
      const line = lineOf(sf, stmt)

      const requestCalls = findCalls(stmt.body, 'request')
      if (requestCalls.length === 0) {
        out.push({ functionName, file: relFile, line, method: 'GET', pathPattern: '', hubScoped: false, unresolvedReason: 'no request() call in function body (custom fetch, pure helper, or delegates elsewhere)' })
        continue
      }
      // A function that calls request() more than once (rare branching) is reported per-call-site
      // by taking the first — branches converging on the same route is the common shape; a function
      // that genuinely hits two different routes is flagged via the reason string on entry 2+.
      requestCalls.forEach((call, idx) => {
        const pathArg = call.arguments[0]
        if (!pathArg) {
          out.push({ functionName, file: relFile, line, method: 'GET', pathPattern: '', hubScoped: false, unresolvedReason: 'request() called with no path argument' })
          return
        }
        const { inner, hubScoped } = unwrapHp(pathArg)
        const rawPattern = templateToPattern(inner)
        if (rawPattern === undefined) {
          out.push({ functionName, file: relFile, line, method: 'GET', pathPattern: '', hubScoped, unresolvedReason: `path argument is not a string/template literal: \`${textOf(sf, pathArg)}\`` })
          return
        }
        // Strip both a literal `?query` suffix and a dynamic one glued on via a nested
        // template/ternary (`${qs}` where `qs` itself builds `?a=b` or `''`) — the latter
        // renders as `:param` with no preceding `/`, e.g. `/blasts/subscribers:param`.
        // Query strings never affect Hono route matching, so dropping them is exact, not lossy.
        const queryLikeSuffix = /([^/]):param/.exec(rawPattern)
        const pathPattern = (queryLikeSuffix ? rawPattern.slice(0, queryLikeSuffix.index + 1) : rawPattern).split('?')[0]
        const optionsArg = call.arguments[1]
        const method = methodFromOptions(optionsArg)

        // Response type: explicit `request<T>(...)`, else contextual `Promise<T>` from the function's own return type.
        let responseType: ClientCall['responseType']
        if (call.typeArguments?.[0]) {
          responseType = describeType(sf, call.typeArguments[0])
        } else if (stmt.type) {
          responseType = describeType(sf, unwrapPromise(stmt.type))
        }

        const bodyResolved = resolveBodyType(sf, optionsArg, stmt.parameters)
        const bodyType = bodyResolved === 'no-body' || bodyResolved === 'unresolvable' ? undefined : bodyResolved

        attachImportSource(responseType)
        attachImportSource(bodyType)

        const entry: ClientCall = {
          functionName: idx === 0 ? functionName : `${functionName} [call site ${idx + 1}]`,
          file: relFile,
          line,
          method,
          pathPattern,
          hubScoped,
          bodyType,
          responseType,
        }
        if (!responseType) entry.unresolvedReason = 'no explicit request<T>() type argument and no declared function return type to infer from'
        if (bodyResolved === 'unresolvable' && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
          entry.unresolvedReason = [entry.unresolvedReason, 'body is constructed from an inline object literal or non-identifier expression — no single declared body type'].filter(Boolean).join('; ')
        }
        out.push(entry)
      })
    }
  }

  return out
}
