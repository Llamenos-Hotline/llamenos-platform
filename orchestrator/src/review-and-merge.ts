import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO, gh, ghJson } from './gh.js'
import { REVIEW_JOB } from './ci.js'
import { classifyImpact } from './impact.js'
import type { VerifyReport } from './verify.js'
import {
  buildReviewPrompt, exportReviewSnapshot, invokeVerifierEngine, toSecondOpinion,
  DEFAULT_MAX_TURNS, HIGH_IMPACT_MAX_TURNS, DEFAULT_TIMEOUT_MS, HIGH_IMPACT_TIMEOUT_MS,
  type SecondOpinionResult, type ReviewSnapshot,
} from './review.js'

const execFileAsync = promisify(execFile)

/**
 * `llamenos-fleet review-and-merge <pr>` — a coding-agent session reviews a
 * pull request AS the `fleet/review` check-run and, only once every required
 * check (including that one) is green on an unmoved head, merges it.
 *
 * This supersedes running `fleet/review` as a GitHub Actions job
 * (`.github/workflows/fleet-review.yml`) as the PRIMARY way that check gets
 * produced. The Actions version is not deleted here — see that workflow's
 * own file header for why a repo must never have a window with no reviewer —
 * but a coding-agent session run from an operator's own terminal reviews far
 * better than a metered API call boxed into a CI job's turn/timeout budget,
 * and every attempt to hand this to CI cost this repo a PR of pure plumbing
 * (bootstrap ordering, base-ref CLI availability, skipped-vs-absent
 * semantics, label association, engine smoke tests, quota exhaustion). None
 * of that plumbing exists here: this runs on the operator's own machine, with
 * the operator's own `claude` login.
 *
 * GitHub stays the enforcer regardless of where the review ran. This file
 * posts a verdict as a real `fleet/review` check-run — the exact same
 * check-run name the Actions job posts as its own job result — attached to
 * the PR's head SHA via the real GitHub Checks API, so the repo's ruleset
 * treats it identically either way. A stray `gh pr merge` from anywhere else,
 * or a bug in this file's own merge step, cannot skip that: `runMerge` below
 * checks the SAME required-checks state GitHub itself would refuse a naive
 * merge attempt against, and refuses first, with a stated reason, rather
 * than relying on `gh pr merge` to reject afterwards.
 *
 * Every step is pure or dependency-injected (`ReviewAndMergeDeps`) so the
 * five real network/process calls this needs — read the PR, export its head,
 * run the reviewer, post the check-run, merge — are exercised in tests as
 * plain mocks, exactly like every other CI-adjacent file in this
 * orchestrator (`ci.ts`, `review.ts`).
 */

// ---------------------------------------------------------------------------
// Step 1 — freshness: does the PR's CURRENT head SHA already carry a
// successful `fleet/review` check-run?
// ---------------------------------------------------------------------------

export interface CheckRunInfo {
  id: number
  status: string
  conclusion: string | null
}

interface CheckRunsResponse { total_count: number; check_runs: CheckRunInfo[] }

/**
 * Reads every `fleet/review`-named check-run recorded against this exact
 * commit — never a time window, never the PR number, exactly as
 * `review-cache.ts`'s own module comment argues for its artifact cache: a
 * rebase changes the head SHA, so a stale review can never be mistaken for a
 * fresh one, and a re-run of this command on an UNCHANGED head always finds
 * what an earlier run of it (or of the Actions workflow) already posted.
 *
 * `undefined` on any read failure (auth, network, rate limit) — `ghJson`'s
 * own contract — and `hasSuccessfulReview` below treats that identically to
 * "no check-run yet": both mean "run the engine", the same fail-safe
 * direction every other cache in this fleet takes.
 */
export async function fetchReviewCheckRuns(sha: string): Promise<CheckRunInfo[] | undefined> {
  const data = await ghJson<CheckRunsResponse>([
    'api', `repos/${REPO}/commits/${sha}/check-runs?check_name=${encodeURIComponent(REVIEW_JOB)}`,
  ])
  return data?.check_runs
}

/**
 * A prior `failure` (or `neutral`, or a run still `in_progress`) is NEVER
 * treated as fresh — only an explicit `success` skips the engine. This is
 * what makes "reuse a FAIL as fresh" the one shape this function must never
 * produce: a diff that failed review keeps failing review, on every head SHA
 * it was ever posted against, until a genuinely new head earns a genuinely
 * new PASS.
 */
