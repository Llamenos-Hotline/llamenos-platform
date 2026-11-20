import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  { file: 'fleet-review.yml', job: 'refresh-carrier', step: "Re-run the head's fleet/review carrier in place", context: 'fleet/review' },
  { file: 'fleet-verify.yml', job: 'refresh-carrier', step: "Re-run the head's fleet/verify carrier in place", context: 'fleet/verify' },
] as const

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
  const wf = `.github/workflows/${gate.file}`

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
    const [a, b] = GATES.map((g) => getStep(getJob(loadWorkflow(g.file), g.job), g.step).run)
    expect(typeof a).toBe('string')
    expect(a).toBe(b)
  })

  it('the fake gh is really on PATH — a test that reached the real one would not be hermetic', () => {
    expect(existsSync(join(bin, 'gh'))).toBe(true)
  })
})
