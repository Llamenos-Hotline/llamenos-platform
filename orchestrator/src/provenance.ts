import { execFileSync } from 'node:child_process'
import { gitFactsFor } from './dependency.js'

/**
 * Issue #1801 — fleet-runtime provenance.
 *
 * The fleet executes from a checkout (`llamenos-fleet-runtime`), not from the
 * GitHub `main` its PRs merge into. On 2026-10-10 that checkout sat 35
 * commits behind `main` on a detached HEAD, so a merged fix (#1771 — the one
 * that stops every fleet PR being born BLOCKED) was reviewed, merged, and
 * NOT RUNNING, while `doctor` reported every lane ok for hours. It was the
 * third fleet-wide outage from stale local state in one week (#1738, #1755,
 * #1801), and the shared shape is named by the issue: doctor validated
 * configuration and liveness, never provenance — it never checked that the
 * code about to run was the code that was reviewed.
 *
 * This module is the general check, built once rather than as three special
 * cases: one gatherer (`checkoutProvenance`) that reads a checkout's
 * revision against its upstream, one pure predicate (`provenanceProblems`)
 * that turns those facts into named problems, and one read-only gate
 * (`assessRuntimeCurrency`) the tick uses to refuse when no automatic move can
 * fix the checkout. The move itself lives in `runtime-sync.ts` (#2515).
 *
 * Severity is deliberate: every condition below is a FAIL, never a WARN —
 * with one exception in `doctor`, not here: a checkout that is clean, on
 * main, and behind ONLY because a fleet run is still in flight (#2515) heals
 * itself at the next idle run start, so doctor WARNs on that one.
 * doctor already emits standing warnings a reader learns to skim past, and
 * runtime drift silently disables merged code — it belongs with the
 * failures.
 */

/**
 * The one place the fleet-runtime root is resolved. cli.ts and engines.ts
 * both used to spell `process.env['FLEET_REPO_ROOT'] ?? process.cwd()`
 * independently; the env override exists so tests (and the break-it
 * acceptance for #1801) can point the fleet at a throwaway checkout without
 * touching the real runtime.
 */
export function fleetRuntimeRoot(): string {
  return process.env['FLEET_REPO_ROOT'] ?? process.cwd()
}

export interface CheckoutProvenance {
  isGitRepo: boolean
  /** See `DependencyFacts.unreadable` in dependency.ts — a git call failed
   *  on what IS a repo (zero commits, or one that became unreadable
   *  mid-check). */
  unreadable: boolean
  /** HEAD's full sha, when readable. */
  commit?: string
  /** The checked-out branch, or `undefined` on a detached HEAD. Detached is
   *  its own problem: no `git pull --ff-only` can ever update a detached
   *  checkout, so it drifts from the very next upstream merge (#1801's
   *  exact shape). */
  branch?: string
  dirty: boolean
  /** `git status --porcelain` lines, so a FAIL can name WHAT is dirty
   *  rather than asserting it — the remediation differs (commit, discard,
   *  or delete debris). */
  dirtyDetail: string[]
  /** False when the best-effort `git fetch` failed — currency is then
   *  UNVERIFIED, which must never render identically to "verified current"
   *  (the same fail-closed rule as #1738's model enumeration). */
  fetchOk: boolean
  /** The upstream ref HEAD is measured against (`origin/main`). */
  upstream: string
  /** False when the upstream ref does not exist locally even after fetch. */
  upstreamKnown: boolean
  /** How many commits `upstream` is ahead of HEAD. `undefined` when not
   *  measurable (no repo, unreadable, fetch failed, upstream unknown). */
  behindBy?: number
  /** Files under the drift prefix that differ between the merge base and
   *  upstream (`git diff HEAD...upstream`) — "35 behind" does not tell an
   *  operator that review-requesting is off; naming
   *  `orchestrator/src/review-request.ts` does. */
  driftedFiles: string[]
}

export interface ProvenanceOptions {
  /** Upstream ref to compare against. Default `origin/main`. */
  upstream?: string
  /** Path prefix (relative to the checkout root) whose differing files are
   *  listed on drift. Default `orchestrator/` — the code the fleet runs. */
  driftPrefix?: string
  /** Best-effort `git fetch` of the upstream ref first. Default true:
   *  without it the check compares against a remote-tracking ref that may
   *  itself be days stale, which is green-while-broken with extra steps. */
  fetch?: boolean
  /** Bound on the fetch so a network partition cannot hang doctor. */
  fetchTimeoutMs?: number
}

