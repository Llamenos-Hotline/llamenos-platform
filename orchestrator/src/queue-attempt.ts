import { parse as parseYaml } from 'yaml'

/**
 * The verdict on a failed merge-queue attempt: whose fault was it, and was it
 * INFRASTRUCTURE rather than CONTENT? (#2036 attribution, #2458 infra.)
 *
 * The one question `queue-feed` must answer before it re-queues a PR whose
 * last queue attempt was ejected with no job of its own diff failing. Before
 * this module it answered it by omission: cancelled jobs were never read at
 * all, so EVERY cancellation-only ejection — a job killed by its own
 * `timeout-minutes`, a human pressing cancel, a dequeue the sweep cleaned up
 * after — re-armed the PR, uncapped and with no evidence recorded.
 *
 * THE PREDICATE. A last attempt is an infrastructure ejection iff:
 *
 *   1. NO job in the attempt concluded in the failure class (`failure`,
 *      `timed_out`, `startup_failure`, `action_required`, an unset
 *      conclusion — anything but `success`/`skipped`/`neutral`/`cancelled`),
 *      the rollup aggregates (`ci-status`, `changes`) aside. A `failure` is a
 *      verdict: the job ran and said no. #2479's third instance was a
 *      transient stall that surfaced as a genuine `failure` (a vitest timeout
 *      on a test that normally runs in ≤339 ms), indistinguishable from a
 *      real assertion failure — re-queueing on it would re-run real
 *      regressions until they passed. So a failure-class job anywhere in the
 *      attempt makes `infra-timeout` unreachable: `classifyAttempt` returns
 *      before any cancellation is judged, and `judgeCancelledJob` separately
 *      refuses any job whose own conclusion is not `cancelled`.
 *   2. The ejection has at least one CAUSE: a non-aggregate job that
 *      concluded `cancelled` no later than the rollup's own failure (a job
 *      that ends after `ci-status` concluded is a consequence of the
 *      ejection — the sweep cancelling an orphaned run — not its cause).
 *   3. EVERY cause is a timeout, not a cancellation: the moment it was
 *      KILLED — the end of its first `cancelled` step, measured from the
 *      job's start — lands on its configured `timeout-minutes`, within
 *      [limit − 10 s, limit + 60 s]. GitHub reports a `timeout-minutes`
 *      overrun as `cancelled`, not `failed`, so conclusion alone cannot tell
 *      a timeout from a human or a concurrency rule; the kill landing on the
 *      limit is what separates them. The job's own end is NOT the measure:
 *      post-steps run on the same stalled runner after the kill (live:
 *      `backend-unit` was killed at 601 s of a 10-min limit, but the job
 *      ended at 900 s).
 *   4. EVERY cause was BLOCKED, not SLOW: at least 3 recent successful runs of
 *      the same job (same workflow, same job name) are known, and even the
 *      slowest of them took at most a third of the limit. Live evidence
 *      (#2479): `Updater pubkey is set` normally 5–9 s, killed at its 2-min
 *      limit; `desktop-rust` normally 193 s, killed at its 30-min limit. A
 *      job that normally runs near its limit and then hits it is a limit
 *      problem, which re-queueing would only repeat.
 *
 * Every term fails CLOSED: an unreadable workflow file, a job name no
 * definition matches (or two definitions disagree on), a job with no numeric
 * `timeout-minutes`, a missing timestamp, too few normal samples — each is
 * "not proven infrastructure", never "infrastructure". A PR that is not
 * re-queued here is merely left for a human, which is the state it was in
 * before this feature existed.
 *
 * REASON OVER SHARD (#2529). Term 1 used to be answered by shard identity
 * alone: any failure-class job on a shard the diff schedules was "the diff's
 * fault". That mislabels a job that FAILED ON PURPOSE for an environmental
 * reason — the iOS disk-headroom guard refuses to run rather than let the
 * runner agent die, and says so on the job in an `::error::` annotation
 * carrying `ENVIRONMENTAL_DECLARATION`. Such a job is read for its declaration
 * (its CheckRun annotations, read by the job's node id) BEFORE the shard map is
 * consulted, and a failure-class job that declared itself environmental is an
 * infrastructure signal, not a verdict on the code. The declaration is a
 * sentence the workflow steps already print, so there is no second parser of
 * step names: a step renamed tomorrow still declares itself. Only jobs the
 * diff schedules are read — a job it cannot schedule is already "a sibling's
 * failure", eligible without any declaration. An unreadable annotation list
 * never turns a refusal into a re-queue: the job counts as undeclared, and an
 * own-diff verdict that rested on one is reported `unreadable`, not asserted.
 *
 * The converse is the point of the skip: a genuine test failure carries no
 * such declaration, so it stays `own-diff` and stays refused. Declared jobs
 * re-queue under the same one-per-head cap as a timeout, because a runner that
 * keeps refusing is a signal, not noise.
 *
 * WHERE THE LIMIT COMES FROM: the workflow file the run actually executed —
 * the run's `path` read at the run's own `head_sha` (the merge-group commit),
 * never the base checkout, so a PR that edits its own `timeout-minutes` is
 * judged by the limit that ran. Reusable workflows (`uses: ./…`) are followed
 * to the called file at the same commit, and their jobs are matched as
 * `<caller> / <inner>`, the name GitHub gives them.
 *
 * WHERE "NORMAL" COMES FROM: the same workflow's recent completed runs (any
 * event), each run's jobs read and only `success` conclusions sampled, the
 * attempt's own runs excluded.
 */

