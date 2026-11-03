import { gh, ghJson, describeGhFailure, REPO } from './gh.js'

/**
 * Orphaned `merge_group` run sweeper (#1868).
 *
 * THE BUG. Every merge-queue reshuffle leaves its old `merge_group` workflow
 * runs EXECUTING, and nothing cancels them. A queue entry's run is built for
 * exactly one (PR, baseCommit) pair on a `gh-readonly-queue/<base>/pr-<n>-
 * <basesha>` branch; when the entry is dequeued, ejected, or REBUILT (the PR
 * is still queued, only its base changed), the run's results can never be
 * used — yet it keeps occupying the two Mac minis, the fleet's throughput
 * constraint (#1665, #1861). Observed three times in one evening on
 * 2026-10-14; one held BOTH Macs for ~90 minutes until cancelled by hand,
 * and the live position-1 entry's `ios-e2e / build (mac)` started the
 * instant it was.
 *
 * WHAT THIS DOES. Lists recent `merge_group` runs, parses each run's branch
 * into (pr, basesha), and compares against the queue's LIVE contents: a run
 * is orphaned when its PR is not in the queue at all, or is queued with a
 * DIFFERENT baseCommit than the branch was built from. Orphans that still
 * have a non-completed job are cancelled with `gh run cancel`.
 *
 * THE TWO TRAPS THIS IS BUILT AROUND (both cost real time on 2026-10-14):
 *
 *   1. A RUNNING job's `conclusion` is `""`, not `null`. A probe written as
 *      `select(.conclusion==null)` matches nothing and reports every run as
 *      idle — the author nearly deleted a live shard's simulator on that
 *      basis. Every "is this still executing" judgement below is on the job's
 *      `status`, never its `conclusion`. A probe that cannot tell "nothing
 *      running" from "my filter never matches" is worse than none, so an
 *      unreadable jobs list cancels NOTHING (fail closed): the dangerous
 *      direction is cancelling a live entry's run, which ejects a PR and
 *      costs a full `ios-e2e` cycle.
 *
 *   2. The RUN's own `status` is unreliable in the stale direction: a
 *      cancelled/finished run can sit at `status: "queued"` indefinitely
 *      with every job completed. Judging by run status would keep "finding"
 *      zombies that consume nothing, and cancelling those is noise — so the
 *      cancel decision is taken from JOB statuses (`gh run view --json
 *      jobs`), and a run whose jobs are ALL completed is reported as a
 *      zombie and left alone.
 *
 * `--limit 60`, not the default 30: six rebuilds plus siblings push an older
 * orphan out of a 30-run window, which is exactly how the first observed
 * orphan hid for 90 minutes.
 */

/** See the module comment — a 30-run window is how the first orphan hid. */
export const QUEUE_RUN_LIST_LIMIT = 60

/** How many queue entries one page holds. A real queue is a handful; 50 is
 *  already generous, and a queue longer than that has worse problems than
 *  this sweep can fix. */
const QUEUE_ENTRIES_PAGE = 50

export interface QueueRun {
  /** GitHub's workflow-run database id — the `gh run cancel` argument. */
  id: number
  /** `headBranch` — `gh-readonly-queue/<base>/pr-<n>-<basesha>` for a queue
   *  entry run. */
  branch: string
  /** Run-level status. INFORMATIONAL ONLY — see trap 2 in the module
   *  comment. Never a cancel/keep input; used only to skip the jobs fetch
   *  for a run GitHub already reports completed (a completed run can hold
   *  no runner, whatever its jobs would say). */
  status: string
  workflowName: string
}

export interface QueueEntry {
  pr: number
  /** Full 40-hex oid of the base commit the LIVE entry builds against. */
  baseCommit: string
  state: string
}

/** Only `status` is read — trap 1 makes `conclusion` unusable for liveness. */
export interface RunJob {
  name: string
  status: string
}

