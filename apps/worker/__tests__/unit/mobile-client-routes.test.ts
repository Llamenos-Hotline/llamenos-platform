/**
 * #1728 — every literal route the mobile clients call, held against the
 * worker's real route table.
 *
 * Client and server already agree on *types*: `packages/protocol/schemas/`
 * is the single source and codegen emits the Swift and Kotlin models. Nothing
 * compared the other half of a request — its **method and path**. That is how
 * four separate instances of one defect coexisted with green CI:
 *
 *   - nine admin settings screens across iOS and Android sent `PUT` to paths
 *     the server mounts only under `PATCH`, or (`/api/settings/telephony`,
 *     `/api/admin/settings`) does not mount at all (#1724);
 *   - Android's admin shift update sent `PUT /api/shifts/:id` against a
 *     `PATCH`-only route, in a pull request whose own new test asserted the
 *     `PUT` and so pinned the 404 as the contract (#1722's review);
 *   - Android's admin screens called an `/api/admin/*` prefix that carries only
 *     security-events, devices and events (#1149);
 *   - 17 iOS paths were measured 404ing against a live backend (#1701).
 *
 * Each was found by running a client against a real server, one screen at a
 * time. This test finds them by reading the two sides: the route table comes
 * from the real Hono app (`apps/worker/app.ts`, which is importable without a
 * database — only its handlers touch one), and the call sites come from the
 * Swift and Kotlin sources. Neither side is restated by hand.
 *
 * It runs on the backend unit tier, which is where coverage actually exists on
 * a pull request: `ios-build-test`, `ios-e2e`, `android-build-test` and
 * `android-e2e` are all gated on `revalidate` (`ci.yml`), so on a PR they
 * report `skipping` (#1584).
 *
 * What it cannot see, stated so the green is not over-read: a path built by
 * string interpolation (`"/api/shifts/$id"`, `"/api/notes/\(id)"`) is skipped,
 * because the literal is not the path. The counts are asserted below, so a
 * regex that stops matching fails here instead of quietly covering nothing.
 */
import { describe, it, expect, vi } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// `apps/worker/app.ts` transitively imports `apps/worker/db`, which uses Bun's
// native SQL driver — unavailable under vitest's worker pool even via `bunx`.
// Stubbed the same way `dev-route-guard.test.ts` does: this test reads the
// route *table*, and no handler runs, so nothing here needs a connection.
vi.mock('@worker/db', () => ({
  createDatabase: vi.fn(),
  getDb: vi.fn(),
  closeDb: vi.fn(),
  schema: {},
}))

import app from '@worker/app'

const REPO_ROOT = join(__dirname, '../../../..')

// ── The server's side: the real route table ──────────────────────────────────

interface MountedRoute { method: string; path: string }

const mounted: MountedRoute[] = (() => {
  const seen = new Set<string>()
  const routes: MountedRoute[] = []
  // Hono lists one entry per handler, so a route with middleware repeats.
  for (const r of (app as unknown as { routes: MountedRoute[] }).routes) {
    const key = `${r.method} ${r.path}`
    if (seen.has(key)) continue
    seen.add(key)
    routes.push({ method: r.method, path: r.path })
  }
  return routes
})()

/**
 * A path segment the client builds at runtime — `"/api/shifts/$shiftId"` in
 * Kotlin, `"/api/notes/\(id)"` in Swift. Held as a sentinel rather than
 * discarded, because a parameterised path is exactly where the wrong-verb
 * defect hid: `PUT /api/shifts/:id` is not mounted while
 * `PUT /api/shifts/fallback` is, so dropping these would have missed it.
 */
const PARAM = '\u0000'

/**
 * The verb of a call whose verb the scanner cannot see — `activeHubPath("/api/records")`
 * handed to a request a few lines away. Such a site is held to the weaker claim that SOME
 * verb is mounted on the path; it still catches a path that is not mounted at all, and it
 * still holds the hub-scoping rule, which has nothing to do with the verb.
 */
