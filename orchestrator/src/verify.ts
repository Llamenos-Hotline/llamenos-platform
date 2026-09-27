import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve as resolvePath, sep } from 'node:path'
import { checkScopeAcross } from './scope.js'
import { classifyImpact } from './impact.js'
import { NEVER_WRITE_PATHS, GRANT_EXCLUDED_PATHS } from './config.js'
import type { Lane } from './config.js'

const execFileAsync = promisify(execFile)

export interface VerifyInput {
  /**
   * Where git runs. This must be a TRUSTED checkout: in CI it is the PR's
   * BASE commit, never the head. Everything this function decides — the
   * changed-file list, and therefore scope, never-write and impact — is
   * computed by git here, from repository history, with no code from the
   * commit under judgement executing anywhere.
   */
  worktree: string
  /** The right-hand side of the diff range. In CI this is the PR's head SHA,
   *  fetched into the base checkout as an object — not checked out. */
  branch: string
  /** The left-hand side of the diff range. Defaults to `origin/main`; CI
   *  passes the PR's base SHA so the range is exactly the PR's own change. */
  base?: string
  lane: Lane
  /**
   * Lanes this PR has been explicitly granted in addition to `lane`, from its
   * `scope:<lane>` labels (#1115). A cross-lane change — a permission fix that
   * spans the shared module, the server enforcing it and the client consuming
   * it — is legitimate work the lane model previously could not express at
   * all: the author's only options were to stray and be hard-blocked, or to
   * split the change into PRs that cannot merge atomically.
   *
   * A grant widens which lane's ownership a file may satisfy. It never
   * weakens `NEVER_WRITE_PATHS`, and it cannot be self-issued from the diff:
   * labels live outside the commit, so the gate reads them from the API and
   * fails closed (no grants) when they cannot be read.
   */
  grantedLanes?: Lane[]
  /**
   * Scope and impact only — used by the `fleet/review` CI job, where
   * `fleet/verify` is the job that runs the diff-targeted tests and running
   * them a second time buys no extra signal. A report produced this way has
   * `testsRun: []` and `testsPassed: undefined`, so it can never be mistaken
   * for one whose tests passed: `buildGateTrace` renders it `tests=none`.
   */
  skipTests?: boolean
  /**
   * Where the diff-targeted tests run. Defaults to `worktree` (the fleet's
   * own worker on the operator's box, where the two are the same tree). CI
   * passes a `git archive` export of the head instead, so the tests run
   * against the PR's files while every DECISION above was already made from
   * the base checkout.
   *
   * Only the export's TEST CODE runs, and only inside vitest's forked
   * workers. Everything that runs in vitest's MAIN process — the process that
   * writes the result file and owns the exit code this gate reads — comes
   * from `worktree`: the runner binary, the config's contents, the dependency
   * tree. See `prepareTestRoot`.
   */
  testDir?: string
}

export interface VerifyReport {
  passed: boolean
  reasons: string[]
  changedFiles: string[]
  addedLines: number
  impact: 'low' | 'high'
  impactReasons: string[]
  testsRun?: string[]
  testsPassed?: boolean
  /** One line per target whose result file was read and was green — the
   *  positive evidence behind `testsPassed: true`, printed in the job log. */
  testResults?: string[]
  /**
   * The exact commit this report examined: the resolved right-hand side of
   * the diff range, captured once, up front. It no longer has to be compared
   * against anything at merge time: a commit status is attached to ONE SHA,
   * so GitHub itself refuses to merge a head that does not carry its own
   * green `fleet/verify`. It survives as the `sha=` field of the gate trace,
   * which `llamenos-fleet status <issue>` reads back. `undefined` only when
   * `git rev-parse` itself failed — which already implies `passed: false`.
   */
  verifiedCommit?: string
}

/** Parses `git diff --name-only` output. Blank lines (a trailing newline, or
 *  one stray in the middle) are dropped rather than kept as an empty-string
 *  "changed file" that would then vacuously match every glob. */