/**
 * `gh-readonly-queue/<base>/pr-<n>-<basesha>` — the ONLY branch shape this
 * sweep may act on. The base segment is matched greedily so a base branch
 * containing slashes still parses; the PR number and the base sha are
 * anchored at the end. The sha length is deliberately a range: GitHub
 * shortens it for uniqueness and has been observed at both 8 (`32413272`)
 * and 9 (`eaca89245`) characters on the same evening.
 *
 * Grouped queue entries (`gh-readonly-queue/<base>/<sha>`, no `pr-`) and
 * anything else on a queue branch return `undefined` — unparseable means
 * UNTOUCHED, never guessed at: the only thing this sweep may cancel is a
 * run it can positively attribute to a specific PR.
 */
export function parseQueueBranch(branch: string): { base: string; pr: number; baseSha: string } | undefined {
  const m = /^gh-readonly-queue\/(.+)\/pr-(\d+)-([0-9a-f]{7,40})$/.exec(branch)
  if (m === null) return undefined
  const [, base, pr, baseSha] = m
  if (base === undefined || pr === undefined || baseSha === undefined) return undefined
  return { base, pr: Number(pr), baseSha }
}

export type OrphanReason = 'not-in-queue' | 'base-mismatch'

/**
 * The orphan judgement, pure. `entries` maps a LIVE queue entry's PR number
 * to the FULL base-commit oid it currently builds against.
 *
 * The comparison is a PREFIX match: the branch carries GitHub's uniqueness-
 * shortened sha, the entry carries the full oid. `eaca89245` matches
 * `eaca89245f0...`. Both sides are lowercased first — hex case is not part
 * of the identity.
 */
export function orphanReason(
  run: { pr: number; baseSha: string },
  entries: ReadonlyMap<number, string>,
): OrphanReason | undefined {
  const current = entries.get(run.pr)
  if (current === undefined) return 'not-in-queue'
  if (!current.toLowerCase().startsWith(run.baseSha.toLowerCase())) return 'base-mismatch'
  return undefined
}

// ---------------------------------------------------------------------------
// The sweep itself — impure edges injected, every decision above the line.
// ---------------------------------------------------------------------------

export interface QueueSweepDeps {
  /** Recent `merge_group` runs, or `undefined` when the list could not be
   *  read. An unreadable list aborts the sweep and cancels NOTHING — "could
   *  not look" must never be indistinguishable from "nothing there"
   *  (ghJson's own contract). */
  listQueueRuns(): Promise<QueueRun[] | undefined>
  /** The LIVE queue contents for one base branch, or `undefined` when
   *  unreadable. Unreadable cancels nothing on that base: an empty map and
   *  a failed read would otherwise both say "no PR is queued", and the
   *  first cancels every live entry's run. */
  listQueueEntries(base: string): Promise<QueueEntry[] | undefined>
  /** A run's jobs, or `undefined` when unreadable — fail closed, see trap 1. */
  fetchRunJobs(runId: number): Promise<RunJob[] | undefined>
  /** `gh run cancel <id>`. THROWS on failure so a refused cancel is an
   *  error row, never a silent no-op. */
  cancelRun(runId: number): Promise<void>
}

export interface CancelledRun {
  runId: number
  pr: number
  reason: OrphanReason
}

export interface SweepSummary {
  /** False when the sweep could not decide (unreadable run list, or a base
   *  whose queue could not be read). A sweep that could not decide has
   *  cancelled nothing on the undecidable bases and says so. */
  ok: boolean
  /** Present when the whole sweep aborted before judging any run. */
  aborted?: string
  /** Runs on parseable `pr-` queue branches that were judged. */
  judged: number
  /** Runs left strictly alone because their (pr, basesha) still matches a
   *  live queue entry. The dangerous direction — cancelling one of these
   *  ejects a PR and costs a full ios-e2e cycle — so the count is reported,
   *  not just implied. */
  kept: number
  /** Orphans whose jobs were ALL completed (trap 2): reported, never
   *  cancelled. */
  zombies: number
  /** Runs skipped because the branch did not parse as a `pr-` queue branch
   *  (grouped entries, anything else) or because their base's queue was
   *  unreadable. */
  skipped: number
  cancelled: CancelledRun[]
  /** One human-readable line per failure — unreadable queue, unreadable
   *  jobs, refused cancel. Never silently dropped. */
  errors: string[]
}

