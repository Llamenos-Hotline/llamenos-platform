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
    if (route.method !== method && route.method !== 'ALL') continue
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
 * iOS: `APIService.request(method: "PATCH", path: "/api/settings/spam", ...)`,
 * with the path optionally wrapped in `hp(...)` for the hub-scoped form.
 */
const SWIFT_CALL = /method:\s*"([A-Z]+)"\s*,\s*path:\s*(?:hp\()?"([^"]*)"/g

/**
 * Android: `apiService.request<T>("PATCH", "/api/settings/spam", body)` and
 * `requestNoContent("POST", hubPath("/api/shifts"), body)`.
 */
const KOTLIN_CALL =
  /request(?:NoContent)?(?:<[^>]*>)?\(\s*"([A-Z]+)"\s*,\s*(?:apiService\.)?(?:hubPath|hp)?\(?"([^"]*)"/g

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
  if (resolved.split('/').some(seg => seg.includes(PARAM) && seg !== PARAM)) return null
  return resolved
}

function scan(dir: string, extension: string, pattern: RegExp) {
  const resolvable: CallSite[] = []
  let skipped = 0
  for (const file of sourceFiles(dir, extension)) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(new RegExp(pattern.source, 'g'))) {
      const [, method, raw] = match
      const path = normalise(raw)
      if (path === null) {
        skipped++
        continue
      }
      resolvable.push({ method, path, file: relative(REPO_ROOT, file) })
    }
  }
  return { resolvable, skipped }
}

type Platform = 'iOS' | 'Android'

const scanned: Record<Platform, ReturnType<typeof scan>> = {
  iOS: scan('apps/ios/Sources', '.swift', SWIFT_CALL),
  Android: scan('apps/android/app/src/main/java', '.kt', KOTLIN_CALL),
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
  iOS: {
    // #1723 — the iOS call settings screen, fixed in its own pull request.
    'PUT /api/settings/call': '#1723',

    // #1701 — iOS admin screens against routes that do not exist. The members
    // and invite endpoints live under /api/users and /api/invites.
    'GET /api/identity/members': '#1701',
    'GET /api/identity/invites': '#1701',
    'POST /api/identity/invite': '#1701',
    'GET /api/recovery-group/shares/my': '#1701',

    // Also #1701, found by this test rather than by reading the client. All
    // three are live 404s on a real backend.
    [`PATCH /api/identity/${PARAM}/role`]: '#1701',
    [`POST /api/conversations/${PARAM}/read`]: '#1701',
  },
  Android: {
    // #1149 — Android admin screens against the /api/admin/* prefix, which
    // carries only security-events and devices/overview. The shift, audit and
    // invite (#1047) halves are fixed; bans, blasts and custom fields are not.
    'GET /api/admin/bans': '#1149',
    'POST /api/admin/bans': '#1149',
    'POST /api/admin/bans/bulk': '#1149',
    [`DELETE /api/admin/bans/${PARAM}`]: '#1149',
    'GET /api/admin/blasts': '#1149',
    'POST /api/admin/blasts': '#1149',
    'GET /api/admin/custom-fields': '#1149',
    'PUT /api/admin/custom-fields': '#1149',

    // Found by this test, on the run that introduced it — not by reading the
    // client. All six are live 404s on a real backend and none is an admin
    // settings screen, so they are recorded here rather than fixed in the same
    // change. `PUT /api/notes/:id` is a fifth instance of the wrong-verb defect
    // this test exists for: the server mounts `PATCH /api/notes/:id`.
    [`PUT /api/notes/${PARAM}`]: '#1730',
    [`POST /api/reports/${PARAM}/convert-to-case`]: '#1730',
    [`GET /api/contacts/${PARAM}/relationships`]: '#1730',
    [`GET /api/contacts/${PARAM}/timeline`]: '#1730',
    [`POST /api/conversations/${PARAM}/read`]: '#1730',
    [`POST /api/conversations/${PARAM}/close`]: '#1730',
    [`POST /api/conversations/${PARAM}/reopen`]: '#1730',
    [`POST /api/conversations/${PARAM}/assign`]: '#1730',
  },
}

const PLATFORMS: Platform[] = ['iOS', 'Android']

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
    // matched only against a `:param` — `PUT /api/shifts/fallback` IS mounted,
    // so a looser match would have called `PUT /api/shifts/$id` mounted, which
    // is the exact 404 a review caught by hand on #1722.
    expect(isMounted('PATCH', `/api/shifts/${PARAM}`)).toBe(true)
    expect(isMounted('PUT', `/api/shifts/${PARAM}`)).toBe(false)
    expect(isMounted('PUT', '/api/shifts/fallback')).toBe(true)
  })

  it.each(PLATFORMS)('%s: the scanner found call sites, so it is not silently matching nothing', platform => {
    expect(
      scanned[platform].resolvable.length,
      `no literal ${platform} call sites matched — has the client's API shape changed?`,
    ).toBeGreaterThan(30)
    // Interpolated paths are skipped rather than mis-resolved; there are always
    // some, and a zero here would mean the regex stopped seeing them.
    expect(scanned[platform].skipped).toBeGreaterThan(0)
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