const ANY_VERB = '*'

/** The path as a reader should see it, sentinels rendered. */
const readable = (path: string) => path.replaceAll(PARAM, '{}')

/**
 * Does the app mount `method path`?
 *
 * Segment by segment. A `PARAM` segment matches ONLY a `:param` segment on the
 * server, never a literal one: a client that interpolates an id into that
 * position needs the parameterised route to exist, and matching a sibling
 * literal route would be the false negative that let `PUT /api/shifts/:id`
 * pass because `PUT /api/shifts/fallback` happens to exist.
 */
function isMounted(method: string, path: string): boolean {
  const wanted = path.split('/')
  for (const route of mounted) {
    if (method !== ANY_VERB && route.method !== method && route.method !== 'ALL') continue
    const have = route.path.split('/')
    if (have.length !== wanted.length) continue
    const matches = wanted.every((segment, i) => {
      const server = have[i]
      if (segment === PARAM) return server.startsWith(':')
      return server.startsWith(':') || server === segment
    })
    if (matches) return true
  }
  return false
}

// ── The clients' side: literal method/path pairs in the sources ──────────────

interface CallSite { method: string; path: string; file: string }

function sourceFiles(dir: string, extension: string): string[] {
  const out: string[] = []
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (full.endsWith(extension)) out.push(full)
    }
  }
  walk(join(REPO_ROOT, dir))
  return out
}

/**
 * How a client reaches a route, as the wrapper around the path literal:
 *
 *   - `activeHubPath(...)` and `hubPath(hubId, ...)` always call the hub-scoped
 *     route and never fall back to the bare path (#2395, #2478), so that is the route
 *     checked;
 *   - `hp(...)` falls back to the bare path with no hub, so its literal is checked as
 *     written.
 *
 * A call site is therefore a *wrapper + literal* pair, and the shapes around that pair
 * (`try`, `apiService.`, `appState.apiService.`, `APIService.`, a leading `hubId,`) are
 * noise the matcher must tolerate — it learned that the hard way: converting 31 iOS
 * call sites to `path: try apiService.activeHubPath(...)` stopped `SWIFT_CALL` matching
 * them, and every assertion below passed over nothing (#2478's review).
 */
const SCOPING_WRAPPERS = new Set(['activeHubPath', 'hubPath'])

/** Swift: any qualifier chain, with an optional `try` / `try?` in front. */
const SWIFT_PATH_EXPR =
  String.raw`(?:try[?!]?\s+)?(?:[A-Za-z_]\w*\.)*(?:(?<wrapper>hp|activeHubPath|hubPath)\(\s*(?:[\w.]+\s*,\s*)?)?"(?<path>[^"]*)"`

/**
 * iOS: `apiService.request(method: "PATCH", path: <expr>, ...)`, where `<expr>` is a path
 * literal optionally wrapped as above.
 */
const SWIFT_CALL = new RegExp(String.raw`method:\s*"(?<method>[A-Z]+)"\s*,\s*path:\s*${SWIFT_PATH_EXPR}`)

/**
 * iOS: `var path = try apiService.activeHubPath("/api/contacts") + "?page=1"` and
 * `request(method: "GET", path: path)` a few lines later. The method belongs to that
 * later call, so it is found by looking forward for the first call that consumes `name`.
 */
const SWIFT_ASSIGNED_PATH = new RegExp(String.raw`\b(?:var|let)\s+(?<name>[A-Za-z_]\w*)\s*=\s*${SWIFT_PATH_EXPR}`)

/** iOS: a hub-scoping wrapper around a literal, wherever it appears. Verb unseen. */
const SWIFT_WRAPPED_PATH =
  /(?:try[?!]?\s+)?(?:[A-Za-z_]\w*\.)*(?<wrapper>hp|activeHubPath|hubPath)\(\s*(?:[\w.]+\s*,\s*)?"(?<path>[^"]*)"/

