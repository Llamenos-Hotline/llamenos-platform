import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { RULESET_REQUIRED_CONTEXTS } from './required-context-creation'
import { evalTemplate, truthy, type ExprValue } from './helpers/github-expr'
import { getJob, getStep, loadWorkflow, runShellStep, type RunResult } from './helpers/workflow-shell'

/**
 * #2813: a re-evaluation (a review request) must update the head's ONE
 * carrier of a required context, never publish a second. The workflows do it
 * by re-running the carrier's workflow run in place — the same check suite,
 * so `GET …/check-runs?filter=latest` still returns one run per name — from a
 * `refresh-carrier` job.
 *
 * This drives the SHIPPED `run:` block of both workflows' refresh step under
 * bash, against a fake `gh` that answers from fixture files and logs every
 * call, so the assertions are about what the script DOES to GitHub: which run
 * it re-runs, when it waits, what it ignores, and that it fails loudly rather
 * than quietly leaving a stale carrier in place.
 */

const GATES = [
  { file: 'fleet-review.yml', job: 'refresh-carrier', step: "Re-run the head's fleet/review carrier in place", context: 'fleet/review', carrier: 'fleet-review.yml' },
  { file: 'fleet-verify.yml', job: 'refresh-carrier', step: "Re-run the head's fleet/verify carrier in place", context: 'fleet/verify', carrier: 'fleet-verify.yml' },
  // #3127: a description edit re-runs the `gitleaks` carrier (which reads the live body) the same way.
  { file: 'pr-body-recheck.yml', job: 'recheck', step: "Re-run the head's gitleaks carrier in place", context: 'gitleaks', carrier: 'secret-scan.yml' },
] as const

/** The pair that must stay byte-identical; pr-body-recheck.yml words its operator guidance for a description edit. */
const REVIEW_GATES = GATES.slice(0, 2)

const HEAD = 'a'.repeat(40)
const REPO = 'Llamenos-Hotline/llamenos-platform'

/** A `gh` stand-in (fixtures/fake-gh-carrier-refresh.sh). Responses come from files in `$FAKE_GH`:
 *   checkruns.json            — the body of GET …/commits/<sha>/check-runs
 *   job-<id>.json             — GET …/actions/jobs/<id>
 *   run-<id>.json             — GET …/actions/runs/<id> (status overridden by:)
 *   run-<id>.status           — one status per line, consumed per read; the
 *                               last line repeats
 *   rerun-refusals-<id>       — how many POST …/rerun calls to refuse first
 *   fail-checkruns            — present: the check-runs listing fails
 * Every invocation is appended to calls.log as "METHOD PATH". */
const FAKE_GH = readFileSync(join(process.cwd(), 'tests', 'orchestrator', 'fixtures', 'fake-gh-carrier-refresh.sh'), 'utf8')

let dir: string
let bin: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'carrier-refresh-'))
  bin = mkdtempSync(join(tmpdir(), 'carrier-refresh-bin-'))
  writeFileSync(join(bin, 'gh'), FAKE_GH)
  chmodSync(join(bin, 'gh'), 0o755)
  writeFileSync(join(dir, 'calls.log'), '')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(bin, { recursive: true, force: true })
})

interface CheckRunFixture { id: number; app?: string; run: number; path: string; event: string; status?: string[] }

function fixture(runs: CheckRunFixture[]): void {
  writeFileSync(join(dir, 'checkruns.json'), JSON.stringify({
    total_count: runs.length,
    check_runs: runs.map((r) => ({ id: r.id, app: { slug: r.app ?? 'github-actions' } })),
  }))
  for (const r of runs) {
    writeFileSync(join(dir, `job-${r.id}.json`), JSON.stringify({ id: r.id, run_id: r.run }))
    writeFileSync(join(dir, `run-${r.run}.json`), JSON.stringify({ id: r.run, path: r.path, event: r.event, status: 'completed' }))
    if (r.status !== undefined) writeFileSync(join(dir, `run-${r.run}.status`), `${r.status.join('\n')}\n`)
  }
}

