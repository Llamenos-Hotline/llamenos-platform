import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync, execSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  changedFilesFrom, addedLinesFrom, testTargetsFor, isSafeTestPath, resolvesWithinRoot, verifyMechanical,
  judgeTargetRun, parseVitestJson, parseVitestFailures,
} from '../../orchestrator/src/verify.js'
import type { TargetOutcome, TestRunResult } from '../../orchestrator/src/verify.js'
import type { Lane } from '../../orchestrator/src/config.js'

describe('changedFilesFrom', () => {
  it('splits git diff --name-only output', () => {
    expect(changedFilesFrom('a/b.ts\nc/d.ts\n')).toEqual(['a/b.ts', 'c/d.ts'])
  })
  it('returns [] for empty output', () => {
    expect(changedFilesFrom('')).toEqual([])
  })
  it('ignores blank lines in the middle of the output', () => {
    expect(changedFilesFrom('a/b.ts\n\nc/d.ts\n')).toEqual(['a/b.ts', 'c/d.ts'])
  })
})

describe('addedLinesFrom', () => {
  it('counts added lines and ignores the +++ header', () => {
    const diff = ['--- a/x.ts', '+++ b/x.ts', '@@', '+one', '+two', '-gone', ' same'].join('\n')
    expect(addedLinesFrom(diff)).toBe(2)
  })
  it('does not count the --- header as a removed line miscounted as added', () => {
    const diff = ['--- a/x.ts', '+++ b/x.ts'].join('\n')
    expect(addedLinesFrom(diff)).toBe(0)
  })
  it('returns 0 for empty diff text', () => {
    expect(addedLinesFrom('')).toBe(0)
  })
  // V3 (fix round 1): a line starting with `+++` is only the file header
  // when it directly follows a `--- ` line — anywhere else it is real
  // content (this repo commits `.diff` fixtures, so this is not academic).
  it('counts an added line that itself begins with "+++" when it is not the file header', () => {
    const diff = [
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,2 +1,3 @@',
      ' context',
      '+++not a real header, just content that happens to start with plus plus plus',
      '+another add',
    ].join('\n')
    expect(addedLinesFrom(diff)).toBe(2)
  })
  it('still excludes the header when the diff touches multiple files', () => {
    const diff = [
      '--- a/one.ts', '+++ b/one.ts', '@@', '+a',
      '--- a/two.ts', '+++ b/two.ts', '@@', '+b', '+c',
    ].join('\n')
    expect(addedLinesFrom(diff)).toBe(3)
  })
})

describe('isSafeTestPath', () => {
  it.each(['-rf', '../etc/passwd', 'a$(whoami)b', 'a;rm -rf /', 'a`id`b'])(
    'rejects %s', (p) => expect(isSafeTestPath(p)).toBe(false))
  it.each(['tests/orchestrator', 'apps/worker/__tests__/unit'])(
    'accepts %s', (p) => expect(isSafeTestPath(p)).toBe(true))
  it('rejects an absolute path masquerading as a leading dash-free string with a shell metacharacter', () => {
    expect(isSafeTestPath('tests/orch|rm -rf ~')).toBe(false)
  })
  it('rejects a path containing a space-separated flag injection', () => {
    expect(isSafeTestPath('tests/orch --coverage=false')).toBe(false)
  })

  // --- V2 (fix round 1): leading-'/' and repoRoot-boundary hardening ---

  it('rejects an absolute path with no ".." and no leading dash', () => {
    expect(isSafeTestPath('/etc/passwd')).toBe(false)
  })
  it('rejects any absolute path, even a plausible-looking one', () => {
    expect(isSafeTestPath('/tmp/x')).toBe(false)
  })
  it('rejects an absolute path that shares a string prefix with the repo root without being inside it', () => {
    // Demonstrates why the boundary check must be `startsWith(root + sep)`,
    // not a bare `startsWith(root)`: '/repo-evil' is a sibling of '/repo',
    // not a path inside it, even though the plain string "starts with" it.
    expect(isSafeTestPath('/repo-evil/malicious.test.ts', '/repo')).toBe(false)
  })
  it('accepts a relative target that resolves inside the given repoRoot', () => {
    expect(isSafeTestPath('apps/worker', '/repo')).toBe(true)
  })
  it('accepts a relative target nested under a nested repoRoot (sanity check on the boundary math)', () => {
    expect(isSafeTestPath('sibling', '/repo/nested')).toBe(true)
  })
})

describe('resolvesWithinRoot', () => {
  // isSafeTestPath's own leading-'/' rejection makes an absolute-path
  // sibling escape unreachable through the public function alone — these
  // exercise the separator-boundary math directly, independent of that
  // earlier gate, so a regression here cannot hide behind it.
  it('accepts a relative path nested under root', () => {
    expect(resolvesWithinRoot('/repo', 'apps/worker')).toBe(true)
  })
  it('accepts root itself', () => {
    expect(resolvesWithinRoot('/repo', '.')).toBe(true)
  })
  it('rejects a sibling directory that merely shares a string prefix with root', () => {
    expect(resolvesWithinRoot('/repo', '/repo-evil/x')).toBe(false)
  })
})

describe('testTargetsFor', () => {
  it('maps worker changes to the worker unit suite', () => {
    expect(testTargetsFor(['apps/worker/lib/auth.ts']).join(' ')).toMatch(/worker/)
  })
  it('maps orchestrator changes to the fleet suite', () => {
    expect(testTargetsFor(['orchestrator/src/tick.ts']).join(' ')).toMatch(/orchestrator/)
  })
  it('maps a change to the orchestrator tests themselves to the fleet suite', () => {
    expect(testTargetsFor(['tests/orchestrator/tick.test.ts']).join(' ')).toMatch(/orchestrator/)
  })
  it('never returns the whole suite', () => {
    expect(testTargetsFor(['apps/worker/a.ts', 'src/client/b.tsx'])).not.toContain('.')
  })
  it('returns [] when nothing maps, rather than falling back to everything', () => {
    expect(testTargetsFor(['README.md'])).toEqual([])
  })
  it('deduplicates when multiple changed files map to the same target', () => {
    const targets = testTargetsFor(['apps/worker/a.ts', 'apps/worker/b.ts'])
    expect(targets.length).toBe(new Set(targets).size)
  })
})