export function changedFilesFrom(diffNameOnly: string): string[] {
  return diffNameOnly.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
}

/**
 * Counts added lines in a unified diff. The `+++ b/file` header line starts
 * with `+` exactly like an added line does, so it must be excluded first —
 * counting it would inflate every file's added-line count by one and, on a
 * diff with many touched files, could tip a diff over LARGE_DIFF_LINES that
 * never actually earned it.
 *
 * Fix-round finding (V3): excluding EVERY line that starts with `+++`,
 * anywhere in the text, also swallows a genuinely added line whose content
 * happens to begin with `++` at column zero — plausible in this repo, which
 * commits `.diff` fixtures. The header is only ever the file's `+++ b/file`
 * line, which unified diff format always emits directly after that file's
 * `--- a/file` line — so the header is identified POSITIONALLY (the line
 * right after a `--- ` line), not by pattern-matching its content against
 * every line in the diff.
 */
export function addedLinesFrom(diffText: string): number {
  let n = 0
  const lines = diffText.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    const prev = lines[i - 1]
    const isFileHeaderLine = prev !== undefined && prev.startsWith('--- ') && line.startsWith('+++ ')
    if (isFileHeaderLine) continue
    if (line.startsWith('+')) n++
  }
  return n
}

interface TestRoute { prefix: string; config: string; target: string }

/**
 * Diff-targeted, not whole-repo: a route maps a changed path prefix to the
 * ONE vitest config + filter argument that covers it, so verifyMechanical
 * runs only the suite relevant to what the worker actually touched. Order
 * matters only in that both orchestrator source and its own tests route to
 * the same fleet suite — a worker's change to `tests/orchestrator/*.test.ts`
 * must re-run the fleet suite exactly as a change to `orchestrator/src/*.ts`
 * would, not silently skip verification because the path prefix looked like
 * "just tests".
 */
const TEST_ROUTES: readonly TestRoute[] = [
  { prefix: 'tests/orchestrator/', config: 'vitest.orchestrator.config.ts', target: 'orchestrator' },
  { prefix: 'orchestrator/', config: 'vitest.orchestrator.config.ts', target: 'orchestrator' },
  { prefix: 'apps/worker/', config: 'vitest.unit.config.ts', target: 'apps/worker' },
]

function routesFor(changed: string[]): TestRoute[] {
  const seen = new Set<string>()
  const out: TestRoute[] = []
  for (const f of changed) {
    for (const r of TEST_ROUTES) {
      if (f.startsWith(r.prefix) && !seen.has(r.target)) {
        seen.add(r.target)
        out.push(r)
      }
    }
  }
  return out
}

/**
 * Maps changed files to the test suites they touch. Deliberately returns `[]`
 * — never `['.']` or any other whole-suite sentinel — when nothing maps: a
 * README-only diff has no suite to run, and falling back to "everything" is
 * exactly the slow, diff-irrelevant behaviour this function exists to avoid.
 */
export function testTargetsFor(changed: string[]): string[] {
  return routesFor(changed).map((r) => r.target)
}

/**
 * Atlas's scar, made mechanical: a previous version of this gate built a
 * `bash -lc` string out of worker-authored filenames, so a committed file
 * named `$(...)` would have executed inside the process holding every
 * credential the orchestrator has. `verifyMechanical` only ever runs test
 * targets via `execFile` argv — never a shell — which already closes that
 * hole for command substitution. This check is the belt-and-suspenders
 * layer on top: even without shell interpretation, a leading `-` can still
 * be read as a CLI flag by the test runner itself (silently disabling
 * coverage, or worse), and `..` can walk a "test target" outside the repo
 * entirely. Restricting to an allowlisted character set removes every shell
 * metacharacter as a possibility too, so a future refactor that starts
 * deriving targets from diff content — rather than this file's fixed,
 * hardcoded route table — does not reopen the hole by accident. Treat this
 * as load-bearing, not defensive.
 *
 * Fix-round finding (V2): the original character-class allowlist accepted a
 * LEADING `/` — `/etc/passwd` has no `-`, no `..`, and every character it
 * contains is in `[A-Za-z0-9_./-]`, so it passed. An absolute path is never
 * a legitimate test target (every real one is relative to the worktree), so
 * it is now rejected outright. On top of that, when a `repoRoot` is given,
 * the path is resolved against it and the result must land INSIDE that
 * root — checked with a trailing separator (`root + sep`), not a bare
 * `startsWith(root)`, because a bare prefix check would wrongly accept a
 * sibling directory that merely shares a string prefix with the root (e.g.
 * root `/repo` and target `/repo-evil/x`). `repoRoot` is optional so this
 * function stays usable as a pure syntactic check wherever no filesystem
 * context is available.
 */