const emptySummary = (over: Partial<SweepSummary> = {}): SweepSummary =>
  ({ ok: true, judged: 0, kept: 0, zombies: 0, skipped: 0, cancelled: [], errors: [], ...over })

/**
 * One sweep. Never throws: every `gh` failure lands in `errors` and the
 * affected runs are simply not cancelled — this is hygiene running inside
 * the dispatch tick, and a hygiene failure must never take the pass down
 * with it.
 */
export async function sweepQueueRuns(deps: QueueSweepDeps): Promise<SweepSummary> {
  const runs = await deps.listQueueRuns()
  if (runs === undefined) {
    return emptySummary({ ok: false, aborted: 'could not list merge_group runs — cancelled nothing' })
  }

  // Parse first, fetch per-base queue state once per DISTINCT base — a real
  // queue is single-base (`main`), so this is usually one read.
  const parsed: { run: QueueRun; branch: { base: string; pr: number; baseSha: string } }[] = []
  let skipped = 0
  for (const run of runs) {
    const branch = parseQueueBranch(run.branch)
    if (branch === undefined) {
      skipped++
      continue
    }
    parsed.push({ run, branch })
  }

  const summary = emptySummary({ skipped })
  const queuesByBase = new Map<string, Map<number, string> | undefined>()
  for (const base of new Set(parsed.map((p) => p.branch.base))) {
    const entries = await deps.listQueueEntries(base)
    if (entries === undefined) {
      queuesByBase.set(base, undefined)
      summary.errors.push(`queue for ${base} is unreadable — left every run on its branches alone`)
      continue
    }
    const byPr = new Map<number, string>()
    for (const e of entries) byPr.set(e.pr, e.baseCommit)
    queuesByBase.set(base, byPr)
  }

  for (const { run, branch } of parsed) {
    const queue = queuesByBase.get(branch.base)
    if (queue === undefined) {
      summary.ok = false
      summary.skipped++
      continue
    }
    summary.judged++

    const orphan = orphanReason(branch, queue)
    if (orphan === undefined) {
      // The negative direction (c) from #1868: the run belongs to a LIVE
      // entry building from the SAME base commit. Strictly alone — not
      // even its jobs are fetched, because there is no judgement to make
      // about it.
      summary.kept++
      continue
    }

    // A completed run holds no runner whatever its jobs would report, and
    // `gh run cancel` on one is noise (trap 2's other half). Everything
    // else — `queued`, `in_progress`, `waiting`, and any future value —
    // is judged by its JOBS, because the run's own status can sit at
    // `queued` forever on a run that is actually finished.
    if (run.status === 'completed') continue

    const jobs = await deps.fetchRunJobs(run.id)
    if (jobs === undefined) {
      // Trap 1, fail closed: a probe that cannot tell "nothing running"
      // from "I could not look" cancels nothing.
      summary.errors.push(`run ${run.id} (pr #${branch.pr}, ${orphan}): jobs unreadable — NOT cancelled`)
      continue
    }
    const live = jobs.filter((j) => j.status !== 'completed')
    if (live.length === 0) {
      // Trap 2: the run says queued/in_progress, every job says done. It
      // consumes nothing; cancelling it is noise.
      summary.zombies++
      continue
    }

    try {
      await deps.cancelRun(run.id)
      summary.cancelled.push({ runId: run.id, pr: branch.pr, reason: orphan })
    } catch (e) {
      summary.errors.push(`run ${run.id} (pr #${branch.pr}, ${orphan}): cancel refused — ${describeGhFailure(e)}`)
    }
  }

  if (summary.errors.length > 0) summary.ok = false
  return summary
}