function refresh(gate: (typeof GATES)[number], overrides: Record<string, string> = {}): RunResult & { calls: string[] } {
  const step = getStep(getJob(loadWorkflow(gate.file), gate.job), gate.step)
  if (typeof step.run !== 'string') throw new Error(`${gate.file}: the refresh step has no run: block`)
  const env = step.env ?? {}
  const r = runShellStep(step.run, {
    PATH: `${bin}:${process.env['PATH'] ?? ''}`,
    FAKE_GH: dir,
    GH_TOKEN: 'fake',
    REPO,
    HEAD_SHA: HEAD,
    CONTEXT: String(env['CONTEXT']),
    WORKFLOW_PATH: String(env['WORKFLOW_PATH']),
    POLL_SECONDS: '0',
    MAX_WAIT_SECONDS: '30',
    ...overrides,
  })
  const calls = readFileSync(join(dir, 'calls.log'), 'utf8').split('\n').filter((l) => l.length > 0)
  return { ...r, calls }
}

const reruns = (calls: string[]) => calls.filter((c) => c.startsWith('POST '))

describe.each(GATES)('$file refresh-carrier (#2813)', (gate) => {
  const wf = `.github/workflows/${gate.carrier}`

  it('names its own gate and workflow — a copy pointed at the other gate would re-run the wrong carrier', () => {
    const env = getStep(getJob(loadWorkflow(gate.file), gate.job), gate.step).env ?? {}
    expect(env['CONTEXT']).toBe(gate.context)
    expect(env['WORKFLOW_PATH']).toBe(wf)
  })

  it('re-runs the head\'s one completed carrier in place, exactly once', () => {
    fixture([{ id: 11, run: 101, path: wf, event: 'pull_request' }])
    const r = refresh(gate)
    expect(r.status, r.stderr + r.stdout).toBe(0)
    expect(reruns(r.calls)).toEqual([`POST repos/${REPO}/actions/runs/101/rerun`])
    // The listing asks for exactly this context, URL-encoded, latest attempt only.
    expect(r.calls[0]).toBe(`GET repos/${REPO}/commits/${HEAD}/check-runs?check_name=${encodeURIComponent(gate.context)}&filter=latest&per_page=100`)
    expect(r.stdout).toContain('re-ran')
  })

  it('waits for a carrier still in flight, then re-runs it — its first read may predate this re-evaluation', () => {
    fixture([{ id: 11, run: 101, path: wf, event: 'pull_request', status: ['queued', 'in_progress', 'in_progress', 'completed'] }])
    const r = refresh(gate)
    expect(r.status, r.stderr + r.stdout).toBe(0)
    expect(reruns(r.calls)).toEqual([`POST repos/${REPO}/actions/runs/101/rerun`])
    // The first read resolves the run's workflow (and consumes `queued`); the
    // two in-flight reads are each waited out before the completed one.
    expect(r.stdout.split('\n').filter((l) => l.includes('waiting for it to finish'))).toHaveLength(2)
    expect(r.calls.indexOf(`POST repos/${REPO}/actions/runs/101/rerun`)).toBe(r.calls.length - 1)
  })

  it('a refused re-run (another one just started) is waited out and retried, not dropped', () => {
    fixture([{ id: 11, run: 101, path: wf, event: 'pull_request' }])
    writeFileSync(join(dir, 'rerun-refusals-101'), '2')
    const r = refresh(gate)
    expect(r.status, r.stderr + r.stdout).toBe(0)
    expect(reruns(r.calls)).toHaveLength(3)
  })

  it('touches nothing that is not this workflow\'s pull_request carrier', () => {
    fixture([
      // the operator's review-and-merge App check run — not re-runnable, not ours
      { id: 12, app: 'llamenos-fleet', run: 0, path: '', event: '' },
      // a workflow_dispatch of the same workflow: its suite is not PR-associated (#1471)
      { id: 13, run: 103, path: wf, event: 'workflow_dispatch' },
      // another workflow that happens to carry the name
      { id: 14, run: 104, path: '.github/workflows/other.yml', event: 'pull_request' },
      // the carrier
      { id: 15, run: 105, path: wf, event: 'pull_request' },
    ])
    const r = refresh(gate)
    expect(r.status, r.stderr + r.stdout).toBe(0)
    expect(reruns(r.calls)).toEqual([`POST repos/${REPO}/actions/runs/105/rerun`])
    expect(r.calls).not.toContain(`GET repos/${REPO}/actions/jobs/12`)
  })

  it('re-runs EVERY carrier a pre-#2813 head already holds, so legacy duplicates converge', () => {
    fixture([
      { id: 21, run: 201, path: wf, event: 'pull_request' },
      { id: 22, run: 202, path: wf, event: 'pull_request' },
      { id: 23, run: 201, path: wf, event: 'pull_request' }, // a second job of the same run: one re-run
    ])
    const r = refresh(gate)
    expect(r.status, r.stderr + r.stdout).toBe(0)
    expect(reruns(r.calls)).toEqual([
      `POST repos/${REPO}/actions/runs/201/rerun`,
      `POST repos/${REPO}/actions/runs/202/rerun`,
    ])
  })

  it('no carrier yet is a clean no-op — the carrier has not started and will read this re-evaluation', () => {
    fixture([])
    const r = refresh(gate)
    expect(r.status, r.stderr + r.stdout).toBe(0)
    expect(reruns(r.calls)).toEqual([])
    expect(r.stdout).toContain(`no ${gate.context} carrier on ${HEAD} yet`)
  })

  it('FAILS loudly, re-running nothing, when the head\'s check runs cannot be read', () => {
    fixture([{ id: 11, run: 101, path: wf, event: 'pull_request' }])
    writeFileSync(join(dir, 'fail-checkruns'), '')
    const r = refresh(gate)
    expect(r.status).not.toBe(0)
    expect(reruns(r.calls)).toEqual([])
    expect(r.stdout).toContain('::error::refresh-carrier FAILED: could not list')
  })

  it('FAILS loudly when the carrier never becomes re-runnable — never a silent stale carrier', () => {
    fixture([{ id: 11, run: 101, path: wf, event: 'pull_request', status: ['in_progress'] }])
    const r = refresh(gate, { MAX_WAIT_SECONDS: '0' })
    expect(r.status).not.toBe(0)
    expect(reruns(r.calls)).toEqual([])
    expect(r.stdout).toContain('::error::refresh-carrier FAILED: carrier run 101 was still not re-runnable')
  })
})

