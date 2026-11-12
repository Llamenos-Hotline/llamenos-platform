import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { REVIEW_AND_MERGE_DIR } from './paths.js'
import { isAlive } from './lock.js'

/**
 * #2742 — the runaway guards around `review-and-merge`.
 *
 * On 2026-11-11, twice, a worker verifying the re-verify path invoked
 * `review-and-merge`, which invoked verification, which invoked
 * `review-and-merge`: 44,158 bun processes, ~4,900 of them `review-and-merge`.
 * Nothing merged and nothing was lost, but the machine was saturated both
 * times. Three failure modes were stacked, and each needs its own guard —
 * stopping whichever one a reproduction happens to hit leaves the others:
 *
 *   1. **Nesting.** A `review-and-merge` that starts inside a verification is
 *      the recursion edge itself. `nestedInVerification`.
 *   2. **Re-processing one head.** A loop that survives (1) by some other
 *      route still arrives at the SAME head SHA each time. `recordAttempt`.
 *   3. **Parallel invocations on one PR.** Two runs of the same PR racing
 *      each other spend two reviews and can post two verdicts. `acquireInFlight`.
 *
 * (The fourth leg — merging is opt-in — is a property of the function's
 * signature in review-and-merge.ts, not state kept here.)
 *
 * Every guard here FAILS CLOSED: a lock or ledger that cannot be read or
 * written refuses the run. A guard that waves a run through when it cannot
 * tell is exactly the shape that lets a fork bomb through.
 */

// ---------------------------------------------------------------------------
// 1. Nesting
// ---------------------------------------------------------------------------

/**
 * Set to a non-empty value in the environment of every process a
 * verification starts: the diff-targeted test runs (`verify.ts`), the
 * `verify-ci` / `review-ci` / `review-gate` commands themselves, and the
 * reviewer engine's allowlisted env (`review.ts`). Environment inheritance is
 * what carries it down a process tree, which is the only channel a recursion
 * spawned by `execFile` / `spawn` / a test's `execFileSync` shares with the
 * process that started it.
 */
export const IN_VERIFICATION_ENV = 'FLEET_IN_VERIFICATION'

/** `env` with the marker set — for a child process a verification starts. */
export function withVerificationMarker(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, [IN_VERIFICATION_ENV]: '1' }
}

/**
 * The reason `review-and-merge` must not run here, or `undefined` when it
 * may. Any non-empty value counts — a marker that only `=== '1'` honoured
 * would let `FLEET_IN_VERIFICATION=true` through.
 */
export function nestedInVerification(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env[IN_VERIFICATION_ENV]
  if (v === undefined || v === '') return undefined
  return `this process is running inside a verification (${IN_VERIFICATION_ENV}=${v}). A verification ` +
    'must never start a review-and-merge: that is the recursion that reached 44,158 processes on ' +
    '2026-11-11 (#2742). Run it from an operator terminal, outside any verification'
}

// ---------------------------------------------------------------------------
// 2. Per-SHA attempt ceiling
// ---------------------------------------------------------------------------

/**
 * How many times one head SHA may be processed. FIVE:
 *
 *   - A legitimate head needs at most a handful: the first run reviews and
 *     records, then an operator who opted into `--merge` may rerun while a
 *     required check is still pending, once the App credentials are fixed
 *     after a `review-unrecorded`, or after a transient `gh` read failure.
 *     Three would leave an operator with a single retry after one of those
 *     and one more for the merge; five covers a realistic worst day.
 *   - A head that has been through five runs is not waiting on a retry. It is
 *     failing the same way each time, or something is looping. The review
 *     itself is cached per head SHA, so attempts 2..5 on a head that PASSED
 *     cost only `gh` reads — the ceiling bounds the expensive case (a head
 *     that never gets a PASS) to five full reviews, not an unbounded number.
 *   - It also bounds a runaway directly: five processes per head, not 44,158.
 *
 * A new commit is a new SHA and gets a fresh allowance, which is the point:
 * the ceiling is on re-processing the SAME bytes, never on a PR's lifetime.
 */
export const MAX_ATTEMPTS_PER_SHA = 5

export type AttemptClaim =
  | { ok: true; attempt: number; ceiling: number }
  | { ok: false; reason: string }

/**
 * Records one processing attempt of `sha` and refuses once `ceiling` earlier
 * ones exist. The refused attempt is NOT appended: a runaway hammering one
 * SHA must not grow the ledger without bound.
 *
 * An append-only line ledger rather than a JSON document: concurrent writers
 * cannot lose each other's update by read-modify-write, and the per-PR
 * in-flight lock already serialises the only writers that share a head.
 */