export function hasSuccessfulReview(checkRuns: CheckRunInfo[] | undefined): boolean {
  return checkRuns?.some((c) => c.conclusion === 'success') ?? false
}

// ---------------------------------------------------------------------------
// Step 2 — review: export the head, build the same prompt `secondOpinion`
// builds, run a non-author `claude` session against it read-only.
// ---------------------------------------------------------------------------

/**
 * The model tier `review-and-merge` reviews with. Deliberately different
 * from `cli.ts`'s `DEFAULT_MODEL` (`'sonnet'`, what a dispatched worker
 * authors with) — this command always runs `claude`, so an author-tier model
 * here would review a diff with the same model family and rough capability
 * that wrote it, which is exactly the "a model reviewing its own output
 * shares its own blind spots" problem `VERIFIER_BRIEF` (review.ts) opens
 * with. `opus` is the heavier tier this fleet already reserves for its other
 * highest-stakes single-shot calls (the Planner role, `cli.ts`'s
 * `PLANNER_MODEL`) — never a guess at a new tier this codebase has not
 * already trusted with a one-shot, no-edit review.
 */
export const REVIEW_AND_MERGE_MODEL = 'opus'

export interface PrSnapshotFacts {
  headSha: string
  baseSha: string
  changedFiles: string[]
  addedLines: number
  authorLogin: string
  authorIsBot: boolean
}

interface GhPrViewForReview {
  headRefOid: string
  baseRefOid: string
  files: { path: string; additions: number; deletions: number }[]
  author: { login: string; is_bot?: boolean }
}

async function readPrSnapshotFacts(pr: string): Promise<PrSnapshotFacts | undefined> {
  const view = await ghJson<GhPrViewForReview>(['pr', 'view', pr, '--json', 'headRefOid,baseRefOid,files,author'])
  if (view === undefined) return undefined
  return {
    headSha: view.headRefOid,
    baseSha: view.baseRefOid,
    changedFiles: view.files.map((f) => f.path),
    addedLines: view.files.reduce((n, f) => n + f.additions, 0),
    authorLogin: view.author.login,
    authorIsBot: view.author.is_bot === true,
  }
}

/**
 * A `VerifyReport` shaped only enough to feed `buildReviewPrompt`'s impact
 * note and file list — `passed: true` and `reasons: []` unconditionally,
 * because this command never runs (and must never run) the mechanical
 * scope/never-write/test gates `verifyMechanical` runs: that is
 * `fleet/verify`'s job, already required and already checked independently
 * at merge time (`readRequiredChecks` below). Re-deriving it here would be a
 * second, silently-driftable copy of a decision GitHub's own required checks
 * already make.
 */
function reportForPrompt(facts: PrSnapshotFacts): VerifyReport {
  const { impact, reasons } = classifyImpact(facts.changedFiles, facts.addedLines)
  return { passed: true, reasons: [], changedFiles: facts.changedFiles, addedLines: facts.addedLines, impact, impactReasons: reasons }
}

/**
 * Fetches both ends of the diff range into this repo's own object database
 * as objects — never a checkout of either — then hands off to
 * `exportReviewSnapshot` (review.ts) for the actual `git archive | tar -x`
 * plus control-file strip. GitHub's git servers allow fetching any commit
 * SHA reachable from the fork network (`uploadpack.allowReachableSHA1InWant`
 * is set repo-wide on github.com), which every PR head and base commit is by
 * definition — so this never needs `refs/pull/<pr>/head` or any other named
 * ref, only the two SHAs `readPrSnapshotFacts` already read from the PR.
 */
async function fetchAndExportHead(repoRoot: string, headSha: string, baseSha: string): Promise<ReviewSnapshot> {
  await execFileAsync('git', ['-C', repoRoot, 'fetch', '--no-tags', 'origin', headSha, baseSha], { timeout: 120_000 })
  return exportReviewSnapshot(repoRoot, headSha)
}

/**
 * The review call itself: `buildReviewPrompt` (review.ts) builds the exact
 * prompt `secondOpinion` would, and `invokeVerifierEngine` (review.ts) runs
 * it — `authorEngine: 'claude'`, `model: REVIEW_AND_MERGE_MODEL` — under the same
 * read-only permission mode, env allowlist and empty-project-root isolation
 * every other reviewer invocation in this fleet gets. `toSecondOpinion`
 * (review.ts) turns the raw engine run into the PASS/FAIL/UNREADABLE verdict
 * this command posts as the check-run's conclusion.
 */
