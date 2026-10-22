/**
 * contract-match.ts — match a client call site against the mounted route
 * table and classify every way it can fail to line up.
 *
 * Status codes are deliberately not an input. `GET /api/contacts/search` has
 * no route of its own; Hono hands it to `GET /api/contacts/:hash`, which
 * answers 200 for a contact named "search". Only a static comparison of the
 * path against the table can see that, so shadowing is its own category.
 */

export type ClientId = 'desktop' | 'ios' | 'android' | 'sip-bridge'

export type Category =
  | 'unmounted'
  | 'missing-/api-prefix'
  | 'wrong-verb'
  | 'hub-scope-mismatch'
  | 'shadowed-by-param-route'
  | 'unresolved'

/** The placeholder every client path evaluator renders a runtime value as. */
export const PARAM = ':param'

/**
 * How the client scoped the path:
 *  - `none`     — used as written.
 *  - `hp`       — wrapped in `hp()`/`hubPath` of the *active* hub: becomes
 *                 `/api/hubs/:id/…`, or the bare path when no hub is active.
 *                 `path` is the bare form.
 *  - `explicit` — the client already named a hub; `path` is the scoped form.
 */
export type HubScoping = 'none' | 'hp' | 'explicit'

export interface ResolvedPath {
  path: string
  scoping: HubScoping
}

export interface CallSite {
  client: ClientId
  /** Repo-relative file. */
  file: string
  line: number
  /** Upper-case verb, or `*` when the verb could not be determined (path-only check). */
  method: string
  /** Every runtime shape of the path (ternaries and `if`/`else` produce several). */
  paths: ResolvedPath[]
  /** Set instead of `paths` when the call cannot be evaluated statically. */
  unresolved?: { expr: string; reason: string }
  /**
   * The path is the enclosing request function's own parameter, handed straight
   * to another request function. Not checkable here, but every caller of the
   * outer function is a call site of its own — so it is listed, not failed.
   */
  passThrough?: boolean
  /** `literal`: no recognised request call, a stray `"/api/…"` string found by the sweep. */
  kind?: 'call' | 'literal'
}

export interface MountedRoute {
  method: string
  path: string
}

export interface Finding {
  client: ClientId
  file: string
  line: number
  method: string
  /** The path as the client sends it (or, for `unresolved`, the source expression). */
  path: string
  category: Category
  nearest: string
  detail: string
  passThrough?: boolean
}

interface IndexedRoute extends MountedRoute {
  segs: string[]
}

export interface RouteIndex {
  routes: IndexedRoute[]
}

export function segmentsOf(path: string): string[] {
  return path.split('?')[0].split('/').filter(Boolean)
}

export function buildRouteIndex(routes: MountedRoute[]): RouteIndex {
  return { routes: routes.map(r => ({ ...r, method: r.method.toUpperCase(), segs: segmentsOf(r.path) })) }
}

const isServerParam = (s: string) => s.startsWith(':')
const isDynamic = (s: string) => s.includes(PARAM)
/** A literal that looks like an operation name, as opposed to an id someone hard-coded. */
const looksLikeOperation = (s: string) => /^[a-z][a-z0-9-]*$/.test(s)

interface SegmentMatch {
  route: IndexedRoute
  /** Client literals that only matched because a server `:param` swallowed them. */
  captured: string[]
  /** Client runtime values that landed on a server *literal* segment (a weak, coincidental fit). */
  loose: number
}

function matchSegments(index: RouteIndex, clientSegs: string[]): SegmentMatch[] {
  const out: SegmentMatch[] = []
  for (const route of index.routes) {
    const wildcard = route.segs[route.segs.length - 1] === '*'
    if (wildcard ? clientSegs.length < route.segs.length - 1 : route.segs.length !== clientSegs.length) continue
    const captured: string[] = []
    let loose = 0
    let ok = true
    for (let i = 0; i < clientSegs.length && ok; i++) {
      const s = route.segs[Math.min(i, route.segs.length - 1)]
      const c = clientSegs[i]
      if (s === '*') continue
      if (isServerParam(s)) {
        if (!isDynamic(c)) captured.push(c)
      } else if (isDynamic(c)) loose++
      else if (c !== s) ok = false
    }
    if (ok) out.push({ route, captured, loose })
  }
  return out
}

