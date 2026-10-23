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
 *   bun scripts/api-schema-binding/contract-guard.ts            # exit 1 on any NEW mismatch
 *   bun scripts/api-schema-binding/contract-guard.ts --all      # also list allowlisted and baselined rows
 *   bun scripts/api-schema-binding/contract-guard.ts --json     # machine-readable
 *
 * Output rows: `client | file:line | method+path | nearest mounted route | category`.
 * `file:line` is the line of the request call; the path argument is usually a
 * line or two below it.
 *
 * Two files hold rows that do not fail, and they mean opposite things:
 *
 *  - `contract-allowlist.json`: rows that are CORRECT. Each one carries the
 *    reason it is correct.
 *  - `contract-baseline.json`: rows that are BROKEN and were already broken when
 *    the guard landed. Each one carries the issue that owns fixing it. This is a
 *    shrink-only ratchet. Entries are enumerated one per call site, with no
 *    wildcards. Each entry absorbs exactly one finding. A fixed row that is still
 *    listed fails the run, so the file can only get shorter.
 *
 * An entry in either file that no longer matches anything fails the run, so
 * neither file can retain dead rows.
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
const BASELINE_FILE = join(import.meta.dirname, 'contract-baseline.json')

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

type RowKey = Pick<AllowlistEntry, 'client' | 'file' | 'method' | 'path' | 'category'>
const entryKey = (e: RowKey) => [e.client, e.file, e.method, e.path, e.category].join('\u0000')
/** The order the baseline must be written in, so an insertion cannot hide in the middle of an unordered list. */
const compareRows = (a: RowKey, b: RowKey) =>
  a.client.localeCompare(b.client) || a.file.localeCompare(b.file) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method) || a.category.localeCompare(b.category)

/** A known-broken call site, frozen when the guard landed. `unresolved` rows are unchecked, not known-broken, so they cannot be baselined. */
export interface BaselineEntry extends RowKey {
  category: Exclude<Category, 'unresolved'>
  /** The open issue that owns fixing this call. Must be a key of `owners`. */
  issue: number
}

export interface Baseline {
  /** Must equal `entries.length`. Any change to the baseline therefore shows up as a changed number in the diff. */
  size: number
  /** Issue number to one-line title. Every entry's `issue` must be here, and every owner must still own at least one entry. */
  owners: Record<string, string>
  entries: BaselineEntry[]
}

/** The baseline file is part of the guard. If it is missing, the guard has been tampered with, so this fails rather than treating it as empty. */
export function loadBaseline(file = BASELINE_FILE): Baseline {
  const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<Baseline>
  return { size: raw.size ?? Number.NaN, owners: raw.owners ?? {}, entries: raw.entries ?? [] }
}

/** Problems with the baseline itself: a miscounted size, an unowned entry, an owner with nothing left, a row out of order. */
export function validateBaseline(b: Baseline): string[] {
  const problems: string[] = []
  if (b.size !== b.entries.length) {
    problems.push(`"size" is ${b.size} but the baseline lists ${b.entries.length} entries. Set "size" to the real count, so the change is visible in review`)
  }
  const usedOwners = new Set<string>()
  b.entries.forEach((e, i) => {
    const where = `baseline entry #${i + 1} (${e.client} ${e.file} ${e.method} ${e.path})`
    if (!CLIENTS.includes(e.client)) problems.push(`${where}: unknown client`)
    if (!CATEGORIES.includes(e.category)) problems.push(`${where}: unknown category "${e.category}"`)
    else if ((e.category as Category) === 'unresolved') problems.push(`${where}: an unresolved call is unchecked, not known-broken. It cannot be baselined; resolve it or allowlist it with a reason`)
    if (!Number.isInteger(e.issue) || e.issue <= 0) problems.push(`${where}: "issue" must name the issue that owns fixing it`)
    else if (!(String(e.issue) in b.owners)) problems.push(`${where}: issue #${e.issue} is not listed in "owners"`)
    else usedOwners.add(String(e.issue))
    if (i > 0 && compareRows(b.entries[i - 1], e) > 0) problems.push(`${where}: out of order. Entries are sorted by client, file, path, method, category`)
  })
  for (const n of Object.keys(b.owners)) {
    if (!usedOwners.has(n)) problems.push(`owner #${n} owns no baseline entry. Its rows are fixed, so remove it from "owners"`)
  }
  return problems
}

export interface GuardResult {
  findings: Finding[]
  failing: Finding[]
  allowed: { finding: Finding; entry: AllowlistEntry }[]
  /** Known-broken rows still present, each absorbed by exactly one baseline entry. */
  baselined: { finding: Finding; entry: BaselineEntry }[]
  passThrough: Finding[]
  stale: AllowlistEntry[]
  /** Baseline entries that no longer reproduce. The call was fixed, so the entry must be deleted. */
  staleBaseline: BaselineEntry[]
  allowlistProblems: string[]
  baselineProblems: string[]
  /** Declared baseline owners, for the per-issue count. */
  baselineOwners: Record<string, string>
  /** An extractor found suspiciously little — see FLOORS. */
  extractionProblems: string[]
  counts: { routes: number; sites: Record<ClientId, number> }
}

