/**
 * Must this PR form its OWN merge group? — the iOS isolation predicate behind
 * queue-feed's requirement 4 (#2548).
 *
 * TWO QUESTIONS, AND THE OLD RULE ANSWERED ONLY THE FIRST.
 *
 *  1. Does this PR SCHEDULE the iOS gate? A path question, answered by the
 *     shared platform map (`.github/scripts/detect-changed-platforms.sh`,
 *     `ios=true`). It is deliberately a blast-radius flag: `package.json`,
 *     anything under `scripts/`, every i18n locale and the release's
 *     `Info.plist` all set it, because none of them can be proven harmless
 *     to the iOS BUILD by a file name.
 *  2. Can this PR FAIL the iOS gate when main would not? A risk question.
 *     That is what isolation insures against: the queue-only iOS jobs
 *     (`ios-build-test`, `ios-e2e` — SKIPPED on `pull_request`, so a PR's
 *     own green checks say nothing about them) run on two Mac runners, and
 *     under ALLGREEN one red entry ejects the group, which can sit for the
 *     whole 240-minute check timeout and is rebuilt on dequeue.
 *
 * Isolating on (1) isolated 7 of 9 open PRs (#2548's count), including every
 * release (knope bumps `apps/ios/Sources/App/Info.plist`), every
 * string-adding PR (all 22 locales) and every CI-script change, which left
 * `max_entries_to_merge=5` inert. This module answers (2), and is consulted
 * only when (1) is true: a PR that does not schedule the gate cannot fail it.
 *
 * THE CONDITION: the diff changes something the queue-only iOS jobs EXECUTE,
 * in a way no `pull_request` check has already exercised. Enumerated from what
 * those jobs actually run, never from what a PR is "about":
 *
 *  - the iOS client itself — `apps/ios/**`: app sources, unit and UI tests,
 *    the project, the UI-test harness scripts and shard lists. The one
 *    exception is an `Info.plist` whose ONLY change is the version strings
 *    (`CFBundleShortVersionString` / `CFBundleVersion`), checked on the
 *    content, not the name: an `Info.plist` edit to ATS or URL schemes is
 *    exactly as risky as a Swift change;
 *  - what is compiled INTO the app: `packages/crypto/**` (UniFFI
 *    XCFramework), `packages/protocol/**` (Swift Codable types),
 *    `packages/i18n/**`'s generator and language table (`.strings`) — plus
 *    `packages/i18n/locales/en.json` when an EXISTING key's value changes or
 *    a key is removed: the UI tests launch in English
 *    (`BaseUITest`: `-AppleLanguages (en)`) and match English text
 *    (`label CONTAINS 'in progress'`, `CallSimulation` reads `en.lproj`).
 *    A key ADDED to en.json, and any non-English locale, cannot move an
 *    English-locale UI test; the locale data's validity is proven on
 *    `pull_request` by `build`'s `i18n:codegen` + `i18n:validate:all`;
 *  - the gate's own harness: `ios-e2e.yml`, the iOS jobs of `ci.yml` (and
 *    the `changes` job that decides whether and which tier they run), and
 *    every repo script those jobs run (`IOS_GATE_HARNESS` — bound to the
 *    workflow text by tests/orchestrator/ios-isolation.test.ts, transitively);
 *  - the toolchain the gate bootstraps on macOS: `bun.lock`, `.mise.toml`,
 *    `tsconfig*.json`, and `package.json` unless the only top-level keys that
 *    changed are `version` and `scripts` and no changed script is one the
 *    gate runs (`IOS_GATE_BUN_SCRIPTS`, closed over `bun run` and pre/post
 *    hooks).
 *
 * Everything else — backend, Android, desktop, other scripts, docs — is
 * inert for THIS question. Backend in particular is a conscious line, not an
 * oversight: `ios-e2e` does run against a backend built from the tree, but a
 * backend-only PR (`ios=false`) has never been isolated and is batched with
 * iOS work today; treating backend files as iOS risk only when a PR also
 * carries an iOS-scheduling file would be inconsistent, and treating them as
 * risk always would isolate most of the repo.
 *
 * FAILURE DIRECTION. Every read that cannot be made — a merge base, a file at
 * either side — answers ISOLATE. Isolation is the safe direction: it costs
 * throughput, never an ejected group.
 */

