import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

/**
 * Rail for #1887: `fleet/review` intermittently hung at its "Setup Bun"
 * step for the full 30-minute job timeout. `llamenos-review-box` — the
 * single self-hosted runner every review in this repo serialises through —
 * already has the pinned Bun installed, so `setup-bun`'s network fetch was
 * obtaining a toolchain that was already present, and the fetch is what
 * stalled. Each hang held the runner hostage for 30 minutes and blocked
 * every merge, not just the PR that triggered it.
 *
 * The fix has three parts, all pinned below:
 *
 *   1. A probe step (`id: host_bun`) resolves `bun` from PATH (falling back
 *      to the installer's default ~/.bun/bin/bun) and uses it when — and
 *      only when — `bun --version` is exactly BUN_VERSION. A different
 *      version fails the job LOUDLY (`bun-version-mismatch`): never review
 *      with an unpinned toolchain, never silently accept whatever is
 *      installed.
 *   2. `setup-bun` runs only when the probe found no Bun at all, so the
 *      stall-prone download is no longer on the self-hosted box's path.
 *      (The `synchronize` arm's ubuntu-latest runner has no Bun, so the
 *      fallback must remain real.)
 *   3. `setup-bun` carries its own short `timeout-minutes`: a stalled
 *      download now fails in minutes and frees the runner, instead of
 *      burning the whole 30-minute job timeout. The gate already reports
 *      NO-VERDICT:setup-failed honestly, so failing fast loses no
 *      correctness — only latency.
 *
 * The behavioural half is a real functional test, not a regex over the
 * YAML: it extracts the probe step's ACTUAL `run:` script with a YAML
 * parser (so it always tests the literal bytes GitHub would run) and
 * executes it against stub `bun` binaries — the only substitution — the
 * same way fleet-review-export-step.test.ts and the merge-group arm's
 * functional test do.
 */

const FLEET_REVIEW_YML = join(process.cwd(), '.github', 'workflows', 'fleet-review.yml')
const JOB = 'fleet-review'
const PROBE_NAME = "Use the runner's own Bun when it is the pinned version"
const SETUP_NAME = 'Setup Bun'
const PINNED_BUN = '1.3.5' // BUN_VERSION at the top of fleet-review.yml
const FAILED_MARKER = 'fleet/review FAILED:'
const REASON_TOKEN = 'bun-version-mismatch'

interface WorkflowStep {
  name?: string
  id?: string
  if?: string
  run?: string
  uses?: string
  'timeout-minutes'?: number
  with?: Record<string, unknown>
}
interface WorkflowJob {
  env?: Record<string, unknown>
  steps: WorkflowStep[]
}
interface WorkflowDoc {
  env?: Record<string, unknown>
  jobs: Record<string, WorkflowJob>
}

function reviewDoc(): WorkflowDoc {
  const doc = parseYaml(readFileSync(FLEET_REVIEW_YML, 'utf8')) as WorkflowDoc
  if (!doc.jobs[JOB]) throw new Error(`no "${JOB}" job in fleet-review.yml — the parser must not pass vacuously`)
  return doc
}

function reviewSteps(): WorkflowStep[] {
  const steps = reviewDoc().jobs[JOB].steps
  if (!steps || steps.length === 0) throw new Error('the fleet-review job has no steps — the parser must not pass vacuously')
  return steps
}

function stepByName(name: string): WorkflowStep {
  const step = reviewSteps().find((s) => s.name === name)
  if (!step) throw new Error(`no "${name}" step found — the parser must not pass vacuously`)
  return step
}

function probeScript(): string {
  const run = stepByName(PROBE_NAME).run
  if (typeof run !== 'string' || run.length === 0) {
    throw new Error(`the "${PROBE_NAME}" step has no run: block — the parser must not pass vacuously`)
  }
  return run
}

let scratch: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'llamenos-fleet-review-host-bun-'))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** A stub `bun` that reports `version` for `--version`, placed in its own
 *  directory. Returns the binary's path. */
function plantBun(dir: string, version: string): string {
  mkdirSync(dir, { recursive: true })
  const bin = join(dir, 'bun')
  writeFileSync(bin, `#!/bin/sh\necho '${version}'\n`)
  chmodSync(bin, 0o755)
  return bin
}

/** Runs the probe step the way GitHub runs an unshelled `run:` step
 *  (`bash -e <file>`), with GITHUB_OUTPUT/GITHUB_PATH pointed at scratch
 *  files and HOME at a scratch dir, so the test never touches the real
 *  machine's Bun or runner state. `bunDirs` are prepended to PATH. */
function runProbe(opts: { bunDirs?: string[]; home: string }): { status: number | null; output: string; ghOutput: string; ghPath: string } {
  const scriptPath = join(scratch, 'probe.sh')
  const outFile = join(scratch, 'github-output')
  const pathFile = join(scratch, 'github-path')
  writeFileSync(scriptPath, probeScript())
  writeFileSync(outFile, '')
  writeFileSync(pathFile, '')
  const env: Record<string, string> = {
    PATH: [...(opts.bunDirs ?? []), '/usr/bin', '/bin'].join(':'),
    HOME: opts.home,
    BUN_VERSION: PINNED_BUN,
    GITHUB_OUTPUT: outFile,
    GITHUB_PATH: pathFile,
  }
  const result = spawnSync('bash', ['-e', scriptPath], { encoding: 'utf8', env })
  return {
    status: result.status,
    output: `${result.stdout}\n${result.stderr}`,
    ghOutput: readFileSync(outFile, 'utf8'),
    ghPath: readFileSync(pathFile, 'utf8'),
  }
}