/**
 * iOS: `apiService.getHubOwned("/api/ring-groups", as: ...)` — a GET of a hub-owned
 * resource in the active hub (#2478). Like `activeHubPath(...)`, it always calls the
 * hub-scoped route, so that is the route checked.
 */
const SWIFT_HUB_OWNED_GET = /getHubOwned\(\s*"(?<path>[^"]*)"/

/** Kotlin: any qualifier chain; `hubPath(hubId, ...)` carries the hub as its first argument. */
const KOTLIN_PATH_EXPR =
  String.raw`(?:[A-Za-z_]\w*\.)*(?:(?<wrapper>hubPath|hp|activeHubPath)\(\s*(?:[\w.?!]+\s*,\s*)?)?"(?<path>[^"]*)"`

/**
 * Android: `apiService.request<T>("PATCH", "/api/settings/spam", body)` and
 * `requestNoContent("POST", hubPath("/api/shifts"), body)`.
 */
const KOTLIN_CALL = new RegExp(
  String.raw`request(?:NoContent)?(?:<[^()]*>)?\(\s*"(?<method>[A-Z]+)"\s*,\s*${KOTLIN_PATH_EXPR}`,
)

/** Android: a hub-scoping wrapper around a literal, wherever it appears. Verb unseen. */
const KOTLIN_WRAPPED_PATH = /(?:[A-Za-z_]\w*\.)*(?<wrapper>hubPath|hp|activeHubPath)\(\s*(?:[\w.?!]+\s*,\s*)?"(?<path>[^"]*)"/

/** Android: `request<T>(method = "GET", path = "/api/config", ...)`, with named arguments. */
const KOTLIN_NAMED_CALL = new RegExp(
  String.raw`request(?:NoContent)?(?:<[^()]*>)?\(\s*method\s*=\s*"(?<method>[A-Z]+)"\s*,\s*path\s*=\s*${KOTLIN_PATH_EXPR}`,
)

/**
 * Android: `val notesPath = if (...) apiService.hubPath(hubId, "/api/notes") else ...`
 * and `request("GET", notesPath)` after it; the verb is the first later call to consume
 * the variable.
 */
const KOTLIN_ASSIGNED_PATH = new RegExp(String.raw`\b(?:val|var)\s+(?<name>[A-Za-z_]\w*)\s*(?::\s*String\s*)?=\s*(?:if\s*\([^)]*\)\s*)?${KOTLIN_PATH_EXPR}`)

const toHubPath = (path: string) => path.replace(/^\/api\//, `/api/hubs/${PARAM}/`)

/**
 * Normalise a client path literal: strip any query string, and replace each
 * interpolation with `PARAM`.
 *
 * Returns `null` for anything that is not a route we can resolve — a path that
 * does not start with `/api/`, or one left with interpolation syntax we did not
 * recognise (rather than guessing at it).
 */
function normalise(raw: string): string | null {
  const path = raw.split('?')[0]
  if (!path.startsWith('/api/')) return null
  const resolved = path
    // Kotlin: "${expr}" then "$name"
    .replace(/\$\{[^}]*\}/g, PARAM)
    .replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, PARAM)
    // Swift: "\(expr)"
    .replace(/\\\([^)]*\)/g, PARAM)
  if (resolved.includes('$') || resolved.includes('\\(')) return null
  // A segment that mixes literal text with an interpolation is not a path
  // segment we can reason about — `"/api/analytics/me$query"` appends a query
  // string, it does not add a segment. Skipped rather than guessed at.
  const segments = resolved.split('/')
  if (segments.some(seg => seg.includes(PARAM) && seg !== PARAM)) return null
  return resolved
}

/**
 * A call-site pattern. Its named groups: `path` (the literal, required), `wrapper`, and
 * `method`. A pattern with no `method` group says how to find one: a fixed verb, or the
 * request that later consumes the assigned variable.
 */
