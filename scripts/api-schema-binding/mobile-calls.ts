/**
 * mobile-calls.ts — find every HTTP call in the Swift (iOS) and Kotlin
 * (Android) clients and evaluate its path the way the app would build it.
 *
 * A per-line regex under-reports here: `request(` spans several lines, the
 * path is often `val path = hubPath("/api/…/$id")` assigned a few lines before
 * the call, and wrappers (`hp()`, a private `onboardPath(suffix)`) rewrite it.
 * So this parses balanced call arguments with a string-aware lexer and
 * evaluates the path expression: literals and interpolation, `+`, ternary and
 * `if`/`else`, `?:`/`??`, local `val`/`let`, file constants, and local helper
 * functions (inlined with their arguments bound).
 *
 * Anything it cannot follow is reported as `unresolved` — never dropped. A
 * final sweep then flags any `"/api/…"` literal no recognised call consumed,
 * so a call reached through an unrecognised wrapper cannot hide.
 */
import {
  findClose,
  findTopLevel,
  isIdentChar,
  lineAt,
  makeSource,
  parseStringLiteral,
  readExpression,
  splitTopLevel,
  type Lang,
  type SourceText,
} from './text-lex'
import { PARAM, scopeToHub, type CallSite, type ClientId, type HubScoping } from './contract-match'
import { isUnres, joinAlts, toSites as buildSites, unres, union, type Alt, type Res } from './path-shared'

interface ParamDef {
  label: string
  name: string
  defaultRange?: [number, number]
}

interface FuncDef {
  name: string
  params: ParamDef[]
  bodyStart: number
  bodyEnd: number
  exprBody: boolean
}

interface FileModel {
  source: SourceText
  funcs: FuncDef[]
  /** Type-scope `val`/`let` string constants (outside any function body): name -> rhs range. */
  consts: Map<string, [number, number]>
}

interface Globals {
  files: Map<string, FileModel>
  /** Constants by name across all files — consulted only for qualified references (`Type.NAME`). */
  consts: Map<string, { file: string; range: [number, number] }[]>
}

interface Ctx {
  m: FileModel
  g: Globals
  at: number
  env: Map<string, Alt[]>
  depth: number
  consumed: Set<string>
}

// ── indexing ────────────────────────────────────────────────────────────────