// --- W1 (fix round 2): verifiedCommit must be a RECORD of the tree that was
// actually examined, not something re-derivable later. Exercised against a
// real temporary git repo so this is checking verifyMechanical's actual
// wiring, not a mock's say-so.

describe('verifyMechanical', () => {
  const createdRepos: string[] = []

  afterEach(() => {
    while (createdRepos.length > 0) {
      const dir = createdRepos.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeRepoWithDivergedMain(file = 'notes.md'): { dir: string; headSha: string; originMainSha: string } {
    const dir = mkdtempSync(join(tmpdir(), 'llamenos-fleet-verify-test-'))
    createdRepos.push(dir)
    // `-b main` explicitly: without it the default branch name comes from the
    // AMBIENT ~/.gitconfig (`init.defaultBranch`), so on a machine without
    // that setting the repo is on `master`, the `origin/main...main` range
    // below never resolves, and `verifyMechanical` bails out at the diff —
    // returning a report that happens to satisfy a `passed === false`
    // assertion for entirely the wrong reason. Pinned so this fixture means
    // the same thing on every machine.
    execSync('git init -q -b main', { cwd: dir })
    execSync('git config user.email test@example.com', { cwd: dir })
    execSync('git config user.name "Test"', { cwd: dir })
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), 'first\n')
    execFileSync('git', ['add', file], { cwd: dir })
    execSync('git commit -q -m initial', { cwd: dir })
    const originMainSha = execSync('git rev-parse HEAD', { cwd: dir }).toString().trim()
    // A local ref standing in for a fetched `origin/main`, without needing
    // an actual remote — verifyMechanical only reads it as a ref.
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', originMainSha], { cwd: dir })

    writeFileSync(join(dir, file), 'first\nsecond\n')
    execFileSync('git', ['add', file], { cwd: dir })
    execSync('git commit -q -m "add a note"', { cwd: dir })
    const headSha = execSync('git rev-parse HEAD', { cwd: dir }).toString().trim()

    return { dir, headSha, originMainSha }
  }

  const testLane: Lane = {
    id: 'test', mode: 'live', cap: 1, engine: 'claude',
    requireLabel: 'agent-dispatchable', vetoLabels: [],
    scope: { owned: ['notes.md'], notOwned: [] },
  }

  it('records the exact commit examined as verifiedCommit', async () => {
    const { dir, headSha, originMainSha } = makeRepoWithDivergedMain()
    const report = await verifyMechanical({ worktree: dir, branch: 'main', lane: testLane })

    expect(report.verifiedCommit).toBe(headSha)
    // Sanity: it is genuinely HEAD, not the base it diffed against.
    expect(report.verifiedCommit).not.toBe(originMainSha)
  })

  it('still records verifiedCommit even when scope verification fails', () => {
    // A record of what was examined must exist regardless of the verdict —
    // an auditor asking "what commit did this failing report even look at"
    // must get an answer, not undefined-because-it-failed-early.
    return (async () => {
      const { dir, headSha } = makeRepoWithDivergedMain()
      const outOfScopeLane: Lane = { ...testLane, scope: { owned: ['some-other-file.md'], notOwned: [] } }
      const report = await verifyMechanical({ worktree: dir, branch: 'main', lane: outOfScopeLane })

      expect(report.passed).toBe(false)
      expect(report.verifiedCommit).toBe(headSha)
    })()
  })

  // `skipTests` exists for the `fleet/review` CI job, where `fleet/verify` is
  // the job that runs the suites. The property that has to hold is that a
  // skipped run is INDISTINGUISHABLE FROM "nothing ran" and can never be
  // mistaken for "the tests passed": `testsRun` empty, `testsPassed`
  // undefined, and no test runner spawned at all. Exercised on a diff that
  // WOULD route to a suite (`orchestrator/`), since a diff that routes
  // nowhere would pass this vacuously either way.
  // The CI shape: git runs in a TRUSTED checkout that is parked on the base,
  // and the commit under judgement is only an object in it. `verifiedCommit`
  // must name the commit judged, not the tree git happened to be sitting on —
  // it is what `status.ts` reads back, and what the gate trace prints as
  // `sha=`. Recording the worktree's own HEAD here named the base instead.
  it('records the commit under judgement, not the worktree HEAD, when they differ', async () => {
    const { dir, headSha, originMainSha } = makeRepoWithDivergedMain()
    execFileSync('git', ['checkout', '-q', '--detach', originMainSha], { cwd: dir })

    const report = await verifyMechanical({
      worktree: dir, base: originMainSha, branch: headSha, lane: testLane, skipTests: true,
    })

    expect(execSync('git rev-parse HEAD', { cwd: dir }).toString().trim()).toBe(originMainSha)
    expect(report.verifiedCommit).toBe(headSha)
    expect(report.changedFiles).toEqual(['notes.md'])
  })

  it('skipTests runs no suite and records none, on a diff that would otherwise route to one', async () => {
    const { dir } = makeRepoWithDivergedMain('orchestrator/src/thing.ts')
    const lane: Lane = { ...testLane, scope: { owned: ['orchestrator/'], notOwned: [] } }

    const skipped = await verifyMechanical({ worktree: dir, branch: 'main', lane, skipTests: true })
    // The diff really was computed — otherwise an empty testsRun would mean
    // "verifyMechanical bailed out early", not "skipTests worked".
    expect(skipped.changedFiles).toEqual(['orchestrator/src/thing.ts'])
    expect(skipped.reasons).toEqual([])
    expect(skipped.testsRun).toEqual([])
    expect(skipped.testsPassed).toBeUndefined()
    expect(skipped.passed).toBe(true)

    // The route this diff maps to is real — so the empty testsRun above is
    // `skipTests` doing its job, not the diff mapping to nothing.
    expect(testTargetsFor(['orchestrator/src/thing.ts'])).toEqual(['orchestrator'])
  })
})

// --- #811: the test verdict fails CLOSED. The runner is always the TRUSTED
// checkout's `node_modules/.bin/vitest`, by absolute path, so each case
// installs a stand-in runner exactly there that behaves like one specific
// broken (or healthy) vitest. Driving the real function end to end — real git
// repo, real child process, real exit code or signal — means these cases
// exercise the same code path CI does.

const GREEN_COUNTS = {
  numTotalTestSuites: 3, numPassedTestSuites: 3, numFailedTestSuites: 0, numPendingTestSuites: 0,
  numTotalTests: 12, numPassedTests: 12, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
  startTime: 0, success: true, testResults: [],
}
const vitestJson = (over: Record<string, unknown> = {}): string => JSON.stringify({ ...GREEN_COUNTS, ...over })

const fleetLane: Lane = {
  id: 'test', mode: 'live', cap: 1, engine: 'claude',
  requireLabel: 'agent-dispatchable', vetoLabels: [],
  scope: { owned: ['orchestrator/'], notOwned: [] },
}

/** A repo whose diff touches `orchestrator/`, so it routes to one suite. */
function orchestratorDiffRepo(cleanup: string[], extraFiles: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'llamenos-fleet-verify-811-'))
  cleanup.push(dir)
  const git = (...args: string[]): void => { execFileSync('git', args, { cwd: dir }) }
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  writeFiles(dir, { 'orchestrator/src/thing.ts': 'export const a = 1\n', ...extraFiles })
  git('add', '.')
  git('commit', '-q', '-m', 'initial')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  writeFileSync(join(dir, 'orchestrator/src/thing.ts'), 'export const a = 2\n')
  git('commit', '-q', '-am', 'change')
  return dir
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
}