interface CallPattern {
  pattern: RegExp
  /** `'GET'`: every match is a hub-owned GET. `'assigned'`: the verb is the later consumer's. */
  method?: 'GET' | 'assigned'
  /** Matches only literals no earlier pattern accounted for; their verb is `ANY_VERB`. */
  fallback?: true
}

const call = (pattern: RegExp): CallPattern => ({ pattern })

/**
 * The call that first consumes a variable holding a path — `request(method: "X", path: name`
 * or `getHubOwned(name` in Swift, `request<T>("X", name` in Kotlin — and the verb it sends.
 * Undefined when nothing consumes the variable that way: the literal then stays unmatched
 * and the census below says so, rather than being guessed at.
 */
function consumer(source: string, from: number, name: string, language: 'swift' | 'kotlin'): { method: string; scoped: boolean } | undefined {
  const consuming =
    language === 'swift'
      ? new RegExp(String.raw`method:\s*"(?<method>[A-Z]+)"\s*,\s*path:\s*${name}\b|(?<hubOwned>getHubOwned)\(\s*${name}\b`)
      : new RegExp(String.raw`request(?:NoContent)?(?:<[^()]*>)?\(\s*"(?<method>[A-Z]+)"\s*,\s*${name}\b`)
  const found = consuming.exec(source.slice(from))?.groups
  if (!found) return undefined
  return found.hubOwned ? { method: 'GET', scoped: true } : { method: found.method, scoped: false }
}

/** Every `"/api/..."` string literal in a client source, wherever it appears. */
const API_LITERAL = /"(\/api\/[^"]*)"/g

interface Unmatched { file: string; literal: string }

function scan(dir: string, extension: string, patterns: CallPattern[]) {
  const resolvable: CallSite[] = []
  const unmatched: Unmatched[] = []
  const runtimeVerbs = new Set<string>()
  let skipped = 0
  let literals = 0
  for (const file of sourceFiles(dir, extension)) {
    const source = readFileSync(file, 'utf8')
    const name = relative(REPO_ROOT, file)
    // Where each path literal starts, for the ones some pattern accounted for.
    const accounted = new Set<number>()
    for (const { pattern, method: fixed, fallback } of patterns) {
      for (const match of source.matchAll(new RegExp(pattern.source, 'gd'))) {
        const pathAt = (match as RegExpMatchArray & { indices: { groups: Record<string, [number, number]> } }).indices.groups.path[0]
        if (fallback && accounted.has(pathAt)) continue
        const groups = match.groups as { path: string; wrapper?: string; method?: string; name?: string }
        const via = fixed === 'assigned' ? consumer(source, match.index + match[0].length, groups.name ?? '', extension === '.swift' ? 'swift' : 'kotlin') : undefined
        const method = groups.method ?? (fallback ? ANY_VERB : fixed === 'GET' ? 'GET' : via?.method)
        if (method === undefined) continue
        accounted.add(pathAt)
        const path = normalise(groups.path)
        if (path === null) {
          skipped++
          continue
        }
        // Two interpolations side by side — `"/api/calls/${call.id}/$action"` — is a verb
        // chosen at runtime. The server does declare routes with adjacent parameters
        // (`/ivr-audio/:promptType/:language`), so this is not skipped by shape: each such
        // path is named and pinned in RUNTIME_VERB_PATHS, and each concrete verb is checked
        // where it is written out.
        const scoped = SCOPING_WRAPPERS.has(groups.wrapper ?? '') || fixed === 'GET' || via?.scoped === true
        const resolved = scoped ? toHubPath(path) : path
        if (resolved.includes(PARAM + '/' + PARAM)) {
          runtimeVerbs.add(readable(resolved))
          continue
        }
        resolvable.push({ method, path: resolved, file: name })
      }
    }
    for (const literal of source.matchAll(API_LITERAL)) {
      // A path quoted in a comment is documentation, not a request.
      const lineStart = source.lastIndexOf('\n', literal.index) + 1
      const before = source.slice(lineStart, literal.index)
      if (before.includes('//') || /^\s*(?:\*|\/\*)/.test(before)) continue
      literals++
      if (!accounted.has(literal.index + 1)) unmatched.push({ file: name, literal: literal[1] })
    }
  }
  return { resolvable, skipped, unmatched, runtimeVerbs: [...runtimeVerbs], literals }
}

