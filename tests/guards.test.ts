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
//
// ── ...and setup-bun installs into a per-runner HOME ─────────────────────────
//
// The same two runners are the same macOS user, so setup-bun's
// `$HOME/.bun/bin/bun` is one file. Its cache restore is a `tar -xf -P` over
// that file — an in-place rewrite of a signed Mach-O that the other runner may
// be exec'ing or running (the native backend is a bun process for a whole
// job). macOS SIGKILLs a process whose executable no longer matches its
// signature: `bun install` died `Killed: 9` (exit 137) 40 ms in, before any
// test, in merge group 40438235535, 25 ms after the other runner's tar wrote
// the file. A setup-bun step with HOME under runner.temp gets its own copy.
//
// ── Playwright jobs run on a fixed runner image ──────────────────────────────
//
// Playwright keeps a browser build and an apt dependency list per OS release
// and refuses a release it has no entry for. GitHub moved `ubuntu-latest` to
// 26.04 under us; @playwright/test 1.59.1 has no 26.04 entry, so `playwright
// install --with-deps chromium` died with `Playwright does not support
// chromium on ubuntu26.04-x64` and ejected four merge groups in a day
// (#2315), while `desktop-e2e`, pinned to 24.04, passed in the same runs.
// Those jobs only run in the merge queue, so nothing on a PR would have
// shown it. This guard runs on every PR: a job that installs a Playwright
// browser must name a fixed Ubuntu image, so the OS only moves in a reviewed
// diff that also has to carry a Playwright version supporting it.
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
  strategy?: { matrix?: Record<string, unknown> }
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

/** Does this step install bun? */
export function installsBun(step: Step): boolean {
  return step.uses?.includes('oven-sh/setup-bun') === true
}

/** Does this step install bun under a HOME that only this runner can see? */
export function installsBunIntoPerRunnerHome(step: Step): boolean {
  return /^\$\{\{\s*runner\.temp\s*\}\}\/\S+$/.test(String(step.env?.HOME ?? ''))
}

