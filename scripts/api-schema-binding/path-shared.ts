/**
 * path-shared.ts — the value model every client path evaluator produces.
 *
 * A path expression evaluates to one or more `Alt`s (a ternary or `if`/`else`
 * yields several), or to an `unresolved` reason. Runtime values the guard
 * cannot see are rendered as `:param`.
 */
import { PARAM, type CallSite, type ClientId, type HubScoping, type ResolvedPath } from './contract-match'

export interface Alt {
  path: string
  scoping: HubScoping
}
export type Res = { alts: Alt[] } | { unresolved: string }

export const MAX_ALTS = 32
export const unres = (reason: string): Res => ({ unresolved: reason })
export const isUnres = (r: Res): r is { unresolved: string } => 'unresolved' in r

export function union(parts: Res[]): Res {
  const alts: Alt[] = []
  for (const p of parts) {
    if (isUnres(p)) return p
    for (const a of p.alts) if (!alts.some(x => x.path === a.path && x.scoping === a.scoping)) alts.push(a)
  }
  return alts.length > MAX_ALTS ? unres('too many alternative paths to enumerate') : { alts }
}

export function joinAlts(parts: Alt[][]): Res {
  let acc: Alt[] = [{ path: '', scoping: 'none' }]
  for (const part of parts) {
    const next: Alt[] = []
    for (const a of acc) {
      for (const b of part) next.push({ path: a.path + b.path, scoping: a.scoping !== 'none' ? a.scoping : b.scoping })
    }
    if (next.length > MAX_ALTS) return unres('too many alternative paths to enumerate')
    acc = next
  }
  return { alts: acc }
}

/**
 * Reduce an evaluated path to what the router sees: no query string, no
 * glued-on suffix, no origin in front of a literal `/api` path.
 */
export function finalize(alt: Alt): ResolvedPath {
  const pattern = alt.path.split('?')[0]
  // `…/foo:param` is a query string or suffix glued on at runtime, never a path segment.
  const glued = /([^/]):param/.exec(pattern)
  let path = glued ? pattern.slice(0, glued.index + 1) : pattern
  // `${baseUrl}/api/health`: an origin the guard cannot see in front of a literal /api path.
  const origin = /^:param(\/api(?:\/|$).*)$/.exec(path)
  if (origin) path = origin[1]
  return { path: path.length > 1 ? path.replace(/\/+$/, '') : path, scoping: alt.scoping }
}

/** Build the call sites for one source location: one per possible HTTP verb. */
export function toSites(
  base: { client: ClientId; file: string; line: number; kind: 'call' | 'literal' },
  methods: Res,
  paths: Res,
  pathExpr: string,
  passThrough = false,
): CallSite[] {
  if (isUnres(paths)) {
    return [{ ...base, method: '*', paths: [], unresolved: { expr: pathExpr, reason: paths.unresolved }, ...(passThrough ? { passThrough } : {}) }]
  }
  const resolved = paths.alts.map(finalize)
  const bad = resolved.find(r => !r.path.startsWith('/') || r.path === PARAM)
  if (bad) {
    return [{ ...base, method: '*', paths: [], unresolved: { expr: pathExpr, reason: `path \`${bad.path}\` does not start with "/" — the base is not statically known` } }]
  }
  const verbs = isUnres(methods) ? [] : [...new Set(methods.alts.map(a => a.path.toUpperCase()).filter(v => /^[A-Z]+$/.test(v)))]
  return (verbs.length ? verbs : ['*']).map(method => ({ ...base, method, paths: resolved }))
}