/** A stand-in `vitest` at `<root>/node_modules/.bin/vitest`, whose body runs
 *  with `$OUT` set to the value of its `--outputFile=` argument. */
function installRunner(root: string, body: string): string {
  const bin = join(root, 'node_modules', '.bin')
  mkdirSync(bin, { recursive: true })
  const runner = join(bin, 'vitest')
  writeFileSync(runner, [
    '#!/bin/sh',
    'OUT=""',
    'for a in "$@"; do case "$a" in --outputFile=*) OUT="${a#--outputFile=}" ;; esac; done',
    body,
    '',
  ].join('\n'))
  chmodSync(runner, 0o755)
  return runner
}

/** CI's shape: a `git archive`-style export of the head with the trusted
 *  install linked in, exactly as the workflow does. */
function headExport(cleanup: string[], worktree: string, files: Record<string, string> = {}): string {
  const head = mkdtempSync(join(tmpdir(), 'llamenos-fleet-head-export-'))
  cleanup.push(head)
  writeFiles(head, files)
  symlinkSync(join(worktree, 'node_modules'), join(head, 'node_modules'))
  return head
}

describe('verifyMechanical test verdict (#811)', () => {
  const cleanup: string[] = []
  const originalPath = process.env['PATH']

  afterEach(() => {
    process.env['PATH'] = originalPath
    while (cleanup.length > 0) {
      const dir = cleanup.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  const verify = async (runnerBody: string): Promise<Awaited<ReturnType<typeof verifyMechanical>>> => {
    const dir = orchestratorDiffRepo(cleanup)
    installRunner(dir, runnerBody)
    return verifyMechanical({ worktree: dir, branch: 'main', lane: fleetLane })
  }

  it('FAILS when the runner exits 137 and writes no output at all', async () => {
    const report = await verify('exit 137')
    expect(report.testsRun).toEqual(['orchestrator'])
    expect(report.testsPassed).toBe(false)
    expect(report.passed).toBe(false)
    expect(report.reasons.join('\n')).toMatch(/runner-exit.*exited 137.*no result file/)
  })

  // A real OOM kill is not `exit 137`: the child that execFile spawned dies on
  // a signal, so it arrives as `code: null, signal: 'SIGKILL'` — the branch an
  // `err.code ?? 0` edit would silently turn into "exited 0".
  it.each(['KILL', 'TERM'])('FAILS when the runner is killed by SIG%s before writing a result', async (sig) => {
    const report = await verify(`kill -${sig} $$`)
    expect(report.testsPassed).toBe(false)
    expect(report.passed).toBe(false)
    expect(report.reasons.join('\n')).toMatch(new RegExp(`runner-exit.*killed by SIG${sig}.*no result file`))
  })

  it.each(['KILL', 'TERM'])('FAILS when the runner writes a green result and is then killed by SIG%s', async (sig) => {
    const report = await verify(`printf '%s' '${vitestJson()}' > "$OUT"; kill -${sig} $$`)
    expect(report.testsPassed).toBe(false)
    expect(report.passed).toBe(false)
    expect(report.testResults).toEqual([])
    expect(report.reasons.join('\n')).toMatch(new RegExp(`runner-exit.*but the runner was killed by SIG${sig}`))
  })

  it('FAILS when the runner writes malformed JSON and exits 0', async () => {
    const report = await verify('printf \'{"numFailedTests": 0, "trunc\' > "$OUT"; exit 0')
    expect(report.testsPassed).toBe(false)
    expect(report.passed).toBe(false)
    expect(report.reasons.join('\n')).toMatch(/unparseable result/)
  })

  it('FAILS when the result reports one failed test, naming the counts', async () => {
    const report = await verify(`printf '%s' '${vitestJson({ numFailedTests: 1, numPassedTests: 11, numFailedTestSuites: 1, success: false })}' > "$OUT"; exit 1`)
    expect(report.testsPassed).toBe(false)
    expect(report.passed).toBe(false)
    expect(report.reasons.join('\n'))
      .toMatch(/tests failed — 1 failed test\(s\), 1 failed suite\(s\), 11 passed, 0 skipped\/todo, of 12 test\(s\)/)
  })

  // The shape of a test FILE that fails to import (syntax error, missing
  // module): the suite fails, no individual test does.
  it('FAILS a failed suite with zero failed tests, as a test failure, not as runner trouble', async () => {
    const report = await verify(`printf '%s' '${vitestJson({ numFailedTests: 0, numFailedTestSuites: 1, success: false })}' > "$OUT"; exit 1`)
    expect(report.passed).toBe(false)
    expect(report.reasons.join('\n')).toMatch(/tests failed — 0 failed test\(s\), 1 failed suite\(s\)/)
  })

  it('FAILS when the runner exits 0 but never writes the result file', async () => {
    const report = await verify('echo "all good, trust me"; exit 0')
    expect(report.passed).toBe(false)
    expect(report.reasons.join('\n')).toMatch(/missing result.*exited 0.*all good, trust me/)
  })

  it('names the three could-not-tell cases distinguishably', async () => {
    const crashed = (await verify('exit 137')).reasons.join('\n')
    const garbage = (await verify('echo nope > "$OUT"; exit 0')).reasons.join('\n')
    const nothing = (await verify('exit 0')).reasons.join('\n')
    expect(crashed).toMatch(/runner-exit/)
    expect(garbage).toMatch(/unparseable result/)
    expect(nothing).toMatch(/missing result/)
    expect(new Set([crashed, garbage, nothing]).size).toBe(3)
  })

  it('FAILS a result reporting zero tests — a run that proves nothing is not a pass', async () => {
    const report = await verify(`printf '%s' '${vitestJson({ numTotalTests: 0, numPassedTests: 0, numTotalTestSuites: 0, numPassedTestSuites: 0 })}' > "$OUT"; exit 0`)
    expect(report.passed).toBe(false)
    expect(report.reasons.join('\n')).toMatch(/no tests ran/)
  })

  it('FAILS a green-looking result from a runner that still exited non-zero', async () => {
    const report = await verify(`printf '%s' '${vitestJson()}' > "$OUT"; echo "Unhandled error" >&2; exit 1`)
    expect(report.passed).toBe(false)
    expect(report.reasons.join('\n')).toMatch(/runner-exit.*exited 1/)
  })

  it('FAILS green counts marked success:false even when the runner exited 0', async () => {
    const report = await verify(`printf '%s' '${vitestJson({ success: false })}' > "$OUT"; exit 0`)
    expect(report.passed).toBe(false)
    expect(report.reasons.join('\n')).toMatch(/runner-exit.*exited 0 and the result is marked unsuccessful/)
  })

  it('FAILS a result document missing the fields the verdict depends on', async () => {
    const report = await verify('printf \'{"success": true}\' > "$OUT"; exit 0')
    expect(report.passed).toBe(false)
    expect(report.reasons.join('\n')).toMatch(/unparseable result/)
  })

  it('passes only on a read, all-green result, and records it as evidence with the passed count', async () => {
    const report = await verify(`printf '%s' '${vitestJson()}' > "$OUT"; exit 0`)
    expect(report.reasons).toEqual([])
    expect(report.testsPassed).toBe(true)
    expect(report.passed).toBe(true)
    expect(report.testResults).toEqual([
      'orchestrator: result file read — 0 failed test(s), 0 failed suite(s), 12 passed, 0 skipped/todo, of 12 test(s)',
    ])
  })

  it('asks vitest for its JSON reporter written to a file', async () => {
    const dir = orchestratorDiffRepo(cleanup)
    const argvLog = join(dir, 'argv.log')
    installRunner(dir, `printf '%s\\n' "$@" > '${argvLog}'; exit 137`)
    await verifyMechanical({ worktree: dir, branch: 'main', lane: fleetLane })
    const argv = readFileSync(argvLog, 'utf8').split('\n')
    expect(argv).toContain('--reporter=json')
    expect(argv.some((a) => /^--outputFile=.+\.json$/.test(a))).toBe(true)
  })

  // --- Round 2, finding 1: the runner is resolved from the TRUSTED checkout.

  it("runs the trusted checkout's runner by absolute path, never whatever `bunx` resolves", async () => {
    const dir = orchestratorDiffRepo(cleanup)
    const invoked = join(dir, 'invoked-as.log')
    const runner = installRunner(dir, `printf '%s' "$0" > '${invoked}'; exit 137`)
    // A `bunx` that would forge a green result, first on PATH.
    const decoy = mkdtempSync(join(tmpdir(), 'llamenos-fleet-decoy-bunx-'))
    cleanup.push(decoy)
    installRunner(decoy, `printf '%s' '${vitestJson()}' > "$OUT"; exit 0`)
    symlinkSync(join(decoy, 'node_modules', '.bin', 'vitest'), join(decoy, 'bunx'))
    process.env['PATH'] = `${decoy}${delimiter}${originalPath ?? ''}`

    const report = await verifyMechanical({ worktree: dir, branch: 'main', lane: fleetLane })
    expect(report.passed).toBe(false)
    expect(report.reasons.join('\n')).toMatch(/runner-exit.*exited 137/)
    expect(readFileSync(invoked, 'utf8')).toBe(runner)
  })

  it('refuses a head export that commits its own node_modules — neither runner is ever started', async () => {
    const dir = orchestratorDiffRepo(cleanup)
    const baseRan = join(dir, 'base-runner-ran')
    // The trusted runner would report green: without the refusal this is a PASS.
    installRunner(dir, `touch '${baseRan}'; printf '%s' '${vitestJson()}' > "$OUT"; exit 0`)
    const head = mkdtempSync(join(tmpdir(), 'llamenos-fleet-head-export-'))
    cleanup.push(head)
    const headRan = join(head, 'head-runner-ran')
    installRunner(head, `touch '${headRan}'; printf '%s' '${vitestJson()}' > "$OUT"; exit 0`)

    const report = await verifyMechanical({ worktree: dir, branch: 'main', lane: fleetLane, testDir: head })
    expect(report.passed).toBe(false)
    expect(report.testsPassed).toBe(false)
    expect(report.reasons.join('\n')).toMatch(/untrusted test root — .*node_modules is not the trusted install/)
    expect(existsSync(baseRan)).toBe(false)
    expect(existsSync(headRan)).toBe(false)
  })

  it('refuses a head export whose node_modules is a symlink to anything but the trusted install', async () => {
    const dir = orchestratorDiffRepo(cleanup)
    installRunner(dir, `printf '%s' '${vitestJson()}' > "$OUT"; exit 0`)
    const elsewhere = mkdtempSync(join(tmpdir(), 'llamenos-fleet-elsewhere-'))
    cleanup.push(elsewhere)
    installRunner(elsewhere, `printf '%s' '${vitestJson()}' > "$OUT"; exit 0`)
    const head = mkdtempSync(join(tmpdir(), 'llamenos-fleet-head-export-'))
    cleanup.push(head)
    symlinkSync(join(elsewhere, 'node_modules'), join(head, 'node_modules'))

    const report = await verifyMechanical({ worktree: dir, branch: 'main', lane: fleetLane, testDir: head })
    expect(report.passed).toBe(false)
    expect(report.reasons.join('\n')).toMatch(/untrusted test root/)
  })

  // --- Round 2, finding 2: the config vitest's main process loads is the
  // trusted checkout's, installed at the export's root, via the gate's wrapper.

  it("loads the trusted checkout's config bytes from the export root, rooted at the export", async () => {
    const trustedConfig = 'export default { test: { include: ["tests/orchestrator/**/*.test.ts"] } } // trusted\n'
    const dir = orchestratorDiffRepo(cleanup, { 'vitest.orchestrator.config.ts': trustedConfig })
    const argvLog = join(dir, 'argv.log')
    installRunner(dir, `printf '%s\\n' "$@" > '${argvLog}'; printf '%s' '${vitestJson()}' > "$OUT"; exit 0`)
    const head = headExport(cleanup, dir, { 'vitest.orchestrator.config.ts': 'export default {} // the PR\'s own\n' })

    const report = await verifyMechanical({ worktree: dir, branch: 'main', lane: fleetLane, testDir: head })
    expect(report.reasons).toEqual([])
    expect(report.passed).toBe(true)
    expect(readFileSync(join(head, 'vitest.orchestrator.config.ts'), 'utf8')).toBe(trustedConfig)
    const argv = readFileSync(argvLog, 'utf8').split('\n')
    expect(argv[argv.indexOf('--root') + 1]).toBe(head)
    const config = argv[argv.indexOf('--config') + 1] ?? ''
    expect(config.startsWith('/')).toBe(true)
    expect(config.startsWith(head)).toBe(false)
  })

  it('replaces a symlink planted at the config name instead of writing through it', async () => {
    const trustedConfig = 'export default {} // trusted\n'
    const dir = orchestratorDiffRepo(cleanup, { 'vitest.orchestrator.config.ts': trustedConfig })
    installRunner(dir, `printf '%s' '${vitestJson()}' > "$OUT"; exit 0`)
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'untouched\n')
    const head = headExport(cleanup, dir)
    symlinkSync(victim, join(head, 'vitest.orchestrator.config.ts'))

    const report = await verifyMechanical({ worktree: dir, branch: 'main', lane: fleetLane, testDir: head })
    expect(report.passed).toBe(true)
    expect(readFileSync(victim, 'utf8')).toBe('untouched\n')
    expect(readFileSync(join(head, 'vitest.orchestrator.config.ts'), 'utf8')).toBe(trustedConfig)
  })

  it('FAILS when the trusted checkout has no config to install', async () => {
    const dir = orchestratorDiffRepo(cleanup)
    installRunner(dir, `printf '%s' '${vitestJson()}' > "$OUT"; exit 0`)
    const head = headExport(cleanup, dir, { 'vitest.orchestrator.config.ts': 'export default {}\n' })

    const report = await verifyMechanical({ worktree: dir, branch: 'main', lane: fleetLane, testDir: head })
    expect(report.passed).toBe(false)
    expect(report.reasons.join('\n')).toMatch(/could not install the trusted vitest\.orchestrator\.config\.ts/)
  })
})

describe('parseVitestJson', () => {
  it('reads every count the verdict depends on', () => {
    expect(parseVitestJson(vitestJson({ numPendingTests: 2, numTodoTests: 1 }))).toEqual({
      numTotalTests: 12, numPassedTests: 12, numFailedTests: 0, numPendingTests: 2, numTodoTests: 1,
      numFailedTestSuites: 0, success: true,
    })
  })
  it.each(['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests', 'numFailedTestSuites', 'success'])(
    'is undefined when %s is missing — never read as zero', (field) => {
      const doc: Record<string, unknown> = { ...GREEN_COUNTS }
      delete doc[field]
      expect(parseVitestJson(JSON.stringify(doc))).toBeUndefined()
    })
  it.each([
    ['a negative count', { numFailedTests: -1 }],
    ['a fractional count', { numPassedTests: 1.5 }],
    ['a string count', { numTotalTests: '12' }],
    ['a string success', { success: 'true' }],
  ])('is undefined for %s', (_label, over) => {
    expect(parseVitestJson(vitestJson(over))).toBeUndefined()
  })
  it.each(['', 'null', '[]', '"green"', '{"numFailedTests": 0, "trunc'])('is undefined for %j', (text) => {
    expect(parseVitestJson(text)).toBeUndefined()
  })
})

// --- #1510/#1495: a failure signal must identify itself. The gate used to
// report "3 failed test(s), 2 failed suite(s)" and nothing else, so a failure
// that happens ONLY under the gate (it runs the head as a `git archive`
// export against the BASE checkout's node_modules) could not be named, and
// therefore could not be reproduced. The names were in the result file the
// gate already reads the counts from; they were simply thrown away.

describe('parseVitestFailures', () => {
  const report = (testResults: unknown[]): string => JSON.stringify({ ...GREEN_COUNTS, testResults })

  it('names each failed assertion by file and full name, with the first line of its error', () => {
    const text = report([{
      name: '/root/apps/worker/__tests__/unit/a.test.ts',
      status: 'failed',
      assertionResults: [
        { fullName: 'suite > passes', status: 'passed' },
        { fullName: 'suite > breaks', status: 'failed', failureMessages: ['AssertionError: expected 1 to be 2\n    at x.ts:1:1'] },
      ],
    }])
    expect(parseVitestFailures(text, '/root')).toEqual([
      {
        file: 'apps/worker/__tests__/unit/a.test.ts',
        test: 'suite > breaks',
        message: 'AssertionError: expected 1 to be 2 at x.ts:1:1',
      },
    ])
  })

  it('keeps the absolute path when no test root is given', () => {
    const text = report([{
      name: '/root/a.test.ts', status: 'failed',
      assertionResults: [{ fullName: 'breaks', status: 'failed', failureMessages: [] }],
    }])
    expect(parseVitestFailures(text)).toEqual([{ file: '/root/a.test.ts', test: 'breaks' }])
  })

  it('reports a file that failed before any test ran — the case the counts show only as a failed suite', () => {
    const text = report([{
      name: '/root/a.test.ts', status: 'failed', assertionResults: [],
      message: "Error: Cannot find module '@llamenos/nope'",
    }])
    expect(parseVitestFailures(text, '/root')).toEqual([
      { file: 'a.test.ts', message: "Error: Cannot find module '@llamenos/nope'" },
    ])
  })

  it('reports nothing for a wholly passing report', () => {
    const text = report([{
      name: '/root/a.test.ts', status: 'passed',
      assertionResults: [{ fullName: 'ok', status: 'passed' }],
    }])
    expect(parseVitestFailures(text, '/root')).toEqual([])
  })

  it.each([
    ['unparseable text', 'not json'],
    ['a non-object document', '[]'],
    ['a document with no testResults', '{"numFailedTests": 3}'],
    ['a testResults that is not an array', '{"testResults": "nope"}'],
    ['entries that are not objects', '{"testResults": [null, 7, "x"]}'],
  ])('returns [] rather than throwing for %s — it may never change a verdict', (_label, text) => {
    expect(parseVitestFailures(text, '/root')).toEqual([])
  })

  it.each([
    ['a GitHub token', 'failed with ghp_abcdefghijklmnopqrstuvwxyz0123', 'ghp_'],
    ['a connection URL with credentials', 'connect postgres://admin:hunter2@db.internal:5432/llamenos failed', 'hunter2'],
    ['an env assignment', 'env dump: SIGNAL_NOTIFIER_BEARER_TOKEN=s3cr3tvalue12345 was wrong', 's3cr3tvalue12345'],
    ['an Authorization header', 'sent Authorization: Bearer abcdefghijklmnop0123', 'abcdefghijklmnop0123'],
    ['a DATABASE_URL assignment', 'DATABASE_URL="postgres://x/y" was unset', 'postgres://x/y'],
  ])('scrubs %s out of a failure message', (_label, raw, secret) => {
    const text = report([{
      name: '/root/a.test.ts', status: 'failed',
      assertionResults: [{ fullName: 'leaks', status: 'failed', failureMessages: [raw] }],
    }])
    const message = parseVitestFailures(text, '/root')[0]?.message ?? ''
    expect(message).not.toContain(secret)
    expect(message).toContain('redacted')
  })

  it('leaves a public key alone — redacting every `…Key` would cost the diagnostic this exists to buy', () => {
    const text = report([{
      name: '/root/a.test.ts', status: 'failed',
      assertionResults: [{ fullName: 'differs', status: 'failed', failureMessages: ['expected publicKey: "abc123def456" to match'] }],
    }])
    expect(parseVitestFailures(text, '/root')[0]?.message).toContain('abc123def456')
  })

  it('bounds a single failure message so one crash dump cannot flood the log', () => {
    const text = report([{
      name: '/root/a.test.ts', status: 'failed',
      assertionResults: [{ fullName: 'huge', status: 'failed', failureMessages: ['x'.repeat(50_000)] }],
    }])
    expect((parseVitestFailures(text, '/root')[0]?.message ?? '').length).toBeLessThanOrEqual(201)
  })
})

describe('judgeTargetRun', () => {
  const exited = (exitCode: number, output = ''): TestRunResult => ({ exitCode, signal: undefined, output })
  const killed = (signal: string): TestRunResult => ({ exitCode: undefined, signal, output: '' })
  const reasonOf = (o: TargetOutcome): string => (o.passed ? `PASSED: ${o.evidence}` : o.reason)

  it('passes a green result from a runner that exited 0, with the passed count as evidence', () => {
    expect(judgeTargetRun('t', exited(0), vitestJson())).toEqual({
      passed: true, evidence: 't: result file read — 0 failed test(s), 0 failed suite(s), 12 passed, 0 skipped/todo, of 12 test(s)',
    })
  })
  it.each(['SIGKILL', 'SIGTERM'])('fails a runner killed by %s with no result file', (sig) => {
    const o = judgeTargetRun('t', killed(sig), undefined)
    expect(o.passed).toBe(false)
    expect(reasonOf(o)).toMatch(new RegExp(`^t: runner-exit — the test runner was killed by ${sig} and wrote no result file`))
  })
  it.each(['SIGKILL', 'SIGTERM'])('fails a runner killed by %s even after it wrote a green result', (sig) => {
    const o = judgeTargetRun('t', killed(sig), vitestJson())
    expect(o.passed).toBe(false)
    expect(reasonOf(o)).toMatch(new RegExp(`^t: runner-exit — .*but the runner was killed by ${sig}`))
  })
  it('fails a runner that never produced an exit code (ENOENT) even with a green result', () => {
    const o = judgeTargetRun('t', { exitCode: undefined, signal: undefined, output: 'ENOENT' }, vitestJson())
    expect(o.passed).toBe(false)
    expect(reasonOf(o)).toMatch(/never started or produced no exit code/)
  })
  it('fails exit 0 with no result file as a missing result', () => {
    expect(reasonOf(judgeTargetRun('t', exited(0), undefined))).toMatch(/^t: missing result/)
  })
  it('fails an unparseable result even from a runner that exited 0', () => {
    expect(reasonOf(judgeTargetRun('t', exited(0), '{"success": true}'))).toMatch(/^t: unparseable result/)
  })
  it('fails a failed suite with no failed test as a test failure', () => {
    const o = judgeTargetRun('t', exited(1), vitestJson({ numFailedTests: 0, numFailedTestSuites: 1, success: false }))
    expect(reasonOf(o)).toMatch(/^t: tests failed — 0 failed test\(s\), 1 failed suite\(s\)/)
  })
  it('fails green counts marked success:false from a runner that exited 0', () => {
    const o = judgeTargetRun('t', exited(0), vitestJson({ success: false }))
    expect(o.passed).toBe(false)
    expect(reasonOf(o)).toMatch(/exited 0 and the result is marked unsuccessful/)
  })
  // Finding 5: exactly what vitest 4.1.5 writes for `describe.skipIf(true)`
  // around two failing tests — collected, never run, `success: true`, exit 0.
  it('fails an all-skipped run: collected tests are not executed tests', () => {
    const o = judgeTargetRun('t', exited(0), vitestJson({ numTotalTests: 2, numPassedTests: 0, numPendingTests: 2 }))
    expect(o.passed).toBe(false)
    expect(reasonOf(o)).toMatch(/^t: no tests ran — .*0 passed, 2 skipped\/todo, of 2 test\(s\)/)
  })
  it('fails an all-todo run', () => {
    const o = judgeTargetRun('t', exited(0), vitestJson({ numTotalTests: 3, numPassedTests: 0, numTodoTests: 3 }))
    expect(reasonOf(o)).toMatch(/^t: no tests ran/)
  })
  it('fails a run in which some test was not skipped yet none passed', () => {
    const o = judgeTargetRun('t', exited(0), vitestJson({ numTotalTests: 2, numPassedTests: 0, numPendingTests: 1 }))
    expect(o.passed).toBe(false)
    expect(reasonOf(o)).toMatch(/^t: no test passed/)
  })
  it('passes a run with skipped tests alongside passing ones, and says how many were skipped', () => {
    const o = judgeTargetRun('t', exited(0), vitestJson({ numTotalTests: 12, numPassedTests: 10, numPendingTests: 2 }))
    expect(o).toEqual({
      passed: true, evidence: 't: result file read — 0 failed test(s), 0 failed suite(s), 10 passed, 2 skipped/todo, of 12 test(s)',
    })
  })

  // #1510: the counts alone are a verdict with no subject.
  const failingReport = (count: number): string => vitestJson({
    numFailedTests: count, numFailedTestSuites: 1, numPassedTests: Math.max(0, 12 - count), numTotalTests: 12 + count, success: false,
    testResults: [{
      name: '/root/apps/worker/__tests__/unit/recording.test.ts',
      status: 'failed',
      assertionResults: Array.from({ length: count }, (_v, i) => ({
        fullName: `call recording notice > case ${i}`,
        status: 'failed',
        failureMessages: [`AssertionError: case ${i} is wrong`],
      })),
    }],
  })

  it('NAMES the failing tests, not just their count', () => {
    const reason = reasonOf(judgeTargetRun('t', exited(1), failingReport(2), '/root'))
    expect(reason).toMatch(/^t: tests failed — 2 failed test\(s\)/)
    expect(reason).toContain('apps/worker/__tests__/unit/recording.test.ts > call recording notice > case 0')
    expect(reason).toContain('apps/worker/__tests__/unit/recording.test.ts > call recording notice > case 1')
    expect(reason).toContain('AssertionError: case 1 is wrong')
  })

  it('caps the list and says how many it left out, so a 400-failure run stays readable', () => {
    const reason = reasonOf(judgeTargetRun('t', exited(1), failingReport(40), '/root'))
    expect(reason).toContain('call recording notice > case 11')
    expect(reason).not.toContain('call recording notice > case 12')
    expect(reason).toContain('(+28 more failure(s) not listed)')
    expect(reason.length).toBeLessThan(8000)
  })

  it('names a suite that failed before any test ran, which the counts show only as a failed suite', () => {
    const text = vitestJson({
      numFailedTests: 0, numFailedTestSuites: 1, success: false,
      testResults: [{ name: '/root/a.test.ts', status: 'failed', assertionResults: [], message: 'Error: boom on import' }],
    })
    const reason = reasonOf(judgeTargetRun('t', exited(1), text, '/root'))
    expect(reason).toContain('a.test.ts (failed before any test ran)')
    expect(reason).toContain('Error: boom on import')
  })

  it("scrubs the runner's own output tail — a dying runner's stderr is where an env dump lands", () => {
    const run = exited(137, 'FATAL\nDATABASE_URL=postgres://admin:hunter2@db/llamenos\ntoken ghp_abcdefghijklmnopqrstuvwxyz0123\n')
    const reason = reasonOf(judgeTargetRun('t', run, undefined))
    expect(reason).toContain('last output:')
    expect(reason).not.toContain('hunter2')
    expect(reason).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123')
  })

  it('SAYS SO when the result named no failure, instead of printing a bare count — and falls back to the output tail', () => {
    const text = vitestJson({ numFailedTests: 3, numFailedTestSuites: 2, numPassedTests: 9, success: false })
    const reason = reasonOf(judgeTargetRun('t', exited(1, 'FAIL somewhere\n'), text, '/root'))
    expect(reason).toMatch(/the result file named no individual failure/)
    expect(reason).toContain('last output: FAIL somewhere')
  })
})

// --- Round 2, findings 2 and 5, against the REAL vitest this repo installs.
// A stand-in runner can only show which config path the gate passed; whether
// the PR's config (or a PostCSS config beside it) actually executes in the
// main process is a property of vitest itself, so it is measured here. Each
// case is shaped so that the vulnerable implementation reports PASS.

describe('phase 2 runs nothing the commit under judgement controls in vitest main (real vitest)', () => {
  const cleanup: string[] = []
  const realModules = resolvePath(dirname(fileURLToPath(import.meta.url)), '../../node_modules')
  const TIMEOUT = 120_000

  afterEach(() => {
    while (cleanup.length > 0) {
      const dir = cleanup.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  const BASE_CONFIG = [
    "import path from 'node:path'",
    'export default {',
    "  resolve: { alias: [{ find: /^@probe\\/(.*)/, replacement: path.resolve(__dirname, 'src/$1') }] },",
    "  test: { include: ['tests/orchestrator/**/*.test.ts'], environment: 'node' },",
    '}',
    '',
  ].join('\n')

  /** The trusted checkout, with the real install linked in. */
  function trustedRepo(): string {
    const dir = orchestratorDiffRepo(cleanup, {
      'vitest.orchestrator.config.ts': BASE_CONFIG,
      'src/value.ts': "export const value = 'base'\n",
    })
    symlinkSync(realModules, join(dir, 'node_modules'))
    return dir
  }

  const marker = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'llamenos-fleet-marker-'))
    cleanup.push(d)
    return join(d, 'executed')
  }

  const GREEN_FORGED = vitestJson({ numTotalTests: 5, numPassedTests: 5 })

  /** A PostCSS config (CommonJS) that, if vitest's main process ever loads
   *  it, rewrites `--outputFile` green and forces exit 0 AFTER vitest's own
   *  failing report — the attack the reviewers reproduced with a config file. */
  const postcssForgery = (markerPath: string): string => [
    "const fs = require('node:fs')",
    `fs.writeFileSync(${JSON.stringify(markerPath)}, 'executed in ' + process.argv.slice(1, 3).join(' '))`,
    "const out = (process.argv.find((a) => a.startsWith('--outputFile=')) || '').slice('--outputFile='.length)",
    `process.on('exit', () => { if (out) fs.writeFileSync(out, ${JSON.stringify(GREEN_FORGED)}); process.exitCode = 0 })`,
    'module.exports = { plugins: [] }',
    '',
  ].join('\n')

  /** A globalSetup module: runs in vitest's main process before any test. */
  const globalSetupForgery = (markerPath: string): string => [
    "import { writeFileSync } from 'node:fs'",
    'export default function forge() {',
    `  writeFileSync(${JSON.stringify(markerPath)}, 'executed in ' + process.argv.slice(1, 3).join(' '))`,
    "  const out = (process.argv.find((a) => a.startsWith('--outputFile=')) || '').slice('--outputFile='.length)",
    `  if (out) writeFileSync(out, ${JSON.stringify(GREEN_FORGED)})`,
    '  process.exit(0)',
    '}',
    '',
  ].join('\n')

  const FAILING_TEST = "import { it, expect } from 'vitest'\nit('is broken', () => { expect(1).toBe(2) })\n"

  it("never loads the export's own config: a globalSetup that forges green and exits 0 cannot pass a failing test", async () => {
    const dir = trustedRepo()
    const executed = marker()
    const head = headExport(cleanup, dir, {
      'vitest.orchestrator.config.ts':
        "export default { test: { include: ['tests/orchestrator/**/*.test.ts'], globalSetup: ['./forge.ts'] } }\n",
      'forge.ts': globalSetupForgery(executed),
      'tests/orchestrator/broken.test.ts': FAILING_TEST,
    })

    const report = await verifyMechanical({ worktree: dir, branch: 'main', lane: fleetLane, testDir: head })
    expect(report.passed).toBe(false)
    expect(report.reasons.join('\n')).toMatch(/tests failed — 1 failed test\(s\)/)
    expect(existsSync(executed)).toBe(false)
  }, TIMEOUT)

  // The break-it proof for #1510's observability fix: a deliberately broken
  // test, run through the real gate path end to end, must come back NAMED.
  // Before this, the same run reported "1 failed test(s)" and nothing else.
  it('NAMES a deliberately broken test in the gate report, not just its count', async () => {
    const dir = trustedRepo()
    const head = headExport(cleanup, dir, {
      'tests/orchestrator/broken.test.ts':
        "import { describe, it, expect } from 'vitest'\n" +
        "describe('a named suite', () => { it('is deliberately broken', () => { expect(1).toBe(2) }) })\n",
    })

    const report = await verifyMechanical({ worktree: dir, branch: 'main', lane: fleetLane, testDir: head })
    expect(report.passed).toBe(false)
    const reasons = report.reasons.join('\n')
    expect(reasons).toMatch(/tests failed — 1 failed test\(s\)/)
    expect(reasons).toContain('tests/orchestrator/broken.test.ts > a named suite is deliberately broken')
    expect(reasons).toContain('expected 1 to be 2')
    // Relative to the export, not the runner's absolute temp path.
    expect(reasons).not.toContain(head)
  }, TIMEOUT)

  it("never searches the export for a PostCSS config: one that forges green on exit cannot pass a failing test", async () => {
    const dir = trustedRepo()
    const executed = marker()
    const head = headExport(cleanup, dir, {
      'postcss.config.cjs': postcssForgery(executed),
      'tests/orchestrator/style.css': '.a { color: red }\n',
      'tests/orchestrator/style.test.ts': `import './style.css'\n${FAILING_TEST}`,
    })

    const report = await verifyMechanical({ worktree: dir, branch: 'main', lane: fleetLane, testDir: head })
    expect(report.passed).toBe(false)
    expect(report.reasons.join('\n')).toMatch(/tests failed — 1 failed test\(s\)/)
    expect(existsSync(executed)).toBe(false)
  }, TIMEOUT)

  // Why the trusted config is installed INTO the export rather than loaded
  // from the trusted checkout: its aliases are built from `__dirname`. Loaded
  // from the checkout, `@probe/value` would be the BASE's module, and a PR
  // that changed (or broke) it would be judged on code it did not ship.
  it("resolves the trusted config's __dirname aliases against the export, so the PR's own source is what is tested", async () => {
    const dir = trustedRepo()
    const head = headExport(cleanup, dir, {
      'src/value.ts': "export const value = 'head'\n",
      'tests/orchestrator/value.test.ts':
        "import { it, expect } from 'vitest'\nimport { value } from '@probe/value'\nit('sees the head', () => { expect(value).toBe('head') })\n",
    })

    const report = await verifyMechanical({ worktree: dir, branch: 'main', lane: fleetLane, testDir: head })
    expect(report.reasons).toEqual([])
    expect(report.passed).toBe(true)
    expect(report.testResults).toEqual([
      'orchestrator: result file read — 0 failed test(s), 0 failed suite(s), 1 passed, 0 skipped/todo, of 1 test(s)',
    ])
  }, TIMEOUT)

  it('FAILS a suite whose failing tests are all skipped by describe.skipIf(true)', async () => {
    const dir = trustedRepo()
    const head = headExport(cleanup, dir, {
      'tests/orchestrator/skipped.test.ts': [
        "import { describe, it, expect } from 'vitest'",
        'describe.skipIf(true)("hidden", () => {',
        "  it('is broken', () => { expect(1).toBe(2) })",
        "  it('is also broken', () => { expect(1).toBe(3) })",
        '})',
        '',
      ].join('\n'),
    })

    const report = await verifyMechanical({ worktree: dir, branch: 'main', lane: fleetLane, testDir: head })
    expect(report.passed).toBe(false)
    expect(report.reasons.join('\n')).toMatch(/no tests ran — .*0 passed, 2 skipped\/todo, of 2 test\(s\)/)
  }, TIMEOUT)
})
