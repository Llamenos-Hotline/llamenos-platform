// CI-structure guards that need no `bun install`: Bun's built-in YAML parser
// and node: built-ins only, so ci.yml's `docs-guard` job runs this file on
// every event with nothing but setup-bun.
//
// ── Self-hosted Mac jobs give `bun install` a per-runner BUN_TMPDIR ──────────
//
// Two self-hosted runners share one Mac, and the two Mac jobs of a merge group
// start `bun install` in the same instant (#1910's `ui (0)`/`ui (3)`: 2 µs
// apart; #1916's ios-build-test/build: 43 ms apart). bun 1.3.5 on macOS does
// not read TMPDIR for installs — its temp dir is `BUN_TMPDIR orelse
// "/private/tmp"` — so both write a node-gyp shim dir into one /private/tmp
// under a name derived from `now_ns | 12345`. The macOS clock is microsecond
// resolution and the OR folds neighbouring microseconds together, so the two
// compute the same name and APFS fails the loser's create with ENOENT:
// `error: FileNotFound creating node-gyp tempdir`, an ejected merge group,
// and no test ever ran. Full measurements are on the step in ios-e2e.yml.
//
// #1919 pinned TMPDIR on each bun step for that error. bun never reads it
// there, so it changed nothing, and no test asserted anything about it. These
// tests assert the variable bun actually reads, on every job that can land on
// that host, before the first step that could run bun.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const WORKFLOWS = join(import.meta.dir, '..', '.github', 'workflows')

interface Step {
  name?: string
  uses?: string
  run?: string
  env?: Record<string, unknown>
}
interface Job {
  'runs-on'?: unknown
  env?: Record<string, unknown>
  steps?: Step[]
}
interface Workflow {
  env?: Record<string, unknown>
  jobs?: Record<string, Job>
}

/** Every workflow file, parsed. */
export function loadWorkflows(dir: string = WORKFLOWS): Map<string, Workflow> {
  const out = new Map<string, Workflow>()
  for (const file of readdirSync(dir).sort()) {
    if (!/\.ya?ml$/.test(file)) continue
    out.set(file, Bun.YAML.parse(readFileSync(join(dir, file), 'utf8')) as Workflow)
  }
  return out
}

/**
 * Can this job be scheduled onto the self-hosted Mac? `runs-on` may be a
 * label list, a string, or an expression choosing between a self-hosted label
 * set and a hosted image (ios-e2e.yml's mixed matrix) — so match the labels
 * anywhere in its serialised form rather than modelling each shape.
 */
export function canRunOnSelfHostedMac(job: Job): boolean {
  const runsOn = JSON.stringify(job['runs-on'] ?? '')
  return /self-hosted/.test(runsOn) && /macOS/i.test(runsOn)
}

/** A step that runs bun, or installs it. */
export function touchesBun(step: Step): boolean {
  if (step.uses?.includes('oven-sh/setup-bun')) return true
  return /(^|[^\w-])bunx?(\s|$)/m.test(step.run ?? '')
}

/** The step that exports a per-runner BUN_TMPDIR to every later step. */
export function exportsPerRunnerBunTmpdir(step: Step): boolean {
  return /^\s*echo\s+"?BUN_TMPDIR=\$RUNNER_TEMP\/[\w.-]+"?\s*>>\s*"?\$GITHUB_ENV"?\s*$/m.test(step.run ?? '')
}

export interface Violation {
  job: string
  problem: string
}

/** Every self-hosted-Mac job whose `bun install` could share /private/tmp. */
export function bunTmpdirViolations(workflows: Map<string, Workflow>): { checked: string[]; violations: Violation[] } {
  const checked: string[] = []
  const violations: Violation[] = []
  for (const [file, wf] of workflows) {
    for (const [id, job] of Object.entries(wf.jobs ?? {})) {
      if (!canRunOnSelfHostedMac(job)) continue
      const where = `${file}:${id}`
      checked.push(where)
      const steps = job.steps ?? []
      const firstBun = steps.findIndex(touchesBun)
      const exporter = steps.findIndex(exportsPerRunnerBunTmpdir)
      if (firstBun === -1) continue
      if (exporter === -1) {
        violations.push({ job: where, problem: 'runs bun but never exports BUN_TMPDIR=$RUNNER_TEMP/… to $GITHUB_ENV' })
      } else if (exporter > firstBun) {
        violations.push({
          job: where,
          problem: `exports BUN_TMPDIR at step ${exporter} but bun first runs at step ${firstBun} (${steps[firstBun].name ?? steps[firstBun].uses})`,
        })
      }
      // A later `env:` BUN_TMPDIR wins over GITHUB_ENV and would quietly put
      // the step back on a shared directory.
      const overrides = [
        wf.env?.BUN_TMPDIR !== undefined ? 'workflow env' : '',
        job.env?.BUN_TMPDIR !== undefined ? 'job env' : '',
        ...steps.map((s, i) => (s.env?.BUN_TMPDIR !== undefined ? `step ${i} (${s.name ?? s.uses}) env` : '')),
      ].filter(Boolean)
      for (const o of overrides) violations.push({ job: where, problem: `${o} sets BUN_TMPDIR, overriding the per-runner export` })
    }
  }
  return { checked, violations }
}