export function evaluate(routes: MountedRoute[], calls: CallSite[], allowlist: AllowlistEntry[], baseline: Baseline): GuardResult {
  const index = buildRouteIndex(routes)
  const findings = calls
    .flatMap(c => checkCall(index, c))
    .sort((a, b) => a.client.localeCompare(b.client) || a.file.localeCompare(b.file) || a.line - b.line || a.path.localeCompare(b.path))

  const byKey = new Map(allowlist.map(e => [entryKey(e), e]))
  const used = new Set<string>()
  // A multiset: two identical broken calls in one file need two entries. A third
  // identical call is a new defect, so it must not be absorbed by the first two.
  const unclaimed = new Map<string, BaselineEntry[]>()
  for (const e of baseline.entries) unclaimed.set(entryKey(e), [...(unclaimed.get(entryKey(e)) ?? []), e])
  const failing: Finding[] = []
  const allowed: GuardResult['allowed'] = []
  const baselined: GuardResult['baselined'] = []
  const passThrough: Finding[] = []
  for (const f of findings) {
    if (f.passThrough) {
      passThrough.push(f)
      continue
    }
    const key = entryKey(f)
    const entry = byKey.get(key)
    const known = entry ? undefined : unclaimed.get(key)?.shift()
    if (entry) {
      used.add(key)
      allowed.push({ finding: f, entry })
    } else if (known) baselined.push({ finding: f, entry: known })
    else failing.push(f)
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
    baselined,
    passThrough,
    stale: allowlist.filter(e => !used.has(entryKey(e))),
    staleBaseline: [...unclaimed.values()].flat().sort(compareRows),
    allowlistProblems: validateAllowlist(allowlist),
    baselineProblems: validateBaseline(baseline),
    baselineOwners: baseline.owners,
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
    out.push(
      `NEW mismatches (${result.failing.length}). These calls reach no mounted route and are not in the baseline. Fix the call.`,
      'Adding a row to contract-baseline.json ships a known-broken client call. Do that only with an owning issue and a reviewer who agrees.',
      'client | file:line | method+path | nearest mounted route | category',
      '---',
    )
    for (const f of result.failing) out.push(row(f))
    out.push('')
  }
  if (opts.all) {
    for (const { finding, entry } of result.allowed) out.push(`allowed: ${row(finding)}\n         reason: ${entry.reason}`)
    for (const { finding, entry } of result.baselined) out.push(`baselined (#${entry.issue}): ${row(finding)}`)
    for (const f of result.passThrough) out.push(`pass-through: ${row(f)}`)
    if (result.allowed.length || result.passThrough.length) out.push('')
  }
  for (const e of result.stale) out.push(`STALE allowlist entry (matches nothing — delete it or fix it): ${e.client} | ${e.file} | ${e.method} ${e.path} | ${e.category}`)
  for (const e of result.staleBaseline) {
    out.push(`FIXED baseline entry (no longer reproduces; delete it from contract-baseline.json and lower "size"): ${e.client} | ${e.file} | ${e.method} ${e.path} | ${e.category} | #${e.issue}`)
  }
  for (const p of result.allowlistProblems) out.push(`INVALID ${p}`)
  for (const p of result.baselineProblems) out.push(`INVALID baseline: ${p}`)
  for (const p of result.extractionProblems) out.push(`EXTRACTION ${p} — a client directory moved, or its call-site parser stopped matching`)

  const tally = new Map<string, number>()
  for (const f of result.failing) tally.set(`${f.client}/${f.category}`, (tally.get(`${f.client}/${f.category}`) ?? 0) + 1)
  out.push(
    `routes mounted: ${result.counts.routes}; call sites: ${Object.entries(result.counts.sites).map(([c, n]) => `${c} ${n}`).join(', ')}`,
    `new mismatches (not baselined): ${result.failing.length}` + (tally.size ? ` (${[...tally].sort().map(([k, n]) => `${k} ${n}`).join(', ')})` : ''),
    `allowlisted: ${result.allowed.length}; pass-through (checked at their callers): ${result.passThrough.length}; stale allowlist entries: ${result.stale.length}`,
    baselineLine(result),
  )
  return out.join('\n')
}

/** Always printed, so the baseline's size and direction are in every log. */
export function baselineLine(result: GuardResult): string {
  const perIssue = new Map(Object.keys(result.baselineOwners).map(n => [n, 0]))
  for (const { entry } of result.baselined) perIssue.set(String(entry.issue), (perIssue.get(String(entry.issue)) ?? 0) + 1)
  const breakdown = [...perIssue].sort(([a], [b]) => Number(a) - Number(b)).map(([n, c]) => `#${n} ${c}`).join(', ')
  return `baseline (shrink-only): ${result.baselined.length} known-broken calls still to fix (${breakdown}); fixed but still listed: ${result.staleBaseline.length}`
}

/** True when the run must fail. A new mismatch, a stale or malformed entry in either file, or an extractor that found too little all fail it. */
export function failed(r: GuardResult): boolean {
  return Boolean(
    r.failing.length || r.stale.length || r.staleBaseline.length || r.allowlistProblems.length || r.baselineProblems.length || r.extractionProblems.length,
  )
}

export function main(argv: string[]): number {
  const { routes, unresolvedMounts } = loadMountedRoutes()
  if (unresolvedMounts.length) {
    console.error(`could not resolve ${unresolvedMounts.length} router mount(s); the route table is incomplete:\n${unresolvedMounts.join('\n')}`)
    return 2
  }
  const result = evaluate(routes, loadClientCalls(), loadAllowlist(), loadBaseline())
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ ...result, findings: undefined }, null, 2))
    console.error(baselineLine(result))
  } else console.log(render(result, { all: argv.includes('--all') }))
  return failed(result) ? 1 : 0
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