type Platform = 'iOS' | 'Android'

const scanned: Record<Platform, ReturnType<typeof scan>> = {
  iOS: scan('apps/ios/Sources', '.swift', [
    call(SWIFT_CALL),
    { pattern: SWIFT_ASSIGNED_PATH, method: 'assigned' },
    { pattern: SWIFT_HUB_OWNED_GET, method: 'GET' },
    { pattern: SWIFT_WRAPPED_PATH, fallback: true },
  ]),
  Android: scan('apps/android/app/src/main/java', '.kt', [
    call(KOTLIN_CALL),
    call(KOTLIN_NAMED_CALL),
    { pattern: KOTLIN_ASSIGNED_PATH, method: 'assigned' },
    { pattern: KOTLIN_WRAPPED_PATH, fallback: true },
  ]),
}

/** Deduplicated `METHOD path`, with one example call site each. */
function distinct(sites: CallSite[]): Map<string, string> {
  const byRoute = new Map<string, string>()
  for (const site of sites) {
    const key = `${site.method} ${site.path}`
    if (!byRoute.has(key)) byRoute.set(key, site.file)
  }
  return byRoute
}

// ── Known gaps, each with the issue that tracks it ───────────────────────────

/**
 * Routes a mobile client calls that the server does not mount, which this
 * change does not fix. Every entry is a live 404 on a real backend.
 *
 * Keyed **by platform**, which is not decoration: a single shared list let an
 * exemption written for one client silently excuse the identical defect in the
 * other. Measured — with `PUT /api/settings/spam` listed once for iOS,
 * reverting Android's spam save from `PATCH` to `PUT` left this test green.
 *
 * It is also deliberately an EXACT list, not a floor: the tests below assert
 * each entry is still unmounted AND still reached by that platform, so an entry
 * whose client has been fixed turns this red until it is deleted. It cannot rot
 * into a blanket exemption.
 */
const KNOWN_UNMOUNTED: Record<Platform, Record<string, string>> = {
  iOS: {},
  // The blasts composer was rebuilt on createBlastBodySchema against the
  // hub-scoped /blasts routes (#1997), which emptied this list.
  Android: {},
}

const PLATFORMS: Platform[] = ['iOS', 'Android']

/**
 * `"/api/..."` literals in the client sources that are NOT a request call the scanner
 * can read, each with why. Keyed by `file  "literal"`.
 *
 * This is the other half of "the scanner is not silently matching nothing". Counting
 * matches proves the scanner matched *something*; it cannot tell that a refactor moved
 * thirty calls out of its sight, because the count merely drops from 100 to 70 and 70 is
 * still "more than 30". This list is exact instead: every path literal in the sources is
 * either matched as a call or named here, so a call whose shape the scanner stops
 * recognising turns this red by name.
 *
 * Like KNOWN_UNMOUNTED it is an exact list, not a floor: an entry the scanner now matches
 * (or whose literal is gone) fails until it is deleted, so it cannot rot into a blanket
 * exemption.
 */