// ---------------------------------------------------------------------------
// Attribution — which platform flags schedule a job (moved from queue-feed.ts).
// ---------------------------------------------------------------------------

/** The platform flags `detect-changed-platforms.sh` computes for a diff. */
export interface PlatformFlags {
  ios: boolean
  android: boolean
  desktop: boolean
  backend: boolean
  crypto: boolean
}

/** Flags a failed job's name maps to. ci.yml job names are prefixed onto
 *  called-workflow inner jobs (`ios-e2e / build (mac)`), so the key is the
 *  name up to the first ` / `. Bound to ci.yml by a test: every job gated
 *  on `revalidate` in ci.yml must appear here with exactly its other
 *  `needs.changes.outputs` flags. */
export const QUEUE_ONLY_JOB_FLAGS: Record<string, readonly (keyof PlatformFlags)[]> = {
  'e2e': ['desktop', 'backend'],
  'desktop-e2e': ['desktop', 'backend'],
  'backend-bdd': ['backend'],
  'backend-bdd-opt-in': ['backend'],
  'android-build-test': ['android'],
  'android-e2e': ['android'],
  'ios-build-test': ['ios'],
  'ios-e2e': ['ios'],
}

/** Jobs whose failure names no culprit: `ci-status` fails because a member
 *  failed; `changes` classifies, it does not judge. */
export const AGGREGATE_JOB_NAMES: readonly string[] = ['ci-status', 'changes']

export type JobAttribution =
  | { kind: 'aggregate' }
  | { kind: 'platforms'; flags: readonly (keyof PlatformFlags)[] }
  | { kind: 'unknown' }

export function attributeJob(jobName: string): JobAttribution {
  const key = jobName.split(' / ')[0] ?? jobName
  if ((AGGREGATE_JOB_NAMES as readonly string[]).includes(key)) return { kind: 'aggregate' }
  const flags = QUEUE_ONLY_JOB_FLAGS[key]
  if (flags !== undefined) return { kind: 'platforms', flags }
  return { kind: 'unknown' }
}

/**
 * The failed jobs a candidate's own diff could have scheduled. An `unknown`
 * job attributes to every candidate (fail closed): a job this map does not
 * know is not proof the candidate is innocent.
 */
export function ownDiffFailures(failedJobs: readonly string[], flags: PlatformFlags): string[] {
  return failedJobs.filter((job) => {
    const a = attributeJob(job)
    if (a.kind === 'aggregate') return false
    if (a.kind === 'unknown') return true
    return a.flags.some((f) => flags[f])
  })
}

// ---------------------------------------------------------------------------
// Facts.
// ---------------------------------------------------------------------------

/** One step of a job, as the jobs API reports it. */
export interface RunStep {
  name: string
  /** `''` when the API reported none. */
  conclusion: string
  completedAt: string | undefined
}

/** One job of a workflow run, as the jobs API reports it. */
export interface RunJob {
  /** The job's GraphQL node id (`CR_…`): a job IS a CheckRun, and this is the
   *  key its annotations are read by. */
  nodeId: string
  name: string
  /** `''` when the API reported none. */
  conclusion: string
  startedAt: string | undefined
  completedAt: string | undefined
  steps: RunStep[]
}