/** Every self-hosted-Mac job whose setup-bun could rewrite a bun the co-tenant is running. */
export function bunHomeViolations(workflows: Map<string, Workflow>): { checked: string[]; violations: Violation[] } {
  const checked: string[] = []
  const violations: Violation[] = []
  for (const [file, wf] of workflows) {
    for (const [id, job] of Object.entries(wf.jobs ?? {})) {
      if (!canRunOnSelfHostedMac(job)) continue
      for (const step of (job.steps ?? []).filter(installsBun)) {
        const where = `${file}:${id}:${step.name ?? step.uses}`
        checked.push(where)
        if (!installsBunIntoPerRunnerHome(step)) {
          violations.push({ job: where, problem: 'setup-bun runs without HOME=${{ runner.temp }}/…, so it rewrites the shared ~/.bun/bin/bun' })
        }
      }
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

describe('self-hosted Mac jobs install bun into a per-runner HOME', () => {
  const workflows = loadWorkflows()

  test('finds every setup-bun step that can land on the self-hosted Mac (an empty scan would pass vacuously)', () => {
    const { checked } = bunHomeViolations(workflows)
    expect(checked.map((c) => c.split(':').slice(0, 2).join(':'))).toEqual(
      expect.arrayContaining(['ci.yml:ios-build-test', 'ios-e2e.yml:build', 'ios-e2e.yml:ui']),
    )
  })

  test('each pins HOME under runner.temp on its setup-bun step', () => {
    const { violations } = bunHomeViolations(workflows)
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

describe('the setup-bun HOME check rejects the defect it was written for', () => {
  const mac = ['self-hosted', 'macOS', 'ARM64', 'ios-e2e']
  const shared: Step = { name: 'Setup Bun', uses: 'oven-sh/setup-bun@x', env: { TMPDIR: '${{ runner.temp }}' } }
  const isolated: Step = { ...shared, env: { ...shared.env, HOME: '${{ runner.temp }}/bun-home' } }
  const one = (job: Job) => bunHomeViolations(new Map([['w.yml', { jobs: { j: job } }]])).violations

  test('a setup-bun step on the real HOME — merge group 40438235535\'s shape — is rejected', () => {
    expect(one({ 'runs-on': mac, steps: [shared] })).toHaveLength(1)
  })

  test('a HOME that is not per-runner is rejected', () => {
    const fixed = { ...shared, env: { HOME: '/Users/rhonda' } }
    expect(one({ 'runs-on': mac, steps: [fixed] })).toHaveLength(1)
  })

  test('a per-runner HOME passes, and hosted jobs are out of scope', () => {
    expect(one({ 'runs-on': mac, steps: [isolated] })).toEqual([])
    expect(one({ 'runs-on': 'macos-15', steps: [shared] })).toEqual([])
  })
})

/** Does this step fetch a Playwright browser or its OS packages? */
export function installsPlaywright(step: Step): boolean {
  return /\bplaywright\s+install(-deps)?\b/.test(step.run ?? '')
}

/**
 * Every runner label this job can be scheduled with. A `${{ matrix.X }}`
 * expression is expanded from the job's own matrix (`X: [...]` and
 * `include: [{ X }]`); any other expression is returned verbatim, so it fails
 * the fixed-image check below instead of being waved through unread.
 */
export function runnerLabels(job: Job): string[] {
  const runsOn = job['runs-on']
  if (Array.isArray(runsOn)) return runsOn.map(String)
  const label = String(runsOn ?? '')
  const key = label.match(/^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/)?.[1]
  if (key === undefined) return [label]
  const matrix = job.strategy?.matrix ?? {}
  const axis = Array.isArray(matrix[key]) ? (matrix[key] as unknown[]) : []
  const include = Array.isArray(matrix.include) ? (matrix.include as Record<string, unknown>[]) : []
  const values = [...axis, ...include.map((row) => row[key]).filter((v) => v !== undefined)].map(String)
  return values.length > 0 ? values : [label]
}

/** A GitHub-hosted Ubuntu image named by its release, e.g. `ubuntu-24.04`. */
export function isFixedUbuntuImage(label: string): boolean {
  return /^ubuntu-\d{2}\.\d{2}(-arm)?$/.test(label)
}

const PLAYWRIGHT_RANGE = (() => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')) as {
    devDependencies?: Record<string, string>
    dependencies?: Record<string, string>
  }
  return pkg.devDependencies?.['@playwright/test'] ?? pkg.dependencies?.['@playwright/test'] ?? '(not declared)'
})()

/** Every job that installs a Playwright browser on a runner image that can move under it. */
export function playwrightRunnerViolations(workflows: Map<string, Workflow>): { checked: string[]; violations: Violation[] } {
  const checked: string[] = []
  const violations: Violation[] = []
  for (const [file, wf] of workflows) {
    for (const [id, job] of Object.entries(wf.jobs ?? {})) {
      if (!(job.steps ?? []).some(installsPlaywright)) continue
      const where = `${file}:${id}`
      checked.push(where)
      for (const label of runnerLabels(job).filter((l) => !isFixedUbuntuImage(l))) {
        violations.push({
          job: where,
          problem:
            `installs a Playwright browser on runs-on \`${label}\`, which is not a fixed ubuntu-NN.NN image. ` +
            `@playwright/test ${PLAYWRIGHT_RANGE} only installs on OS releases it has a build for; ` +
            `pin the image and move it together with a Playwright version that supports the new one (#2315)`,
        })
      }
    }
  }
  return { checked, violations }
}

describe('Playwright jobs run on a fixed runner image', () => {
  const workflows = loadWorkflows()

  test('finds every job that installs a Playwright browser (an empty scan would pass vacuously)', () => {
    const { checked } = playwrightRunnerViolations(workflows)
    expect(checked).toEqual(
      expect.arrayContaining([
        'ci.yml:e2e',
        'ci.yml:desktop-e2e',
        'ci.yml:backend-bdd',
        'ci.yml:backend-bdd-opt-in',
        'main-canary.yml:e2e',
      ]),
    )
  })

  test('each names a fixed Ubuntu image', () => {
    const { violations } = playwrightRunnerViolations(workflows)
    expect(violations).toEqual([])
  })
})

describe('the Playwright runner check rejects the defect it was written for', () => {
  const install: Step = { name: 'Install Playwright browsers', run: 'bunx playwright install --with-deps chromium' }
  const deps: Step = { name: 'Install Playwright deps (cached)', run: 'bunx playwright install-deps chromium' }
  const one = (job: Job) => playwrightRunnerViolations(new Map([['w.yml', { jobs: { j: job } }]])).violations

  test("`ubuntu-latest` — the four ejected merge groups' shape — is rejected, naming the label and the Playwright version", () => {
    const [v] = one({ 'runs-on': 'ubuntu-latest', steps: [install] })
    expect(v?.problem).toContain('`ubuntu-latest`')
    expect(v?.problem).toContain(`@playwright/test ${PLAYWRIGHT_RANGE}`)
  })

  test('the cached-browser branch (`install-deps` only) is in scope too', () => {
    expect(one({ 'runs-on': 'ubuntu-latest', steps: [deps] })).toHaveLength(1)
  })

  test('a matrix runs-on is expanded, and one floating row is enough to reject', () => {
    const matrix = { include: [{ platform: 'ubuntu-24.04' }, { platform: 'ubuntu-latest' }] }
    const job: Job = { 'runs-on': '${{ matrix.platform }}', strategy: { matrix }, steps: [install] }
    expect(one(job).map((v) => v.problem)).toEqual([expect.stringContaining('`ubuntu-latest`')])
  })

  test('an expression the check cannot expand is rejected, not passed unread', () => {
    expect(one({ 'runs-on': "${{ inputs.runner || 'ubuntu-24.04' }}", steps: [install] })).toHaveLength(1)
  })

  test('a fixed image passes, and jobs that install no browser are out of scope', () => {
    expect(one({ 'runs-on': 'ubuntu-24.04', steps: [install, deps] })).toEqual([])
    expect(one({ 'runs-on': '${{ matrix.os }}', strategy: { matrix: { os: ['ubuntu-24.04'] } }, steps: [install] })).toEqual([])
    expect(one({ 'runs-on': 'ubuntu-latest', steps: [{ run: 'bunx playwright test --project=bdd' }] })).toEqual([])
  })
})
