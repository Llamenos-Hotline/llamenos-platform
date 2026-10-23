/**
 * desktop-calls.ts — every HTTP call in the desktop client (`src/client/**`),
 * resolved the way the webview builds it.
 *
 * Desktop paths are relative to `/api`: `request(path)` and `getApiUrl(path)`
 * both prepend it, so a desktop call cannot omit the prefix. `hp(path)` scopes
 * to the active hub (`/hubs/:id` + path) and falls back to the bare path when
 * no hub is active; `hubPath(id, path)` names the hub explicitly.
 *
 * Unlike `extract-client-calls.ts` (exported functions of `lib/api/*` only,
 * for the schema-binding report) this walks the whole client, because the
 * defects live outside `lib/api` too: `queries/devices.ts`, `webauthn.ts`,
 * admin-settings components, `offline-queue.ts`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { PARAM, scopeToHub, type CallSite } from './contract-match'
import { isUnres, joinAlts, toSites, unres, union, type Alt, type Res } from './path-shared'

export interface DesktopFile {
  file: string
  raw: string
}

export function readDesktopSources(root: string, cwd: string): DesktopFile[] {
  const out: DesktopFile[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        if (name !== 'node_modules' && name !== '__tests__') walk(full)
      } else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
        out.push({ file: relative(cwd, full), raw: readFileSync(full, 'utf-8') })
      }
    }
  }
  walk(root)
  return out.sort((a, b) => a.file.localeCompare(b.file))
}

type FnLike = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression

interface FileModel {
  sf: ts.SourceFile
  file: string
  /** Named function declarations and `const f = () => …`, anywhere in the file. */
  fns: Map<string, FnLike>
}

const lineOf = (sf: ts.SourceFile, n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1

function buildModel({ file, raw }: DesktopFile): FileModel {
  const sf = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const fns = new Map<string, FnLike>()
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body) fns.set(n.name.text, n)
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
      fns.set(n.name.text, n.initializer)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return { sf, file, fns }
}

interface Ctx {
  m: FileModel
  env: Map<string, Alt[]>
  depth: number
}

const stripWrappers = (e: ts.Expression): ts.Expression => {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e)) {
    e = e.expression
  }
  return e
}

/** The nearest enclosing function-like of `node`. */
function enclosingFn(node: ts.Node): FnLike | undefined {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) || ts.isArrowFunction(p) || ts.isFunctionExpression(p)) return p
  }
  return undefined
}

function fnName(fn: FnLike | undefined): string {
  if (!fn) return '(module)'
  if (ts.isFunctionDeclaration(fn) && fn.name) return fn.name.text
  if (ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) return fn.parent.name.text
  return '(anonymous)'
}

/** The last `const|let name = init` visible from `use`, searching outward scope by scope. */
function findDeclaration(use: ts.Node, name: string): ts.Expression | 'param' | undefined {
  for (let scope: ts.Node | undefined = use.parent; scope; scope = scope.parent) {
    const statements: readonly ts.Statement[] | undefined =
      ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope) ? scope.statements : undefined
    if (statements) {
      let found: ts.Expression | undefined
      for (const st of statements) {
        if (st.getStart() >= use.getStart()) break
        if (!ts.isVariableStatement(st)) continue
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) found = d.initializer
        }
      }
      if (found) return found
    }
    if ((ts.isFunctionDeclaration(scope) || ts.isArrowFunction(scope) || ts.isFunctionExpression(scope)) && scope.parameters.some(p => ts.isIdentifier(p.name) && p.name.text === name)) {
      return 'param'
    }
  }
  return undefined
}

