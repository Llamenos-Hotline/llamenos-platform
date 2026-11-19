// @suite: repo
// Runs mac-ci-work-volume.sh's own `selftest` (stubs stand in for hdiutil, mount,
// launchctl, ps and xcrun, so it runs anywhere) so the cutover's safety rules are
// enforced by CI rather than by whoever remembers to run it after an edit.
//
// What it must prove, each a break-it:
//   * cutover will not link onto a volume that is detached, or one a
//     LAUNCHD-started process is denied on (the runner's situation: an ssh
//     `touch` proves nothing), and moves nothing when it refuses;
//   * cutover will not move a runner's workspace while ANY runner has a
//     Runner.Worker, or while a simulator is booted, and a worker belonging to
//     some other install does not block it;
//   * what moves is kept, a second cutover is a no-op, a link to somewhere else is
//     never overwritten, a leftover from an earlier attempt stops it;
//   * rollback refuses a detached volume rather than lose what is on it, and
//     `rollback --discard-missing` recovers a PERMANENTLY lost volume only when every
//     link target (and the image) is provably absent;
//   * runner-start/health judge a runner by its Runner.Listener process, not by
//     launchctl or svc.sh output;
//   * the attach agent's wrapper does nothing when attached, attaches when not,
//     and names the failure when the SSD is absent.
//
// And what the cutover costs every workflow that runs on the Mac: `_work` is a
// symlink, so a job's workspace has two names (see the rail at the bottom).
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

const SCRIPT = join(import.meta.dir, 'mac-ci-work-volume.sh')
const WORKFLOWS = join(import.meta.dir, '..', '..', '.github', 'workflows')

describe('mac-ci-work-volume.sh selftest', () => {
  const run = spawnSync('bash', [SCRIPT, 'selftest'], { encoding: 'utf8', timeout: 120_000 })
  const out = `${run.stdout}${run.stderr}`

  test('passes with no failing case', () => {
    expect(out).not.toContain('  FAIL  ')
    expect(run.status).toBe(0)
    expect(out).toContain('selftest passed')
  })

  test.each([
    'cutover refuses while the image is not attached (rc=1)',
    '...and moved nothing',
    'attach fails loudly when the image is not on the SSD (rc=1)',
    'attach is idempotent: a second call says so and does not call hdiutil again',
    'hdiutil was not called by the second attach',
    'create refuses to overwrite an existing image (rc=1)',
    'verify FAILS when the launchd-started process is denied (rc=1)',
    'cutover refuses a volume a launchd process cannot use (rc=1)',
    'verify passes when the launchd-started process can write, read and exec (rc=0)',
    'cutover refuses while ANY runner has a job (rc=1)',
    '...and has moved NOTHING, not even the idle runner',
    'a Runner.Worker belonging to some other install does not block (rc=0)',
    'cutover refuses while a simulator is booted (rc=1)',
    'cutover succeeds when attached, verified and idle (rc=0)',
    "runner 1's workspace content came across",
    'the device came across',
    'a stale file left on the volume by an earlier rollback does not survive the cutover',
    'a second cutover is a no-op (rc=0)',
    'a _work link to somewhere else is refused, not overwritten (rc=1)',
    'rollback refuses when the volume is detached, rather than lose what is on it (rc=1)',
    'rollback succeeds when attached and idle (rc=0)',
    'a leftover .pre-ci-work from an earlier attempt stops cutover (rc=1)',
    'the wrapper does nothing when the volume is already attached',
    'the wrapper attaches it when it is not',
    'the wrapper names the failure when the SSD is not there',
    "discard-missing with no links is an idempotent no-op (rc=0)",
    "discard-missing refuses when one link target is still present (rc=1)",
    "discard-missing refuses while the image still exists (rc=1)",
    "discard-missing refuses while a runner has a job (rc=1)",
    "discard-missing proceeds when every target is absent (rc=0)",
    "...and each discarded link is named in the report",
    "a second discard-missing is an idempotent no-op (rc=0)",
    "runner-health fails when no Runner.Listener is running (rc=1)",
    "runner-health still fails when only one install has a Listener (rc=1)",
    "runner-start FAILS when kickstart leaves no process, whatever launchctl printed (rc=1)",
    "runner-start succeeds once the Listener exists (rc=0)",
    "runner-start leaves a running install alone (rc=0)",
    "the wrapper exits non-zero when it could not attach (rc=1)",
    "...but logs only attempts 1, 2 and 4 (backoff), not one line per run",
    "the fifth consecutive failure logs a loud ALERT naming the way out",
    "status reports the attach agent as FAILING",
    "the wrapper exits 0 once the volume attaches (rc=0)",
    "...and clears the failure record",
  ])('asserts: %s', (label) => {
    // A case that silently stopped running would otherwise read as green.
    expect(out).toContain(`  ok    ${label}`)
  })
})