function splitParams(text: string, from: number, to: number, lang: Lang): [number, number][] {
  // Like splitTopLevel(',') but generics (`Map<String, Any>`) do not split.
  const out: [number, number][] = []
  let depth = 0
  let angle = 0
  let begin = from
  for (let i = from; i < to; i++) {
    const ch = text[i]
    if (ch === '"') {
      i = parseStringLiteral(text, i, lang).end - 1
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth--
    else if (ch === '<') angle++
    else if (ch === '>' && text[i - 1] !== '-' && angle > 0) angle--
    else if (ch === ',' && depth === 0 && angle === 0) {
      out.push([begin, i])
      begin = i + 1
    }
  }
  if (text.slice(begin, to).trim()) out.push([begin, to])
  return out
}

function parseParam(text: string, from: number, to: number, lang: Lang): ParamDef | undefined {
  const piece = text.slice(from, to)
  const decl =
    lang === 'swift'
      ? /^\s*(?:(\w+)\s+)?(\w+)\s*:/.exec(piece)
      : /^\s*(?:(?:vararg|noinline|crossinline)\s+)?()(\w+)\s*:/.exec(piece)
  if (!decl) return undefined
  const label = lang === 'swift' ? (decl[1] ? decl[1] : decl[2]) : decl[2]
  const swiftExternal = lang === 'swift' && decl[1] ? decl[1] : label
  const name = decl[2]
  // The default value is the first top-level `=` after the type.
  const eq = findTopLevel(text, from + decl[0].length, to, '=', lang).find(i => text[i + 1] !== '=' && text[i - 1] !== '=')
  return { label: swiftExternal, name, defaultRange: eq !== undefined ? [eq + 1, to] : undefined }
}

function indexFunctions(source: SourceText): FuncDef[] {
  const { text, lang } = source
  const re =
    lang === 'swift'
      ? /\bfunc\s+([A-Za-z_]\w*)\s*(?:<[^>(]*>)?\s*\(/g
      : /\bfun\s+(?:<[^>]*>\s*)?(?:[A-Za-z_][\w.<>?]*\.)?([A-Za-z_]\w*)\s*\(/g
  const funcs: FuncDef[] = []
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const open = m.index + m[0].length - 1
    let close: number
    try {
      close = findClose(text, open, lang)
    } catch {
      continue
    }
    const params = splitParams(text, open + 1, close, lang)
      .map(([a, b]) => parseParam(text, a, b, lang))
      .filter((p): p is ParamDef => !!p)
    // Find the body: first `{` or expression-`=` after the signature, unless a new declaration starts first.
    let i = close + 1
    let found: FuncDef | undefined
    while (i < text.length) {
      const ch = text[i]
      if (ch === '{') {
        found = { name: m[1], params, bodyStart: i + 1, bodyEnd: findClose(text, i, lang), exprBody: false }
        break
      }
      if (ch === '=' && text[i + 1] !== '=' && text[i + 1] !== '>' && !'=!<>'.includes(text[i - 1])) {
        // `fun f(...): String =\n    expr` — the body starts on the next line; reading from the
        // `=` itself would stop at that newline and see an empty expression.
        const start = i + 1 + (text.slice(i + 1).length - text.slice(i + 1).trimStart().length)
        const end = readExpression(text, start, lang)
        found = { name: m[1], params, bodyStart: start, bodyEnd: end, exprBody: true }
        break
      }
      if (ch === '\n') {
        const next = text.slice(i, i + 80).trimStart()
        if (/^(?:func|fun|var|val|let|private|public|internal|override|protected|open|abstract|\}|@|case|init|class|struct|protocol|extension|enum|object|interface)\b/.test(next) || next.startsWith('}')) break
      }
      i++
    }
    if (found) funcs.push(found)
  }
  return funcs
}

function indexConsts(source: SourceText, funcs: FuncDef[]): Map<string, [number, number]> {
  const { text, lang } = source
  const re =
    lang === 'swift'
      ? /\b(?:static\s+)?(?:let|var)\s+([A-Za-z_]\w*)\s*(?::\s*[\w.<>?[\]]+\s*)?=\s*(?=")/g
      : /\b(?:const\s+)?val\s+([A-Za-z_]\w*)\s*(?::\s*[\w.<>?]+\s*)?=\s*(?=")/g
  const out = new Map<string, [number, number]>()
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const at = m.index
    if (funcs.some(f => at >= f.bodyStart && at < f.bodyEnd)) continue
    const start = m.index + m[0].length
    out.set(m[1], [start, readExpression(text, start, lang)])
  }
  return out
}

function buildModel(file: string, lang: Lang, raw: string): FileModel {
  const source = makeSource(file, lang, raw)
  const funcs = indexFunctions(source)
  return { source, funcs, consts: indexConsts(source, funcs) }
}

function enclosingFn(m: FileModel, at: number): FuncDef | undefined {
  let best: FuncDef | undefined
  for (const f of m.funcs) {
    if (at >= f.bodyStart && at < f.bodyEnd && (!best || f.bodyEnd - f.bodyStart < best.bodyEnd - best.bodyStart)) best = f
  }
  return best
}

// ── evaluation ──────────────────────────────────────────────────────────────

function trimRange(text: string, from: number, to: number): [number, number] {
  while (from < to && /\s/.test(text[from])) from++
  while (to > from && /\s/.test(text[to - 1])) to--
  return [from, to]
}

const wordAt = (text: string, i: number, word: string) =>
  text.startsWith(word, i) && !isIdentChar(text[i - 1]) && !isIdentChar(text[i + word.length])

function evalString(ctx: Ctx, start: number): { res: Res; end: number } {
  const { text, lang, file } = ctx.m.source
  const lit = parseStringLiteral(text, start, lang)
  ctx.consumed.add(`${file}:${start}`)
  const parts: Alt[][] = lit.parts.map(p => {
    if ('lit' in p) return [{ path: p.lit, scoping: 'none' as HubScoping }]
    const inner = evalRange({ ...ctx, depth: ctx.depth + 1, at: p.exprStart }, p.exprStart, p.exprStart + p.expr.length)
    // A runtime value the guard cannot see is a placeholder segment, not a failure.
    return isUnres(inner) ? [{ path: PARAM, scoping: 'none' as HubScoping }] : inner.alts.map(a => ({ path: a.path, scoping: 'none' as HubScoping }))
  })
  return { res: joinAlts(parts), end: lit.end }
}

function evalRange(ctx: Ctx, from0: number, to0: number): Res {
  const { text, lang } = ctx.m.source
  const [from, to] = trimRange(text, from0, to0)
  if (from >= to) return unres('empty expression')
  if (ctx.depth > 14) return unres('expression nests too deeply to follow')

  // Leading keywords that do not change the value.
  const kw = /^(?:try[?!]?|await|return)\s+/.exec(text.slice(from, to))
  if (kw) return evalRange(ctx, from + kw[0].length, to)

  // Kotlin `if (c) a else b`
  if (lang === 'kotlin' && /^if\s*\(/.test(text.slice(from, from + 8))) {
    const open = text.indexOf('(', from)
    const close = findClose(text, open, lang)
    const elses = findTopLevel(text, close + 1, to, 'else', lang).filter(i => wordAt(text, i, 'else'))
    if (elses.length === 0) return unres('`if` without `else` is not a value')
    return union([evalRange(ctx, close + 1, elses[0]), evalRange(ctx, elses[0] + 4, to)])
  }

  // Swift ternary `c ? a : b`
  if (lang === 'swift') {
    const qs = findTopLevel(text, from, to, '?', lang).filter(
      i => /\s/.test(text[i - 1] ?? '') && /\s/.test(text[i + 1] ?? ''),
    )
    if (qs.length > 0) {
      const q = qs[0]
      const colons = findTopLevel(text, q + 1, to, ':', lang).filter(i => /\s/.test(text[i - 1] ?? '') && /\s/.test(text[i + 1] ?? ''))
      const nested = (i: number) => qs.filter(x => x > q && x < i).length
      const colon = colons.find((c, idx) => nested(c) === idx)
      if (colon !== undefined) return union([evalRange(ctx, q + 1, colon), evalRange(ctx, colon + 1, to)])
    }
  }

  // `a ?? b` (Swift) / `a ?: b` (Kotlin)
  const coalesce = findTopLevel(text, from, to, lang === 'swift' ? '??' : '?:', lang)
  if (coalesce.length > 0) {
    const rhs = text.slice(coalesce[0] + 2, to).trim()
    const lhs = evalRange(ctx, from, coalesce[0])
    return /^(?:throw|return|error\(|fatalError)/.test(rhs) ? lhs : union([lhs, evalRange(ctx, coalesce[0] + 2, to)])
  }

  // Concatenation
  const plus = findTopLevel(text, from, to, '+', lang).filter(i => text[i + 1] !== '=' && text[i - 1] !== '+' && text[i + 1] !== '+')
  if (plus.length > 0) {
    const bounds = [from, ...plus.flatMap(i => [i, i + 1]), to]
    const parts: Alt[][] = []
    for (let k = 0; k < bounds.length; k += 2) {
      const piece = evalRange(ctx, bounds[k], bounds[k + 1])
      if (isUnres(piece)) {
        if (k === 0) return piece
        parts.push([{ path: PARAM, scoping: 'none' }])
      } else parts.push(piece.alts)
    }
    return joinAlts(parts)
  }

  // Atoms
  if (text[from] === '"') {
    const { res, end } = evalString(ctx, from)
    const rest = text.slice(end, to).trim()
    return rest === '' || rest === '!' ? res : unres(`string followed by \`${rest.slice(0, 30)}\``)
  }
  if (text[from] === '(' && findClose(text, from, lang) === to - 1) return evalRange(ctx, from + 1, to - 1)
  if (text[from] === '{' && findClose(text, from, lang) === to - 1) return evalRange(ctx, from + 1, to - 1)

  const chain = /^((?:[A-Za-z_]\w*[!?]*\s*\.\s*)*)([A-Za-z_]\w*)[!?]*/.exec(text.slice(from, to))
  if (!chain) return unres(`unsupported expression \`${text.slice(from, Math.min(to, from + 40)).replace(/\s+/g, ' ')}\``)
  const qualifier = chain[1].replace(/[\s!?.]+/g, '.').replace(/\.$/, '')
  const name = chain[2]
  const afterName = from + chain[0].length
  const rest = text.slice(afterName, to)
  const restTrim = rest.trimStart()
  if (restTrim === '') return resolveIdent(ctx, name, qualifier !== '' && !/^(?:self|this|Self)$/.test(qualifier))
  if (name === 'buildString' && restTrim.startsWith('{')) {
    const open = afterName + (rest.length - restTrim.length)
    if (findClose(text, open, lang) === to - 1) return evalBuildString(ctx, open + 1, to - 1)
  }
  if (restTrim.startsWith('(')) {
    const open = afterName + (rest.length - restTrim.length)
    if (findClose(text, open, lang) !== to - 1) {
      return unres(`call to \`${name}()\` is followed by more member access`)
    }
    return evalCall(ctx, name, open, to - 1)
  }
  return unres(`unsupported expression \`${text.slice(from, Math.min(to, from + 40)).replace(/\s+/g, ' ')}\``)
}

/**
 * Kotlin `buildString { append(a); append(b); if (c) append("&x=1") }`. The
 * unconditional top-level appends are the path; appends nested in a block are
 * conditional, so they only widen the result when they extend the path itself
 * (a `?`/`&` query piece never changes which route is hit).
 */
function evalBuildString(ctx: Ctx, from: number, to: number): Res {
  const { text, lang } = ctx.m.source
  const sub = { ...ctx, depth: ctx.depth + 1 }
  const top: Alt[][] = []
  const optional: Res[] = []
  const re = /\bappend\s*\(/g
  const body = text.slice(from, to)
  for (let r = re.exec(body); r; r = re.exec(body)) {
    const open = from + r.index + r[0].length - 1
    const close = findClose(text, open, lang)
    const piece = evalRange({ ...sub, at: open }, open + 1, close)
    let depth = 0
    for (let i = from; i < open; i++) {
      if (text[i] === '"') i = parseStringLiteral(text, i, lang).end - 1
      else if (text[i] === '{') depth++
      else if (text[i] === '}') depth--
    }
    if (depth === 0) {
      if (isUnres(piece)) {
        if (top.length === 0) return piece
        top.push([{ path: PARAM, scoping: 'none' }])
      } else top.push(piece.alts)
    } else if (!isUnres(piece) && piece.alts.some(a => a.path.startsWith('/'))) optional.push(piece)
  }
  if (top.length === 0) return unres('buildString { } with no append() at its top level')
  const base = joinAlts(top)
  if (isUnres(base) || optional.length === 0) return base
  return union([base, ...optional.map(o => joinAlts([base.alts, (o as { alts: Alt[] }).alts]))])
}

interface ArgDef {
  name?: string
  range: [number, number]
}

function parseArgs(ctx: Ctx, open: number, close: number): ArgDef[] {
  const { text, lang } = ctx.m.source
  if (text.slice(open + 1, close).trim() === '') return []
  return splitTopLevel(text, open + 1, close, ',', lang).map(([a, b]) => {
    const named = (lang === 'swift' ? /^\s*([A-Za-z_]\w*)\s*:(?!:)\s*/ : /^\s*([A-Za-z_]\w*)\s*=(?!=)\s*/).exec(text.slice(a, b))
    return named ? { name: named[1], range: [a + named[0].length, b] as [number, number] } : { range: [a, b] as [number, number] }
  })
}

function evalCall(ctx: Ctx, name: string, open: number, close: number): Res {
  const { lang } = ctx.m.source
  const args = parseArgs(ctx, open, close)
  const sub = { ...ctx, depth: ctx.depth + 1 }

  if (name === 'hp') {
    if (args.length !== 1) return unres('hp() with an unexpected argument list')
    const inner = evalRange(sub, ...args[0].range)
    return isUnres(inner) ? inner : { alts: inner.alts.map(a => ({ path: a.path, scoping: a.scoping === 'none' ? 'hp' : a.scoping })) }
  }
  // `activeHubPath("/api/x")` (Swift and Kotlin): the active hub's scoped path with NO
  // unscoped fallback — it throws when no hub is active (#2395) — so it always calls
  // the hub route.
  if (name === 'activeHubPath') {
    if (args.length !== 1) return unres('activeHubPath() with an unexpected argument list')
    const inner = evalRange(sub, ...args[0].range)
    return isUnres(inner) ? inner : { alts: inner.alts.map(a => ({ path: scopeToHub(a.path), scoping: 'explicit' as HubScoping })) }
  }
  // `APIService.hubPath(hubId, "/api/x")` (Swift) and `ApiService.hubPath(hubId, "/api/x")`
  // (Kotlin) — the canonical explicit-hub builder. A one-argument `hubPath(path)` is a
  // different, file-private helper and is resolved as an ordinary call below.
  if (name === 'hubPath' && args.length === 2) {
    const inner = evalRange(sub, ...args[1].range)
    return isUnres(inner) ? inner : { alts: inner.alts.map(a => ({ path: scopeToHub(a.path), scoping: 'explicit' as HubScoping })) }
  }

  const callee = ctx.m.funcs.find(f => f.name === name && args.length <= f.params.length)
  if (!callee) return unres(`call to \`${name}()\` is not defined in this file`)
  const env = new Map<string, Alt[]>()
  const positional = args.filter(a => !a.name)
  callee.params.forEach((p, idx) => {
    const byName = args.find(a => a.name === p.label || a.name === p.name)
    const arg = byName ?? (lang === 'kotlin' ? positional[idx] : args.filter(a => !a.name || a.name === p.label)[idx])
    const source = arg ? evalRange(sub, ...arg.range) : p.defaultRange ? evalRange({ ...sub, at: p.defaultRange[0] }, ...p.defaultRange) : unres('missing')
    env.set(p.name, isUnres(source) ? [{ path: PARAM, scoping: 'none' }] : source.alts)
  })
  const { text } = ctx.m.source
  const bodyCtx: Ctx = { ...sub, env, at: callee.bodyStart }
  if (callee.exprBody) return evalRange({ ...bodyCtx, at: callee.bodyStart }, callee.bodyStart, callee.bodyEnd)
  const returns: Res[] = []
  const re = /\breturn\b/g
  const body = text.slice(callee.bodyStart, callee.bodyEnd)
  for (let r = re.exec(body); r; r = re.exec(body)) {
    const start = callee.bodyStart + r.index + 6
    returns.push(evalRange({ ...bodyCtx, at: start }, start, readExpression(text, start, lang)))
  }
  if (returns.length === 0) returns.push(evalRange({ ...bodyCtx, at: callee.bodyEnd }, callee.bodyStart, callee.bodyEnd))
  return union(returns)
}

function resolveIdent(ctx: Ctx, name: string, qualified: boolean): Res {
  const { text, lang } = ctx.m.source
  if (!qualified) {
    const bound = ctx.env.get(name)
    if (bound) return { alts: bound }
    const fn = enclosingFn(ctx.m, ctx.at)
    if (fn) {
      const decl = new RegExp(`\\b(?:val|var|let)\\s+${name}\\b`, 'g')
      let last: RegExpExecArray | undefined
      const window = text.slice(fn.bodyStart, ctx.at)
      for (let d = decl.exec(window); d; d = decl.exec(window)) last = d
      if (last) {
        const declStart = fn.bodyStart + last.index
        let eq = -1
        for (let i = declStart + last[0].length; i < text.length && text[i] !== '\n'; i++) {
          if (text[i] === '=' && text[i + 1] !== '=' && !'=!<>'.includes(text[i - 1])) {
            eq = i
            break
          }
        }
        if (eq < 0) return unres(`\`${name}\` is declared without an initial value`)
        const end = readExpression(text, eq + 1, lang)
        let res = evalRange({ ...ctx, depth: ctx.depth + 1, at: eq + 1 }, eq + 1, end)
        if (!isUnres(res)) {
          // `name += "…"` between the declaration and the use appends to it.
          const appends = new RegExp(`\\b${name}\\s*\\+=\\s*`, 'g')
          const after = text.slice(end, ctx.at)
          for (let a = appends.exec(after); a && !isUnres(res); a = appends.exec(after)) {
            const s = end + a.index + a[0].length
            const extra = evalRange({ ...ctx, depth: ctx.depth + 1, at: s }, s, readExpression(text, s, lang))
            res = isUnres(extra) ? extra : joinAlts([res.alts, extra.alts])
          }
        }
        return res
      }
      if (fn.params.some(p => p.name === name)) return unres(`\`${name}\` is a parameter of ${fn.name}()`)
    }
    const range = ctx.m.consts.get(name)
    if (range) return evalRange({ ...ctx, depth: ctx.depth + 1, at: range[0], env: new Map() }, ...range)
    return unres(`\`${name}\` is not a string constant or local the guard can follow`)
  }
  const defs = ctx.g.consts.get(name)
  if (!defs) return unres(`\`${name}\` is not a string constant the guard can follow`)
  return union(
    defs.map(d => {
      const m = ctx.g.files.get(d.file)
      return m ? evalRange({ ...ctx, m, depth: ctx.depth + 1, at: d.range[0], env: new Map() }, ...d.range) : unres(`${d.file} is not indexed`)
    }),
  )
}

// ── call-site discovery ─────────────────────────────────────────────────────

interface Entry {
  /** Callee names that issue a request. */
  callees: string[]
  /** How method and path are passed. */
  style: 'labelled' | 'positional'
}

const SWIFT_ENTRY: Entry = { callees: ['request', 'rawRequest', 'publicRequest'], style: 'labelled' }
const KOTLIN_ENTRY: Entry = { callees: ['request', 'requestNoContent', 'requestRawNoContent', 'requestBytes'], style: 'positional' }

/** Request entry points: a bare own-parameter path handed on from one of these is plumbing. */
const ENTRY_NAMES = new Set(['request', 'rawRequest', 'publicRequest', 'requestNoContent', 'requestRawNoContent', 'requestBytes', 'resolve'])

function isPassThrough(m: FileModel, at: number, expr: string): boolean {
  const fn = enclosingFn(m, at)
  return !!fn && ENTRY_NAMES.has(fn.name) && /^[A-Za-z_]\w*$/.test(expr) && fn.params.some(p => p.name === expr)
}

function toSites(client: ClientId, m: FileModel, line: number, methods: Res, paths: Res, pathExpr: string, kind: 'call' | 'literal', at = -1): CallSite[] {
  return buildSites({ client, file: m.source.file, line, kind }, methods, paths, pathExpr, at >= 0 && isPassThrough(m, at, pathExpr))
}

function exprText(m: FileModel, range: [number, number]): string {
  const { text } = m.source
  return text.slice(range[0], range[1]).replace(/\s+/g, ' ').trim()
}

function findCallOpens(m: FileModel, entry: Entry): { name: string; open: number; at: number }[] {
  const { text } = m.source
  const out: { name: string; open: number; at: number }[] = []
  const re = new RegExp(`\\b(${entry.callees.join('|')})\\s*(?:<[^()]*?>)?\\s*\\(`, 'g')
  for (let r = re.exec(text); r; r = re.exec(text)) {
    const lineStart = text.lastIndexOf('\n', r.index) + 1
    if (/\b(?:func|fun)\b[^{=]*$/.test(text.slice(lineStart, r.index))) continue // a declaration, not a call
    out.push({ name: r[1], open: r.index + r[0].length - 1, at: r.index })
  }
  return out
}

function mkCtx(m: FileModel, g: Globals, at: number, consumed: Set<string>): Ctx {
  return { m, g, at, env: new Map(), depth: 0, consumed }
}

/** `httpMethod = "POST"` anywhere in the function containing `at`. */
function methodInFunction(m: FileModel, at: number): Res {
  const fn = enclosingFn(m, at)
  if (!fn) return unres('no enclosing function')
  const body = m.source.text.slice(fn.bodyStart, fn.bodyEnd)
  const found = [...body.matchAll(/\bhttpMethod\s*=\s*"([A-Za-z]+)"/g)].map(x => x[1].toUpperCase())
  return found.length ? { alts: [...new Set(found)].map(v => ({ path: v, scoping: 'none' as HubScoping })) } : unres('no literal HTTP verb in the function')
}

function sitesForFile(client: ClientId, m: FileModel, g: Globals, consumed: Set<string>): CallSite[] {
  const { text, lang } = m.source
  const entry = lang === 'swift' ? SWIFT_ENTRY : KOTLIN_ENTRY
  const sites: CallSite[] = []

  for (const call of findCallOpens(m, entry)) {
    const ctx = mkCtx(m, g, call.at, consumed)
    let close: number
    try {
      close = findClose(text, call.open, lang)
    } catch {
      continue
    }
    const args = parseArgs(ctx, call.open, close)
    let methodArg: ArgDef | undefined
    let pathArg: ArgDef | undefined
    if (entry.style === 'labelled') {
      methodArg = args.find(a => a.name === 'method')
      pathArg = args.find(a => a.name === 'path')
      if (!pathArg) continue // not an API call (no `path:` label)
    } else {
      const positional = args.filter(a => !a.name)
      methodArg = args.find(a => a.name === 'method') ?? positional[0]
      pathArg = args.find(a => a.name === 'path') ?? (args.some(a => a.name === 'method') ? positional[0] : positional[1])
      if (!pathArg || !methodArg) continue
    }
    const line = lineAt(m.source, call.at)
    const expr = exprText(m, pathArg.range)
    const methods = methodArg ? evalRange(ctx, ...methodArg.range) : unres('no method argument')
    sites.push(...toSites(client, m, line, methods, evalRange(ctx, ...pathArg.range), expr, 'call', call.at))
  }

  if (lang === 'swift') {
    // Direct URL construction: `Self.resolve(path: …)` and `baseURL.appendingPathComponent("/api/…")`.
    const direct = /\b(resolve|appendingPathComponent)\s*\(/g
    for (let r = direct.exec(text); r; r = direct.exec(text)) {
      if (/\bfunc\s+$/.test(text.slice(Math.max(0, r.index - 8), r.index))) continue
      const open = r.index + r[0].length - 1
      let close: number
      try {
        close = findClose(text, open, lang)
      } catch {
        continue
      }
      const ctx = mkCtx(m, g, r.index, consumed)
      const args = parseArgs(ctx, open, close)
      const pathArg = r[1] === 'resolve' ? args.find(a => a.name === 'path') : args[0]
      if (!pathArg) continue
      const res = evalRange(ctx, ...pathArg.range)
      // `appendingPathComponent` is also used for local files; only an /api URL is a request.
      if (r[1] === 'appendingPathComponent' && (isUnres(res) || !res.alts.some(a => /^\/api(\/|$)/.test(a.path)))) continue
      sites.push(...toSites(client, m, lineAt(m.source, r.index), methodInFunction(m, r.index), res, exprText(m, pathArg.range), 'call', r.index))
    }
  }
  return sites
}

/** Every `"/api…"` literal no recognised call consumed — checked path-only, verb unknown. */
function strayLiterals(client: ClientId, m: FileModel, g: Globals, consumed: Set<string>): CallSite[] {
  const { text, lang, file } = m.source
  const sites: CallSite[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (lang === 'kotlin' && ch === "'") {
      const c = /^'(?:\\.[^']*|[^'\\])'/.exec(text.slice(i, i + 12))
      if (c) i += c[0].length - 1
      continue
    }
    if (ch !== '"') continue
    const lit = parseStringLiteral(text, i, lang)
    const start = i
    i = lit.end - 1
    if (consumed.has(`${file}:${start}`)) continue
    // `"/api/…"`, or `"$baseUrl/api/…"` — an origin placeholder followed by a literal /api path.
    const shape = lit.parts.map(p => ('lit' in p ? p.lit : PARAM)).join('')
    if (!/^(?::param)?\/api\//.test(shape)) continue
    // A prefix test or comparison is not an endpoint.
    const before = text.slice(Math.max(0, start - 48), start)
    if (/(?:hasPrefix|startsWith|hasSuffix|contains|removePrefix|==|!=|case)\s*\(?\s*$/.test(before)) continue
    const res = evalString(mkCtx(m, g, start, consumed), start).res
    sites.push(...toSites(client, m, lineAt(m.source, start), unres('verb unknown'), res, text.slice(start, lit.end), 'literal'))
  }
  return sites
}

export interface MobileFile {
  file: string
  raw: string
}

export function extractMobileCalls(client: 'ios' | 'android', files: MobileFile[]): CallSite[] {
  const lang: Lang = client === 'ios' ? 'swift' : 'kotlin'
  const models = files.map(f => buildModel(f.file, lang, f.raw))
  const g: Globals = { files: new Map(models.map(m => [m.source.file, m])), consts: new Map() }
  for (const m of models) {
    for (const [name, range] of m.consts) {
      const list = g.consts.get(name) ?? []
      list.push({ file: m.source.file, range })
      g.consts.set(name, list)
    }
  }
  const consumed = new Set<string>()
  const calls = models.flatMap(m => sitesForFile(client, m, g, consumed))
  const stray = models.flatMap(m => strayLiterals(client, m, g, consumed))
  return [...calls, ...stray]
}