/** Mirrors dependency.ts's `tryGit`: one guarded git call, `undefined` on
 *  ANY failure, never throws. Provenance is a health read; a single failing
 *  git invocation must surface as a reported fact, not a crash. */
function tryGit(dir: string, args: string[], timeoutMs?: number): string | undefined {
  try {
    return execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
    })
  } catch {
    return undefined
  }
}

const FETCH_TIMEOUT_MS = 15_000
/** A drifted-file list longer than this stops being something an operator
 *  reads; the count is still exact in the message either way. */
const DRIFT_FILE_LIST_MAX = 8

/**
 * Reads everything checkable about a checkout's relationship to its
 * upstream. Every git call is independently guarded; the returned facts
 * distinguish "verified stale" from "could not verify" because the
 * predicate below treats them differently on purpose.
 */
export function checkoutProvenance(dir: string, opts: ProvenanceOptions = {}): CheckoutProvenance {
  const upstream = opts.upstream ?? 'origin/main'
  const driftPrefix = opts.driftPrefix ?? 'orchestrator/'
  const doFetch = opts.fetch ?? true

  const git = gitFactsFor(dir)
  const base: CheckoutProvenance = {
    isGitRepo: git.isGitRepo,
    unreadable: git.unreadable,
    commit: git.commit,
    branch: undefined,
    dirty: git.dirty,
    dirtyDetail: [],
    fetchOk: false,
    upstream,
    upstreamKnown: false,
    behindBy: undefined,
    driftedFiles: [],
  }
  if (!git.isGitRepo) return base

  const branch = tryGit(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  base.branch = branch?.trim() || undefined

  if (git.dirty) {
    const porcelain = tryGit(dir, ['status', '--porcelain'])
    base.dirtyDetail = (porcelain ?? '').split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0)
  }

  if (doFetch) {
    // Explicit refspec: `git fetch origin main` only opportunistically
    // updates the remote-tracking ref on some git versions; naming the
    // destination ref makes the update deterministic. Fetching is the one
    // mutation a provenance check is allowed — it changes refs, never the
    // worktree, and without it "behind" is measured against a ref whose
    // own staleness is invisible.
    const [remote, ...branchParts] = upstream.split('/')
    const remoteBranch = branchParts.join('/')
    base.fetchOk = remote !== undefined && remoteBranch.length > 0 &&
      tryGit(dir, ['fetch', remote, `+${remoteBranch}:refs/remotes/${upstream}`], opts.fetchTimeoutMs ?? FETCH_TIMEOUT_MS) !== undefined
  } else {
    base.fetchOk = true // caller opted out of fetching — last-known refs are the best available
  }

  base.upstreamKnown = tryGit(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/${upstream}`]) !== undefined
  if (!base.upstreamKnown || git.commit === undefined) return base

  const behind = tryGit(dir, ['rev-list', '--count', `HEAD..${upstream}`])
  const behindN = behind !== undefined ? Number(behind.trim()) : Number.NaN
  base.behindBy = Number.isFinite(behindN) ? behindN : undefined
  if (base.behindBy === undefined) {
    base.unreadable = true
    return base
  }

  if (base.behindBy > 0) {
    // Three-dot: files changed on the UPSTREAM side since the merge base —
    // the merged work this checkout is not running. Two-dot would also list
    // files changed locally on HEAD, which is not the drift question.
    const diff = tryGit(dir, ['diff', '--name-only', `HEAD...${upstream}`, '--', driftPrefix])
    base.driftedFiles = (diff ?? '').split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  }
  return base
}

/**
 * The pure predicate over the gathered facts — kept separate so the
 * failure-mode logic (what counts as a problem, at what severity: all of it
 * FAIL) is testable without touching a filesystem or spawning git.
 */
export function provenanceProblems(p: CheckoutProvenance): string[] {
  const problems: string[] = []
  if (!p.isGitRepo) {
    problems.push('is not a git repository — its revision cannot be verified against origin/main')
    return problems
  }
  if (p.unreadable) {
    problems.push('its git state could not be fully read — revision UNVERIFIED')
  }
  if (p.dirty) {
    const detail = p.dirtyDetail.length > 0 ? `: ${p.dirtyDetail.slice(0, DRIFT_FILE_LIST_MAX).join(', ')}${p.dirtyDetail.length > DRIFT_FILE_LIST_MAX ? ` (+${p.dirtyDetail.length - DRIFT_FILE_LIST_MAX} more)` : ''}` : ''
    problems.push(`has uncommitted changes${detail} — code is running that no reviewed commit describes`)
  }
  if (p.branch === undefined) {
    problems.push('is on a detached HEAD — no `git pull --ff-only` can ever update it; check out a branch tracking origin/main')
  }
  if (!p.fetchOk) {
    problems.push(`could not fetch ${p.upstream} — currency UNVERIFIED (network or auth problem); refusing to call a stale measurement current`)
  } else if (!p.upstreamKnown) {
    problems.push(`${p.upstream} ref is absent — cannot measure drift`)
  } else if (p.behindBy !== undefined && p.behindBy > 0) {
    const files = p.driftedFiles.length > 0
      ? `; drifted: ${p.driftedFiles.slice(0, DRIFT_FILE_LIST_MAX).join(', ')}${p.driftedFiles.length > DRIFT_FILE_LIST_MAX ? ` (+${p.driftedFiles.length - DRIFT_FILE_LIST_MAX} more)` : ''}`
      : ''
    problems.push(`is ${p.behindBy} commit(s) behind ${p.upstream} — merged fixes are NOT running${files}`)
  }
  return problems
}

/**
 * True when the ONLY thing between this checkout and `origin/main` is a
 * fast-forward: on `main`, clean, readable, fetched, verifiably behind. This
 * is the one state in which an automatic move is safe, so it is also the one
 * state in which "behind" is a condition that heals by itself (the wrapper's
 * `runtime-sync` step performs the move at the next idle run start) rather
 * than one that needs an operator.
 */
export function isFastForwardable(p: CheckoutProvenance): boolean {
  return p.isGitRepo && !p.unreadable && !p.dirty && p.branch === 'main' &&
    p.fetchOk && p.upstreamKnown && (p.behindBy ?? 0) > 0
}

export interface CurrencyCheck {
  /** False = the pass must not dispatch. */
  ok: boolean
  /** HEAD — the revision the running orchestrator was started from. */
  commit?: string
  /** Commits behind `origin/main`, when measurable. */
  behindBy?: number
  /** True when the pass runs on code behind `origin/main` ONLY because the
   *  wrapper deferred the update behind another in-flight run — loud, but
   *  not a refusal. */
  stale: boolean
  /** Why a refusal refused — problems joined, plus the operator remedy. */
  reason?: string
}

/**
 * The tick's currency gate (issue #1801), now READ-ONLY (#2515).
 *
 * It used to fast-forward the checkout itself, from inside the pass. That
 * swapped files under whatever else was running, and the pass that did it
 * still executed the old code. Moving the checkout is now the wrapper's job
 * (`runtime-sync.ts`, before the orchestrator starts, behind a registry of
 * live runs); this gate only decides whether the pass may dispatch on what
 * it was started with, and reports the revision and its distance from
 * `origin/main` so every pass says which code it ran.
 *
 * - **Refuse** when no automatic move can ever fix it: dirty, detached, on a
 *   branch other than main, diverged, or unverifiable. Silently dispatching
 *   yesterday's rails is the incident this exists to prevent.
 * - **Run, loudly** when the checkout is merely behind and fast-forwardable:
 *   the wrapper deferred the update because another run was in flight, and
 *   refusing here would skip a pass over a window that closes on its own.
 */
export function assessRuntimeCurrency(root: string, log: (msg: string) => void): CurrencyCheck {
  const p = checkoutProvenance(root)
  const problems = provenanceProblems(p)
  if (problems.length === 0) {
    log(`fleet runtime ${p.commit?.slice(0, 12) ?? '?'} is current with ${p.upstream}`)
    return { ok: true, commit: p.commit, behindBy: p.behindBy, stale: false }
  }
  if (isFastForwardable(p)) {
    log(`fleet runtime ${p.commit?.slice(0, 12) ?? '?'} is ${p.behindBy} commit(s) behind ${p.upstream} — this pass runs the old code; the update was deferred behind an in-flight run and the next idle run start adopts it`)
    return { ok: true, commit: p.commit, behindBy: p.behindBy, stale: true }
  }
  return {
    ok: false, commit: p.commit, behindBy: p.behindBy, stale: false,
    reason:
      `fleet runtime is not current: ${problems.join('; ')}. ` +
      `Remedy: git -C ${root} checkout main && git -C ${root} pull --ff-only ` +
      '(committing, discarding, or cleaning any local changes first). ' +
      'The fleet refuses to dispatch code whose provenance it cannot stand behind.',
  }
}
