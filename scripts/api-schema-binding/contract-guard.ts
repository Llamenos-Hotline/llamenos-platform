#!/usr/bin/env bun
/**
 * contract-guard.ts — the endpoint-contract guard (#1997).
 *
 * Every HTTP call in the desktop, iOS, Android and sip-bridge clients is
 * resolved to a method and path and matched against the routes the worker
 * actually mounts (read from the Hono route definitions in `apps/worker`, the
 * same table `app.ts` builds — not from the OpenAPI spec, which omits 82 of
 * them). A call that lines up with no route, or only with one it is shadowed
 * by, fails.
 *
 *   bun scripts/api-schema-binding/contract-guard.ts            # exit 1 on any mismatch
 *   bun scripts/api-schema-binding/contract-guard.ts --all      # also list allowlisted rows
 *   bun scripts/api-schema-binding/contract-guard.ts --json     # machine-readable
 *
 * Output rows: `client | file:line | method+path | nearest mounted route | category`.
 * `file:line` is the line of the request call; the path argument is usually a
 * line or two below it.
 *
 * Genuinely-correct rows go in `contract-allowlist.json`, each with the reason
 * it is correct. An entry that no longer matches anything fails the run, so a
 * reason cannot outlive the code it excused.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildRouteIndex, checkCall, type CallSite, type Category, type ClientId, type Finding, type MountedRoute } from './contract-match'
import { extractDesktopCalls, readDesktopSources } from './desktop-calls'
import { extractServerRoutes } from './extract-server-routes'
import { extractMobileCalls } from './mobile-calls'
import { extractBridgeCalls, readBridgeSources } from './sip-bridge-calls'

export const ROOT = resolve(import.meta.dirname, '../..')
const ALLOWLIST_FILE = join(import.meta.dirname, 'contract-allowlist.json')

const CATEGORIES: readonly Category[] = ['unmounted', 'missing-/api-prefix', 'wrong-verb', 'hub-scope-mismatch', 'shadowed-by-param-route', 'unresolved']
const CLIENTS: readonly ClientId[] = ['desktop', 'ios', 'android', 'sip-bridge']
const MIN_REASON = 30

/**
 * Floors on what the extractors must find. A renamed client directory or a
 * parser that stops recognising `request(` yields zero call sites and a
 * perfectly green run — the guard must fail instead. Set well under today's
 * counts (routes 829, desktop 390, ios 199, android 188, sip-bridge 11).
 */
export const FLOORS = { routes: 700, sites: { desktop: 300, ios: 150, android: 150, 'sip-bridge': 6 } } as const

export interface AllowlistEntry {
  client: ClientId
  file: string
  method: string
  /** The path exactly as printed in the report (`hp(/api/teams)`), or the source expression for `unresolved`. */
  path: string
  category: Category
  /** Why this row is correct. Required; it is what makes the entry reviewable. */
  reason: string
}

export function loadAllowlist(file = ALLOWLIST_FILE): AllowlistEntry[] {
  if (!existsSync(file)) return []
  return (JSON.parse(readFileSync(file, 'utf-8')) as { entries: AllowlistEntry[] }).entries
}

/** Problems with the allowlist itself — a missing reason, a typo'd category, a duplicate. */
export function validateAllowlist(entries: AllowlistEntry[]): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  entries.forEach((e, i) => {
    const where = `allowlist entry #${i + 1} (${e.client} ${e.file} ${e.method} ${e.path})`
    if (!CLIENTS.includes(e.client)) problems.push(`${where}: unknown client`)
    if (!CATEGORIES.includes(e.category)) problems.push(`${where}: unknown category "${e.category}"`)
    if (typeof e.reason !== 'string' || e.reason.trim().length < MIN_REASON) {
      problems.push(`${where}: "reason" is required and must say why this row is correct (at least ${MIN_REASON} characters)`)
    }
    const key = entryKey(e)
    if (seen.has(key)) problems.push(`${where}: duplicate entry`)
    seen.add(key)
  })
  return problems
}

const entryKey = (e: Pick<AllowlistEntry, 'client' | 'file' | 'method' | 'path' | 'category'>) =>
  [e.client, e.file, e.method, e.path, e.category].join('\u0000')

export interface GuardResult {
  findings: Finding[]
  failing: Finding[]
  allowed: { finding: Finding; entry: AllowlistEntry }[]
  passThrough: Finding[]
  stale: AllowlistEntry[]
  allowlistProblems: string[]
  /** An extractor found suspiciously little — see FLOORS. */
  extractionProblems: string[]
  counts: { routes: number; sites: Record<ClientId, number> }
}