// ── the cutover's cost: a workspace with two names ─────────────────────────
//
// After `cutover`, GITHUB_WORKSPACE is the link path
// (/Users/<u>/actions-runner-ios-<N>/_work/...) while a step's cwd is the
// resolved one (/Volumes/CIWork/actions-runner-ios-<N>/_work/...). actions/cache
// globs a RELATIVE `path:` from the cwd and archives each match relative to
// GITHUB_WORKSPACE, so the entry holds `../../../../../../Volumes/CIWork/
// actions-runner-ios-<N>/...` — the SAVING runner's workspace. Restored on the
// other runner it lands in the saver's workspace, `cache-hit` is still true,
// the build behind it is skipped, and the job finds nothing (run 43802220455
// saved the XCFramework on ios-2; run 43821741537 restored it on ios-1 and
// failed at "Copy UniFFI bindings"). A path that names the workspace
// absolutely is archived relative to it whatever the cwd resolves to.

type Step = { uses?: string; with?: Record<string, unknown> }
type Job = { 'runs-on'?: unknown; steps?: Step[] }

const ABSOLUTE = [/^\//, /^~/, /^\$\{\{\s*github\.workspace\s*\}\}/, /^\$\{\{\s*runner\.(temp|tool_cache)\s*\}\}/]

function runsOnTheMac(runsOn: unknown): boolean {
  const labels = (Array.isArray(runsOn) ? runsOn : [runsOn]).map(String)
  return labels.includes('self-hosted') && labels.includes('macOS')
}

/** Every actions/cache `path:` entry a Mac job hands over relative to the cwd,
 *  as `<workflow> <job>: <entry>`. */
export function relativeMacCachePaths(workflow: string, text: string): string[] {
  const doc = parseYaml(text) as { jobs?: Record<string, Job> } | null
  const found: string[] = []
  for (const [name, job] of Object.entries(doc?.jobs ?? {})) {
    if (!runsOnTheMac(job['runs-on'])) continue
    for (const step of job.steps ?? []) {
      if (!/^actions\/cache(\/(restore|save))?@/.test(step.uses ?? '')) continue
      const entries = String(step.with?.path ?? '').split('\n').map((l) => l.trim().replace(/^!/, '')).filter(Boolean)
      for (const entry of entries) {
        if (!ABSOLUTE.some((rx) => rx.test(entry))) found.push(`${workflow} ${name}: ${entry}`)
      }
    }
  }
  return found
}

describe('a Mac job never hands actions/cache a cwd-relative path', () => {
  const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))
  const macCacheSteps = files.flatMap((f) => {
    const doc = parseYaml(readFileSync(join(WORKFLOWS, f), 'utf8')) as { jobs?: Record<string, Job> } | null
    return Object.entries(doc?.jobs ?? {})
      .filter(([, j]) => runsOnTheMac(j['runs-on']))
      .flatMap(([n, j]) => (j.steps ?? []).filter((s) => /^actions\/cache/.test(s.uses ?? '')).map(() => `${f} ${n}`))
  })

  test('the rail is looking at the Mac jobs that cache (not vacuously green)', () => {
    expect(macCacheSteps).toContain('ios-e2e.yml build')
    expect(macCacheSteps).toContain('ci.yml ios-build-test')
  })

  test('every such path names the workspace (or another absolute root)', () => {
    const found = files.flatMap((f) => relativeMacCachePaths(f, readFileSync(join(WORKFLOWS, f), 'utf8')))
    expect(found).toEqual([])
  })

  test('break-it: the exact pre-fix step is caught, on the Mac only', () => {
    const wf = (runsOn: string) => `
jobs:
  build:
    runs-on: ${runsOn}
    steps:
      - uses: actions/cache@0000000000000000000000000000000000000000
        with:
          path: |
            apps/ios/LlamenosCoreFFI.xcframework
            \${{ github.workspace }}/packages/crypto/dist/ios/LlamenosCore.swift
            !apps/ios/tmp
          key: k
      - uses: actions/cache/restore@0000000000000000000000000000000000000000
        with:
          path: \${{ runner.temp }}/llamenos-build
          key: k
`
    expect(relativeMacCachePaths('x.yml', wf('[self-hosted, macOS, ARM64, ios-e2e]'))).toEqual([
      'x.yml build: apps/ios/LlamenosCoreFFI.xcframework',
      'x.yml build: apps/ios/tmp',
    ])
    // A hosted runner has one name for its workspace; a relative path is fine there.
    expect(relativeMacCachePaths('x.yml', wf('macos-15'))).toEqual([])
  })
})