type FormResult =
  | { status: 'ok' }
  | { status: 'shadowed'; route: IndexedRoute; literals: string[] }
  | { status: 'wrong-verb'; routes: IndexedRoute[] }
  | { status: 'none' }

function evaluateForm(index: RouteIndex, method: string, path: string): FormResult {
  // A runtime value that lands on a literal segment and ALSO leaves a literal swallowed by a :param
  // is two coincidences stacked; it is not evidence that the route exists.
  const matches = matchSegments(index, segmentsOf(path)).filter(m => m.loose === 0 || m.captured.length === 0)
  const verbOk = matches.filter(m => method === '*' || m.route.method === method || m.route.method === 'ALL')
  if (verbOk.some(m => m.captured.length === 0)) return { status: 'ok' }
  const shadowed = verbOk.find(m => m.loose === 0 && m.captured.some(looksLikeOperation))
  if (shadowed) {
    return { status: 'shadowed', route: shadowed.route, literals: shadowed.captured.filter(looksLikeOperation) }
  }
  if (verbOk.length > 0) return { status: 'ok' } // an id-shaped literal landing on a :param is a real id
  if (matches.length > 0) {
    // Report the routes that fit the path best: a dynamic client segment should land on a :param.
    const fit = (r: IndexedRoute) => segmentsOf(path).filter((c, i) => isDynamic(c) && !isServerParam(r.segs[Math.min(i, r.segs.length - 1)])).length
    const best = Math.min(...matches.map(m => fit(m.route)))
    return { status: 'wrong-verb', routes: matches.map(m => m.route).filter(r => fit(r) === best) }
  }
  return { status: 'none' }
}

/** `/api/x` -> `/api/hubs/:param/x`; `/x` -> `/hubs/:param/x`. */
export function scopeToHub(path: string): string {
  return path.startsWith('/api/') ? `/api/hubs/${PARAM}${path.slice(4)}` : `/hubs/${PARAM}${path}`
}

/** `/api/hubs/:param/x` -> `/api/x`, or undefined when the path is not hub-scoped. */
export function unscopeFromHub(path: string): string | undefined {
  const m = /^(\/api)?\/hubs\/[^/]+(\/.*)$/.exec(path)
  return m ? `${m[1] ?? ''}${m[2]}` : undefined
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return row[b.length]
}

/** The mounted route most like `method path`: longest shared prefix, then same verb, then edit distance. */
export function nearestRoute(index: RouteIndex, method: string, path: string): string {
  const want = segmentsOf(path)
  let best: { score: number; label: string } | undefined
  for (const r of index.routes) {
    let shared = 0
    while (
      shared < want.length && shared < r.segs.length &&
      (isDynamic(want[shared]) || isServerParam(r.segs[shared]) || want[shared] === r.segs[shared])
    ) shared++
    const score =
      shared * 100 +
      (method === '*' || r.method === method ? 25 : 0) -
      Math.abs(want.length - r.segs.length) * 8 -
      distance(want.join('/'), r.segs.join('/'))
    if (!best || score > best.score) best = { score, label: `${r.method} ${r.path}` }
  }
  return best?.label ?? '(none)'
}

function verbList(routes: IndexedRoute[]): string {
  return [...new Set(routes.map(r => r.method))].sort().join('/')
}

interface Verdict {
  category: Category
  detail: string
  nearest: string
}