export function evaluate(routes: MountedRoute[], calls: CallSite[], allowlist: AllowlistEntry[]): GuardResult {
  const index = buildRouteIndex(routes)
  const findings = calls
    .flatMap(c => checkCall(index, c))
    .sort((a, b) => a.client.localeCompare(b.client) || a.file.localeCompare(b.file) || a.line - b.line || a.path.localeCompare(b.path))

  const byKey = new Map(allowlist.map(e => [entryKey(e), e]))
  const used = new Set<string>()
  const failing: Finding[] = []
  const allowed: GuardResult['allowed'] = []
  const passThrough: Finding[] = []
  for (const f of findings) {
    if (f.passThrough) {
      passThrough.push(f)
      continue
    }
    const key = entryKey(f)
    const entry = byKey.get(key)
    if (entry) {
      used.add(key)
      allowed.push({ finding: f, entry })
    } else failing.push(f)
  }
  const sites = { desktop: 0, ios: 0, android: 0, 'sip-bridge': 0 } satisfies Record<ClientId, number>
  for (const c of calls) sites[c.client]++
  const extractionProblems: string[] = []
  if (routes.length < FLOORS.routes) extractionProblems.push(`only ${routes.length} routes mounted (expected at least ${FLOORS.routes})`)
  for (const c of CLIENTS) {
    if (sites[c] < FLOORS.sites[c]) extractionProblems.push(`only ${sites[c]} ${c} call sites found (expected at least ${FLOORS.sites[c]})`)
  }
  return {
    findings,
    failing,
    allowed,
    passThrough,
    stale: allowlist.filter(e => !used.has(entryKey(e))),
    allowlistProblems: validateAllowlist(allowlist),
    extractionProblems,
    counts: { routes: routes.length, sites },
  }
}

/** The mounted routes, as the router sees them. The root catch-all 404 (`app.all('*')`) is not an endpoint. */
export function loadMountedRoutes(): { routes: MountedRoute[]; unresolvedMounts: string[] } {
  const { routes, unresolvedMounts } = extractServerRoutes()
  return {
    routes: routes.filter(r => r.fullPath !== '/*').map(r => ({ method: r.method, path: r.fullPath })),
    unresolvedMounts,
  }
}

function walkFiles(dir: string, ext: string): string[] {
  const out: string[] = []
  const visit = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name)
      if (statSync(full).isDirectory()) visit(full)
      else if (name.endsWith(ext)) out.push(full)
    }
  }
  visit(dir)
  return out.sort()
}

export function loadClientCalls(root = ROOT): CallSite[] {
  const read = (dir: string, ext: string) =>
    walkFiles(join(root, dir), ext).map(f => ({ file: f.slice(root.length + 1), raw: readFileSync(f, 'utf-8') }))
  return [
    ...extractDesktopCalls(readDesktopSources(join(root, 'src/client'), root)),
    ...extractMobileCalls('ios', read('apps/ios/Sources', '.swift')),
    ...extractMobileCalls('android', read('apps/android/app/src/main', '.kt')),
    ...extractBridgeCalls(readBridgeSources(join(root, 'sip-bridge/src'), root)),
  ]
}

const row = (f: Finding) => [f.client, `${f.file}:${f.line}`, f.category === 'unresolved' ? `${f.path}` : `${f.method} ${f.path}`, f.nearest, f.category].join(' | ')

export function render(result: GuardResult, opts: { all?: boolean } = {}): string {
  const out: string[] = []
  if (result.failing.length) {
    out.push('client | file:line | method+path | nearest mounted route | category', '---')
    for (const f of result.failing) out.push(row(f))
    out.push('')
  }
  if (opts.all) {
    for (const { finding, entry } of result.allowed) out.push(`allowed: ${row(finding)}\n         reason: ${entry.reason}`)
    for (const f of result.passThrough) out.push(`pass-through: ${row(f)}`)
    if (result.allowed.length || result.passThrough.length) out.push('')
  }
  for (const e of result.stale) out.push(`STALE allowlist entry (matches nothing — delete it or fix it): ${e.client} | ${e.file} | ${e.method} ${e.path} | ${e.category}`)
  for (const p of result.allowlistProblems) out.push(`INVALID ${p}`)
  for (const p of result.extractionProblems) out.push(`EXTRACTION ${p} — a client directory moved, or its call-site parser stopped matching`)

  const tally = new Map<string, number>()
  for (const f of result.failing) tally.set(`${f.client}/${f.category}`, (tally.get(`${f.client}/${f.category}`) ?? 0) + 1)
  out.push(
    `routes mounted: ${result.counts.routes}; call sites: ${Object.entries(result.counts.sites).map(([c, n]) => `${c} ${n}`).join(', ')}`,
    `mismatches: ${result.failing.length}` + (tally.size ? ` (${[...tally].sort().map(([k, n]) => `${k} ${n}`).join(', ')})` : ''),
    `allowlisted: ${result.allowed.length}; pass-through (checked at their callers): ${result.passThrough.length}; stale allowlist entries: ${result.stale.length}`,
  )
  return out.join('\n')
}

export function main(argv: string[]): number {
  const { routes, unresolvedMounts } = loadMountedRoutes()
  if (unresolvedMounts.length) {
    console.error(`could not resolve ${unresolvedMounts.length} router mount(s); the route table is incomplete:\n${unresolvedMounts.join('\n')}`)
    return 2
  }
  const result = evaluate(routes, loadClientCalls(), loadAllowlist())
  if (argv.includes('--json')) console.log(JSON.stringify({ ...result, findings: undefined }, null, 2))
  else console.log(render(result, { all: argv.includes('--all') }))
  return result.failing.length || result.stale.length || result.allowlistProblems.length || result.extractionProblems.length ? 1 : 0
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