/** Scripts the queue-only iOS jobs run, by repo path. Bound to the
 *  workflow text (and closed transitively over the scripts' own references)
 *  by a test, so a new step that runs a new script fails CI here rather than
 *  silently becoming batchable. `apps/ios/**` and `packages/crypto/**` are
 *  risky as whole trees and need no entry. */
export const IOS_GATE_HARNESS: readonly string[] = [
  '.github/workflows/ios-e2e.yml',
  '.github/scripts/classify-infra-failure.py',
  '.github/scripts/detect-changed-platforms.sh',
  'scripts/ci/mac-runner-disk-guard.sh',
  'scripts/lib/server-hash-keys.sh',
  'scripts/run-migrations.ts',
]

/** `package.json` scripts the queue-only iOS jobs invoke by name (`bun run
 *  <name>`). Bound to the workflow text by a test. */
export const IOS_GATE_BUN_SCRIPTS: readonly string[] = ['codegen', 'i18n:codegen']

/** The `ci.yml` jobs that are part of the iOS gate: those that read the
 *  `ios` output or produce it. Derived from the file, never listed. */
const IOS_JOB_MARKER = /\boutputs\.ios\b/

export type ContentCheck = 'plist-version' | 'en-strings' | 'package-json' | 'ci-yml'

/** What one changed file means for question (2). */
export type IosGateFileClass =
  | { kind: 'inert' }
  | { kind: 'risky'; why: string }
  | { kind: 'content'; check: ContentCheck }

const CI_YML = '.github/workflows/ci.yml'
const EN_STRINGS = 'packages/i18n/locales/en.json'

export function classifyIosGateFile(path: string): IosGateFileClass {
  if (path.endsWith('.md')) return { kind: 'inert' }
  if (path.startsWith('apps/ios/')) {
    if (path.endsWith('/Info.plist')) return { kind: 'content', check: 'plist-version' }
    if (path.startsWith('apps/ios/Tests/UI/')) return { kind: 'risky', why: 'an iOS UI test or its harness' }
    if (path.startsWith('apps/ios/Tests/')) return { kind: 'risky', why: 'an iOS unit test (ios-build-test runs only in the queue)' }
    if (path.startsWith('apps/ios/scripts/')) return { kind: 'risky', why: 'an iOS gate script' }
    return { kind: 'risky', why: 'iOS app source or project' }
  }
  if (path.startsWith('packages/crypto/')) return { kind: 'risky', why: 'compiled into the app as the UniFFI XCFramework' }
  if (path.startsWith('packages/protocol/')) return { kind: 'risky', why: 'generates the Swift types compiled into the app' }
  if (path === EN_STRINGS) return { kind: 'content', check: 'en-strings' }
  if (/^packages\/i18n\/locales\/[^/]+\.json$/.test(path) || path === 'packages/i18n/deferred.json') {
    return { kind: 'inert' } // non-English: the UI tests launch in en; validity is proven on pull_request
  }
  if (path.startsWith('packages/i18n/')) return { kind: 'risky', why: 'generates the .strings compiled into the app' }
  if (path === CI_YML) return { kind: 'content', check: 'ci-yml' }
  if (IOS_GATE_HARNESS.includes(path)) return { kind: 'risky', why: 'run by the queue-only iOS jobs' }
  if (path === 'package.json') return { kind: 'content', check: 'package-json' }
  if (path === 'bun.lock' || path === '.mise.toml' || /^tsconfig[^/]*\.json$/.test(path)) {
    return { kind: 'risky', why: 'toolchain the iOS gate bootstraps on macOS' }
  }
  return { kind: 'inert' }
}

/** Paths a content check may read — the only ones `readFileAt` serves. */
export function isContentCheckedPath(path: string): boolean {
  const c = classifyIosGateFile(path)
  return c.kind === 'content' && !path.includes('..') && /^[A-Za-z0-9._/-]+$/.test(path)
}

// ---------------------------------------------------------------------------
// Content checks — pure. Each returns undefined when the change cannot move
// the iOS gate, or a description of what can.
// ---------------------------------------------------------------------------

const PLIST_VERSION = /(<key>(?:CFBundleShortVersionString|CFBundleVersion)<\/key>\s*<string>)[^<]*(<\/string>)/g