const SAFE_TEST_PATH_RE = /^[A-Za-z0-9_./-]+$/

/**
 * Exported separately from `isSafeTestPath` so the separator-safe boundary
 * math is directly unit-testable on its own: `isSafeTestPath`'s earlier
 * leading-`/` rejection already refuses every absolute `p`, which would
 * otherwise make a bare `startsWith(root)` bug (accepting the sibling
 * `/repo-evil` as if it were inside `/repo`) unreachable through
 * `isSafeTestPath` alone and therefore invisible to a test suite that only
 * calls the public function.
 */
export function resolvesWithinRoot(root: string, p: string): boolean {
  const absRoot = resolvePath(root)
  const resolved = resolvePath(absRoot, p)
  return resolved === absRoot || resolved.startsWith(absRoot + sep)
}

export function isSafeTestPath(p: string, repoRoot?: string): boolean {
  if (p.length === 0) return false
  if (p.startsWith('-')) return false
  if (p.startsWith('/')) return false
  if (p.includes('..')) return false
  if (!SAFE_TEST_PATH_RE.test(p)) return false
  if (repoRoot !== undefined && !resolvesWithinRoot(repoRoot, p)) return false
  return true
}

async function runGit(worktree: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', worktree, ...args], {
      maxBuffer: 32 * 1024 * 1024,
    })
    return stdout
  } catch {
    return undefined
  }
}

export interface TestRunResult {
  /** The runner's exit code; `undefined` when it died on a signal (including
   *  `execFile`'s own timeout kill) and so never exited at all. */
  exitCode: number | undefined
  signal: string | undefined
  output: string
}

/**
 * The runner, by ABSOLUTE path into the trusted checkout. Never `bunx vitest`:
 * with cwd = the head export, `bunx` resolves `<cwd>/node_modules/.bin/vitest`
 * first — so a PR that commits that file supplies its own "runner", which
 * writes a green result to the path it is handed and exits 0 — and it reads
 * the export's own `bunfig.toml` on the way.
 */
export function trustedVitestBin(worktree: string): string {
  return join(resolvePath(worktree), 'node_modules', '.bin', 'vitest')
}

/**
 * Vitest's JSON reporter writes its result to `outputFile` — a document with
 * a fixed, typed shape, read here instead of the human-readable text reporter.
 * The text reporter is prose for people: its summary wording is not a
 * contract, and an OOM-killed, crashed or misconfigured runner prints no
 * summary at all — which a text scraper cannot tell apart from "nothing
 * failed".
 *
 * `--config` is the gate's own wrapper (absolute, outside the test root) and
 * `--root` is the test root, so nothing here is resolved against the cwd.
 */
function vitestArgv(route: TestRoute, config: string, testRoot: string, outputFile: string): string[] {
  return ['run', '--config', config, '--root', testRoot, route.target, '--reporter=json', `--outputFile=${outputFile}`]
}

type Prepared = { ok: true; config: string } | { ok: false; reason: string }

