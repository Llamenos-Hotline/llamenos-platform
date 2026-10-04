import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { REPO, gh, ghJson } from './gh.js'
import {
  GITHUB_API, appApiRequest, checkVerdictRecorder, describeRecorderFailure, fetchAppHttp,
  githubErrorDetail, mintInstallationToken, VerdictRecorderError,
  type AppHttp, type RecorderReadiness,
} from './github-app.js'
import { decideReviewSet, reviewTriggerLogins, REVIEW_JOB, type ReviewSetDecision } from './ci.js'
import { resolveReviewerLabel, AGENT_REGISTRY_DIR } from './specialist.js'
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
 * real network/process calls this needs — read the PR, export its head, run
 * the reviewer, check that a verdict CAN be recorded, record it, merge — are
 * exercised in tests as plain mocks, exactly like every other CI-adjacent
 * file in this orchestrator (`ci.ts`, `review.ts`).
 *
 * #1483 — one of those calls cannot use the operator's `gh` credentials at
 * all. The Checks API refuses a personal access token
 * (`You must authenticate via a GitHub App. (HTTP 403)`), so the verdict is
 * posted with a short-lived GitHub App installation token minted per
 * invocation by `github-app.ts`. Nothing else here uses it. Until that App
 * exists this command fails CLOSED — it refuses before spending a review
 * (`cannot-record`), or, if the post fails after one ran, says plainly that
 * the verdict is lost (`review-unrecorded`) and exits non-zero. There is no
 * PAT fallback, and `POST …/statuses` on a commit — which a PAT *would* accept — is
 * rejected permanently, because a PAT-written green status could override a
 * red check run and a review gate must fail closed.
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
  /** The head branch — with the author, it decides whom a review may be
   *  requested from (`reviewTriggerLogins`). */
  headBranch: string
}

interface GhPrViewForReview {
  headRefOid: string
  baseRefOid: string
  headRefName: string
  files: { path: string; additions: number; deletions: number }[]
  author: { login: string; is_bot?: boolean }
}