describe('the two refresh steps are one script (#2813)', () => {
  it('fleet-review.yml and fleet-verify.yml ship byte-identical refresh scripts', () => {
    const [a, b] = REVIEW_GATES.map((g) => getStep(getJob(loadWorkflow(g.file), g.job), g.step).run)
    expect(typeof a).toBe('string')
    expect(a).toBe(b)
  })

  it('the fake gh is really on PATH — a test that reached the real one would not be hermetic', () => {
    expect(existsSync(join(bin, 'gh'))).toBe(true)
  })
})

/**
 * #3127: the PR-body guard must be clearable by the action that fixes it — an
 * edit to the description — without a second `gitleaks` carrier and without the
 * file scan becoming clearable by editing prose.
 */
describe('editing the PR description re-judges the gitleaks carrier (#3127)', () => {
  const read = (f: string) => readFileSync(join(process.cwd(), '.github', 'workflows', f), 'utf8')
  const recheck = parseYaml(read('pr-body-recheck.yml')) as {
    on: { pull_request: { types: string[] } }
    concurrency: { group: string; 'cancel-in-progress': boolean }
    permissions: Record<string, string>
    jobs: Record<string, { name: string; if: string; permissions: Record<string, string> }>
  }
  const scan = read('secret-scan.yml')

  it('the carrier workflow still triggers on opened/synchronize only — `edited` there would be a second `gitleaks` on an unchanged head', () => {
    expect(scan).toMatch(/pull_request:\s*\n\s*types: \[opened, synchronize\]\n/)
    expect(scan).not.toMatch(/types:[^\n]*edited/)
  })

  it('the recheck lives in its own workflow, on `edited` alone, under a name that is not a required context', () => {
    expect(recheck.on.pull_request.types).toEqual(['edited'])
    expect(recheck.permissions).toEqual({})
    const job = recheck.jobs['recheck']
    if (job === undefined) throw new Error('no recheck job')
    expect(RULESET_REQUIRED_CONTEXTS as readonly string[]).not.toContain(job.name)
    expect(job.permissions).toEqual({ actions: 'write', checks: 'read' })
  })

  it('a title or base edit starts no scan: only a body edit on a same-repo PR passes the job `if`', () => {
    const cond = recheck.jobs['recheck']?.if ?? ''
    expect(cond).toContain('github.event.changes.body != null')
    expect(cond).toContain('github.event.pull_request.head.repo.full_name == github.repository')
  })

  it('a run the job `if` skips never shares a recheck\'s concurrency group, so it can never cancel one', () => {
    // The group is fixed for the whole run before the job `if` is evaluated,
    // and cancel-in-progress cancels (or displaces) whatever else is in it. A
    // title edit landing while a body edit's recheck polls its carrier must
    // not take the recheck down with it: the corrected body would get no re-run.
    const job = recheck.jobs['recheck']
    if (job === undefined) throw new Error('no recheck job')
    const NUMBER = 4242
    const edits: Array<{ label: string; changes: Record<string, ExprValue>; head: string; works: boolean }> = [
      { label: 'body edit', changes: { body: { from: 'old' } }, head: REPO, works: true },
      { label: 'body and title edit', changes: { body: { from: 'old' }, title: { from: 'old' } }, head: REPO, works: true },
      { label: 'title edit', changes: { title: { from: 'old' } }, head: REPO, works: false },
      { label: 'base-branch edit', changes: { base: { ref: { from: 'dev' }, sha: { from: 'b'.repeat(40) } } }, head: REPO, works: false },
      { label: 'body edit on a fork PR', changes: { body: { from: 'old' } }, head: 'someone/llamenos-platform', works: false },
    ]
    const runs = edits.map((e, i) => {
      const ctx: Record<string, ExprValue> = {
        github: {
          event_name: 'pull_request',
          repository: REPO,
          run_id: 9000 + i,
          event: { action: 'edited', changes: e.changes, pull_request: { number: NUMBER, head: { sha: HEAD, repo: { full_name: e.head } } } },
        },
      }
      return { ...e, runsJob: truthy(evalTemplate(job.if, ctx)), group: String(evalTemplate(recheck.concurrency.group, ctx)) }
    })
    // Anchor the event shapes: the `if` must agree with which edits do work.
    for (const r of runs) expect(r.runsJob, `job if on a ${r.label}`).toBe(r.works)
    expect(recheck.concurrency['cancel-in-progress']).toBe(true)
    for (const a of runs) {
      for (const b of runs) {
        if (a === b || a.group !== b.group) continue
        expect(a.works && b.works, `a ${a.label} and a ${b.label} share group \`${a.group}\``).toBe(true)
      }
    }
    // …and body edits still supersede each other per PR: the last edit's re-run judges every edit before it.
    expect(new Set(runs.filter((r) => r.works).map((r) => r.group))).toEqual(new Set([`pr-body-recheck-pr-${NUMBER}`]))
  })

  it('the guard reads the description LIVE, never from the event payload a re-run replays', () => {
    expect(scan).not.toContain('PR_BODY_JSON')
    expect(scan).not.toContain('github.event.pull_request.body')
    expect(scan).toContain('--body-from-api "${REPO}" "${PR_NUMBER}"')
  })

  it('the guard stays fail-closed and required: no continue-on-error, no `if` on the job', () => {
    const doc = parseYaml(scan) as { jobs: { gitleaks: { if?: unknown; steps: Array<{ name?: string; 'continue-on-error'?: unknown }> } } }
    expect(doc.jobs.gitleaks.if).toBeUndefined()
    const step = doc.jobs.gitleaks.steps.find((st) => st.name === 'Check for machine-specific absolute paths')
    expect(step).toBeDefined()
    expect(step?.['continue-on-error']).toBeUndefined()
  })
})