const UNSCANNED_LITERALS: Record<Platform, Record<string, string>> = {
  iOS: {
    'apps/ios/Sources/App/AppState.swift  "/api/users"': 'UI-test bootstrap: the harness admin registers the test device through sendAsTestAdmin, not APIService',
    'apps/ios/Sources/App/AppState.swift  "/api/hubs/\\(hubId)/members"': 'UI-test bootstrap: the harness admin adds the test device to the hub',
    'apps/ios/Sources/Services/APIService.swift  "/api/health"': 'reachability probe built with appendingPathComponent, before any hub exists',
    'apps/ios/Sources/Services/APIService.swift  "/api/config"': 'public config fetch built with appendingPathComponent, before any hub exists',
    'apps/ios/Sources/Services/HubOnboardAPI.swift  "/api/hubs/\\(hubId)/onboard\\(suffix)"': 'a path-building helper; the suffix is chosen by its callers',
    'apps/ios/Sources/Services/InviteEnrollmentService.swift  "/api/invites/redeem"': 'a named constant (redeemPath) consumed by a later call',
    'apps/ios/Sources/Services/SecurityEventService.swift  "/api/security-events"': 'a security-event POST built with appendingPathComponent on the unauthenticated queue',
  },
  Android: {
    'apps/android/app/src/main/java/org/llamenos/hotline/api/ApiService.kt  "/api/"': 'the prefix test inside hubPath() itself, not a request',
    'apps/android/app/src/main/java/org/llamenos/hotline/api/ApiService.kt  "/api/hubs/$hubId${path.removePrefix("': 'hubPath() itself: the hub-scoping implementation, not a request',
    'apps/android/app/src/main/java/org/llamenos/hotline/api/HubOnboardApi.kt  "/api/hubs/$hubId/onboard$suffix"': 'a path-building helper; the suffix is chosen by its callers',
  },
}

/**
 * Paths a client builds with an interpolated verb right after an interpolated id —
 * `"/api/calls/${call.id}/$action"`. No route can be matched against that shape, so the
 * path is pinned here instead of silently skipped: a NEW such path fails until it is
 * reviewed and listed, and a listed one that is gone fails until it is deleted.
 */
const RUNTIME_VERB_PATHS: Record<Platform, string[]> = {
  iOS: [],
  Android: ['/api/hubs/{}/calls/{}/{}'],
}

const unscannedKey = ({ file, literal }: Unmatched) => `${file}  "${literal}"`

/**
 * How many distinct `METHOD path` routes the scanner must find, in total and under each
 * hub-owned router. Measured against the sources when this was written (#2478).
 *
 * The census above proves no path literal went unread; this proves the reading did not
 * collapse. The failure it exists for is a client refactor — a new wrapper, a constants
 * enum, `path:` moved behind a builder — that leaves the scanner matching a fraction of the
 * calls: each assertion still passes on what it can see, and the rest is never checked.
 * Under a per-router floor that shows up as "iOS: records 13 → 0", by name.
 *
 * It is a ratchet, not a target. Lower a number only because a client really dropped calls,
 * and say so in the commit; raise it when a client gains them. A router a client does not
 * call (Android has no `events` or `ring-groups` screens) is deliberately absent.
 */
const CALL_FLOORS: Record<Platform, { total: number; scoped: Record<string, number> }> = {
  iOS: {
    total: 162,
    scoped: { notes: 2, reports: 6, contacts: 2, audit: 1, records: 13, events: 5, calls: 6, shifts: 14, 'ring-groups': 7 },
  },
  Android: {
    total: 131,
    scoped: { notes: 5, reports: 6, contacts: 2, audit: 1, records: 14, evidence: 1, calls: 3, shifts: 9 },
  },
}