/**
 * Makes the test root safe to hand to vitest, and returns the config to pass
 * it. Vitest's MAIN process — which writes `--outputFile` and owns the exit
 * code — executes the config file, and anything the config tells it to load
 * (`globalSetup`, a PostCSS config found by searching the root). A PR that
 * controls any of those controls the verdict: a `globalSetup` or an `exit`
 * listener can rewrite the result file green and set `process.exitCode = 0`
 * after the real, failing report was written. So, when the test root is not
 * the trusted checkout itself (CI's head export):
 *
 * 1. Its `node_modules` must BE the trusted install — the same directory by
 *    realpath. A committed `node_modules/` (real directory, or a symlink
 *    pointing elsewhere) is refused outright: dependencies the PR supplies
 *    would load in the main process too.
 * 2. The export's own copy of the config is REPLACED with the trusted
 *    checkout's bytes. Not "pass the base config's absolute path": the
 *    configs build `resolve.alias` from `__dirname`, so a base config loaded
 *    from the base checkout points `@worker/*` at the BASE's source, and a PR
 *    that breaks an aliased module would go green having never been tested.
 *    Same bytes, loaded from the export's root, resolve against the export.
 *    The consequence is deliberate: a PR's edit to a `vitest.*.config.ts` is
 *    not in effect under this gate (those files are code-owned instead).
 *
 * In both modes the config is then loaded through a wrapper written to the
 * gate's own temp dir, which pins `css.postcss` to an inline object. Vite
 * otherwise SEARCHES the root for a PostCSS config and executes it in the main
 * process the first time any test imports a stylesheet — measured: a
 * `postcss.config.cjs` in the export ran with argv `.bin/vitest run`.
 */
async function prepareTestRoot(
  worktree: string, testRoot: string, route: TestRoute, resultDir: string,
): Promise<Prepared> {
  const configName = basename(route.config)
  if (configName !== route.config) {
    // Unreachable with the fixed route table; refuse rather than write through a path.
    return { ok: false, reason: `${route.target}: refusing a config path that is not a root file: ${route.config}` }
  }
  const rootConfig = join(resolvePath(testRoot), configName)

  if (resolvePath(testRoot) !== resolvePath(worktree)) {
    const trustedModules = await realpath(join(worktree, 'node_modules')).catch(() => undefined)
    const rootModules = await realpath(join(testRoot, 'node_modules')).catch(() => undefined)
    if (trustedModules === undefined || rootModules !== trustedModules) {
      return {
        ok: false,
        reason: `${route.target}: untrusted test root — ${join(testRoot, 'node_modules')} is not the trusted ` +
          `install (${trustedModules ?? 'missing'}); it resolves to ${rootModules ?? 'nothing'}. ` +
          'A commit under judgement may not supply its own node_modules.',
      }
    }
    try {
      const trustedBytes = await readFile(join(worktree, configName))
      // `rm` unlinks a symlink rather than following it, and `wx` is
      // O_CREAT|O_EXCL: the write can only create a fresh regular file, never
      // write through something the export planted at that name.
      await rm(rootConfig, { force: true })
      await writeFile(rootConfig, trustedBytes, { flag: 'wx' })
    } catch (e) {
      return {
        ok: false,
        reason: `${route.target}: could not install the trusted ${configName} into the test root — ` +
          `${e instanceof Error ? e.message : String(e)}`,
      }
    }
  }

  const wrapper = join(resultDir, `${route.target.replaceAll('/', '_')}.vitest.config.mjs`)
  await writeFile(wrapper, [
    `import loaded from ${JSON.stringify(rootConfig)}`,
    '// Inline PostCSS options: vite never searches the test root for a PostCSS config.',
    'const pin = (c) => ({ ...c, css: { ...(c.css ?? {}), postcss: {} } })',
    "export default typeof loaded === 'function' ? async (env) => pin(await loaded(env)) : pin(loaded)",
    '',
  ].join('\n'), { flag: 'wx' })
  return { ok: true, config: wrapper }
}