/** One compact line for the fleet log — the tick pass emits exactly this. */
export function renderSweepInline(s: SweepSummary): string {
  if (s.aborted !== undefined) return `queue-sweep ABORTED: ${s.aborted}`
  const cancelled = s.cancelled.map((c) => `run ${c.runId} (#${c.pr}, ${c.reason})`).join(', ')
  return (
    `queue-sweep: judged=${s.judged} kept=${s.kept} cancelled=${s.cancelled.length}` +
    `${cancelled.length > 0 ? ` (${cancelled})` : ''} zombies=${s.zombies} skipped=${s.skipped}` +
    `${s.errors.length > 0 ? ` errors=${s.errors.length}` : ''}`
  )
}

/** Human form for the standalone command. Quiet when the sweep was clean —
 *  a report that speaks on a healthy run trains its reader to skim. */
export function renderSweepReport(s: SweepSummary): string {
  const lines: string[] = []
  if (s.aborted !== undefined) {
    lines.push(`ABORTED: ${s.aborted}`)
    return lines.join('\n')
  }
  for (const c of s.cancelled) {
    lines.push(`CANCELLED run ${c.runId} — pr #${c.pr} ${c.reason === 'not-in-queue' ? 'is not in the queue' : 'is queued with a different base commit'}`)
  }
  if (s.zombies > 0) {
    lines.push(`${s.zombies} orphan(s) left alone: every job completed despite the run's status (zombie — consumes nothing)`)
  }
  for (const e of s.errors) lines.push(`ERROR: ${e}`)
  if (lines.length === 0) {
    lines.push(`no orphaned merge_group runs — ${s.judged} judged, ${s.kept} live entr${s.kept === 1 ? 'y' : 'ies'} left alone`)
  }
  return lines.join('\n')
}

/** `cancel|<runId>|<pr>|<reason>` / `error|-|-|<detail>`; empty when clean. */
export function renderSweepPorcelain(s: SweepSummary): string {
  const rows: string[] = []
  if (s.aborted !== undefined) return `aborted|-|-|${s.aborted.replace(/\|/g, '/')}`
  for (const c of s.cancelled) rows.push(`cancel|${c.runId}|${c.pr}|${c.reason}`)
  for (const e of s.errors) rows.push(`error|-|-|${e.replace(/\|/g, '/')}`)
  return rows.join('\n')
}

// ---------------------------------------------------------------------------
// Default deps — the real `gh` calls, isolated so the sweep above is
// exercised entirely against injected fakes.
// ---------------------------------------------------------------------------

/** Exported so the window width is pinned by a test, not by reading the
 *  source: six rebuilds plus siblings push an older orphan out of a 30-run
 *  window, which is exactly how the first observed orphan hid for 90
 *  minutes. */
export function listQueueRunsArgs(): string[] {
  return [
    'run', 'list', '--event', 'merge_group',
    '--limit', String(QUEUE_RUN_LIST_LIMIT),
    '--json', 'databaseId,headBranch,status,workflowName',
  ]
}

interface GhRunListRow {
  databaseId?: number
  headBranch?: string
  status?: string
  workflowName?: string
}

interface GhMergeQueueResponse {
  data?: {
    repository?: {
      mergeQueue?: {
        entries?: {
          nodes?: ({
            state?: string
            pullRequest?: { number?: number } | null
            baseCommit?: { oid?: string } | null
          } | null)[]
        }
      } | null
    } | null
  }
}

/**
 * The queue's live contents, via GraphQL — the REST surface has no
 * merge-queue endpoint this repo's token can read (verified 2026-11:
 * `GET repos/…/merge-queue/main` is 404). A `null` mergeQueue (no queue on
 * the branch) is an EMPTY queue, not an unreadable one: nothing is queued,
 * so every run on that base's queue branches is an orphan. Entries without
 * a PR (grouped entries) carry no number and are simply not in the map —
 * their runs do not parse as `pr-` branches and are never judged against
 * the map at all.
 */
