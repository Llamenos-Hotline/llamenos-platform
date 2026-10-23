/**
 * contract-guard.test.ts — the guard, proven by breaking it.
 *
 * Each "break it" case feeds a deliberately wrong client call through the REAL
 * extractor for that client and the REAL mounted-route table, and asserts the
 * guard reports the intended category. A guard that cannot fail on a seeded
 * defect proves nothing, so these are the tests that matter; the repo-wide run
 * is `bun scripts/api-schema-binding/contract-guard.ts` (workflow api-contract).
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { buildRouteIndex, checkCall, type CallSite, type Finding } from './contract-match'
import {
  evaluate,
  failed,
  FLOORS,
  loadAllowlist,
  loadBaseline,
  loadMountedRoutes,
  render,
  validateAllowlist,
  validateBaseline,
  type AllowlistEntry,
  type Baseline,
  type BaselineEntry,
} from './contract-guard'
import { extractDesktopCalls } from './desktop-calls'
import { extractMobileCalls } from './mobile-calls'
import { extractBridgeCalls } from './sip-bridge-calls'

let routes: ReturnType<typeof loadMountedRoutes>['routes']
beforeAll(() => {
  routes = loadMountedRoutes().routes
})

const check = (calls: CallSite[]): Finding[] => calls.flatMap(c => checkCall(buildRouteIndex(routes), c))
const swift = (body: string) => check(extractMobileCalls('ios', [{ file: 'Fixture.swift', raw: `final class Fixture {\n${body}\n}` }]))
const kotlin = (body: string) => check(extractMobileCalls('android', [{ file: 'Fixture.kt', raw: `class Fixture {\n${body}\n}` }]))
const desktop = (body: string) => check(extractDesktopCalls([{ file: 'fixture.ts', raw: body }]))
const only = (f: Finding[]) => {
  expect(f).toHaveLength(1)
  return f[0]
}

describe('route table', () => {
  test('is read from the router, not the OpenAPI spec', () => {
    const paths = new Set(routes.map(r => `${r.method.toUpperCase()} ${r.path}`))
    // Three of the 82 operations the generated spec lacks.
    expect(paths.has('GET /api/config/demo/credentials')).toBe(true)
    expect(routes.some(r => r.path.startsWith('/api/firehose'))).toBe(true)
    expect(routes.some(r => r.path.startsWith('/api/hubs/:hubId/firehose'))).toBe(true)
    // `telephony.all('/wait-music')` registers as ALL.
    expect(paths.has('ALL /api/telephony/wait-music')).toBe(true)
    // The catch-all 404 is not an endpoint — if it were, every path would "match".
    expect(routes.some(r => r.path === '/*')).toBe(false)
    expect(routes.length).toBeGreaterThanOrEqual(FLOORS.routes)
  })

  test('static table matches the routes the live Hono app registers', () => {
    const run = spawnSync('bun', [join(import.meta.dirname, 'live-router.ts')], { encoding: 'utf-8', cwd: join(import.meta.dirname, '../..') })
    expect(run.status, run.stderr).toBe(0)
    const live = (JSON.parse(run.stdout) as string[]).filter(r => !r.startsWith('ALL '))
    const liveSet = new Set(live)
    const staticSet = new Set(routes.filter(r => r.method.toUpperCase() !== 'ALL').map(r => `${r.method.toUpperCase()} ${r.path}`))
    // A route in the static table that the app does not register would let a call to it pass.
    expect([...staticSet].filter(r => !liveSet.has(r))).toEqual([])
    // A live route the static walk missed would be reported as a false "unmounted".
    expect([...liveSet].filter(r => !staticSet.has(r))).toEqual([])
  }, 120_000)
})

describe('break it: each seeded defect is caught', () => {
  test('path with /api omitted (Swift)', () => {
    const f = only(swift(`func load() async throws { let c: Config = try await api.request(method: "GET", path: "/settings/messaging") }`))
    expect(f.category).toBe('missing-/api-prefix')
    expect(f.nearest).toBe('GET /api/settings/messaging')
  })

  test('path with /api omitted (Kotlin)', () => {
    const f = only(kotlin(`suspend fun load() = apiService.request<Config>("GET", "/settings/messaging")`))
    expect(f.category).toBe('missing-/api-prefix')
  })

  test('wrong verb on a binary download (Kotlin requestBytes)', () => {
    // requestBytes is the signed binary-response entry point (call-recording audio). If the
    // guard did not know it as a callee, its path would be checked only as a stray literal
    // with no verb — and a POST to a GET-only route would pass.
    const f = only(kotlin(`suspend fun audio(id: String) = apiService.requestBytes("POST", apiService.hp("/api/calls/$id/recording"))`))
    expect(f.category).toBe('wrong-verb')
  })

  test('PUT where the route is PATCH (Kotlin, hp-wrapped)', () => {
    const f = only(kotlin(`suspend fun save(id: String) = apiService.request<Note>("PUT", apiService.hp("/api/notes/$id"))`))
    expect(f.category).toBe('wrong-verb')
    expect(f.nearest).toContain('PATCH /api/notes/:id')
  })

  test('PUT where the route is PATCH (desktop)', () => {
    const f = only(desktop(`import { request, hp } from './client'\nexport const save = (id: string) => request(hp(\`/directory/\${id}\`), { method: 'PUT' })`))
    expect(f.category).toBe('wrong-verb')
  })

  test('hp() on a route mounted only unscoped (desktop)', () => {
    const f = only(desktop(`import { request, hp } from './client'\nexport const enroll = () => request(hp('/recovery-group/enroll'), { method: 'POST' })`))
    expect(f.category).toBe('hub-scope-mismatch')
    expect(f.detail).toContain('mounted only unscoped')
  })

  test('hp() on a route mounted only unscoped (Swift)', () => {
    const f = only(swift(`func enroll() async throws { try await request(method: "POST", path: hp("/api/recovery-group/enroll")) }`))
    expect(f.category).toBe('hub-scope-mismatch')
  })

  test('an unscoped call to a route mounted only hub-scoped', () => {
    const f = only(desktop(`import { request } from './client'\nexport const teams = () => request('/teams')`))
    expect(f.category).toBe('hub-scope-mismatch')
    expect(f.detail).toContain('mounted only hub-scoped')
  })

  test('GET /api/contacts/search is shadowed by GET /api/contacts/:hash (all four clients)', () => {
    for (const f of [
      swift(`func s() async throws { try await api.request(method: "GET", path: hp("/api/contacts/search")) }`),
      kotlin(`suspend fun s() = apiService.request<R>("GET", apiService.hp("/api/contacts/search"))`),
      desktop(`import { request, hp } from './client'\nexport const s = () => request(hp('/contacts/search'))`),
    ]) {
      const found = only(f)
      expect(found.category).toBe('shadowed-by-param-route')
      expect(found.detail).toContain('returns 200')
    }
  })

  test('a mounted route with an id in the param position is NOT shadowing', () => {
    expect(desktop(`import { request, hp } from './client'\nexport const g = (h: string) => request(hp(\`/contacts/\${h}\`))`)).toEqual([])
  })

  test('a route that does not exist at all is unmounted, with the nearest route named', () => {
    const f = only(kotlin(`suspend fun x(id: String) = apiService.request<R>("POST", "/api/conversations/$id/close")`))
    expect(f.category).toBe('unmounted')
    expect(f.nearest).toContain('/api/conversations/:id')
  })

  test('a correct call produces no finding, and the ALL verb matches any method', () => {
    expect(swift(`func ok() async throws { try await api.request(method: "GET", path: hp("/api/calls/active")) }`)).toEqual([])
    expect(swift(`func ok() async throws { try await api.request(method: "POST", path: "/api/telephony/wait-music") }`)).toEqual([])
  })
})

describe('call-site parsing follows the way the clients build paths', () => {
  test('a multi-line request with a path assigned lines earlier', () => {
    const f = only(swift(`
      func load(id: String) async throws {
          let base = "/settings/messaging"
          let path = base + "/test"
          let r: R = try await api.request(
              method: "POST",
              path: path,
              body: nil
          )
      }`))
    expect(f.category).toBe('missing-/api-prefix')
    expect(f.path).toBe('/settings/messaging/test')
  })

  test('Kotlin buildString with a conditional query piece', () => {
    expect(kotlin(`
      suspend fun list(q: String?) {
          val query = buildString {
              append(apiService.hp("/api/records"))
              append("?limit=50")
              q?.let { append("&q=$it") }
          }
          apiService.request<R>("GET", query)
      }`)).toEqual([])
  })

  test('both arms of a ternary are checked', () => {
    const f = only(swift(`func go(edit: Bool, id: String) async throws {
        try await api.request(method: "GET", path: edit ? "/api/calls/active" : "/api/calls/\\(id)/nope")
    }`))
    expect(f.category).toBe('unmounted')
    expect(f.path).toBe('/api/calls/:param/nope')
  })

  test('a local helper that builds the path is inlined with its arguments', () => {
    const f = only(kotlin(`
      private fun onboardPath(suffix: String = ""): String = "/api/hubs/$hubId/onboard$suffix"
      suspend fun a() = apiService.request<R>("GET", onboardPath("/nope"))
      suspend fun b() = apiService.request<R>("POST", onboardPath())
    `))
    expect(f.path).toBe('/api/hubs/:param/onboard/nope')
  })

  test('a private hubPath() that only appends a query is not read as hub scoping', () => {
    expect(kotlin(`
      private fun hubPath(path: String): String = if (hubId != null) "$path?hubId=$hubId" else path
      suspend fun status(p: String) = apiService.request<R>("GET", hubPath("/api/provider-setup/status/$p"))
    `)).toEqual([])
  })

  test('a comment is not a call', () => {
    expect(swift(`// try await api.request(method: "GET", path: "/nope")\nfunc a() {}`)).toEqual([])
  })

  test('an unconsumed "/api/…" literal is still checked (verb unknown)', () => {
    const f = only(kotlin(`val url = "$baseUrl/api/recordings/$id/audio"`))
    expect(f.category).toBe('unmounted')
    expect(f.method).toBe('*')
  })

  test('desktop: getApiUrl + netFetch takes its verb from the options', () => {
    const f = only(desktop(`
      import { netFetch } from './net'
      import { getApiUrl } from './api-config'
      export const go = () => netFetch(getApiUrl('/admin/events/migrate'), { method: 'POST' })`))
    expect(f.method).toBe('POST')
    expect(f.category).toBe('unmounted')
  })

  test('sip-bridge: callback tables are checked, a dynamic index is checked against every value', () => {
    const files = [
      { file: 'sip-bridge/src/types.ts', raw: `export const CALLBACK_PATHS = { a: '/api/telephony/captcha', b: '/api/telephony/nope' } as const` },
      { file: 'sip-bridge/src/webhook-sender.ts', raw: `export class W { async sendWebhook(path: string) { return fetch(path, { method: 'POST' }) } }` },
      { file: 'sip-bridge/src/command-handler.ts', raw: `import { CALLBACK_PATHS } from './types'\nexport class H { go(e: keyof typeof CALLBACK_PATHS) { return this.post(CALLBACK_PATHS[e], {}) } }` },
    ]
    const f = only(check(extractBridgeCalls(files)))
    expect(f.category).toBe('unmounted')
    expect(f.path).toBe('/api/telephony/nope')
    expect(f.method).toBe('POST')
  })
})

describe('unresolved calls are reported, never passed', () => {
  test('a path that is only a runtime value', () => {
    const f = only(swift(`func replay(op: Op) async throws { try await api.rawRequest(method: op.method, path: op.path, body: nil) }`))
    expect(f.category).toBe('unresolved')
    expect(f.passThrough).toBeUndefined()
  })

  test('a forwarder of its own parameter is listed as pass-through, not dropped', () => {
    const f = only(swift(`func request(method: String, path: String) async throws { try await request(method: method, path: path, body: nil) }`))
    expect(f.category).toBe('unresolved')
    expect(f.passThrough).toBe(true)
  })
})

const noBaseline: Baseline = { size: 0, owners: {}, entries: [] }

describe('allowlist', () => {
  const route = (method: string, path: string) => ({ method, path })
  const call = (path: string): CallSite => ({ client: 'ios', file: 'A.swift', line: 3, method: 'GET', paths: [{ path, scoping: 'none' }] })
  const floorsOk = (): CallSite[] => {
    const filler: CallSite[] = []
    for (const [client, n] of Object.entries(FLOORS.sites)) {
      for (let i = 0; i < n; i++) filler.push({ client: client as CallSite['client'], file: 'ok', line: i, method: 'GET', paths: [{ path: '/api/ok', scoping: 'none' }] })
    }
    return filler
  }
  const table = [route('GET', '/api/ok'), ...Array.from({ length: FLOORS.routes }, (_, i) => route('GET', `/api/r${i}`))]
  const entry = (over: Partial<AllowlistEntry> = {}): AllowlistEntry => ({
    client: 'ios', file: 'A.swift', method: 'GET', path: '/api/gone', category: 'unmounted',
    reason: 'This route is intentionally absent on the server until the feature ships behind a flag.', ...over,
  })

  test('an entry silences exactly its row and a missing reason is rejected', () => {
    const calls = [...floorsOk(), call('/api/gone')]
    expect(evaluate(table, calls, [], noBaseline).failing).toHaveLength(1)
    expect(evaluate(table, calls, [entry()], noBaseline).failing).toHaveLength(0)
    expect(validateAllowlist([entry({ reason: '' })])[0]).toContain('"reason" is required')
    expect(validateAllowlist([entry({ reason: 'ok' })])[0]).toContain('"reason" is required')
    expect(validateAllowlist([entry(), entry()].slice(0, 2)).some(p => p.includes('duplicate'))).toBe(true)
  })

  test('an entry that matches nothing is stale and fails the run', () => {
    expect(evaluate(table, floorsOk(), [entry()], noBaseline).stale).toHaveLength(1)
  })

  test('too few call sites or routes fails instead of passing vacuously', () => {
    expect(evaluate(table, [], [], noBaseline).extractionProblems.length).toBeGreaterThan(0)
    expect(evaluate([route('GET', '/api/ok')], floorsOk(), [], noBaseline).extractionProblems.length).toBeGreaterThan(0)
  })

  test('the committed allowlist is well formed and every row carries its reason', () => {
    const entries = loadAllowlist()
    expect(validateAllowlist(entries)).toEqual([])
    expect(entries.length).toBeGreaterThan(0)
  })
})

describe('baseline: a shrink-only ratchet of known-broken calls', () => {
  const table = [{ method: 'GET', path: '/api/ok' }, ...Array.from({ length: FLOORS.routes }, (_, i) => ({ method: 'GET', path: `/api/r${i}` }))]
  const floorsOk: CallSite[] = Object.entries(FLOORS.sites).flatMap(([client, n]) =>
    Array.from({ length: n }, (_, i): CallSite => ({ client: client as CallSite['client'], file: 'ok', line: i, method: 'GET', paths: [{ path: '/api/ok', scoping: 'none' }] })),
  )
  const broken = (path: string, line = 3): CallSite => ({ client: 'ios', file: 'A.swift', line, method: 'GET', paths: [{ path, scoping: 'none' }] })
  const known = (path: string, over: Partial<BaselineEntry> = {}): BaselineEntry => ({ client: 'ios', file: 'A.swift', method: 'GET', path, category: 'unmounted', issue: 1997, ...over })
  const baseline = (...entries: BaselineEntry[]): Baseline => ({ size: entries.length, owners: { '1997': 'the contract audit' }, entries })

  test('(a) a mismatch that is not in the baseline fails the run', () => {
    const r = evaluate(table, [...floorsOk, broken('/api/gone'), broken('/api/new-defect')], [], baseline(known('/api/gone')))
    expect(r.failing.map(f => f.path)).toEqual(['/api/new-defect'])
    expect(failed(r)).toBe(true)
    expect(render(r)).toContain('NEW mismatches (1)')
  })

  test('(b) a baselined call that was fixed fails the run until its entry is deleted', () => {
    const r = evaluate(table, floorsOk, [], baseline(known('/api/gone')))
    expect(r.failing).toEqual([])
    expect(r.staleBaseline).toEqual([known('/api/gone')])
    expect(failed(r)).toBe(true)
    expect(render(r)).toContain('FIXED baseline entry')
  })

  test('(c) the baselined set passes, and its size is printed with a per-issue count', () => {
    const r = evaluate(table, [...floorsOk, broken('/api/gone')], [], baseline(known('/api/gone')))
    expect(r.baselined).toHaveLength(1)
    expect(failed(r)).toBe(false)
    expect(render(r)).toContain('baseline (shrink-only): 1 known-broken calls still to fix (#1997 1)')
  })

  test('each entry absorbs exactly one call: a third identical broken call fails', () => {
    const two = baseline(known('/api/gone'), known('/api/gone'))
    expect(failed(evaluate(table, [...floorsOk, broken('/api/gone', 3), broken('/api/gone', 9)], [], two))).toBe(false)
    const r = evaluate(table, [...floorsOk, broken('/api/gone', 3), broken('/api/gone', 9), broken('/api/gone', 20)], [], two)
    expect(r.failing.map(f => f.line)).toEqual([20])
    // And one of two identical calls fixed leaves one stale entry.
    expect(evaluate(table, [...floorsOk, broken('/api/gone', 3)], [], two).staleBaseline).toHaveLength(1)
  })

  test('an entry matches on client, file, method, path and category, never on a prefix', () => {
    const r = evaluate(table, [...floorsOk, broken('/api/gone/deeper')], [], baseline(known('/api/gone')))
    expect(r.failing.map(f => f.path)).toEqual(['/api/gone/deeper'])
    expect(r.staleBaseline).toHaveLength(1)
  })

  test('the file rejects an unowned entry, a stale owner, a miscounted size, an unresolved row and an out-of-order row', () => {
    expect(validateBaseline(baseline(known('/api/a')))).toEqual([])
    expect(validateBaseline(baseline(known('/api/a', { issue: 0 })))[0]).toContain('"issue" must name the issue')
    expect(validateBaseline(baseline(known('/api/a', { issue: 4242 })))[0]).toContain('#4242 is not listed in "owners"')
    expect(validateBaseline({ ...baseline(known('/api/a')), owners: { '1997': 'x', '1': 'fixed' } })).toEqual([
      'owner #1 owns no baseline entry. Its rows are fixed, so remove it from "owners"',
    ])
    expect(validateBaseline({ ...baseline(known('/api/a')), size: 2 })[0]).toContain('"size" is 2 but the baseline lists 1')
    expect(validateBaseline(baseline(known('/api/a', { category: 'unresolved' as BaselineEntry['category'] })))[0]).toContain('cannot be baselined')
    expect(validateBaseline(baseline(known('/api/b'), known('/api/a'))).some(p => p.includes('out of order'))).toBe(true)
    // A malformed baseline fails the run even when every call matches.
    expect(failed(evaluate(table, [...floorsOk, broken('/api/a')], [], { ...baseline(known('/api/a')), size: 5 }))).toBe(true)
  })

  test('the committed baseline is well formed and every entry is owned by an issue', () => {
    const b = loadBaseline()
    expect(validateBaseline(b)).toEqual([])
    expect(b.entries.every(e => String(e.issue) in b.owners)).toBe(true)
  })
})
