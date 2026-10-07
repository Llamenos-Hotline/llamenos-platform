import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { REPO, gh, ghJson } from './gh.js'
import {
  GITHUB_API, appApiRequest, checkVerdictRecorder, describeRecorderFailure, fetchAppHttp,
  githubErrorDetail, mintInstallationToken, VerdictRecorderError,
  type AppHttp, type RecorderReadiness,
} from './github-app.js'
import {
  composeReviewSet, decideReviewSet, reviewTriggerLogins, GENERAL_REVIEWER, REVIEW_JOB,
  REVIEW_REQUEST_LOGIN, type ReviewSetDecision,
} from './ci.js'
import {
  buildProfileReviewPrompt, resolveReviewerLabel, AGENT_REGISTRY_DIR,
  type ReviewerProfile, type ReviewerResolution,
} from './specialist.js'
import { classifyImpact } from './impact.js'
import type { VerifyReport } from './verify.js'
import {
  buildReviewPrompt, exportReviewSnapshot, invokeVerifierEngine, reviewPrimaryEngine, toSecondOpinion,
  DEFAULT_MAX_TURNS, HIGH_IMPACT_MAX_TURNS, DEFAULT_TIMEOUT_MS, HIGH_IMPACT_TIMEOUT_MS,
  type ReviewRunEngine, type SecondOpinionResult, type ReviewSnapshot,
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
 * The engine this command's reviewers run on — KIMI, and resolved through
 * `reviewPrimaryEngine()` (review.ts) rather than named as a literal here,
 * so this command and the CI gate cannot disagree about which engine
 * produces a `fleet/review` verdict. Both post the SAME check-run name
 * against the same commit; two independent engine decisions would mean the
 * check means one thing when CI produced it and another when the operator
 * did.
 *
 * #1637 moved this command OFF `claude`-with-an-`opus`-override as its
 * engine, which is what `REVIEW_AND_MERGE_FALLBACK_MODEL` below used to be
 * the whole story of. It is still a function and not a constant on purpose:
 * `FLEET_REVIEW_PRIMARY=claude` remains the operator dial, and it is the
 * dial that makes the non-authorship argument below hold on a kimi-authored
 * lane. Hard-pinning kimi here would read as stricter and would in fact
 * REMOVE the one mitigation for the only case where the reviewer and the
 * author share a vendor.
 *
 * ### How non-authorship is guaranteed once the reviewer is kimi
 *
 * Non-authorship was never a property of the model NAME, and it must not
 * become one now that the name can coincide with a lane's own:
 *
 *   - **Session independence, unconditional.** The reviewer is a separate
 *     process in a separate session with no shared context: it never sees
 *     the author's reasoning, its scratch state, its tool transcript, or
 *     its worktree. What it is handed is the PR's diff plus a `.git`-less,
 *     control-file-stripped read-only export of the head commit
 *     (`exportReviewSnapshot`, `stripReviewerControlFiles`) — the same
 *     export the CI gate hands its reviewers — under a tool profile with no
 *     shell and no edit tool (`REVIEWER_TOOLS`,
 *     `reviewer-readonly.agent.md`). A reviewer that cannot write cannot
 *     launder its own diff into a pass.
 *   - **Vendor independence, conditional — and stated as conditional.**
 *     This fleet's default authoring engine is claude at `cli.ts`'s
 *     `DEFAULT_MODEL` (`'sonnet'`), so on a default lane a kimi reviewer is
 *     a different vendor as well as a different session. A lane configured
 *     `engine: opencode` with a kimi model (`config.ts`) authors on the same
 *     vendor the reviewer now runs, and on THAT lane vendor independence is
 *     simply not available from this code — exactly as review.ts's comment
 *     above `verifierFor` already says of the gate. The honest mitigations
 *     are operational and both still exist: `FLEET_REVIEW_PRIMARY=claude`
 *     moves this command's reviewer to the other vendor outright, and
 *     `FLEET_REVIEW_KIMI_MODEL` separates the TIER within kimi. Neither is
 *     claimed here as automatic.
 *
 * The kimi reviewer takes no model id from this file: `kimiArgs` passes
 * `FLEET_REVIEW_KIMI_MODEL` when set and otherwise no `--model` at all, so
 * kimi resolves its own configured `default_model`. That is deliberate —
 * #891's finding was that a silently-defaulted provider/model id goes stale
 * under everyone's feet and then fails as something that reads like an
 * outage (the fleet's opencode provider id has been renamed twice; the
 * current one is `kimi-code-plan-global`, and the retired `kimi-for-coding`
 * fails as a fake "server error" rather than as a rejected id). Nothing in
 * this file invents one.
 */
export function reviewAndMergeEngine(): ReviewRunEngine {
  return reviewPrimaryEngine()
}

/**
 * The CLAUDE tier used only when claude actually runs here — as the
 * fallback arm after a kimi cannot-run failure, or under
 * `FLEET_REVIEW_PRIMARY=claude`. Deliberately NOT `cli.ts`'s `DEFAULT_MODEL`
 * (`'sonnet'`, what a dispatched worker authors with): on the claude arm an
 * author-tier model would review a diff with the same model family and
 * rough capability that wrote it, which is exactly the "a model reviewing
 * its own output shares its own blind spots" problem `VERIFIER_BRIEF`
 * (review.ts) opens with. `opus` is the heavier tier this fleet already
 * reserves for its other highest-stakes single-shot calls (the Planner role,
 * `cli.ts`'s `PLANNER_MODEL`) — never a guess at a new tier this codebase
 * has not already trusted with a one-shot, no-edit review.
 *
 * It is passed on EVERY invocation, kimi-primary included, because
 * `invokeVerifierEngine` consumes it only on whichever arm runs claude:
 * leaving it off would silently hand the fallback arm the authoring tier,
 * which is the quiet lapse #1637 was told not to let happen.
 */
export const REVIEW_AND_MERGE_FALLBACK_MODEL = 'opus'

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
 * One reviewer invocation, shared by the general reviewer and every profile
 * so neither can drift into a weaker posture than the other: the same
 * `invokeVerifierEngine` (review.ts), the same engine resolution
 * (`reviewAndMergeEngine`), the same read-only permission mode, env
 * allowlist and empty-project-root isolation every other reviewer
 * invocation in this fleet gets, and the same `toSecondOpinion` mapping from
 * raw engine run to PASS/FAIL/UNREADABLE. Only the PROMPT differs between
 * them — which is the only thing that should.
 */
async function invokeOneReviewer(
  pr: string,
  prompt: string,
  report: VerifyReport,
  exportDir: string,
  highImpact: boolean,
): Promise<SecondOpinionResult> {
  const run = await invokeVerifierEngine({
    // Consumed only on whichever arm runs claude (see
    // `REVIEW_AND_MERGE_FALLBACK_MODEL`); the kimi arm resolves its own
    // model and never receives a claude tier.
    authorEngine: 'claude',
    model: REVIEW_AND_MERGE_FALLBACK_MODEL,
    exportDir,
    prompt,
    // So an exhausted budget here salvages a partial verdict too, rather
    // than this operator command being the one reviewer path that still
    // loses everything its session concluded (review.ts's
    // `salvagePartialVerdict` needs the changed-file list to ask "which of
    // these did you not reach"). This command exports only the PR head, so
    // it passes no `baseDir` and gets the single-tree prompt.
    pr,
    changedFiles: report.changedFiles,
    maxTurns: highImpact ? HIGH_IMPACT_MAX_TURNS : DEFAULT_MAX_TURNS,
    timeoutMs: highImpact ? HIGH_IMPACT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
  })
  return toSecondOpinion(run)
}

/**
 * The general non-author review: `buildReviewPrompt` (review.ts) builds the
 * exact prompt `secondOpinion` would. Mandatory for every diff — it is
 * never in `ReviewSetDecision.profiles` and no label or path can add or
 * remove it.
 */
async function runNonAuthorReview(
  pr: string,
  diff: string,
  facts: PrSnapshotFacts,
  exportDir: string,
): Promise<SecondOpinionResult> {
  const report = reportForPrompt(facts)
  return invokeOneReviewer(pr, buildReviewPrompt(pr, diff, report, exportDir), report, exportDir, report.impact === 'high')
}

/**
 * ONE reviewer PROFILE (#1637) — `crypto-security-reviewer` and anything
 * else `decideReviewSet` puts in the set, by label or by the diff's own
 * content. Its prompt is `buildProfileReviewPrompt` (specialist.ts): the
 * agent definition's own instructions, read from the TRUSTED local
 * checkout's `.claude/agents/` and never from the export (which has
 * `.claude/` stripped), followed by the same read-only and verdict contract
 * the general reviewer gets.
 *
 * A profile always gets the HIGH-IMPACT budget, exactly as the CI gate's
 * `profileReview` does (`cli.ts`): something asked for this reviewer by
 * name — a human's label or the PR's own crypto content — so its session is
 * never the one cut short for a diff nobody flagged.
 */
async function runProfileReview(
  profile: ReviewerProfile,
  pr: string,
  diff: string,
  facts: PrSnapshotFacts,
  exportDir: string,
): Promise<SecondOpinionResult> {
  const report = reportForPrompt(facts)
  const prompt = buildProfileReviewPrompt(profile, pr, diff, report.changedFiles, exportDir)
  return invokeOneReviewer(pr, prompt, report, exportDir, true)
}

/**
 * The required profiles that are NOT covered by the profiles actually
 * resolved and about to run — empty when the run is complete.
 *
 * Exported and pure because it is the last line of defence on the property
 * this whole command rests on: the `fleet/review` it posts must be the
 * verdict of the WHOLE set the PR requires, never a narrower one wearing
 * the same name. `decideReviewSet` says what is required and
 * `resolveReviewerLabel` says what can run; this compares the two by NAME
 * rather than by count, so a resolution that quietly answered with a
 * different agent than the one asked for is caught as an uncovered
 * requirement instead of passing a length check.
 */
export function uncoveredProfiles(
  required: readonly string[],
  resolved: readonly ReviewerProfile[],
): string[] {
  const running = new Set(resolved.map((p) => p.agent))
  return required.filter((name) => !running.has(name))
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

/**
 * Whether this PR was opened by the FLEET rather than by a human making a
 * decision — the condition under which this command stops short of merging
 * and asks for a human code-owner instead.
 *
 * GitHub's `author.is_bot` alone is NOT that test, and #1637's live run
 * against PR #1546 proved it by breaking the stop: every PR the fleet's own
 * workers open is authored by `llamenos-auto` (`REVIEW_REQUEST_LOGIN`,
 * ci.ts), which is a real GitHub USER account — a second write identity, not
 * a GitHub App — so `gh pr view --json author` answers
 * `{"login":"llamenos-auto","is_bot":false}` and the `is_bot` branch never
 * fired. The guard read as "the fleet never merges its own work unapproved"
 * and in fact covered only App-authored PRs, of which the fleet opens none.
 *
 * `is_bot` is KEPT alongside the login check rather than replaced by it:
 * dependabot and any future App-authored PR are genuinely non-human and must
 * stop here too, and matching on a login list alone would silently let a new
 * App through.
 *
 * Matched on AUTHOR, never on branch name — a `fleet/...` branch name is a
 * convention anyone with push access can imitate, and `REVIEW_SKIP_AUTHORS`
 * (ci.ts) already records why keying this class of decision on a branch
 * hands out a free bypass. Logins are case-insensitive on GitHub, so the
 * comparison is too.
 */
export function authorNeedsHumanApproval(facts: Pick<PrSnapshotFacts, 'authorLogin' | 'authorIsBot'>): boolean {
  return facts.authorIsBot || facts.authorLogin.trim().toLowerCase() === REVIEW_REQUEST_LOGIN
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
  /** #1637 — the PR requires a reviewer the command cannot RUN (an agent
   *  definition that is missing, malformed, or unreadable in the local
   *  checkout). Caught BEFORE anything is spent and BEFORE anything is
   *  posted: a narrower verdict wearing the `fleet/review` name is the one
   *  shape this command must never produce, so it refuses instead. */
  | { kind: 'review-set-unrunnable'; pr: string; reason: string }

export function describeOutcome(o: ReviewAndMergeOutcome): string {
  switch (o.kind) {
    case 'already-merged': return `review-and-merge: PR ${o.pr} is already merged — nothing to do`
    case 'merged': return `review-and-merge: merged PR ${o.pr} at ${o.headSha}`
    case 'needs-codeowner':
      return `review-and-merge: PR ${o.pr} (head ${o.headSha}) is ready to merge but was opened by ` +
        `${o.authorLogin} — the fleet, not a human making a decision. A human code-owner must approve it ` +
        'first; not merging on the operator\'s behalf'
    case 'not-mergeable': return `review-and-merge: PR ${o.pr} not merged — ${o.reason}`
    case 'cannot-record':
      return `review-and-merge: PR ${o.pr} NOT reviewed and NOT merged — this command cannot record a ` +
        `${REVIEW_JOB} verdict, so it refused before spending a review: ${o.reason}. ` +
        'Nothing was posted. Use the CI gate (request a review on the PR) until the GitHub App exists — see issue #1483'
    case 'review-set-unrunnable':
      return `review-and-merge: PR ${o.pr} NOT reviewed and NOT merged — ${o.reason}. Nothing was posted: ` +
        `this command will not post a ${REVIEW_JOB} for a narrower review set than the PR requires`
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
  /** The MANDATORY general non-author review — in every set, never a
   *  profile, never skippable. */
  invokeReviewer(pr: string, diff: string, facts: PrSnapshotFacts, exportDir: string): Promise<SecondOpinionResult>
  /** #1637 — resolves one profile NAME from the review set to a runnable
   *  agent definition, or refuses with a reason. The SAME
   *  `resolveReviewerLabel` the CI gate resolves with, against the same
   *  trusted-checkout registry. */
  resolveProfile(name: string): Promise<ReviewerResolution>
  /** #1637 — runs ONE resolved profile, read-only, against the same export
   *  the general reviewer reads. */
  invokeProfileReviewer(
    profile: ReviewerProfile, pr: string, diff: string, facts: PrSnapshotFacts, exportDir: string,
  ): Promise<SecondOpinionResult>
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
  // check: it runs the reviewers itself and posts the verdict itself. Under
  // #1092 a narrower run was held back by the specialists' own
  // `fleet/review/<agent>` contexts, which `evaluateMergeReadiness` refused
  // on. Those contexts are gone (#1158) — every reviewer runs inside the one
  // check — so nothing in the PLATFORM would stop this command posting a
  // GREEN `fleet/review` on a crypto PR after running only the general
  // review. What stops it is this file.
  //
  // Until #1637 the answer was a blanket refusal on any PR with a profile in
  // its set, with the advice "request a review and let the CI gate run the
  // whole set". That advice turned out to name an impossible act: when the
  // required reviewer is a CODEOWNER of a path the PR touches, GitHub
  // re-adds the request the instant it is removed, so no `review_requested`
  // event is ever emitted and nothing starts (#1471) — and `synchronize` is
  // structurally forbidden from reviewing (`republishOnly`, ci.ts). A PR in
  // that state had no route back to green at all.
  //
  // So the command runs the WHOLE set instead: the general reviewer plus
  // every profile `decideReviewSet` names — the SAME decision function the
  // CI gate calls, deciding from the PR's `-reviewer` labels AND from the
  // diff itself, so a crypto diff gets the crypto review whether or not
  // anybody labelled it. The refusal is not deleted; it MOVES to the one
  // honest trigger for it (a reviewer that cannot be run at all), because a
  // `fleet/review` narrower than it claims is still the worst outcome
  // available here.
  const reviewSet = await deps.reviewSet(pr, facts.changedFiles)
  if (!reviewSet.ok) {
    return { kind: 'not-mergeable', pr, reason: `could not work out which reviews PR ${pr} needs: ${reviewSet.reason}` }
  }
  const profiles: ReviewerProfile[] = []
  for (const name of reviewSet.profiles) {
    const resolved = await deps.resolveProfile(name)
    if (!resolved.ok) {
      return {
        kind: 'review-set-unrunnable', pr,
        reason: `PR ${pr} requires the "${name}" review and it cannot be run: ${resolved.reason}`,
      }
    }
    profiles.push(resolved.profile)
  }
  // Belt AND braces on the one property that matters: compare the set that
  // will RUN against the set that is REQUIRED, by name. `resolveProfile`
  // answering with some other agent, or a future edit dropping a profile
  // between resolution and invocation, is an uncovered requirement here
  // rather than a silently narrower verdict later.
  const uncovered = uncoveredProfiles(reviewSet.profiles, profiles)
  if (uncovered.length > 0) {
    return {
      kind: 'review-set-unrunnable', pr,
      reason: `PR ${pr} requires ${uncovered.join(', ')} and this command did not resolve a reviewer for ` +
        // Whom to ask depends on who wrote the PR: GitHub refuses to request
        // a PR's own author, so naming one fixed login here sent every PR
        // `llamenos-auto` wrote to a request that cannot be made (#1232).
        `${uncovered.length === 1 ? 'it' : 'them'}. Ask ` +
        `${reviewTriggerLogins({ prAuthor: facts.authorLogin, branch: facts.headBranch })[0]} to review it by hand`,
    }
  }

  // A green `fleet/review` on this SHA is a WHOLE-SET green, and nothing
  // extra is needed here to make that true. A check-run carries no review-set
  // tag — unlike the gate's per-diff cache, which `reviewSetTag` namespaces —
  // so this reuse would be unsound if any producer could post a green
  // `fleet/review` for a narrower set than the PR requires. Neither can:
  // `runReviewCi` runs the whole set, this command now runs the whole set,
  // and the version of this command that did NOT refused every
  // profile-bearing PR outright rather than posting one.
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
    // The whole set, CONCURRENTLY, against the one export — exactly the
    // shape `runReviewCi` uses (ci.ts). `Promise.allSettled` deliberately:
    // one reviewer throwing must not discard the verdicts of the others,
    // and a thrown reviewer is recorded as its own UNREADABLE rather than
    // as an opaque crash of the command.
    const names = [GENERAL_REVIEWER, ...profiles.map((p) => p.agent)]
    let composed: ReturnType<typeof composeReviewSet>
    try {
      composed = composeReviewSet(names, await Promise.allSettled([
        deps.invokeReviewer(pr, diff, facts, snapshot.dir),
        ...profiles.map((p) => deps.invokeProfileReviewer(p, pr, diff, facts, snapshot.dir)),
      ]))
    } finally {
      await snapshot.cleanup()
    }
    // The engine is NAMED in the log, not just in a doc comment: which
    // engine earned a verdict is the first thing an operator needs when a
    // review reads oddly, and `reviewAndMergeEngine` resolves a dial
    // (`FLEET_REVIEW_PRIMARY`) rather than a constant — so "it was kimi" is
    // a fact to record per run, never an assumption.
    deps.log(
      `review-and-merge: PR ${pr} review set on ${reviewAndMergeEngine()} — ${names.join(', ')} ` +
      `(${composed.results.map((r) => `${r.name}: ${r.verdict}`).join(', ')})`,
    )
    // `composeReviewSet` (ci.ts) is the SAME composition the CI gate
    // applies: ANY FAIL FAILS, and an UNREADABLE is a failure too, so a
    // profile's verdict can never be outranked by the general reviewer's
    // PASS. One implementation, because two producers of the same check-run
    // name composing differently would be a verdict that means one thing
    // from CI and another from here.
    try {
      await deps.postCheckRun(facts.headSha, composed.verdict, composed.summary)
    } catch (e) {
      // The verdict existed and is now unrecorded. Said plainly, with a
      // non-zero exit, and never as "posted" — the log line below is
      // reached only on a real 201.
      return {
        kind: 'review-unrecorded', pr, headSha: facts.headSha, verdict: composed.verdict,
        reason: describeRecorderFailure(e),
      }
    }
    deps.log(`review-and-merge: posted ${REVIEW_JOB}=${checkRunConclusion(composed.verdict)} for PR ${pr} head ${facts.headSha}`)
    if (composed.verdict !== 'PASS') {
      return {
        kind: 'not-mergeable', pr,
        reason: `non-author review verdict was ${composed.verdict} (${composed.result}) for PR ${pr} — ` +
          `see the ${REVIEW_JOB} check`,
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
  // `fleet/review`, is green on an unmoved head. A PR the FLEET opened still
  // needs a human code-owner's approval — CODEOWNERS forbids self-approval,
  // and this command never approves a PR on the operator's behalf, so it
  // stops here rather than attempting (and having GitHub reject) the merge.
  // See `authorNeedsHumanApproval` for why `is_bot` alone did not express
  // that, and for the live run that found it.
  if (authorNeedsHumanApproval(facts)) {
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
    // The SAME resolver the CI gate uses, against the SAME registry
    // directory, read from the local trusted checkout — never the export
    // (which has `.claude/` stripped, `REVIEWER_CONTROL_NAMES`). A PR that
    // ADDS a reviewer profile therefore cannot use it until that definition
    // has merged, here exactly as in CI.
    resolveProfile: (name) => resolveReviewerLabel(name, join(repoRoot, AGENT_REGISTRY_DIR)),
    invokeProfileReviewer: runProfileReview,
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