/** A job of one of a queue attempt's runs. */
export interface AttemptJob extends RunJob {
  runId: number
  /** The workflow file the run executed (`.github/workflows/ci.yml`). */
  workflowPath: string
  /** The commit the run executed — the merge-group commit. */
  headSha: string
}

// ---------------------------------------------------------------------------
// Thresholds — every one named, so the predicate is reviewable in one place.
// ---------------------------------------------------------------------------

/** How far BEFORE the limit the kill may land and still count as the limit. */
export const TIMEOUT_EARLY_TOLERANCE_SEC = 10
/** How far AFTER the limit the kill may land — a stalled runner acknowledges
 *  the kill late. Observed kill moments (first cancelled step's end − job
 *  start), 2026-11-05: `backend-unit` 601 s of a 10-min limit, `desktop-rust`
 *  1816 s of 30 min, `Updater pubkey is set` 151 s of 2 min (+31 s, its
 *  runner stalled). The JOB's own end is useless here: post-steps run after
 *  the kill on the same stalled runner and added 300 s, 21 s and 120 s. */
export const TIMEOUT_LATE_TOLERANCE_SEC = 60
/** Fewer successful samples than this and "normal" is not established. */
export const MIN_NORMAL_SAMPLES = 3
/** The limit must be at least this multiple of the SLOWEST normal sample. */
export const MIN_LIMIT_TO_NORMAL_RATIO = 3
/** Samples collected per job before the search stops. */
export const NORMAL_SAMPLE_TARGET = 5
/** Recent runs of a workflow read, at most, while sampling. */
export const NORMAL_LOOKBACK_RUNS = 20

/** Conclusions that are neither a verdict against the code nor a cancellation. */
const PASSING_CONCLUSIONS: readonly string[] = ['success', 'skipped', 'neutral']

/** Anything that is not passing and not `cancelled` — including `timed_out`
 *  and an unset conclusion — is the failure class. Closed by construction:
 *  a conclusion GitHub adds tomorrow lands here, not in "cancelled". */
export function isFailureClass(conclusion: string): boolean {
  return !PASSING_CONCLUSIONS.includes(conclusion) && conclusion !== 'cancelled'
}

// ---------------------------------------------------------------------------
// Configured limits — from the workflow file the run executed.
// ---------------------------------------------------------------------------

export interface WorkflowJobDef {
  id: string
  /** `name:` when set, else the job id — what GitHub displays. */
  displayName: string
  hasMatrix: boolean
  /** A literal number only; an expression is unknown, never guessed. */
  timeoutMinutes: number | undefined
  /** `uses:` for a reusable-workflow call. */
  uses: string | undefined
}

/** The jobs of a workflow file. `undefined` when it is not a parseable
 *  workflow — never an empty list. */