async function readPrSnapshotFacts(pr: string): Promise<PrSnapshotFacts | undefined> {
  const view = await ghJson<GhPrViewForReview>(['pr', 'view', pr, '--json', 'headRefOid,baseRefOid,headRefName,files,author'])
  if (view === undefined) return undefined
  return {
    headSha: view.headRefOid,
    baseSha: view.baseRefOid,
    changedFiles: view.files.map((f) => f.path),
    addedLines: view.files.reduce((n, f) => n + f.additions, 0),
    authorLogin: view.author.login,
    authorIsBot: view.author.is_bot === true,
    headBranch: view.headRefName,
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

export interface PostCheckRunOptions {
  /** Injected in tests; production mints per invocation and keeps no copy. */
  mintToken?: () => Promise<string>
  http?: AppHttp
}

/**
 * The ONLY place in `orchestrator/src` that creates a check run — see the
 * "created in exactly one file" rail in guards.test.ts, which this change
 * keeps true: `github-app.ts` holds the AUTH (JWT + installation token) and
 * never touches this endpoint, so there is still exactly one place this
 * process can post a verdict.
 *
 * #1483 — this is the one call in the whole orchestrator that cannot use the
 * operator's own `gh` credentials. The Checks API refuses a personal access
 * token outright (`You must authenticate via a GitHub App. (HTTP 403)`), so
 * the verdict is posted with a short-lived installation token minted here and
 * used for nothing else. Reading the PR, exporting its head and merging all
 * keep using the operator's own `gh`.
 *
 * Posted in-process over `fetch`, not `gh api --input <file>`. The temp-file
 * form existed because `output.summary` is the reviewer's own unbounded prose
 * and this codebase does not hand unbounded model text to a subprocess as an
 * argv element — in-process there is no argv and no temp file at all, which
 * satisfies that constraint more completely, and it also keeps the
 * installation token out of any subprocess's environment or command line.
 *
 * Throws on every failure, never returns quietly: `runReviewAndMerge` turns a
 * throw here into the `review-unrecorded` outcome, which says plainly that a
 * review ran and could not be recorded. There is no PAT fallback and no
 * commit-status path — see `github-app.ts` for why that shortcut is rejected
 * permanently.
 */
export async function postReviewCheckRun(
  sha: string,
  verdict: ReviewVerdict,
  text: string,
  opts: PostCheckRunOptions = {},
): Promise<void> {
  const summary = text.length > CHECK_RUN_SUMMARY_MAX
    ? `${text.slice(0, CHECK_RUN_SUMMARY_MAX)}\n\n… (truncated)`
    : text
  const body = JSON.stringify({
    name: REVIEW_JOB,
    head_sha: sha,
    status: 'completed',
    conclusion: checkRunConclusion(verdict),
    output: { title: CHECK_RUN_TITLES[verdict], summary },
  })
  const token = await (opts.mintToken ?? mintInstallationToken)()
  const what = `recording the ${REVIEW_JOB} verdict for ${sha}`
  const res = await appApiRequest(opts.http ?? fetchAppHttp, {
    method: 'POST',
    url: `${GITHUB_API}/repos/${REPO}/check-runs`,
    authorization: `token ${token}`,
    body,
  }, [token], what)
  if (res.status !== 201) {
    throw new VerdictRecorderError(
      `${what} failed: HTTP ${res.status} — ${githubErrorDetail(res.body, [token])}`,
      [token],
    )
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
  /** #1483 — the App credentials that record a verdict are absent or
   *  unusable. Caught BEFORE the reviewer runs, so nothing was spent and
   *  nothing was posted. */
  | { kind: 'cannot-record'; pr: string; reason: string }
  /** #1483 — the review RAN and its verdict could not be written to GitHub.
   *  The one outcome this command must never render as a success: a verdict
   *  that is quietly lost is worse than the 403 it replaced, which at least
   *  shouted. */
  | { kind: 'review-unrecorded'; pr: string; headSha: string; verdict: ReviewVerdict; reason: string }

export function describeOutcome(o: ReviewAndMergeOutcome): string {
  switch (o.kind) {
    case 'already-merged': return `review-and-merge: PR ${o.pr} is already merged — nothing to do`
    case 'merged': return `review-and-merge: merged PR ${o.pr} at ${o.headSha}`
    case 'needs-codeowner':
      return `review-and-merge: PR ${o.pr} (head ${o.headSha}) is ready to merge but was opened by ` +
        `${o.authorLogin}, a bot — a human code-owner must approve it first; not merging on the operator's behalf`
    case 'not-mergeable': return `review-and-merge: PR ${o.pr} not merged — ${o.reason}`
    case 'cannot-record':
      return `review-and-merge: PR ${o.pr} NOT reviewed and NOT merged — this command cannot record a ` +
        `${REVIEW_JOB} verdict, so it refused before spending a review: ${o.reason}. ` +
        'Nothing was posted. Use the CI gate (request a review on the PR) until the GitHub App exists — see issue #1483'
    case 'review-unrecorded':
      return `review-and-merge: PR ${o.pr} — a non-author review RAN on head ${o.headSha} and reached ` +
        `${o.verdict}, but it could NOT be recorded as the ${REVIEW_JOB} check run: ${o.reason}. ` +
        'That verdict is LOST — nothing was posted and nothing was merged. Fix the GitHub App ' +
        'credentials (issue #1483) and run this again'
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
  /** #1483 — can this process record a verdict at all? Local-only (no
   *  network, no token minted) so a missing App credential costs a
   *  millisecond rather than a whole `opus` review. */
  recorderReady(): Promise<RecorderReadiness>
  /** Throws on every failure — there is no "posted it, probably" return. */
  postCheckRun(sha: string, verdict: ReviewVerdict, text: string): Promise<void>
  currentHeadSha(pr: string): Promise<string | undefined>
  requiredChecks(pr: string): Promise<RequiredCheck[] | undefined>
  /** #1158 — the reviews this PR needs, so the command can refuse rather
   *  than post a `fleet/review` for a set it does not actually run. */
  reviewSet(pr: string, changedFiles: readonly string[]): Promise<ReviewSetDecision>
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

  // This command is an INDEPENDENT producer of the required `fleet/review`
  // check: it runs one reviewer (`invokeReviewer`, the general non-author
  // one) and posts the verdict itself. Under #1092 that was safe, because
  // the specialists had their own `fleet/review/<agent>` contexts and
  // `evaluateMergeReadiness` refused on any of them that had not passed.
  // Those contexts are gone (#1158) — every reviewer now runs inside the
  // CI job — so nothing here would stop this command posting a GREEN
  // `fleet/review` on a crypto PR after running only the general review.
  //
  // It refuses instead. Expanding it to run the whole set is a real
  // feature, not a patch, and until it exists "use the CI gate" is the
  // honest answer rather than a weaker verdict wearing the same name.
  const reviewSet = await deps.reviewSet(pr, facts.changedFiles)
  if (!reviewSet.ok) {
    return { kind: 'not-mergeable', pr, reason: `could not work out which reviews PR ${pr} needs: ${reviewSet.reason}` }
  }
  if (reviewSet.profiles.length > 0) {
    return {
      kind: 'not-mergeable', pr,
      reason: `PR ${pr} needs ${reviewSet.profiles.join(', ')} as well as the general non-author review, and this ` +
        `command only runs the general one — it will not post a ${REVIEW_JOB} that claims otherwise. ` +
        // Whom to ask depends on who wrote the PR: GitHub refuses to request
        // a PR's own author, so naming one fixed login here sent every PR
        // `llamenos-auto` wrote to a request that cannot be made (#1232).
        `Request a review from ${reviewTriggerLogins({ prAuthor: facts.authorLogin, branch: facts.headBranch })[0]} ` +
        'and let the CI gate run the whole set.',
    }
  }

  const cachedCheckRuns = await deps.fetchReviewCheckRuns(facts.headSha)
  if (hasSuccessfulReview(cachedCheckRuns)) {
    deps.log(
      `review-and-merge: PR ${pr} head ${facts.headSha} already carries a successful ${REVIEW_JOB} ` +
      'check-run — reusing it, no new review',
    )
  } else {
    // #1483 — refuse BEFORE the review, not after. The Checks API will not
    // accept the operator's PAT, so without working App credentials this
    // command would perform a full `opus` review and then have nowhere to
    // put the answer. Checked only on this branch: the freshness-hit path
    // above posts nothing and so needs no recorder.
    const recorder = await deps.recorderReady()
    if (!recorder.ok) return { kind: 'cannot-record', pr, reason: recorder.reason }

    const diff = await deps.prDiff(pr)
    const snapshot = await deps.exportHead(facts.headSha, facts.baseSha)
    let result: SecondOpinionResult
    try {
      result = await deps.invokeReviewer(pr, diff, facts, snapshot.dir)
    } finally {
      await snapshot.cleanup()
    }
    try {
      await deps.postCheckRun(facts.headSha, result.verdict, result.text)
    } catch (e) {
      // The verdict existed and is now unrecorded. Said plainly, with a
      // non-zero exit, and never as "posted" — the log line below is
      // reached only on a real 201.
      return {
        kind: 'review-unrecorded', pr, headSha: facts.headSha, verdict: result.verdict,
        reason: describeRecorderFailure(e),
      }
    }
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
    recorderReady: async () => checkVerdictRecorder(),
    postCheckRun: (sha, verdict, text) => postReviewCheckRun(sha, verdict, text),
    currentHeadSha: async (pr) => (await ghJson<{ headRefOid: string }>(['pr', 'view', pr, '--json', 'headRefOid']))?.headRefOid,
    requiredChecks: readRequiredChecks,
    reviewSet: async (pr, changedFiles) => {
      const view = await ghJson<{ labels: { name: string }[]; title: string; body: string | null }>(
        ['pr', 'view', pr, '--json', 'labels,title,body'],
      )
      return decideReviewSet({
        labels: view?.labels.map((l) => l.name),
        changedFiles,
        description: `${view?.title ?? ''}\n\n${view?.body ?? ''}`,
        resolve: (name) => resolveReviewerLabel(name, join(repoRoot, AGENT_REGISTRY_DIR)),
      })
    },
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