async function runVitestTarget(
  worktree: string, testRoot: string, route: TestRoute, config: string, outputFile: string,
): Promise<TestRunResult> {
  if (!isSafeTestPath(route.target, testRoot)) {
    // Should be unreachable — every target above comes from the fixed
    // TEST_ROUTES table, never from diff content — but a gate that trusts
    // its own invariants is exactly how the reference system's hole opened.
    throw new Error(`refusing to run unsafe test target: ${JSON.stringify(route.target)}`)
  }
  try {
    const { stdout, stderr } = await execFileAsync(trustedVitestBin(worktree), vitestArgv(route, config, testRoot, outputFile), {
      cwd: testRoot, timeout: 10 * 60_000, maxBuffer: 32 * 1024 * 1024,
    })
    return { exitCode: 0, signal: undefined, output: `${stdout}${stderr}` }
  } catch (e) {
    const err = e as { code?: number | string | null; signal?: string | null; stdout?: string; stderr?: string }
    return {
      // A string `code` (ENOENT, ERR_CHILD_PROCESS_STDIO_MAXBUFFER, …) means
      // the runner never produced an exit code of its own.
      exitCode: typeof err.code === 'number' ? err.code : undefined,
      signal: typeof err.signal === 'string' ? err.signal : undefined,
      output: `${err.stdout ?? ''}${err.stderr ?? ''}${typeof err.code === 'string' ? `\n${err.code}` : ''}`,
    }
  }
}

/**
 * The fields of vitest's JSON result this gate relies on. `numTotalTests`
 * alone proves nothing ran: vitest counts every COLLECTED test there,
 * skipped and todo included, so a suite wrapped in `describe.skipIf(true)`
 * reports N total, 0 passed, `success: true`, exit 0.
 */
export interface VitestJsonCounts {
  numTotalTests: number
  numPassedTests: number
  numFailedTests: number
  /** Skipped (`.skip`, `.skipIf`, filtered out) — collected, never run. */
  numPendingTests: number
  numTodoTests: number
  numFailedTestSuites: number
  success: boolean
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0
}

/** `undefined` unless every field the verdict depends on is present and
 *  well-typed — a document missing `numFailedTests` is unparseable, never a
 *  document reporting zero failures. */
export function parseVitestJson(text: string): VitestJsonCounts | undefined {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof doc !== 'object' || doc === null) return undefined
  const d = doc as Record<string, unknown>
  const { numTotalTests, numPassedTests, numFailedTests, numPendingTests, numTodoTests, numFailedTestSuites, success } = d
  if (!isCount(numTotalTests) || !isCount(numPassedTests) || !isCount(numFailedTests)) return undefined
  if (!isCount(numPendingTests) || !isCount(numTodoTests) || !isCount(numFailedTestSuites)) return undefined
  if (typeof success !== 'boolean') return undefined
  return { numTotalTests, numPassedTests, numFailedTests, numPendingTests, numTodoTests, numFailedTestSuites, success }
}

/** The last few lines of the runner's own output, for a reader of the job log
 *  when no result could be read — bounded so a crash dump cannot flood it. */
function outputTail(output: string): string {
  const lines = output.split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0)
  if (lines.length === 0) return ' (runner printed nothing)'
  return `; last output: ${lines.slice(-5).join(' | ')}`
}

function describeExit(run: TestRunResult): string {
  if (run.signal !== undefined) return `was killed by ${run.signal}`
  if (run.exitCode === undefined) return 'never started or produced no exit code'
  return `exited ${run.exitCode}`
}

export type TargetOutcome = { passed: true; evidence: string } | { passed: false; reason: string }

/**
 * Judges ONE target. The only way to `passed: true` is a result file that
 * exists, parses, reports zero failed tests and zero failed suites, at least
 * one EXECUTED test (total minus skipped minus todo) and at least one PASSED
 * test, and `success`, from a runner that exited 0. Every other combination
 * — including every way of not knowing — is a failure, and each "could not
 * tell" case says which one it was, so the job log distinguishes a runner
 * that died from one that wrote garbage from one that wrote nothing.
 */