export function parseWorkflowJobs(yamlText: string): WorkflowJobDef[] | undefined {
  let doc: unknown
  try {
    doc = parseYaml(yamlText)
  } catch {
    return undefined
  }
  if (typeof doc !== 'object' || doc === null) return undefined
  const jobs = (doc as { jobs?: unknown }).jobs
  if (typeof jobs !== 'object' || jobs === null || Array.isArray(jobs)) return undefined
  const out: WorkflowJobDef[] = []
  for (const [id, raw] of Object.entries(jobs as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue
    const j = raw as { name?: unknown; strategy?: unknown; 'timeout-minutes'?: unknown; uses?: unknown }
    const strategy = j.strategy as { matrix?: unknown } | undefined
    out.push({
      id,
      displayName: typeof j.name === 'string' && j.name.length > 0 ? j.name : id,
      hasMatrix: typeof strategy === 'object' && strategy !== null && strategy.matrix !== undefined,
      timeoutMinutes: typeof j['timeout-minutes'] === 'number' ? j['timeout-minutes'] : undefined,
      uses: typeof j.uses === 'string' ? j.uses : undefined,
    })
  }
  return out
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The regex source matching the name GitHub gives a job. An expression in
 * the name (`ui (${{ matrix.shard }})`) matches any text; a matrix job whose
 * name carries no expression gets GitHub's ` (<values>)` suffix.
 */
export function jobNamePattern(displayName: string, hasMatrix: boolean): string {
  const parts = displayName.split(/\$\{\{[\s\S]*?\}\}/)
  const src = parts.map(escapeRe).join('.+?')
  return hasMatrix && parts.length === 1 ? `${src} \\(.+\\)` : src
}

export interface JobLimitEntry {
  /** Anchored regex source over the API job name. */
  pattern: string
  timeoutMinutes: number | undefined
  /** Where the definition lives, for the evidence line. */
  source: string
}

/** Local reusable-workflow references only: `./.github/workflows/x.yml`. */
const LOCAL_WORKFLOW_RE = /^\.\/(\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml)$/
const MAX_REUSABLE_DEPTH = 4 // GitHub's own nesting limit

/**
 * Every job a workflow can produce, with its configured limit, following
 * local reusable workflows. `undefined` when the root file is unreadable or
 * not a workflow. An unreadable or non-local CALLED workflow yields a
 * catch-all entry with no limit for that caller's prefix — those names are
 * unknown, never absent.
 */
export async function loadJobLimits(
  workflowPath: string,
  ref: string,
  readWorkflowFile: (path: string, ref: string) => Promise<string | undefined>,
): Promise<JobLimitEntry[] | undefined> {
  const walk = async (path: string, prefix: string, depth: number): Promise<JobLimitEntry[] | undefined> => {
    const text = await readWorkflowFile(path, ref)
    if (text === undefined) return undefined
    const defs = parseWorkflowJobs(text)
    if (defs === undefined) return undefined
    const out: JobLimitEntry[] = []
    for (const def of defs) {
      const own = prefix + jobNamePattern(def.displayName, def.hasMatrix)
      if (def.uses === undefined) {
        out.push({ pattern: own, timeoutMinutes: def.timeoutMinutes, source: `${path}#${def.id}` })
        continue
      }
      const local = LOCAL_WORKFLOW_RE.exec(def.uses)?.[1]
      const inner = local !== undefined && depth < MAX_REUSABLE_DEPTH
        ? await walk(local, `${own} / `, depth + 1)
        : undefined
      if (inner === undefined) {
        out.push({ pattern: `${own} / .+`, timeoutMinutes: undefined, source: `${path}#${def.id} (uses ${def.uses}, unreadable)` })
      } else {
        out.push(...inner)
      }
    }
    return out
  }
  return walk(workflowPath, '', 0)
}

export type LimitLookup =
  | { ok: true; minutes: number; source: string }
  | { ok: false; reason: string }

/** The one configured limit for a job name, or why there is none. Two
 *  definitions matching with different limits is ambiguous — unknown. */
export function limitFor(jobName: string, table: readonly JobLimitEntry[] | undefined): LimitLookup {
  if (table === undefined) return { ok: false, reason: 'the workflow file the run executed could not be read' }
  const hits = table.filter((e) => new RegExp(`^(?:${e.pattern})$`).test(jobName))
  if (hits.length === 0) return { ok: false, reason: 'no job definition in the workflow the run executed matches this name' }
  const limits = new Set(hits.map((h) => h.timeoutMinutes))
  if (limits.size > 1) return { ok: false, reason: `ambiguous — ${hits.length} definitions match with different limits` }
  const minutes = hits[0]?.timeoutMinutes
  if (minutes === undefined) return { ok: false, reason: `no literal timeout-minutes is configured (${hits[0]?.source ?? '?'})` }
  return { ok: true, minutes, source: hits[0]?.source ?? '?' }
}

// ---------------------------------------------------------------------------
// The per-job judgement.
// ---------------------------------------------------------------------------

/** Whole seconds between two ISO timestamps, or `undefined`. */
function secondsBetween(start: string | undefined, end: string | undefined): number | undefined {
  if (start === undefined || end === undefined) return undefined
  const s = Date.parse(start)
  const e = Date.parse(end)
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return undefined
  return Math.round((e - s) / 1000)
}

/** A job's whole running time — the "normal duration" sample of a success. */
export function jobDurationSec(job: Pick<RunJob, 'startedAt' | 'completedAt'>): number | undefined {
  return secondsBetween(job.startedAt, job.completedAt)
}

/**
 * When a cancelled job was KILLED, in seconds after it started: the end of
 * its earliest-ending `cancelled` step. `timeout-minutes` kills the running
 * step; everything after it (post-steps, "Complete job") is teardown. A job
 * with no cancelled step — cancelled before any step ran, or while waiting
 * for a runner — has no kill moment and is not the shape of a timeout.
 */
export function killMomentSec(job: Pick<RunJob, 'startedAt' | 'steps'>): number | undefined {
  const ends = job.steps
    .filter((st) => st.conclusion === 'cancelled')
    .map((st) => secondsBetween(job.startedAt, st.completedAt))
    .filter((d): d is number => d !== undefined)
  return ends.length === 0 ? undefined : Math.min(...ends)
}

export interface NormalDuration { samples: number; minSec: number; medianSec: number; maxSec: number }

export function normalDuration(samples: readonly number[]): NormalDuration | undefined {
  if (samples.length === 0) return undefined
  const sorted = [...samples].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 1 ? sorted[mid] ?? 0 : Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2)
  return { samples: sorted.length, minSec: sorted[0] ?? 0, medianSec: median, maxSec: sorted[sorted.length - 1] ?? 0 }
}

export interface TimeoutEvidence {
  kind: 'timeout'
  job: string
  runId: number
  /** Seconds from the job's start to its kill (`killMomentSec`). */
  killedAfterSec: number
  limitMinutes: number
  limitSource: string
  normal: NormalDuration
}

/** A failure-class job that said, itself, that it was not the code's fault. */
export interface DeclaredEvidence {
  kind: 'declared'
  job: string
  runId: number
  /** The stable token the step named itself with (`disk-headroom`), else `unnamed`. */
  reason: string
  /** The start of the annotation, for the evidence line. */
  excerpt: string
}

/** Why an ejection was infrastructure — either kind is capped once per head. */
export type InfraEvidence = TimeoutEvidence | DeclaredEvidence

export type CancelledJobJudgement =
  | { infra: true; evidence: TimeoutEvidence }
  | { infra: false; reason: string }

const fmtNormal = (n: NormalDuration): string =>
  `normally ${n.minSec}–${n.maxSec} s (median ${n.medianSec} s over ${n.samples} successful run${n.samples === 1 ? '' : 's'})`

/** The evidence line — what the log and the PR comment say. */
export function describeEvidence(e: InfraEvidence): string {
  if (e.kind === 'declared') {
    return `"${e.job}" (run ${e.runId}) FAILED but declared itself environmental (${e.reason}): ${e.excerpt}`
  }
  return `"${e.job}" (run ${e.runId}) killed ${e.killedAfterSec} s after it started, against its configured ` +
    `timeout-minutes: ${e.limitMinutes} (${e.limitMinutes * 60} s); ${fmtNormal(e.normal)} — ` +
    `${(e.limitMinutes * 60 / Math.max(e.normal.maxSec, 1)).toFixed(1)}× its slowest normal run`
}

/** Terms 3 and 4 of the predicate for one job. */
export function judgeCancelledJob(job: AttemptJob, limit: LimitLookup, samples: readonly number[]): CancelledJobJudgement {
  const no = (reason: string): CancelledJobJudgement => ({ infra: false, reason: `"${job.name}" (run ${job.runId}): ${reason}` })
  // Never on a failure — independent of classifyAttempt's own early return.
  if (job.conclusion !== 'cancelled') return no(`concluded ${job.conclusion || '(none)'}, not cancelled — a verdict, never an infrastructure signal`)
  const killedAfter = killMomentSec(job)
  if (killedAfter === undefined) return no('no step of it was cancelled (it was cancelled before or between steps, or its timestamps are missing) — not the shape of a timeout kill')
  if (!limit.ok) return no(`its configured limit is unknown: ${limit.reason}`)
  const limitSec = limit.minutes * 60
  if (killedAfter < limitSec - TIMEOUT_EARLY_TOLERANCE_SEC || killedAfter > limitSec + TIMEOUT_LATE_TOLERANCE_SEC) {
    return no(`killed ${killedAfter} s after it started, not at its ${limit.minutes}-min (${limitSec} s) limit — a cancellation, not a timeout`)
  }
  const normal = normalDuration(samples)
  if (normal === undefined || normal.samples < MIN_NORMAL_SAMPLES) {
    return no(`timed out at its ${limit.minutes}-min limit, but only ${normal?.samples ?? 0} successful run(s) of it are known (need ${MIN_NORMAL_SAMPLES}) — "blocked, not slow" is unprovable`)
  }
  if (normal.maxSec * MIN_LIMIT_TO_NORMAL_RATIO > limitSec) {
    return no(`timed out at its ${limit.minutes}-min limit, but it is ${fmtNormal(normal)} — within ${MIN_LIMIT_TO_NORMAL_RATIO}× of the limit, so it was slow, not blocked`)
  }
  return { infra: true, evidence: { kind: 'timeout', job: job.name, runId: job.runId, killedAfterSec: killedAfter, limitMinutes: limit.minutes, limitSource: limit.source, normal } }
}

// ---------------------------------------------------------------------------
// Declared environmental failures — the reason a job failed (#2529).
// ---------------------------------------------------------------------------

/** The sentence a CI step prints, in an `::error::`, when it fails because of
 *  the runner and not the code (`mac-runner-disk-guard.sh`, ios-e2e.yml's
 *  disk fallback and zero-tests guard). The apostrophe is matched in both
 *  ASCII and typographic form. */
export const ENVIRONMENTAL_DECLARATION = /THIS IS NOT A TEST FAILURE AND NOT THIS PR['\u2019]S FAULT/

/** The stable tokens those steps name themselves with, in the order checked.
 *  They label the evidence; the sentence above is what declares. */
export const DECLARED_REASON_TOKENS: readonly string[] = ['disk-headroom', 'zero-tests-executed']

const EXCERPT_CHARS = 160

export interface EnvironmentalDeclaration { reason: string; excerpt: string }

/** The declaration in a job's failure annotations, if any. */
export function environmentalDeclaration(messages: readonly string[]): EnvironmentalDeclaration | undefined {
  const hit = messages.find((m) => ENVIRONMENTAL_DECLARATION.test(m))
  if (hit === undefined) return undefined
  const oneLine = hit.replace(/\s+/g, ' ').trim()
  return {
    reason: DECLARED_REASON_TOKENS.find((t) => hit.includes(t)) ?? 'unnamed',
    excerpt: oneLine.length > EXCERPT_CHARS ? `${oneLine.slice(0, EXCERPT_CHARS)}…` : oneLine,
  }
}

// ---------------------------------------------------------------------------
// The attempt verdict.
// ---------------------------------------------------------------------------

export type AttemptVerdict =
  /** A failure-class job its own diff schedules — a defect to fix. */
  | { kind: 'own-diff'; jobs: string[] }
  /** Failure-class jobs only on shards the diff cannot schedule — a sibling
   *  broke the group (#2036). Not an infrastructure verdict and not capped
   *  here; eligible exactly as before this module. */
  | { kind: 'sibling'; failed: string[] }
  /** Every cause timed out while blocked — the one re-queue this module adds. */
  | { kind: 'infra-timeout'; evidence: TimeoutEvidence[] }
  /** Every failure-class job declared itself environmental (#2529). */
  | { kind: 'infra-declared'; evidence: DeclaredEvidence[] }
  /** Cancelled, but not provably by infrastructure — left for a human. */
  | { kind: 'not-infra'; reason: string }
  /** A read the verdict needs failed. */
  | { kind: 'unreadable'; reason: string }

const isAggregate = (name: string): boolean => attributeJob(name).kind === 'aggregate'

/** The jobs of an attempt that are in the failure class, aggregates aside. */
export function failedJobs(jobs: readonly AttemptJob[]): AttemptJob[] {
  return jobs.filter((j) => isFailureClass(j.conclusion) && !isAggregate(j.name))
}

/** Term 1: the failure verdicts, decided before any cancellation is read.
 *  `declared` holds the failed jobs that declared themselves environmental —
 *  they are set aside before the shard map is consulted; what remains is the
 *  genuine failures, attributed by shard as before. */
export function failureVerdict(
  jobs: readonly AttemptJob[],
  flags: PlatformFlags,
  declared: ReadonlyMap<AttemptJob, EnvironmentalDeclaration> = new Map(),
): AttemptVerdict | undefined {
  const failed = failedJobs(jobs)
  if (failed.length === 0) return undefined
  const genuine = failed.filter((j) => !declared.has(j)).map((j) => j.name)
  if (genuine.length === 0) {
    return {
      kind: 'infra-declared',
      evidence: failed.map((j): DeclaredEvidence => {
        const d = declared.get(j)
        return { kind: 'declared', job: j.name, runId: j.runId, reason: d?.reason ?? 'unnamed', excerpt: d?.excerpt ?? '' }
      }),
    }
  }
  const own = ownDiffFailures(genuine, flags)
  return own.length > 0 ? { kind: 'own-diff', jobs: own } : { kind: 'sibling', failed: genuine }
}

/** Term 2: the cancelled jobs that could have caused the ejection — those
 *  ending no later than the rollup's own failure. */
export function ejectionCauses(jobs: readonly AttemptJob[]): AttemptJob[] {
  const rollupEnds = jobs
    .filter((j) => isAggregate(j.name) && isFailureClass(j.conclusion) && j.completedAt !== undefined)
    .map((j) => Date.parse(j.completedAt ?? ''))
    .filter((t) => !Number.isNaN(t))
  const ejectedAt = rollupEnds.length > 0 ? Math.min(...rollupEnds) : Number.POSITIVE_INFINITY
  return jobs.filter((j) => {
    if (j.conclusion !== 'cancelled' || isAggregate(j.name)) return false
    const end = j.completedAt === undefined ? Number.NaN : Date.parse(j.completedAt)
    // An unparseable end cannot be proven to be a consequence — it stays a cause.
    return Number.isNaN(end) || end <= ejectedAt
  })
}

export interface AttemptReadDeps {
  readRunJobs(runId: number): Promise<RunJob[] | undefined>
  readWorkflowFile(path: string, ref: string): Promise<string | undefined>
  /** Recent COMPLETED runs of one workflow file (any event), newest first. */
  listRecentWorkflowRuns(workflowPath: string): Promise<number[] | undefined>
  /** The messages of a job's failure-level annotations (`::error::` lines).
   *  `undefined` on any failure — never an empty list. */
  readJobAnnotations(nodeId: string): Promise<string[] | undefined>
}

/** Per-pass memo, so N candidates share one read of each run, file and sample. */
export interface AttemptReadCache {
  jobs: Map<number, Promise<RunJob[] | undefined>>
  limits: Map<string, Promise<JobLimitEntry[] | undefined>>
  recentRuns: Map<string, Promise<number[] | undefined>>
  annotations: Map<string, Promise<string[] | undefined>>
}

export const newAttemptReadCache = (): AttemptReadCache => ({ jobs: new Map(), limits: new Map(), recentRuns: new Map(), annotations: new Map() })

function memo<K, V>(map: Map<K, Promise<V>>, key: K, load: () => Promise<V>): Promise<V> {
  const hit = map.get(key)
  if (hit !== undefined) return hit
  const p = load()
  map.set(key, p)
  return p
}

/** Successful durations of `jobName` in `workflowPath`'s recent runs. */
async function normalSamples(
  workflowPath: string, jobName: string, exclude: ReadonlySet<number>,
  deps: AttemptReadDeps, cache: AttemptReadCache,
): Promise<number[]> {
  const runs = await memo(cache.recentRuns, workflowPath, () => deps.listRecentWorkflowRuns(workflowPath))
  const samples: number[] = []
  for (const id of (runs ?? []).filter((r) => !exclude.has(r)).slice(0, NORMAL_LOOKBACK_RUNS)) {
    const jobs = await memo(cache.jobs, id, () => deps.readRunJobs(id))
    for (const j of jobs ?? []) {
      if (j.name !== jobName || j.conclusion !== 'success') continue
      const d = jobDurationSec(j)
      if (d !== undefined) samples.push(d)
    }
    if (samples.length >= NORMAL_SAMPLE_TARGET) break
  }
  return samples
}

export interface AttemptRun { id: number; path: string; headSha: string; conclusion: string }

/**
 * The verdict on one failed queue attempt (all of its workflow runs). The
 * order IS the safety property: failures first, and only an attempt with no
 * failure-class job at all ever reaches the cancellation judgement.
 */
export async function classifyAttempt(
  runs: readonly AttemptRun[],
  flags: PlatformFlags,
  deps: AttemptReadDeps,
  cache: AttemptReadCache = newAttemptReadCache(),
): Promise<AttemptVerdict> {
  const jobs: AttemptJob[] = []
  for (const run of runs) {
    if (PASSING_CONCLUSIONS.includes(run.conclusion)) continue // a passing run holds no failed or cancelled job
    const runJobs = await memo(cache.jobs, run.id, () => deps.readRunJobs(run.id))
    if (runJobs === undefined) return { kind: 'unreadable', reason: `the jobs of run ${run.id} could not be read — cannot rule out its own diff` }
    for (const j of runJobs) jobs.push({ ...j, runId: run.id, workflowPath: run.path, headSha: run.headSha })
  }

  // Reason over shard: a failed job the diff schedules is read for a
  // declaration of its own before the shard map judges it.
  const declared = new Map<AttemptJob, EnvironmentalDeclaration>()
  const unread: AttemptJob[] = []
  const scheduled = new Set(ownDiffFailures(failedJobs(jobs).map((j) => j.name), flags))
  for (const j of failedJobs(jobs).filter((f) => scheduled.has(f.name))) {
    const messages = await memo(cache.annotations, j.nodeId, () => deps.readJobAnnotations(j.nodeId))
    if (messages === undefined) { unread.push(j); continue }
    const d = environmentalDeclaration(messages)
    if (d !== undefined) declared.set(j, d)
  }
  const failure = failureVerdict(jobs, flags, declared)
  if (failure?.kind === 'own-diff' && unread.length > 0) {
    return {
      kind: 'unreadable',
      reason: `the annotations of ${unread.map((j) => `"${j.name}" (run ${j.runId})`).join(', ')} could not be read — whether it declared itself environmental is unknown, so it is not called a defect`,
    }
  }
  if (failure !== undefined) return failure

  const causes = ejectionCauses(jobs)
  if (causes.length === 0) {
    return { kind: 'not-infra', reason: 'no job failed and none was cancelled before the rollup concluded — the ejection is unexplained' }
  }

  const exclude = new Set(runs.map((r) => r.id))
  const evidence: TimeoutEvidence[] = []
  const refusals: string[] = []
  for (const job of causes) {
    const table = await memo(cache.limits, `${job.workflowPath}@${job.headSha}`,
      () => loadJobLimits(job.workflowPath, job.headSha, deps.readWorkflowFile))
    const limit = limitFor(job.name, table)
    const samples = limit.ok ? await normalSamples(job.workflowPath, job.name, exclude, deps, cache) : []
    const j = judgeCancelledJob(job, limit, samples)
    if (j.infra) evidence.push(j.evidence)
    else refusals.push(j.reason)
  }
  if (refusals.length > 0) return { kind: 'not-infra', reason: refusals.join('; ') }
  return { kind: 'infra-timeout', evidence }
}

// ---------------------------------------------------------------------------
// The cap — one automatic re-queue per PR per head, recorded ON the PR.
// ---------------------------------------------------------------------------

/**
 * The cap lives on GitHub, not in a local file: a PR comment carrying this
 * marker is both rule V's visible record and the cap's ledger, so it survives
 * a host move, is readable by anyone deciding what to do next, and cannot go
 * merge-blind the way a second-purpose ledger did. The marker can only ever
 * BLOCK a re-queue — anyone forging one makes the feed more conservative,
 * never less.
 */
export const INFRA_REQUEUE_MARKER = 'fleet:infra-requeue'

export function infraRequeueMarker(head: string, runId: number): string {
  return `<!-- ${INFRA_REQUEUE_MARKER} head=${head} run=${runId} -->`
}

const MARKER_RE = new RegExp(`<!-- ${INFRA_REQUEUE_MARKER} head=([0-9a-f]{40}) run=(\\d+) -->`, 'g')

/** The prior automatic re-queue recorded for THIS head, if any. */
export function priorInfraRequeue(commentBodies: readonly string[], head: string): { runId: number } | undefined {
  for (const body of commentBodies) {
    for (const m of body.matchAll(MARKER_RE)) {
      if (m[1] === head) return { runId: Number(m[2]) }
    }
  }
  return undefined
}

export function renderInfraRequeueComment(head: string, runIds: readonly number[], evidence: readonly InfraEvidence[]): string {
  const lead = runIds[0] ?? 0
  return [
    infraRequeueMarker(head, lead),
    `**Automatic re-queue after an infrastructure ejection** (#2458) — head \`${head.slice(0, 12)}\`, merge-group run${runIds.length === 1 ? '' : 's'} ${runIds.join(', ')}.`,
    '',
    evidence.every((e) => e.kind === 'declared')
      ? 'No job failed on its merits. Every failed job declared itself environmental — a step that refuses to run on a starved or broken runner, and says it is not this PR\'s fault:'
      : 'No job failed on its merits. Every job that ejected the group was either cancelled by its own `timeout-minutes` while blocked, not slow, or declared itself environmental:',
    '',
    ...evidence.map((e) => `- ${describeEvidence(e)}`),
    '',
    'This is the **one** automatic re-queue for this head. If it is ejected by infrastructure again, `queue-feed` stops and leaves it for a human — a second infra ejection on one head is a signal, not noise. A `failure` that did not declare itself environmental is never re-queued automatically.',
  ].join('\n')
}