async function runNonAuthorReview(
  pr: string,
  diff: string,
  facts: PrSnapshotFacts,
  exportDir: string,
): Promise<SecondOpinionResult> {
  const report = reportForPrompt(facts)
  const prompt = buildReviewPrompt(pr, diff, report, exportDir)
  const highImpact = report.impact === 'high'
  const run = await invokeVerifierEngine({
    authorEngine: 'claude',
    model: REVIEW_AND_MERGE_MODEL,
    exportDir,
    prompt,
    maxTurns: highImpact ? HIGH_IMPACT_MAX_TURNS : DEFAULT_MAX_TURNS,
    timeoutMs: highImpact ? HIGH_IMPACT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
  })
  return toSecondOpinion(run)
}

// ---------------------------------------------------------------------------
// Step 3 — record the verdict as the real `fleet/review` check-run.
// ---------------------------------------------------------------------------

export type ReviewVerdict = 'PASS' | 'FAIL' | 'UNREADABLE'

export function checkRunConclusion(verdict: ReviewVerdict): 'success' | 'failure' {
  return verdict === 'PASS' ? 'success' : 'failure'
}

const CHECK_RUN_TITLES: Record<ReviewVerdict, string> = {
  PASS: 'Non-author review passed',
  FAIL: 'Non-author review found a problem',
  UNREADABLE: 'Non-author review was unreadable',
}

/** The Checks API's own cap on `output.summary` (65535 characters) — GitHub
 *  rejects a longer body outright, which would turn a genuine PASS into a
 *  failed `gh api` call and no check-run at all. Truncated, never rejected. */
const CHECK_RUN_SUMMARY_MAX = 65_000

/**
 * The ONLY place in `orchestrator/src` that creates a check-run — see the
 * "check-runs is created in exactly one file" rail in guards.test.ts. Posted
 * via `--input <file>` (a temp JSON file), never as `-f`/`-F` argv fields:
 * `output.summary` is the reviewer's own unbounded prose, and this codebase
 * already avoids handing unbounded worker/model text to a subprocess as an
 * argv element (see `cli.ts`'s `editPrBody`, which does the same for a PR
 * body over `--body-file`) rather than trusting an OS argv limit to never
 * bite the one review that mattered enough to write a long summary.
 */