function evalExpr(ctx: Ctx, expr0: ts.Expression): Res {
  const expr = stripWrappers(expr0)
  const { sf } = ctx.m
  if (ctx.depth > 14) return unres('expression nests too deeply to follow')
  const sub = { ...ctx, depth: ctx.depth + 1 }

  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return { alts: [{ path: expr.text, scoping: 'none' }] }

  if (ts.isTemplateExpression(expr)) {
    const parts: Alt[][] = [[{ path: expr.head.text, scoping: 'none' }]]
    for (const span of expr.templateSpans) {
      const inner = evalExpr(sub, span.expression)
      parts.push(isUnres(inner) ? [{ path: PARAM, scoping: 'none' }] : inner.alts.map(a => ({ path: a.path, scoping: 'none' as const })))
      parts.push([{ path: span.literal.text, scoping: 'none' }])
    }
    return joinAlts(parts)
  }

  if (ts.isConditionalExpression(expr)) return union([evalExpr(sub, expr.whenTrue), evalExpr(sub, expr.whenFalse)])

  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind
    if (op === ts.SyntaxKind.PlusToken) {
      const l = evalExpr(sub, expr.left)
      if (isUnres(l)) return l
      const r = evalExpr(sub, expr.right)
      return joinAlts([l.alts, isUnres(r) ? [{ path: PARAM, scoping: 'none' }] : r.alts])
    }
    if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) {
      return union([evalExpr(sub, expr.left), evalExpr(sub, expr.right)])
    }
    return unres(`unsupported operator in \`${expr.getText(sf).slice(0, 40)}\``)
  }

  if (ts.isIdentifier(expr)) {
    const bound = ctx.env.get(expr.text)
    if (bound) return { alts: bound }
    const decl = findDeclaration(expr, expr.text)
    if (decl === 'param') return unres(`\`${expr.text}\` is a parameter of ${fnName(enclosingFn(expr))}()`)
    if (decl) {
      const r = evalExpr({ ...sub, env: new Map() }, decl)
      return isUnres(r) ? unres(`\`${expr.text}\` = ${r.unresolved}`) : r
    }
    return unres(`\`${expr.text}\` is not a constant the guard can follow`)
  }

  if (ts.isCallExpression(expr)) {
    const callee = expr.expression
    const name = ts.isIdentifier(callee) ? callee.text : undefined
    if (name === 'hp' && expr.arguments.length === 1) {
      const inner = evalExpr(sub, expr.arguments[0])
      return isUnres(inner) ? inner : { alts: inner.alts.map(a => ({ path: a.path, scoping: a.scoping === 'none' ? ('hp' as const) : a.scoping })) }
    }
    if (name === 'hubPath' && expr.arguments.length === 2) {
      const inner = evalExpr(sub, expr.arguments[1])
      // Desktop paths are /api-relative, so scope without the /api prefix.
      return isUnres(inner) ? inner : { alts: inner.alts.map(a => ({ path: scopeToHub(a.path), scoping: 'explicit' as const })) }
    }
    const fn = name ? ctx.m.fns.get(name) : undefined
    if (fn) return inlineCall(sub, fn, expr)
    return unres(`call to \`${callee.getText(sf).slice(0, 40)}()\` is not a function the guard can follow`)
  }

  return unres(`unsupported expression \`${expr.getText(sf).replace(/\s+/g, ' ').slice(0, 40)}\``)
}

function inlineCall(ctx: Ctx, fn: FnLike, call: ts.CallExpression): Res {
  const env = new Map<string, Alt[]>()
  fn.parameters.forEach((p, i) => {
    if (!ts.isIdentifier(p.name)) return
    const arg = call.arguments[i]
    const source = arg ? evalExpr(ctx, arg) : p.initializer ? evalExpr(ctx, p.initializer) : unres('missing')
    env.set(p.name.text, isUnres(source) ? [{ path: PARAM, scoping: 'none' }] : source.alts)
  })
  const bodyCtx = { ...ctx, env }
  const body = fn.body
  if (!body) return unres('function has no body')
  if (!ts.isBlock(body)) return evalExpr(bodyCtx, body)
  const returns: Res[] = []
  const visit = (n: ts.Node) => {
    if (ts.isFunctionLike(n) && n !== fn) return
    if (ts.isReturnStatement(n) && n.expression) returns.push(evalExpr(bodyCtx, n.expression))
    ts.forEachChild(n, visit)
  }
  visit(body)
  return returns.length ? union(returns) : unres('function returns no value')
}