export function recordAttempt(
  sha: string,
  opts: { dir?: string; ceiling?: number } = {},
): AttemptClaim {
  const dir = opts.dir ?? REVIEW_AND_MERGE_DIR
  const ceiling = opts.ceiling ?? MAX_ATTEMPTS_PER_SHA
  if (!/^\S+$/.test(sha)) return { ok: false, reason: `refusing to record an attempt for an unusable head SHA ${JSON.stringify(sha)}` }
  const file = join(dir, 'attempts.log')
  try {
    mkdirSync(dir, { recursive: true })
    let prior = 0
    try {
      prior = readFileSync(file, 'utf8').split('\n').filter((l) => l.split(' ')[0] === sha).length
    } catch (e) {
      if (!isErrno(e, 'ENOENT')) throw e
    }
    if (prior >= ceiling) {
      return {
        ok: false,
        reason: `head ${sha} has already been processed ${prior} times (ceiling ${ceiling}) — refusing a ` +
          `${prior + 1}th. A head that keeps being re-processed is failing the same way or being looped on; ` +
          'fix what it fails on and push a new commit (a new head gets a fresh allowance), or clear its ' +
          `lines from ${file} only if you know why they are there`,
      }
    }
    appendFileSync(file, `${sha} ${new Date().toISOString()}\n`)
    return { ok: true, attempt: prior + 1, ceiling }
  } catch (e) {
    return { ok: false, reason: `could not read or write the attempt ledger ${file}: ${errMsg(e)} — refusing rather than running unbounded` }
  }
}

// ---------------------------------------------------------------------------
// 3. In-flight guard
// ---------------------------------------------------------------------------

export type InFlightClaim =
  | { ok: true; release(): void }
  | { ok: false; reason: string }

/**
 * A pidfile per PR, created `O_EXCL`, with the same liveness probe `lock.ts`
 * uses for the scheduler lock: a lock left by a crashed run is reaped by
 * looking at it, never by guessing. One reap-and-retry, no more — two
 * processes reaping the same stale lock must not recurse into each other.
 *
 * Keyed on the PR NUMBER, which is why the CLI accepts only a number: `9`,
 * `#9` and a URL naming PR 9 are the same PR and must hit the same lock.
 */
export function acquireInFlight(pr: string, opts: { dir?: string; pid?: number } = {}): InFlightClaim {
  if (!/^\d+$/.test(pr)) return { ok: false, reason: `PR ${JSON.stringify(pr)} is not a PR number, so it cannot be locked` }
  const dir = opts.dir ?? REVIEW_AND_MERGE_DIR
  const pid = opts.pid ?? process.pid
  const file = join(dir, `pr-${pr}.lock`)
  try {
    mkdirSync(dir, { recursive: true })
    return take(file, pid, true)
  } catch (e) {
    return { ok: false, reason: `could not take the in-flight lock ${file}: ${errMsg(e)} — refusing rather than running unguarded` }
  }
}

function take(file: string, pid: number, allowReap: boolean): InFlightClaim {
  try {
    const fd = openSync(file, 'wx')
    writeSync(fd, String(pid))
    closeSync(fd)
    return {
      ok: true,
      release: () => {
        // Never remove a lock someone else now holds.
        if (readPid(file) === pid) rmSync(file, { force: true })
      },
    }
  } catch (e) {
    if (!isErrno(e, 'EEXIST')) throw e
    const holder = readPid(file)
    if (holder !== undefined && isAlive(holder)) {
      return {
        ok: false,
        reason: `another review-and-merge is already processing this PR (pid ${holder}, lock ${file}) — ` +
          'refusing to start a parallel run',
      }
    }
    // No readable pid: either its creator is between `open` and `write` (a
    // window of microseconds) or it crashed in that gap. Reaping it at once
    // would race the first case, so only a lock that has sat empty for longer
    // than any live writer could take is treated as stale.
    if (holder === undefined && Date.now() - mtimeMs(file) < EMPTY_LOCK_GRACE_MS) {
      return { ok: false, reason: `the in-flight lock ${file} was just created by a process that has not recorded its pid yet — refusing to start a parallel run` }
    }
    if (!allowReap) return { ok: false, reason: `the in-flight lock ${file} is held by a process that could not be identified` }
    rmSync(file, { force: true }) // stale — its holder is dead
    return take(file, pid, false)
  }
}

const EMPTY_LOCK_GRACE_MS = 10_000

function mtimeMs(file: string): number {
  try { return statSync(file).mtimeMs } catch { return 0 }
}

function readPid(file: string): number | undefined {
  try {
    const n = Number.parseInt(readFileSync(file, 'utf8').trim(), 10)
    return Number.isFinite(n) ? n : undefined
  } catch { return undefined }
}

function isErrno(e: unknown, code: string): boolean {
  return e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === code
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