/** Classify one runtime shape of a call. `undefined` means it matches. */
function classifyPath(index: RouteIndex, method: string, rp: ResolvedPath): Verdict | undefined {
  if (rp.scoping === 'hp') return classifyHubWrapped(index, method, rp.path)

  const direct = evaluateForm(index, method, rp.path)
  if (direct.status === 'ok') return undefined
  if (direct.status === 'shadowed') {
    return {
      category: 'shadowed-by-param-route',
      detail: `no route of its own; answered by ${direct.route.method} ${direct.route.path} with "${direct.literals.join('", "')}" as the parameter (returns 200, not 404)`,
      nearest: `${direct.route.method} ${direct.route.path}`,
    }
  }
  if (direct.status === 'wrong-verb') {
    return {
      category: 'wrong-verb',
      detail: `path is mounted, but only for ${verbList(direct.routes)}`,
      nearest: direct.routes.map(r => `${r.method} ${r.path}`).sort().join(' | '),
    }
  }

  if (!rp.path.startsWith('/api/') && rp.path !== '/api') {
    const prefixed = `/api${rp.path.startsWith('/') ? '' : '/'}${rp.path}`
    const withApi = evaluateForm(index, method, prefixed)
    if (withApi.status !== 'none') {
      return {
        category: 'missing-/api-prefix',
        detail: `the router mounts everything under /api; ${prefixed} exists${withApi.status === 'wrong-verb' ? ' (for another verb)' : ''}`,
        nearest: nearestRoute(index, method, prefixed),
      }
    }
  }

  const bare = unscopeFromHub(rp.path)
  if (bare && evaluateForm(index, method, bare).status === 'ok') {
    return {
      category: 'hub-scope-mismatch',
      detail: `the client names a hub, but this route is mounted only unscoped (${bare})`,
      nearest: nearestRoute(index, method, bare),
    }
  }
  const scoped = scopeToHub(rp.path)
  if (!bare && evaluateForm(index, method, scoped).status === 'ok') {
    return {
      category: 'hub-scope-mismatch',
      detail: `this route is mounted only hub-scoped (${scoped}); the client sends it unscoped`,
      nearest: nearestRoute(index, method, scoped),
    }
  }
  return { category: 'unmounted', detail: 'no mounted route has this path', nearest: nearestRoute(index, method, rp.path) }
}

/** `hp()` — scoped when a hub is active, bare when not; both must exist. */
function classifyHubWrapped(index: RouteIndex, method: string, barePath: string): Verdict | undefined {
  const scopedPath = scopeToHub(barePath)
  const scoped = evaluateForm(index, method, scopedPath)
  const bare = evaluateForm(index, method, barePath)
  if (scoped.status === 'ok' && bare.status === 'ok') return undefined
  if (scoped.status === 'ok') {
    return {
      category: 'hub-scope-mismatch',
      detail: `hp() sends ${barePath} when no hub is active, and that route is mounted only hub-scoped (${scopedPath})`,
      nearest: nearestRoute(index, method, scopedPath),
    }
  }
  if (bare.status === 'ok') {
    return {
      category: 'hub-scope-mismatch',
      detail: `hp() wraps a route that is mounted only unscoped: ${scopedPath} does not exist`,
      nearest: nearestRoute(index, method, barePath),
    }
  }
  // Neither form is fully mounted: report the more specific of the two failures.
  for (const [form, p] of [[bare, barePath], [scoped, scopedPath]] as const) {
    if (form.status === 'shadowed') {
      return {
        category: 'shadowed-by-param-route',
        detail: `no route of its own; answered by ${form.route.method} ${form.route.path} (returns 200, not 404)`,
        nearest: `${form.route.method} ${form.route.path}`,
      }
    }
    if (form.status === 'wrong-verb') {
      return {
        category: 'wrong-verb',
        detail: `${p} is mounted, but only for ${verbList(form.routes)}`,
        nearest: form.routes.map(r => `${r.method} ${r.path}`).sort().join(' | '),
      }
    }
  }
  return { category: 'unmounted', detail: 'neither the hub-scoped nor the bare path is mounted', nearest: nearestRoute(index, method, barePath) }
}

/** Format the path the way a person would write the call: `hp(/api/x)` for hub-wrapped. */
export function displayPath(rp: ResolvedPath): string {
  return rp.scoping === 'hp' ? `hp(${rp.path})` : rp.path
}

/** Every mismatch of one call site. Empty when the call lines up with the router. */
export function checkCall(index: RouteIndex, call: CallSite): Finding[] {
  const base = { client: call.client, file: call.file, line: call.line, method: call.method }
  if (call.unresolved !== undefined || call.paths.length === 0) {
    return [{
      ...base,
      path: call.unresolved?.expr ?? '(no path)',
      category: 'unresolved',
      nearest: '-',
      detail: `${call.unresolved?.reason ?? 'no path'}; the guard did not check this call`,
      ...(call.passThrough ? { passThrough: true } : {}),
    }]
  }
  const findings: Finding[] = []
  const seen = new Set<string>()
  for (const rp of call.paths) {
    const verdict = classifyPath(index, call.method, rp)
    if (!verdict) continue
    const key = `${displayPath(rp)}|${verdict.category}`
    if (seen.has(key)) continue
    seen.add(key)
    findings.push({
      ...base,
      path: displayPath(rp),
      ...verdict,
      detail: call.kind === 'literal' ? `${verdict.detail} [stray "/api/…" literal, verb unknown]` : verdict.detail,
    })
  }
  return findings
}
