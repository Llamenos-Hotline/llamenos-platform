import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getJob, getStep, loadWorkflow, runShellStep, type RunResult } from './helpers/workflow-shell'
import { RULESET_REQUIRED_CONTEXTS } from './required-context-creation'

/**
 * #2816: a `reopened` PR creates NO carrier of any required context — a
 * carrier workflow that ran on it put a second one on every head whose branch
 * had not moved. What it must not do is leave a head that DID move while the
 * PR was closed silently empty: nothing creates a carrier for it, so the PR
 * would read BLOCKED with every visible check green. `carriers-on-reopen.yml`
 * says so out loud. This drives its shipped `run:` block under bash against a
 * fake `gh`, so the assertions are about what it DECIDES for a given head.
 */
const FILE = 'carriers-on-reopen.yml'
const JOB = 'carriers-present'
const STEP = 'Every required context has a carrier on the reopened head'
const HEAD = 'a'.repeat(40)
const REPO = 'Llamenos-Hotline/llamenos-platform'
const FAKE_GH = readFileSync(join(process.cwd(), 'tests', 'orchestrator', 'fixtures', 'fake-gh-reopen-guard.sh'), 'utf8')

let dir: string
let bin: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reopen-guard-'))
  bin = mkdtempSync(join(tmpdir(), 'reopen-guard-bin-'))
  writeFileSync(join(bin, 'gh'), FAKE_GH)
  chmodSync(join(bin, 'gh'), 0o755)
  writeFileSync(join(dir, 'calls.log'), '')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(bin, { recursive: true, force: true })
})

function head(opts: { required?: readonly string[]; present?: readonly string[]; failRules?: boolean; failRuns?: boolean }): RunResult {
  const required = opts.required ?? RULESET_REQUIRED_CONTEXTS
  writeFileSync(join(dir, 'rules.json'), JSON.stringify([
    { type: 'pull_request', parameters: {} },
    { type: 'required_status_checks', parameters: { required_status_checks: required.map((context) => ({ context })) } },
  ]))
  const present = opts.present ?? RULESET_REQUIRED_CONTEXTS
  writeFileSync(join(dir, 'checkruns.json'), JSON.stringify({
    total_count: present.length,
    check_runs: present.map((name, i) => ({ id: i + 1, name, status: i % 2 === 0 ? 'completed' : 'in_progress' })),
  }))
  if (opts.failRules) writeFileSync(join(dir, 'fail-rules'), '')
  if (opts.failRuns) writeFileSync(join(dir, 'fail-checkruns'), '')
  const step = getStep(getJob(loadWorkflow(FILE), JOB), STEP)
  if (typeof step.run !== 'string') throw new Error(`${FILE}: the guard step has no run: block`)
  return runShellStep(step.run, {
    PATH: `${bin}:${process.env['PATH'] ?? ''}`,
    FAKE_GH: dir, GH_TOKEN: 'fake', REPO, HEAD_SHA: HEAD, BASE_REF: 'main',
  })
}

describe('carriers-on-reopen.yml (#2816)', () => {
  it('passes when every required context already has a carrier — in flight counts, it will conclude', () => {
    const r = head({})
    expect(r.status, r.stderr + r.stdout).toBe(0)
  })

  it('fails naming every required context a head that moved while closed lacks', () => {
    const r = head({ present: [] })
    expect(r.status).not.toBe(0)
    for (const c of RULESET_REQUIRED_CONTEXTS) expect(r.stderr).toContain(`\`${c}\``)
    expect(r.stderr).toMatch(/Push a commit/)
  })

  it('fails naming only the one that is missing', () => {
    const r = head({ present: RULESET_REQUIRED_CONTEXTS.filter((c) => c !== 'CodeQL') })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('`CodeQL`')
    expect(r.stderr).not.toContain('`gitleaks`')
  })

  it('"could not look" is a failure, never a pass — rules unreadable', () => {
    const r = head({ failRules: true })
    expect(r.status).not.toBe(0)
  })

  it('"could not look" is a failure, never a pass — check runs unreadable', () => {
    const r = head({ failRuns: true })
    expect(r.status).not.toBe(0)
  })

  it('an empty required list is a refusal, not a vacuous pass', () => {
    const r = head({ required: [] })
    expect(r.status).not.toBe(0)
  })
})