export function judgeTargetRun(target: string, run: TestRunResult, resultText: string | undefined): TargetOutcome {
  if (resultText === undefined) {
    if (run.exitCode !== 0) {
      return {
        passed: false,
        reason: `${target}: runner-exit — the test runner ${describeExit(run)} and wrote no result file${outputTail(run.output)}`,
      }
    }
    return {
      passed: false,
      reason: `${target}: missing result — the test runner exited 0 but wrote no result file${outputTail(run.output)}`,
    }
  }
  const counts = parseVitestJson(resultText)
  if (counts === undefined) {
    return {
      passed: false,
      reason: `${target}: unparseable result — the result file is not a vitest JSON report (runner ${describeExit(run)})`,
    }
  }
  const notRun = counts.numPendingTests + counts.numTodoTests
  const executed = counts.numTotalTests - notRun
  const summary = `${counts.numFailedTests} failed test(s), ${counts.numFailedTestSuites} failed suite(s), ` +
    `${counts.numPassedTests} passed, ${notRun} skipped/todo, of ${counts.numTotalTests} test(s)`
  if (counts.numFailedTests > 0 || counts.numFailedTestSuites > 0) {
    return { passed: false, reason: `${target}: tests failed — ${summary}` }
  }
  if (executed <= 0) {
    return {
      passed: false,
      reason: `${target}: no tests ran — ${summary}; a run that executed nothing proves nothing`,
    }
  }
  if (counts.numPassedTests === 0) {
    return { passed: false, reason: `${target}: no test passed — ${summary}; a run with no passing test proves nothing` }
  }
  if (!counts.success || run.exitCode !== 0) {
    return {
      passed: false,
      reason: `${target}: runner-exit — the result reports ${summary}, but the runner ${describeExit(run)}` +
        `${counts.success ? '' : ' and the result is marked unsuccessful'}${outputTail(run.output)}`,
    }
  }
  return { passed: true, evidence: `${target}: result file read — ${summary}` }
}

/**
 * Order is the design, not a style choice:
 *
 * 1. Scope — any forbidden or strayed file is an immediate fail, naming the
 *    offenders. `checkScope` and `classifyImpact` have had no runtime caller
 *    until this function; this is what wires them in.
 * 2. Impact — recorded on the report, never itself a fail, and no longer a
 *    gate anywhere in this process: a diff touching a sensitive path is held
 *    by GitHub's own "require review from Code Owners" rule against
 *    `CODEOWNERS`. `classifyImpact` survives to DESCRIBE a diff (the trace,
 *    the digest, the reviewer's turn budget), never to decide about it.
 * 3. Diff-targeted tests only, run by argv via `execFile` — never a shell,
 *    never the whole suite (slow, produces failures unrelated to the diff,
 *    and CI already shards it). The runner, the config's contents and the
 *    dependency tree come from `worktree`; the test root supplies test files
 *    and nothing that runs in vitest's main process (`prepareTestRoot`).
 * 4. Tests pass only on positive evidence. Each target's machine-readable
 *    result must be read and show no failures (`judgeTargetRun`); a runner
 *    that crashed, was OOM-killed, or wrote nothing readable FAILS the gate.
 *    "Could not tell" is never "passed" — a required check that goes green
 *    when its runner dies is no check at all.
 */