describe('self-hosted Mac jobs give bun install a per-runner BUN_TMPDIR', () => {
  const workflows = loadWorkflows()

  test('finds every job that can land on the self-hosted Mac (an empty scan would pass vacuously)', () => {
    const { checked } = bunTmpdirViolations(workflows)
    expect(checked).toEqual(expect.arrayContaining(['ci.yml:ios-build-test', 'ios-e2e.yml:build', 'ios-e2e.yml:ui']))
  })

  test('each exports BUN_TMPDIR under RUNNER_TEMP before its first bun step, and nothing overrides it', () => {
    const { violations } = bunTmpdirViolations(workflows)
    expect(violations).toEqual([])
  })
})

// The checker above is only evidence if it rejects the shapes it exists for.
// Each fixture is the real defect, in miniature.
describe('the BUN_TMPDIR check rejects the defects it was written for', () => {
  const mac = ['self-hosted', 'macOS', 'ARM64', 'ios-e2e']
  const setupBun: Step = { name: 'Setup Bun', uses: 'oven-sh/setup-bun@x' }
  const install: Step = { name: 'Install', run: 'bun install --frozen-lockfile' }
  const exporter: Step = {
    name: 'Give bun a per-runner temp dir',
    run: 'mkdir -p "$RUNNER_TEMP/bun-tmp"\necho "BUN_TMPDIR=$RUNNER_TEMP/bun-tmp" >> "$GITHUB_ENV"\n',
  }
  const one = (job: Job) => bunTmpdirViolations(new Map([['w.yml', { jobs: { j: job } }]])).violations

  test("#1919's shape — TMPDIR pinned, BUN_TMPDIR absent — is rejected", () => {
    const pinnedTmpdir = { ...install, env: { TMPDIR: '${{ runner.temp }}' } }
    expect(one({ 'runs-on': mac, steps: [setupBun, pinnedTmpdir] })).toHaveLength(1)
  })

  test('an export placed after the first bun step is rejected', () => {
    expect(one({ 'runs-on': mac, steps: [setupBun, install, exporter] })[0]?.problem).toContain('bun first runs at step 0')
  })

  test('a step-level BUN_TMPDIR override back onto /private/tmp is rejected', () => {
    const override = { ...install, env: { BUN_TMPDIR: '/private/tmp' } }
    expect(one({ 'runs-on': mac, steps: [exporter, setupBun, override] })[0]?.problem).toContain('overriding')
  })

  test("ios-e2e.yml's mixed self-hosted/hosted runs-on expression is recognised as the Mac", () => {
    const mixed = `\${{ matrix.host == 'mac' && fromJSON('["self-hosted", "macOS", "ARM64", "ios-e2e"]') || 'macos-15' }}`
    expect(one({ 'runs-on': mixed, steps: [setupBun, install] })).toHaveLength(1)
  })

  test('the fixed shape passes, and hosted or Linux self-hosted jobs are out of scope', () => {
    expect(one({ 'runs-on': mac, steps: [exporter, setupBun, install] })).toEqual([])
    expect(one({ 'runs-on': 'macos-15', steps: [setupBun, install] })).toEqual([])
    expect(one({ 'runs-on': ['self-hosted', 'linux', 'x64'], steps: [setupBun, install] })).toEqual([])
  })

  test('scripts that run bun count as bun steps; words merely containing "bun" do not', () => {
    expect(touchesBun({ run: 'set -e\nbunx vitest run' })).toBe(true)
    expect(touchesBun({ run: 'echo ok && bun run codegen' })).toBe(true)
    expect(touchesBun({ run: 'echo bundle exec fastlane' })).toBe(false)
    expect(touchesBun({ run: 'rm -rf bun-cache' })).toBe(false)
  })
})