export async function fetchQueueEntries(base: string): Promise<QueueEntry[] | undefined> {
  const query = `query($owner:String!,$name:String!,$branch:String!) {
  repository(owner:$owner, name:$name) {
    mergeQueue(branch:$branch) {
      entries(first:${QUEUE_ENTRIES_PAGE}) {
        nodes { state pullRequest { number } baseCommit { oid } }
      }
    }
  }
}`
  const [owner, name] = REPO.split('/')
  if (owner === undefined || name === undefined) return undefined
  const data = await ghJson<GhMergeQueueResponse>([
    'api', 'graphql',
    '-f', `query=${query}`,
    '-f', `owner=${owner}`,
    '-f', `name=${name}`,
    '-f', `branch=${base}`,
  ], 30_000)
  if (data === undefined) return undefined
  const nodes = data.data?.repository?.mergeQueue?.entries?.nodes
  if (nodes === undefined) return []
  const out: QueueEntry[] = []
  for (const n of nodes) {
    const pr = n?.pullRequest?.number
    const oid = n?.baseCommit?.oid
    if (typeof pr === 'number' && typeof oid === 'string') {
      out.push({ pr, baseCommit: oid, state: n?.state ?? '' })
    }
  }
  return out
}

export function defaultQueueSweepDeps(): QueueSweepDeps {
  return {
    listQueueRuns: async () => {
      const rows = await ghJson<GhRunListRow[]>(listQueueRunsArgs(), 30_000)
      if (!Array.isArray(rows)) return undefined
      return rows.map((r) => ({
        id: r.databaseId ?? 0,
        branch: r.headBranch ?? '',
        status: r.status ?? '',
        workflowName: r.workflowName ?? '',
      }))
    },
    listQueueEntries: fetchQueueEntries,
    // `--json jobs` on `gh run view`, NOT a conclusion filter — see trap 1
    // in the module comment for what a conclusion-keyed probe gets wrong.
    fetchRunJobs: async (runId) => {
      const data = await ghJson<{ jobs?: { name?: string; status?: string }[] }>(
        ['run', 'view', String(runId), '--json', 'jobs'], 30_000)
      if (data === undefined || !Array.isArray(data.jobs)) return undefined
      return data.jobs.map((j) => ({ name: j.name ?? '', status: j.status ?? '' }))
    },
    cancelRun: async (runId) => { await gh(['run', 'cancel', String(runId)], 30_000) },
  }
}

/**
 * Wired into `cli.ts`'s `HANDLERS`, and called by `runTick` on every pass
 * (see cli.ts — the sweep's interval IS the tick timer's interval, so an
 * orphan lives at most one tick).
 *
 *   llamenos-fleet queue-sweep                # sweep now, human report
 *   llamenos-fleet queue-sweep --porcelain    # machine-readable rows
 *
 * Exit `2` when the sweep could not decide (unreadable run list or queue)
 * or any cancel/jobs read failed — the same "CANNOT DECIDE is never clean"
 * contract as `missing-checks`; `0` otherwise, including when runs were
 * cancelled: a cancelled orphan is the sweep WORKING, not a defect to
 * report to a caller scripting around it.
 */
export async function runQueueSweep(args: string[]): Promise<number> {
  if (args.some((a) => !a.startsWith('--'))) {
    process.stderr.write('usage: llamenos-fleet queue-sweep [--porcelain]\n')
    return 2
  }
  const summary = await sweepQueueRuns(defaultQueueSweepDeps())
  const text = args.includes('--porcelain') ? renderSweepPorcelain(summary) : renderSweepReport(summary)
  if (text.length > 0) process.stdout.write(text + '\n')
  return summary.ok ? 0 : 2
}