export async function verifyMechanical(input: VerifyInput): Promise<VerifyReport> {
  const { worktree, branch, lane } = input
  const range = `${input.base ?? 'origin/main'}...${branch}`
  const testRoot = input.testDir ?? worktree

  // Captured FIRST and once: the commit under judgement — the RIGHT-HAND
  // side of the range, resolved, not the worktree's own HEAD. Those are the
  // same thing on the operator's box, where the worktree is checked out on
  // the branch being verified. They are NOT the same in CI, where git runs
  // in the trusted BASE checkout and the commit being judged is only an
  // object in it: `rev-parse HEAD` there names the base, so the trace would
  // have identified the wrong commit entirely — and `status.ts` reads this
  // field back as "the commit this report examined".
  const headShaRaw = await runGit(worktree, ['rev-parse', branch])
  if (headShaRaw === undefined) {
    return {
      passed: false,
      reasons: [`could not resolve HEAD in ${worktree} — git rev-parse failed`],
      changedFiles: [],
      addedLines: 0,
      impact: 'low',
      impactReasons: [],
    }
  }
  const verifiedCommit = headShaRaw.trim()

  const nameOnly = await runGit(worktree, ['diff', '--name-only', range])
  if (nameOnly === undefined) {
    return {
      passed: false,
      reasons: [`could not compute the diff against origin/main for ${branch} — git diff failed`],
      changedFiles: [],
      addedLines: 0,
      impact: 'low',
      impactReasons: [],
      verifiedCommit,
    }
  }

  const fullDiff = await runGit(worktree, ['diff', range])
  const changedFiles = changedFilesFrom(nameOnly)
  const addedLines = addedLinesFrom(fullDiff ?? '')

  const reasons: string[] = []
  // A granted lane with no owned paths grants nothing — see checkScopeAcross.
  // Dropped here too so the failure message never credits a grant that had no
  // effect.
  const granted = (input.grantedLanes ?? []).filter((g) => g.scope.owned.length > 0)
  const { forbidden, strayed } = checkScopeAcross(
    changedFiles,
    lane.scope,
    granted.map((g) => g.scope),
    [...NEVER_WRITE_PATHS],
    [...GRANT_EXCLUDED_PATHS],
  )
  if (forbidden.length > 0) {
    reasons.push(`touched never-write paths: ${forbidden.join(', ')}`)
  }
  if (strayed.length > 0) {
    // Name the grants already in force, so a half-labelled cross-lane PR does
    // not read as though its labels were ignored.
    const scopeDesc = granted.length > 0
      ? `lane "${lane.id}"'s scope (granted also: ${granted.map((g) => g.id).join(', ')})`
      : `lane "${lane.id}"'s scope`
    reasons.push(`touched files outside ${scopeDesc}: ${strayed.join(', ')}`)
  }
  const scopeFailed = forbidden.length > 0 || strayed.length > 0

  const { impact, reasons: impactReasons } = classifyImpact(changedFiles, addedLines)

  // Scope failure is immediate and unconditional: do not spend time running
  // tests for a diff that already touched what it must not have.
  if (scopeFailed) {
    return { passed: false, reasons, changedFiles, addedLines, impact, impactReasons, verifiedCommit }
  }

  const routes = input.skipTests === true ? [] : routesFor(changedFiles)
  const testsRun = routes.map((r) => r.target)
  let testsPassed: boolean | undefined
  const testResults: string[] = []

  if (routes.length > 0) {
    const resultDir = await mkdtemp(join(tmpdir(), 'llamenos-fleet-verify-'))
    try {
      let allPassed = true
      for (const route of routes) {
        const prepared = await prepareTestRoot(worktree, testRoot, route, resultDir)
        if (!prepared.ok) {
          allPassed = false
          reasons.push(prepared.reason)
          continue
        }
        const outputFile = join(resultDir, `${route.target.replaceAll('/', '_')}.json`)
        const run = await runVitestTarget(worktree, testRoot, route, prepared.config, outputFile)
        const resultText = await readFile(outputFile, 'utf8').catch(() => undefined)
        const outcome = judgeTargetRun(route.target, run, resultText)
        if (outcome.passed) {
          testResults.push(outcome.evidence)
        } else {
          allPassed = false
          reasons.push(outcome.reason)
        }
      }
      testsPassed = allPassed
    } finally {
      await rm(resultDir, { recursive: true, force: true })
    }
  }

  return {
    // Explicit, not `testsPassed !== false`: with suites routed, only a
    // positively read, all-green result for EVERY target passes.
    passed: !scopeFailed && (routes.length === 0 || testsPassed === true),
    reasons,
    changedFiles,
    addedLines,
    impact,
    impactReasons,
    testsRun,
    testsPassed,
    testResults,
    verifiedCommit,
  }
}