describe('#1728 every literal route the mobile clients call is one the worker mounts', () => {
  it('the route table was read from the real app', () => {
    // A `routes` array that came back empty would make every assertion vacuous.
    expect(mounted.length).toBeGreaterThan(500)
    expect(isMounted('GET', '/api/settings/call')).toBe(true)
    expect(isMounted('PATCH', '/api/settings/call')).toBe(true)
    // And the negative, so "mounted" is a real predicate: the server defines no
    // PUT on that path, which is the whole of #1724.
    expect(isMounted('PUT', '/api/settings/call')).toBe(false)
    // Parameterised segments resolve, and a client-interpolated segment is
    // matched only against a `:param` — `PUT .../shifts/fallback` IS mounted,
    // so a looser match would have called `PUT .../shifts/$id` mounted, which
    // is the exact 404 a review caught by hand on #1722. Shifts are hub-only
    // (#2461), so the probe is the hub path, and the bare one is NOT mounted.
    const shifts = `/api/hubs/${PARAM}/shifts`
    expect(isMounted('PATCH', `${shifts}/${PARAM}`)).toBe(true)
    expect(isMounted('PUT', `${shifts}/${PARAM}`)).toBe(false)
    expect(isMounted('PUT', `${shifts}/fallback`)).toBe(true)
    expect(isMounted('PUT', '/api/shifts/fallback')).toBe(false)
  })

  it.each(PLATFORMS)('%s: the scanner found call sites, so it is not silently matching nothing', platform => {
    const found = distinct(scanned[platform].resolvable).size
    expect(
      found,
      `only ${found} distinct ${platform} routes matched (floor ${CALL_FLOORS[platform].total}) — ` +
        "has the client's API shape changed? Teach the matcher; do not lower the floor to fit.",
    ).toBeGreaterThanOrEqual(CALL_FLOORS[platform].total)
    // Interpolated paths are skipped rather than mis-resolved; there are always
    // some, and a zero here would mean the regex stopped seeing them.
    expect(scanned[platform].skipped).toBeGreaterThan(0)
  })

  it.each(PLATFORMS)('%s: every /api/ literal in the sources is matched as a call or accounted for', platform => {
    const exempt = UNSCANNED_LITERALS[platform]
    const unaccounted = [...new Set(scanned[platform].unmatched.map(unscannedKey))].filter(key => !(key in exempt))
    expect(
      unaccounted,
      `the ${platform} scanner cannot read these path literals as a request call. If a call's ` +
        'shape changed, teach the matcher the new shape — do not add the literal to ' +
        'UNSCANNED_LITERALS, which is only for literals that are not a request.',
    ).toEqual([])
  })

  it.each(PLATFORMS)('%s: every unscanned literal is still unscanned, so the list cannot outlive its entries', platform => {
    const present = new Set(scanned[platform].unmatched.map(unscannedKey))
    expect(
      Object.keys(UNSCANNED_LITERALS[platform]).filter(key => !present.has(key)),
      `the ${platform} scanner now matches these (or they are gone) — delete them from UNSCANNED_LITERALS.${platform}`,
    ).toEqual([])
  })

  it.each(PLATFORMS)('%s: paths with a runtime-chosen verb are exactly the known ones', platform => {
    expect(scanned[platform].runtimeVerbs).toEqual(RUNTIME_VERB_PATHS[platform])
  })

  // #2395: notes, reports, contacts, audit. #2461: records, events, evidence,
  // calls, shifts, ring groups — the server used to write those into hub ''.
  const HUB_OWNED = 'notes|reports|contacts|audit|records|events|evidence|calls|shifts|ring-groups'

  it.each(PLATFORMS)('%s calls hub-owned resources only under a hub (#2395, #2461)', platform => {
    const sites = scanned[platform].resolvable
    const hubOwned = new RegExp(`^/api/(${HUB_OWNED})(/|$)`)
    expect(
      sites.filter(s => hubOwned.test(s.path)).map(s => `${s.method} ${readable(s.path)} (${s.file})`),
      'these resources have no unscoped route: use activeHubPath(...), or hubPath(call.hubId, ...) for a call',
    ).toEqual([])
  })

  it.each(PLATFORMS)('%s: the scanner sees hub-scoped calls under every hub-owned router it has a floor for', platform => {
    // The assertion above is only as strong as the scanner's view of the scoped calls: it
    // passes when there are none. So each router is held to a floor of its own.
    const scoped = new Map<string, number>()
    for (const route of distinct(scanned[platform].resolvable).keys()) {
      const router = new RegExp(`^\\S+ /api/hubs/${PARAM}/(${HUB_OWNED})(?:/|$)`).exec(route)?.[1]
      if (router) scoped.set(router, (scoped.get(router) ?? 0) + 1)
    }
    const short = Object.entries(CALL_FLOORS[platform].scoped)
      .filter(([router, floor]) => (scoped.get(router) ?? 0) < floor)
      .map(([router, floor]) => `${router}: found ${scoped.get(router) ?? 0}, floor ${floor}`)
    expect(
      short,
      `the ${platform} scanner lost sight of hub-scoped calls — a call shape changed. Teach the matcher.`,
    ).toEqual([])
  })

  it.each(PLATFORMS)('%s calls only routes the worker mounts', platform => {
    const exempt = KNOWN_UNMOUNTED[platform]
    const unmounted: string[] = []
    for (const [route, file] of distinct(scanned[platform].resolvable)) {
      const [method, path] = route.split(' ')
      if (isMounted(method, path)) continue
      if (route in exempt) continue
      unmounted.push(`${readable(route)}   (${file})`)
    }
    expect(
      unmounted,
      `${platform} calls ${unmounted.length} route(s) the worker does not mount. Each is a ` +
        'live 404: the request fails and, on a write, nothing is stored. Either point the ' +
        'client at the route the server has, or add the route — do not add it to ' +
        'KNOWN_UNMOUNTED without an issue.',
    ).toEqual([])
  })

  it.each(PLATFORMS)('%s: every known gap is still a gap, so the list cannot outlive its fixes', platform => {
    const exempt = KNOWN_UNMOUNTED[platform]
    const fixed: string[] = []
    for (const route of Object.keys(exempt)) {
      const [method, path] = route.split(' ')
      if (isMounted(method, path)) fixed.push(`${readable(route)} (${exempt[route]})`)
    }
    expect(
      fixed,
      `these routes are now mounted — delete them from KNOWN_UNMOUNTED.${platform} so the sweep covers them`,
    ).toEqual([])
  })

  it.each(PLATFORMS)('%s: every known gap is still reached, so the list cannot outlive its callers', platform => {
    const called = new Set(distinct(scanned[platform].resolvable).keys())
    const orphaned = Object.keys(KNOWN_UNMOUNTED[platform])
      .filter(route => !called.has(route))
      .map(readable)
    expect(
      orphaned,
      `${platform} no longer calls these — delete them from KNOWN_UNMOUNTED.${platform}`,
    ).toEqual([])
  })

  it('the nine admin settings screens reach the routes the server really has', () => {
    // The specific claim of #1724, asserted rather than left to the sweep: these
    // are the method/path pairs both clients now use, and the verbs they used to
    // send are confirmed absent from the contract.
    for (const path of [
      '/api/settings/call',
      '/api/settings/spam',
      '/api/settings/transcription',
      '/api/settings/ivr-languages',
    ]) {
      expect(isMounted('GET', path), `GET ${path}`).toBe(true)
      expect(isMounted('PATCH', path), `PATCH ${path}`).toBe(true)
      expect(isMounted('PUT', path), `PUT ${path} must not exist`).toBe(false)
    }

    // Telephony's route is not missing — the screens named a path that never
    // existed. The read and the write both exist and the desktop uses them.
    expect(isMounted('GET', '/api/settings/telephony')).toBe(false)
    expect(isMounted('PUT', '/api/settings/telephony')).toBe(false)
    expect(isMounted('GET', '/api/settings/telephony-provider')).toBe(true)
    expect(isMounted('POST', '/api/provider-setup/configure')).toBe(true)

    // Android's transcription screen used a prefix that carries three routers.
    expect(isMounted('GET', '/api/admin/settings')).toBe(false)
    expect(isMounted('PUT', '/api/admin/settings/transcription')).toBe(false)
    expect(isMounted('GET', '/api/admin/security-events')).toBe(true)
  })
})