describe('rail: the host-Bun probe and the setup-bun fallback (#1887)', () => {
  it('the probe step exists with id host_bun, directly before the Setup Bun step', () => {
    const steps = reviewSteps()
    const probeIdx = steps.findIndex((s) => s.name === PROBE_NAME)
    expect(probeIdx, `no "${PROBE_NAME}" step — this rail must not pass vacuously`).toBeGreaterThan(-1)
    expect(steps[probeIdx]?.id).toBe('host_bun')
    expect(steps[probeIdx + 1]?.name, 'setup-bun must follow the probe so its `if:` can read the probe output').toBe(SETUP_NAME)
  })

  it('both steps stand down on merge_group — the queue arm never touches a toolchain', () => {
    expect(stepByName(PROBE_NAME).if).toBe("github.event_name != 'merge_group'")
    expect(stepByName(SETUP_NAME).if).toBe("github.event_name != 'merge_group' && steps.host_bun.outputs.usable == 'false'")
  })

  it('setup-bun is gated on the probe reporting no usable Bun, keeps the pinned bun-version, and carries its own short timeout', () => {
    const setup = stepByName(SETUP_NAME)
    expect(setup.uses).toContain('oven-sh/setup-bun@')
    // A runner with no Bun must still get EXACTLY the pinned one.
    expect(setup.with?.['bun-version']).toBe('${{ env.BUN_VERSION }}')
    // The whole point of #1887's second half: a stalled download frees the
    // single review runner in minutes, never the job's 30.
    expect(setup['timeout-minutes'], 'setup-bun must carry its own short timeout').toBeLessThanOrEqual(3)
  })

  it('BUN_VERSION is still declared once, at workflow level, so the probe and setup-bun can never disagree about the pin', () => {
    const doc = reviewDoc()
    expect(doc.env?.['BUN_VERSION'], 'BUN_VERSION missing at workflow level').toBe(PINNED_BUN)
  })

  it('a runner whose PATH bun is exactly the pinned version is used, and its dir is prepended to PATH', () => {
    const binDir = join(scratch, 'host-bin')
    plantBun(binDir, PINNED_BUN)
    const home = join(scratch, 'home')
    mkdirSync(home, { recursive: true })
    const { status, ghOutput, ghPath } = runProbe({ bunDirs: [binDir], home })
    expect(status).toBe(0)
    expect(ghOutput).toContain('usable=true')
    expect(ghPath).toContain(binDir)
  })

  it('a runner with no PATH bun but the pinned one at ~/.bun/bin/bun is used', () => {
    const home = join(scratch, 'home')
    plantBun(join(home, '.bun', 'bin'), PINNED_BUN)
    const { status, ghOutput, ghPath } = runProbe({ home })
    expect(status).toBe(0)
    expect(ghOutput).toContain('usable=true')
    expect(ghPath).toContain(join(home, '.bun', 'bin'))
  })

  it('a runner with no bun at all defers to setup-bun (usable=false), and does not fail', () => {
    const home = join(scratch, 'home')
    mkdirSync(home, { recursive: true })
    const { status, output, ghOutput } = runProbe({ home })
    expect(status).toBe(0)
    expect(ghOutput).toContain('usable=false')
    expect(output).toContain('setup-bun')
  })

  it('a bun whose version differs from the pin fails LOUDLY — never silently accepted, never silently replaced', () => {
    const binDir = join(scratch, 'stale-bin')
    plantBun(binDir, '1.2.0')
    const home = join(scratch, 'home')
    mkdirSync(home, { recursive: true })
    const { status, output, ghOutput } = runProbe({ bunDirs: [binDir], home })
    expect(status).toBe(1)
    expect(output).toContain(FAILED_MARKER)
    expect(output).toContain(REASON_TOKEN)
    expect(output).toContain('1.2.0')
    expect(ghOutput).not.toContain('usable=true')
  })

  // MUTATION GUARD (per "audit gates by breaking them"): reintroduce the
  // exact defect this fix removes — accepting whatever bun is on PATH —
  // and prove the probe goes back to succeeding on a stale toolchain. If
  // this test ever fails to show the mutation passing, the rail above has
  // stopped being a real rail and this file needs to be re-examined.
  it('MUTATION: without the version check, a stale bun is silently used — the #1887 class of unpinned toolchain', () => {
    const mutated = probeScript().replace(/if \[ "\$version" != "\$BUN_VERSION" \]; then\n(?:.*\n)*?\s*fi\n/, '')
    expect(mutated, 'the version-pin check was not found — this mutation is vacuous').not.toBe(probeScript())
    const scriptPath = join(scratch, 'mutated.sh')
    const outFile = join(scratch, 'github-output')
    const pathFile = join(scratch, 'github-path')
    writeFileSync(scriptPath, mutated)
    writeFileSync(outFile, '')
    writeFileSync(pathFile, '')
    const binDir = join(scratch, 'stale-bin')
    plantBun(binDir, '1.2.0')
    const home = join(scratch, 'home')
    mkdirSync(home, { recursive: true })
    const result = spawnSync('bash', ['-e', scriptPath], {
      encoding: 'utf8',
      env: {
        PATH: `${binDir}:/usr/bin:/bin`,
        HOME: home,
        BUN_VERSION: PINNED_BUN,
        GITHUB_OUTPUT: outFile,
        GITHUB_PATH: pathFile,
      },
    })
    // The defect: the stale bun is accepted as usable, no failure at all.
    expect(result.status).toBe(0)
    expect(readFileSync(outFile, 'utf8')).toContain('usable=true')
  })
})