/** `{ method: 'POST' }` -> verbs. Absent options mean GET. */
function methodsOf(ctx: Ctx, options: ts.Expression | undefined): Res {
  if (!options) return { alts: [{ path: 'GET', scoping: 'none' }] }
  let obj = stripWrappers(options)
  if (ts.isIdentifier(obj)) {
    const decl = findDeclaration(obj, obj.text)
    if (decl && decl !== 'param') obj = stripWrappers(decl)
  }
  if (!ts.isObjectLiteralExpression(obj)) return unres('options are not an object literal')
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === 'method') return evalExpr(ctx, prop.initializer)
    if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === 'method') return evalExpr(ctx, prop.name)
  }
  // A spread may carry a method; with none visible this is GET.
  return obj.properties.some(ts.isSpreadAssignment) ? unres('options spread may carry a method') : { alts: [{ path: 'GET', scoping: 'none' }] }
}

const API = '/api'
const withApi = (r: Res): Res => (isUnres(r) ? r : { alts: r.alts.map(a => ({ ...a, path: API + a.path })) })

/** `request(path, …)` and `netFetch(input, …)` forward whatever their caller passes; each caller is its own site. */
const ENTRY_POINTS = new Set(['request', 'netFetch'])

function isPassThrough(fn: FnLike | undefined, expr: ts.Expression): boolean {
  return !!fn && ENTRY_POINTS.has(fnName(fn)) && ts.isIdentifier(expr) && fn.parameters.some(p => ts.isIdentifier(p.name) && p.name.text === expr.text)
}

export function extractDesktopCalls(files: DesktopFile[]): CallSite[] {
  const sites: CallSite[] = []
  for (const f of files) {
    const m = buildModel(f)
    const ctx: Ctx = { m, env: new Map(), depth: 0 }
    const base = (n: ts.Node) => ({ client: 'desktop' as const, file: f.file, line: lineOf(m.sf, n), kind: 'call' as const })
    const exprText = (e: ts.Expression) => e.getText(m.sf).replace(/\s+/g, ' ').trim()

    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const callee = n.expression
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined
        const fn = enclosingFn(n)
        const arg0 = n.arguments[0]

        if (name === 'request' && ts.isIdentifier(callee) && arg0) {
          sites.push(...toSites(base(n), methodsOf(ctx, n.arguments[1]), withApi(evalExpr(ctx, arg0)), exprText(arg0), isPassThrough(fn, arg0)))
        } else if (name === 'getApiUrl' && arg0) {
          // Method comes from the fetch this URL feeds: netFetch(getApiUrl(p), { method }).
          const parent = n.parent
          const feeds = ts.isCallExpression(parent) && parent.arguments[0] === n && ['netFetch', 'fetch'].includes(ts.isIdentifier(parent.expression) ? parent.expression.text : '')
          const methods = feeds ? methodsOf(ctx, (parent as ts.CallExpression).arguments[1]) : unres('URL is not passed straight to a fetch')
          sites.push(...toSites(base(n), methods, withApi(evalExpr(ctx, arg0)), exprText(arg0), isPassThrough(fn, arg0)))
        } else if (name === 'fetch' && ts.isIdentifier(callee) && arg0 && !(ts.isCallExpression(arg0) && ts.isIdentifier(arg0.expression) && arg0.expression.text === 'getApiUrl')) {
          // A raw fetch: crash reports, health probes. Not /api-relative — the URL is whatever it builds.
          sites.push(...toSites(base(n), methodsOf(ctx, n.arguments[1]), evalExpr(ctx, arg0), exprText(arg0), isPassThrough(fn, arg0)))
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(m.sf)
  }
  return sites
}