export async function postReviewCheckRun(sha: string, verdict: ReviewVerdict, text: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'llamenos-fleet-checkrun-'))
  try {
    const file = join(dir, 'check-run.json')
    const summary = text.length > CHECK_RUN_SUMMARY_MAX
      ? `${text.slice(0, CHECK_RUN_SUMMARY_MAX)}\n\n… (truncated)`
      : text
    writeFileSync(file, JSON.stringify({
      name: REVIEW_JOB,
      head_sha: sha,
      status: 'completed',
      conclusion: checkRunConclusion(verdict),
      output: { title: CHECK_RUN_TITLES[verdict], summary },
    }))
    await gh(['api', `repos/${REPO}/check-runs`, '-X', 'POST', '--input', file])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Step 4 — merge readiness and the merge itself.
// ---------------------------------------------------------------------------

export type CheckBucket = 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel'
export interface RequiredCheck { name: string; state: string; bucket: CheckBucket }

/** `gh pr checks <pr> --required` — the exact set branch protection binds
 *  this PR to, already bucketed pass/fail/pending/skipping/cancel by `gh`
 *  itself. `fleet/review` (this command's own check-run, once posted) shows
 *  up in this same list like any other required check, so one call answers
 *  both "did my own review pass" and "is everything else green". */
async function readRequiredChecks(pr: string): Promise<RequiredCheck[] | undefined> {
  return ghJson<RequiredCheck[]>(['pr', 'checks', pr, '--required', '--json', 'name,state,bucket'])
}

export type MergeReadiness = { ready: true } | { ready: false; reason: string }

/**
 * Pure and exported so every fail-closed branch — head moved, checks
 * unreadable, `fleet/review` itself missing or not green, some OTHER
 * required check red — is a direct unit test with no `gh` in sight.
 */
export function evaluateMergeReadiness(input: {
  currentHeadSha: string
  reviewedHeadSha: string
  requiredChecks: RequiredCheck[] | undefined
}): MergeReadiness {
  if (input.currentHeadSha !== input.reviewedHeadSha) {
    return {
      ready: false,
      reason: `head moved from ${input.reviewedHeadSha} to ${input.currentHeadSha} since the review — ` +
        'refusing to merge a commit that was never reviewed',
    }
  }
  if (input.requiredChecks === undefined) {
    return { ready: false, reason: 'could not read this PR\'s required checks — refusing to merge on an unknown state' }
  }
  const review = input.requiredChecks.find((c) => c.name === REVIEW_JOB)
  if (review === undefined) {
    return { ready: false, reason: `${REVIEW_JOB} is not a required check on this PR — refusing to merge without it` }
  }
  if (review.bucket !== 'pass') {
    return { ready: false, reason: `${REVIEW_JOB} is not passing (state=${review.state}) — refusing to merge` }
  }
  const notGreen = input.requiredChecks.filter((c) => c.name !== REVIEW_JOB && c.bucket !== 'pass')
  if (notGreen.length > 0) {
    return {
      ready: false,
      reason: `required check(s) not green: ${notGreen.map((c) => `${c.name}=${c.bucket}`).join(', ')}`,
    }
  }
  // No separate specialist tree to consult (#1158): every reviewer a PR
  // needs runs inside the one `fleet/review` job, so its verdict above
  // already carries them. There is nothing left here that GitHub's own
  // required-context check does not already refuse on.
  return { ready: true }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export type ReviewAndMergeOutcome =
  | { kind: 'already-merged'; pr: string }
  | { kind: 'merged'; pr: string; headSha: string }
  | { kind: 'needs-codeowner'; pr: string; headSha: string; authorLogin: string }
  | { kind: 'not-mergeable'; pr: string; reason: string }

export function describeOutcome(o: ReviewAndMergeOutcome): string {
  switch (o.kind) {
    case 'already-merged': return `review-and-merge: PR ${o.pr} is already merged — nothing to do`
    case 'merged': return `review-and-merge: merged PR ${o.pr} at ${o.headSha}`
    case 'needs-codeowner':
      return `review-and-merge: PR ${o.pr} (head ${o.headSha}) is ready to merge but was opened by ` +
        `${o.authorLogin}, a bot — a human code-owner must approve it first; not merging on the operator's behalf`
    case 'not-mergeable': return `review-and-merge: PR ${o.pr} not merged — ${o.reason}`
  }
}

export interface ReviewAndMergeDeps {
  /** `undefined` on any read failure — never guessed at. */
  prState(pr: string): Promise<'OPEN' | 'MERGED' | 'CLOSED' | undefined>
  readPr(pr: string): Promise<PrSnapshotFacts | undefined>
  prDiff(pr: string): Promise<string>
  fetchReviewCheckRuns(sha: string): Promise<CheckRunInfo[] | undefined>
  /** Export + strip the head commit; caller always calls `cleanup()`. */
  exportHead(headSha: string, baseSha: string): Promise<ReviewSnapshot>
  invokeReviewer(pr: string, diff: string, facts: PrSnapshotFacts, exportDir: string): Promise<SecondOpinionResult>
  postCheckRun(sha: string, verdict: ReviewVerdict, text: string): Promise<void>
  currentHeadSha(pr: string): Promise<string | undefined>
  requiredChecks(pr: string): Promise<RequiredCheck[] | undefined>
  merge(pr: string): Promise<void>
  log(msg: string): void
}

/**
 * The whole command, steps 1–4 of the module comment above, as one function
 * over injected deps. Every early return is a fail-closed refusal with a
 * stated reason — there is no path here that merges on a guess.
 *
 * Idempotent on an unchanged head by construction, not by a special case:
 * a PR already `MERGED` returns immediately (no review, no merge attempt —
 * the very first check below), and a PR whose head already carries a
 * successful `fleet/review` check-run (step 1) skips straight to the
 * readiness check in step 4 without invoking the engine again. Running this
 * command twice in a row against the same head therefore costs, at most, one
 * extra `gh` read on the second call — never a second review and never a
 * second merge attempt.
 */
export async function runReviewAndMerge(pr: string, deps: ReviewAndMergeDeps): Promise<ReviewAndMergeOutcome> {
  const state = await deps.prState(pr)
  if (state === 'MERGED') {
    deps.log(`review-and-merge: PR ${pr} is already merged — nothing to do`)
    return { kind: 'already-merged', pr }
  }
  if (state === undefined) return { kind: 'not-mergeable', pr, reason: `could not read PR ${pr}'s state` }
  if (state === 'CLOSED') return { kind: 'not-mergeable', pr, reason: `PR ${pr} is closed, not merged` }

  const facts = await deps.readPr(pr)
  if (facts === undefined) return { kind: 'not-mergeable', pr, reason: `could not read PR ${pr}` }

  const cachedCheckRuns = await deps.fetchReviewCheckRuns(facts.headSha)
  if (hasSuccessfulReview(cachedCheckRuns)) {
    deps.log(
      `review-and-merge: PR ${pr} head ${facts.headSha} already carries a successful ${REVIEW_JOB} ` +
      'check-run — reusing it, no new review',
    )
  } else {
    const diff = await deps.prDiff(pr)
    const snapshot = await deps.exportHead(facts.headSha, facts.baseSha)
    let result: SecondOpinionResult
    try {
      result = await deps.invokeReviewer(pr, diff, facts, snapshot.dir)
    } finally {
      await snapshot.cleanup()
    }
    await deps.postCheckRun(facts.headSha, result.verdict, result.text)
    deps.log(`review-and-merge: posted ${REVIEW_JOB}=${checkRunConclusion(result.verdict)} for PR ${pr} head ${facts.headSha}`)
    if (result.verdict !== 'PASS') {
      return {
        kind: 'not-mergeable', pr,
        reason: `non-author review verdict was ${result.verdict} for PR ${pr} — see the ${REVIEW_JOB} check`,
      }
    }
  }

  const currentHead = await deps.currentHeadSha(pr)
  if (currentHead === undefined) return { kind: 'not-mergeable', pr, reason: `could not re-read PR ${pr}'s current head` }

  const requiredChecksNow = await deps.requiredChecks(pr)
  const readiness = evaluateMergeReadiness({
    currentHeadSha: currentHead, reviewedHeadSha: facts.headSha, requiredChecks: requiredChecksNow,
  })
  if (!readiness.ready) return { kind: 'not-mergeable', pr, reason: readiness.reason }

  // Reached only once every required check, including our own fresh
  // `fleet/review`, is green on an unmoved head. A bot-authored PR (the
  // fleet's own workers) still needs a human code-owner's approval —
  // CODEOWNERS forbids self-approval, and this command never approves a PR
  // on the operator's behalf, so it stops here rather than attempting (and
  // having GitHub reject) the merge.
  if (facts.authorIsBot) {
    return { kind: 'needs-codeowner', pr, headSha: facts.headSha, authorLogin: facts.authorLogin }
  }

  await deps.merge(pr)
  deps.log(`review-and-merge: merged PR ${pr} at head ${facts.headSha}`)
  return { kind: 'merged', pr, headSha: facts.headSha }
}

/** The real, non-test wiring — one `gh`/`git` call per `ReviewAndMergeDeps`
 *  method, nothing more. `repoRoot` is the trusted checkout `git fetch` and
 *  `git archive` run in — the CLI passes its own `REPO_ROOT`. */
export function defaultReviewAndMergeDeps(repoRoot: string, log: (msg: string) => void): ReviewAndMergeDeps {
  return {
    prState: async (pr) => (await ghJson<{ state: 'OPEN' | 'MERGED' | 'CLOSED' }>(['pr', 'view', pr, '--json', 'state']))?.state,
    readPr: readPrSnapshotFacts,
    prDiff: (pr) => gh(['pr', 'diff', pr]),
    fetchReviewCheckRuns,
    exportHead: (headSha, baseSha) => fetchAndExportHead(repoRoot, headSha, baseSha),
    invokeReviewer: runNonAuthorReview,
    postCheckRun: postReviewCheckRun,
    currentHeadSha: async (pr) => (await ghJson<{ headRefOid: string }>(['pr', 'view', pr, '--json', 'headRefOid']))?.headRefOid,
    requiredChecks: readRequiredChecks,
    // The one merge call in this file — a REAL squash merge, not the
    // fleet's own `enableAutoMerge` (cli.ts), which only ever ARMS
    // auto-merge for GitHub to complete later. This command is the
    // operator's own explicit act, run by hand against one named PR, gated
    // by everything above — never the autonomous tick loop, which still
    // never merges anything itself.
    merge: async (pr) => { await gh(['pr', 'merge', pr, '--squash', '--delete-branch']) },
    log,
  }
}