/** An `Info.plist` whose only change is its version strings. */
export function plistChangeBeyondVersion(base: string, head: string): string | undefined {
  const mask = (s: string): string => s.replace(PLIST_VERSION, '$1\u0000$2')
  return mask(base) === mask(head) ? undefined : 'changes more than CFBundleShortVersionString / CFBundleVersion'
}

function flatten(value: unknown, prefix: string, out: Map<string, string>): void {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix === '' ? k : `${prefix}.${k}`, out)
  } else {
    out.set(prefix, JSON.stringify(value))
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** en.json: keys only ADDED. A removed key or a changed English value can
 *  move a UI test that matches English text. */
export function enStringsChangeBeyondAdditions(base: string, head: string): string | undefined {
  const [b, h] = [parseJson(base), parseJson(head)]
  if (b === undefined || h === undefined) return 'is not parseable JSON on both sides'
  const [bm, hm] = [new Map<string, string>(), new Map<string, string>()]
  flatten(b, '', bm)
  flatten(h, '', hm)
  const changed = [...bm].filter(([k, v]) => hm.get(k) !== v).map(([k]) => k)
  if (changed.length === 0) return undefined
  return `changes or removes existing English string(s) (${changed.slice(0, 3).join(', ')}${changed.length > 3 ? `, +${changed.length - 3} more` : ''}) — the UI tests run in English and match its text`
}

const RUN_REF = /\b(?:bun|npm)\s+run\s+([A-Za-z0-9:_.-]+)/g

/** The gate's scripts, closed over `bun run <name>` references and npm
 *  lifecycle hooks, across both sides' script tables. */
function gateScriptClosure(tables: readonly Record<string, string>[]): Set<string> {
  const closure = new Set<string>(['preinstall', 'install', 'postinstall', 'prepare'])
  const pending = [...IOS_GATE_BUN_SCRIPTS]
  while (pending.length > 0) {
    const name = pending.pop() as string
    for (const n of [name, `pre${name}`, `post${name}`]) {
      if (closure.has(n)) continue
      closure.add(n)
      for (const t of tables) {
        const cmd = t[n]
        if (cmd === undefined) continue
        for (const m of cmd.matchAll(RUN_REF)) if (m[1] !== undefined) pending.push(m[1])
      }
    }
  }
  return closure
}

function scriptTable(pkg: Record<string, unknown>): Record<string, string> | undefined {
  const s = pkg.scripts
  if (s === undefined) return {}
  if (s === null || typeof s !== 'object' || Array.isArray(s)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(s)) {
    if (typeof v !== 'string') return undefined
    out[k] = v
  }
  return out
}

/** package.json: only `version` and non-gate `scripts` changed. */
export function packageJsonChangeReachingGate(base: string, head: string): string | undefined {
  const [b, h] = [parseJson(base), parseJson(head)]
  const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
  if (!isObj(b) || !isObj(h)) return 'is not a parseable JSON object on both sides'
  const keys = new Set([...Object.keys(b), ...Object.keys(h)])
  const otherChanged = [...keys].filter((k) => k !== 'version' && k !== 'scripts' && JSON.stringify(b[k]) !== JSON.stringify(h[k]))
  if (otherChanged.length > 0) return `changes ${otherChanged.join(', ')} — dependencies and toolchain the iOS gate installs`
  const [bs, hs] = [scriptTable(b), scriptTable(h)]
  if (bs === undefined || hs === undefined) return '"scripts" is not a string table on both sides'
  const names = new Set([...Object.keys(bs), ...Object.keys(hs)])
  const changed = [...names].filter((n) => bs[n] !== hs[n])
  const closure = gateScriptClosure([bs, hs])
  const reaching = changed.filter((n) => closure.has(n))
  return reaching.length === 0 ? undefined : `changes script(s) the iOS gate runs (${reaching.join(', ')})`
}

/** `ci.yml` split into its top-level job blocks and everything else. A block
 *  runs from its 2-space `name:` header under `jobs:` to the next header or
 *  the next top-level key. `undefined` when there is no `jobs:` map. */
export function ciJobBlocks(text: string): { jobs: Map<string, string>; rest: string } | undefined {
  const lines = text.split('\n')
  const jobs = new Map<string, string[]>()
  const rest: string[] = []
  let inJobs = false
  let current: string[] | undefined
  let sawJobs = false
  for (const line of lines) {
    if (/^\S/.test(line) && !line.startsWith('#')) {
      inJobs = /^jobs:\s*(#.*)?$/.test(line)
      sawJobs ||= inJobs
      current = undefined
      rest.push(line)
      continue
    }
    const header = inJobs ? /^ {2}([A-Za-z0-9_-]+):\s*(#.*)?$/.exec(line) : null
    if (header !== null) {
      current = []
      jobs.set(header[1] as string, current)
    }
    if (current !== undefined) current.push(line)
    else rest.push(line)
  }
  if (!sawJobs) return undefined
  return { jobs: new Map([...jobs].map(([k, v]) => [k, v.join('\n')])), rest: rest.join('\n') }
}

/** ci.yml: neither an iOS-gate job nor anything outside the jobs map (on:,
 *  env:, concurrency:, which every job inherits) changed. */
export function ciYmlChangeReachingGate(base: string, head: string): string | undefined {
  const [b, h] = [ciJobBlocks(base), ciJobBlocks(head)]
  if (b === undefined || h === undefined) return 'has no readable jobs: map on both sides'
  if (b.rest !== h.rest) return 'changes workflow-level configuration (outside any job) that the iOS jobs inherit'
  const iosJobs = new Set<string>()
  for (const side of [b, h]) for (const [name, block] of side.jobs) if (IOS_JOB_MARKER.test(block)) iosJobs.add(name)
  const changed = [...iosJobs].filter((j) => b.jobs.get(j) !== h.jobs.get(j)).sort()
  return changed.length === 0 ? undefined : `changes the iOS gate's job(s) ${changed.join(', ')}`
}

const CHECKS: Record<ContentCheck, (base: string, head: string) => string | undefined> = {
  'plist-version': plistChangeBeyondVersion,
  'en-strings': enStringsChangeBeyondAdditions,
  'package-json': packageJsonChangeReachingGate,
  'ci-yml': ciYmlChangeReachingGate,
}

// ---------------------------------------------------------------------------
// The verdict.
// ---------------------------------------------------------------------------

export type IosIsolation =
  /** Schedules the gate, but nothing in the diff can change its verdict. */
  | { isolate: false; checked: string[] }
  /** Each reason is `<file>: <why>`. */
  | { isolate: true; reasons: string[] }

export interface IosIsolationReads {
  /** The commit the PR's diff is taken from (`compare base...head`).
   *  `undefined` on failure. */
  readMergeBase(baseRef: string, headSha: string): Promise<string | undefined>
  /** A content-checked file's text at a commit. `undefined` on failure or
   *  when the file does not exist there (an added or deleted file is not a
   *  content-only change, so either answer isolates). */
  readFileAt(path: string, sha: string): Promise<string | undefined>
}

/**
 * Question (2) for a PR that answers yes to (1). Path rules first; content
 * is read only when no path alone already decides, and only for the four
 * content-checked shapes.
 */
export async function iosIsolationFor(
  files: readonly string[],
  pr: { baseRefName: string; headRefOid: string },
  reads: IosIsolationReads,
): Promise<IosIsolation> {
  const reasons: string[] = []
  const content: { path: string; check: ContentCheck }[] = []
  for (const f of files) {
    const c = classifyIosGateFile(f)
    if (c.kind === 'risky') reasons.push(`${f}: ${c.why}`)
    else if (c.kind === 'content') content.push({ path: f, check: c.check })
  }
  if (reasons.length > 0) return { isolate: true, reasons }
  if (content.length === 0) return { isolate: false, checked: [] }

  const base = await reads.readMergeBase(pr.baseRefName, pr.headRefOid)
  if (base === undefined) {
    return { isolate: true, reasons: [`${content.map((c) => c.path).join(', ')}: the merge base could not be read, so the content checks are unprovable`] }
  }
  for (const { path, check } of content) {
    const [before, after] = await Promise.all([reads.readFileAt(path, base), reads.readFileAt(path, pr.headRefOid)])
    if (before === undefined || after === undefined) {
      reasons.push(`${path}: could not be read at ${before === undefined ? 'the merge base' : 'the head'} (or is added/deleted) — not provably a content-only change`)
      continue
    }
    const why = CHECKS[check](before, after)
    if (why !== undefined) reasons.push(`${path}: ${why}`)
  }
  return reasons.length > 0 ? { isolate: true, reasons } : { isolate: false, checked: content.map((c) => c.path) }
}
