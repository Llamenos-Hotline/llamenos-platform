import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Lane } from './config.js'
import type { VerifyInput, VerifyReport } from './verify.js'
import { changedFilesFrom } from './verify.js'
import { finalLine, type SecondOpinionInput, type SecondOpinionResult } from './review.js'
import { diffHash, type CachedVerdict, type ReviewCache, type ReviewCacheKey } from './review-cache.js'
import { join } from 'node:path'
import { buildGateTrace } from './trace.js'
import { tierFor, type ImpactTier } from './impact.js'

const execFileAsync = promisify(execFile)

/**
 * The fleet's gates, expressed as the only thing GitHub can actually enforce:
 * two CI jobs named `fleet/verify` and `fleet/review`. Both run their full
 * logic on EVERY pull request, on GitHub's runners, against the PR's head
 * commit — never on the operator's laptop before the PR exists, and with no
 * branch-name opt-out.
 *
 * The migration is complete as of this commit: the ruleset requires both
 * checks, and `merge.ts`'s in-process gate — which nothing outside this
 * process was ever bound by — is deleted. What stops a merge now is GitHub. The previous design decided
 * "may this merge?" in-process and then ran the merge itself; GitHub knew
 * nothing about it, so anyone could merge a fleet PR on the repo's own CI
 * alone, which is what happened to the fleet's first live PR (#662).
 *
 * THE INVARIANT, and the reason this round exists: **the gate never executes
 * code from the commit it judges — it reads it.** The jobs check out the
 * PR's BASE commit, install from the BASE lockfile with `--ignore-scripts`,
 * and run this orchestrator from that trusted tree. The head commit is
 * fetched as an object and extracted with `git archive | tar` into a
 * directory with no `.git` — files, never a checkout, never a module path.
 *
 * The first version of this design checked out the head and ran
 * `bun install` plus the CLI from it. A PR editing `package.json` (an
 * install script) or `bun.lockb` (a postinstall) therefore got arbitrary
 * execution inside both gate jobs BEFORE any verdict was computed — enough
 * to force exit 0 on both and to read the review key out of the runner's
 * HOME. Neither file was code-owned, so no human would have seen it. The
 * judge was running the defendant's code; `fleet/review` itself caught it.
 *
 * Nothing here posts a commit status. An Actions job already IS a check run
 * named after the job, and that name is what the ruleset requires — posting a
 * same-named status on top would be a second copy of the same verdict, and
 * the `statuses: write` permission it needed is exactly what makes fork PRs
 * unmergeable. These functions return a verdict; the CLI turns it into an
 * exit code and prints the reason. Red job, red check, one fact.
 *
 * Check runs are per-commit, so the verified-commit pin the old merge path
 * enforced with a gh flag comes free: a push moves the head, and the new head
 * has no green check of its own. Fail-closed by construction — a job that
 * does not run leaves its required check missing, and the merge is blocked.
 */
export const VERIFY_JOB = 'fleet/verify'
export const REVIEW_JOB = 'fleet/review'

/**
 * A PR whose branch is not `fleet/<lane>/<item>` has no lane, so there is no
 * owned-path scope to hold it to — but NEVER-WRITE still binds everyone (no
 * PR may add a secret), and the non-author review still runs. `checkScope`
 * gives exactly that for an empty `owned` list, which is the same rail
 * guards.test.ts already asserts ("never-write binds even an unrestricted
 * lane").
 *
 * There is deliberately no opt-out and no discriminator. An earlier revision
 * passed non-fleet branches trivially, which was wrong twice over: the user's
 * policy is green CI plus a non-author review for ALL work, and author login
 * could not have distinguished the two anyway — the fleet pushes with the
 * operator's own GitHub account.
 */
export const UNSCOPED_LANE: Lane = {
  id: '(no lane — not a fleet branch)',
  mode: 'off',
  cap: 0,
  // `verifierFor` (review.ts) resolves the reviewer to `claude` regardless
  // of this value now (#812 retired the "other engine" bijection along with
  // opencode) — this field stays `claude` only because `Lane.engine` still
  // means "who authored this", and a human PR has no fleet author at all.
  engine: 'claude',
  requireLabel: '',
  vetoLabels: [],
  scope: { owned: [], notOwned: [] },
}

/**
 * The CI secret this job's `FLEET_REVIEW_API_KEY` env var reads from — kept
 * as a required repo secret for two reasons that have nothing to do with
 * authenticating the reviewer itself (see `VERIFIER_ENV_ALLOWLIST`'s doc
 * comment in review.ts: `claude` authenticates via the self-hosted runner's
 * own logged-in session under `HOME`, not this key):
 *   1. it is still the operator's explicit "review is enabled for this
 *      repo" toggle — the same UX as before #812, so absence still FAILS
 *      the job rather than skipping or passing it;
 *   2. `fleet-review.yml`'s job needing an explicit `secrets.*` reference is
 *      what keeps CodeQL's cache-poisoning query treating this job as
 *      privileged (`isPrivileged()`) and therefore out of scope for that
 *      specific query — see the "the job that executes the judged commit's
 *      code cannot be reached by a cache-write event" rail in
 *      guards.test.ts for the mechanism. Dropping this secret reference
 *      would put `fleet/review` back in scope for that query, since its
 *      trigger includes `workflow_dispatch` (one of the events with
 *      default-branch cache-write access) and its steps run `bun`
 *      (a poisonable command by CodeQL's own model) — an unrelated
 *      regression this secret reference exists to keep closed.
 */
export const REVIEW_KEY_ENV = 'FLEET_REVIEW_API_KEY'

/** `ok` becomes the job's exit code; `summary` is printed, and is the whole
 *  reason a reader needs for why the job is the colour it is. */
export interface CiVerdict { ok: boolean; summary: string }

/**
 * `realDispatch` (cli.ts) builds every fleet branch as `fleet/<lane>/<item>`.
 * ONE regex for that grammar, used by everything that reads a fleet branch —
 * deriving the lane (CI, to load its real scope) and the item (cli.ts, to
 * link the PR to its issue) from the branch NAME rather than from a label, a
 * ledger row, or a worker's own status report, which is the only source that
 * is both authoritative and available with no state of its own.
 */
const FLEET_BRANCH_RE = /^fleet\/([^/]+)\/([^/]+)$/

/**
 * The one WRITER of that grammar, next to the one reader. `buildArgs`
 * (engines.ts) passes this to `dispatch-one.sh --branch`, and `realDispatch`
 * (cli.ts) verifies the worktree and PR head against it — neither may spell
 * the format out itself. Issue #812: the dispatcher used to name the branch
 * after the worker (`fleet-shared-704`), which this regex does not
 * recognise, so the fleet skipped verify/review for the PR and CI treated it
 * as a non-fleet branch with no lane scope.
 *
 * Throws rather than returning a branch its own reader would reject: a lane
 * or item id containing `/` (or an empty one) would otherwise produce a
 * branch every consumer above treats as "not a fleet branch".
 */
export function fleetBranchFor(laneId: string, itemId: string): string {
  const branch = `fleet/${laneId}/${itemId}`
  if (laneIdFromBranch(branch) !== laneId || itemIdFromBranch(branch) !== itemId) {
    throw new Error(`lane "${laneId}" / item "${itemId}" cannot form a fleet branch (fleet/<lane>/<item>)`)
  }
  return branch
}

export function laneIdFromBranch(branch: string): string | undefined {
  return FLEET_BRANCH_RE.exec(branch)?.[1]
}

/**
 * The pre-#812 branch spelling (`fleet-<lane>-<item>`, same grammar the
 * worker NAME and tmux session use — see `nameFor` in cli.ts). Some PRs
 * opened before #812's fix still live on it. Issues
 * #705/#724/#729/#775/#784/#785 each burned three worker attempts
 * rediscovering a PR that was already open and simply waiting on the review
 * gate; a pre-dispatch "does an open PR already exist" check that only
 * looked at the canonical `fleet/<lane>/<item>` grammar would miss every one
 * of them. Never used to WRITE a branch — only to check whether one already
 * has an open PR before dispatching a brand new worker attempt.
 */
export function legacyFleetBranchFor(laneId: string, itemId: string): string {
  return `fleet-${laneId}-${itemId}`
}

export function itemIdFromBranch(branch: string): string | undefined {
  return FLEET_BRANCH_RE.exec(branch)?.[2]
}

/** The one line `parseVerdict` judged — the reviewer's final non-empty line,
 *  selected by the same function (`finalLine`), so the printed summary and the
 *  job's exit code can never name different verdicts. Never an invented
 *  summary and never a search of its own. */
export function verdictSummary(text: string): string {
  return finalLine(text) ?? '(no reviewer output)'
}

export interface CiContext {
  /** The PR's HEAD branch name — `github.head_ref`. Used only to derive the
   *  lane; it is a NAME, never something that gets checked out. */
  branch: string
  /** The BASE checkout: trusted git history, trusted orchestrator code,
   *  trusted `node_modules`. Every decision is computed from here. */
  repoDir: string
  /** `git archive <headSha> | tar -x` of the commit under judgement — its
   *  files, with no `.git` and nothing executed. */
  headDir: string
  /** LHS of the diff range: the commit the PR is based on. */
  baseSha: string
  /** RHS of the diff range: the commit under judgement, fetched into the
   *  base checkout as an object. */
  headSha: string
  /** For the reviewer's prompt only. */
  pr: string
}

export interface CiDeps {
  ctx: CiContext
  lanes(): Promise<Lane[]>
  verify(input: VerifyInput): Promise<VerifyReport>
  /** Injected so the export-not-a-checkout invariant below is testable
   *  without a filesystem. */
  pathExists(p: string): boolean
  /** The job log — the durable record of what the gate saw. */
  log(msg: string): void
}

export type VerifyCiDeps = CiDeps

export interface ReviewCiDeps extends CiDeps {
  /** `undefined`/empty when the repo secret is not configured. */
  apiKey: string | undefined
  prDiff(): Promise<string>
  secondOpinion(input: SecondOpinionInput): Promise<SecondOpinionResult>
  /**
   * `undefined` disables caching outright — every call reviews fresh,
   * exactly like before this existed. Optional so every pre-existing test
   * and call site that never heard of a review cache is unaffected: this
   * is additive, not a new required wire.
   */
  cache?: ReviewCache
}

/**
 * `undefined` ONLY when the branch parses as a fleet branch but names a lane
 * that does not exist — a real misconfiguration that must fail, not be
 * quietly downgraded to the unscoped check. A branch that is not a fleet
 * branch at all resolves to `UNSCOPED_LANE` and is verified like anything
 * else.
 */
async function resolveLane(deps: CiDeps): Promise<Lane | undefined> {
  const laneId = laneIdFromBranch(deps.ctx.branch)
  if (laneId === undefined) return UNSCOPED_LANE
  return (await deps.lanes()).find((l) => l.id === laneId)
}

/**
 * Asserted, never assumed. A `.git` inside the head directory means someone
 * changed the workflow to CHECK OUT the commit under judgement instead of
 * exporting it — restoring exactly the hole this design closed, silently and
 * with both jobs still green. Refusing here makes that edit fail loudly on
 * its own PR.
 */
export function headDirRefusal(deps: Pick<CiDeps, 'ctx' | 'pathExists'>): CiVerdict | undefined {
  if (!deps.pathExists(join(deps.ctx.headDir, '.git'))) return undefined
  return {
    ok: false,
    summary: `refusing to judge: ${deps.ctx.headDir} contains a .git — the commit under ` +
      'judgement must be exported as data (git archive), never checked out',
  }
}

/** The diff range, taken entirely inside the trusted base checkout. */
function rangeFor(ctx: CiContext): Pick<VerifyInput, 'worktree' | 'base' | 'branch'> {
  return { worktree: ctx.repoDir, base: ctx.baseSha, branch: ctx.headSha }
}

/** `fleet/verify` — scope, impact, and diff-targeted tests against
 *  `origin/main...HEAD`. */
export async function runVerifyCi(deps: VerifyCiDeps): Promise<CiVerdict> {
  const refusal = headDirRefusal(deps)
  if (refusal !== undefined) return refusal

  const lane = await resolveLane(deps)
  if (lane === undefined) return { ok: false, summary: `unknown lane in branch ${deps.ctx.branch}` }

  // PHASE 1 — trusted only. git runs in the base checkout; scope, never-write
  // and impact are pure functions over the file list it returns. No code from
  // the commit under judgement has executed, or can, at this point.
  const gate = await deps.verify({ ...rangeFor(deps.ctx), lane, skipTests: true })
  deps.log(`gate (no code from the commit under judgement executed): ${buildGateTrace({ report: gate })}`)
  if (!gate.passed) {
    return {
      ok: false,
      summary: [buildGateTrace({ report: gate }), ...gate.reasons.map((r) => `- ${r}`)].join('\n'),
    }
  }

  // PHASE 2 — the ONLY place the judged commit's code runs, and running it is
  // unavoidable: these are its own tests. It happens AFTER the verdict above
  // was computed and printed, in a separate process, against the export — so
  // it can only AND into the result, never revise it. This job holds no
  // secrets for that code to reach.
  const withTests = await deps.verify({ ...rangeFor(deps.ctx), lane, testDir: deps.ctx.headDir })
  return {
    ok: withTests.passed,
    summary: [
      buildGateTrace({ report: withTests }),
      ...(withTests.testResults ?? []).map((r) => `- ${r}`),
      ...withTests.reasons.map((r) => `- ${r}`),
    ].join('\n'),
  }
}

/**
 * `fleet/review` — the non-author model's verdict on EVERY pull request,
 * produced on the runner against the exact head commit by an engine that is
 * not the one that wrote the diff (`secondOpinion` picks it, and hands it a
 * `.git`-less snapshot).
 *
 * Scope is re-checked but tests are NOT re-run: `fleet/verify` runs them, and
 * twice doubles every fleet PR's CI cost for no extra signal. The scope
 * re-check is the invariant `secondOpinion` already enforces by throwing — a
 * review may only downgrade a mechanical pass, never rescue a failure — so a
 * diff that failed scope gets no review at all.
 */
export async function runReviewCi(deps: ReviewCiDeps): Promise<CiVerdict> {
  const refusal = headDirRefusal(deps)
  if (refusal !== undefined) return refusal

  if (deps.apiKey === undefined || deps.apiKey.length === 0) {
    return { ok: false, summary: `review unavailable: ${REVIEW_KEY_ENV} is not configured on this repository` }
  }
  const lane = await resolveLane(deps)
  if (lane === undefined) return { ok: false, summary: `unknown lane in branch ${deps.ctx.branch}` }

  const report = await deps.verify({ ...rangeFor(deps.ctx), lane, skipTests: true })
  if (!report.passed) {
    return {
      ok: false,
      summary: `no review requested: ${report.reasons.join('; ') || 'mechanical verification failed'}`,
    }
  }

  const diff = await deps.prDiff()

  // Exactly one review per PR per DIFF CONTENT, not per merge-queue attempt —
  // a re-queue after the queue rebases this PR onto a newer `main` is a new
  // `merge_group` event with a new head SHA, but the same diff, and must
  // still hit. Keyed by a hash of the diff itself (`review-cache.ts`), never
  // the head SHA.
  //
  // A lookup failure and a genuine cache miss are DELIBERATELY the same
  // thing here — `cached === undefined` — because both mean "run the
  // engine": see `artifactReviewCache`'s use of `ghJson`, which already
  // returns `undefined` rather than throwing. The `try` below exists only
  // because `deps.cache` is an injected interface, not `ghJson` itself, and
  // a future or test implementation of it could still throw; the fail-safe
  // direction must hold even then.
  const cacheKey: ReviewCacheKey = { pr: deps.ctx.pr, diffHash: diffHash(diff) }
  if (deps.cache !== undefined) {
    let cached: CachedVerdict | undefined
    try {
      cached = await deps.cache.lookup(cacheKey)
    } catch (e) {
      deps.log(`review cache lookup threw — running the engine (fail safe): ${e instanceof Error ? e.message : String(e)}`)
      cached = undefined
    }
    if (cached !== undefined) {
      deps.log(`review cache hit for PR ${deps.ctx.pr} (sha256:${cacheKey.diffHash.slice(0, 12)}…) — re-publishing instead of invoking the engine`)
      return { ok: true, summary: cached.text }
    }
  }

  let result: SecondOpinionResult
  try {
    // `snapshotDir`, never `worktree`: the export already exists, so this
    // job runs no git and creates nothing. Zero execution of the judged
    // commit's code anywhere in this job — which is what lets it hold the key.
    result = await deps.secondOpinion({
      authorEngine: lane.engine, pr: deps.ctx.pr, snapshotDir: deps.ctx.headDir, diff, report,
    })
  } catch (e) {
    return { ok: false, summary: `review unavailable: ${e instanceof Error ? e.message : String(e)}` }
  }

  // UNREADABLE and FAIL both fail the job, but they are different facts and
  // the summary says which: "the reviewer could not be run" is not "the
  // reviewer found a problem". Within UNREADABLE, `failureKind` draws one
  // more distinction that used to be lost here: `'engine-misconfigured'`
  // (a `--model`/engine id the reviewer refuses outright) is a
  // MISCONFIGURATION — a defect retrying will never fix — not an
  // AVAILABILITY problem, which is what "unavailable" implies to a human
  // reading the check. #866 hit exactly this: the engine was reachable and
  // ran, and still produced an opaque `review unavailable: {"name":
  // "UnknownError",...}` for what was, underneath, a bad model id — the
  // wrong diagnostic sent whoever read it looking for an outage that was
  // never happening. `'engine-unavailable'` (or no failureKind at all, e.g.
  // a thrown tamper-detection error below) keeps the original wording.
  const unreadablePrefix = result.failureKind === 'engine-misconfigured' ? 'review misconfigured' : 'review unavailable'
  const summary = result.verdict === 'UNREADABLE'
    ? `${unreadablePrefix}: ${verdictSummary(result.text)}`
    : verdictSummary(result.text)
  const verdict: CiVerdict = { ok: result.verdict === 'PASS', summary: `${summary}\n\n${result.text}` }

  // Only a FRESH PASS this process itself just produced is ever recorded —
  // never a FAIL, and never a cache hit being re-published (that would just
  // re-upload the identical artifact under its own name for no benefit).
  // Recording nothing for a FAIL is the entire mechanism behind "a FAIL is
  // never reused": there is nothing a later lookup could ever find.
  if (verdict.ok && deps.cache !== undefined) {
    try {
      await deps.cache.record(cacheKey, { verdict: 'PASS', text: verdict.summary })
    } catch (e) {
      deps.log(`review cache record failed (non-fatal — the review itself still passed): ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return verdict
}

/**
 * The three outcomes `fleet-review.yml`'s job-level `if:` used to encode —
 * see #848 and this function's own comment for why that design fails open.
 * The job now has NO `if:` at all and always reaches a real conclusion; this
 * is what a step INSIDE it calls, before installing the review engine, to
 * decide which of the three branches applies:
 *
 *  - `specialist-unmet` — checked before everything else (#1092): the PR
 *    carries a `-reviewer` label whose specialist has no PASS for this exact
 *    diff (or the label does not resolve). Fails the job. This is what makes
 *    a specialist binding on the REQUIRED check without the specialist's own
 *    `fleet/review/<agent>` context ever being required — see
 *    `fleet-specialist-review.yml`'s header.
 *  - `cache-hit`  — a prior PASS exists for this exact diff. Concludes the
 *    job successfully with no engine call, regardless of which label fired
 *    this run — this is what makes an unrelated label event (say,
 *    `agent-dispatchable` on an already-reviewed PR) cheap and
 *    non-destructive instead of a wasted (or worse, skipped) re-review.
 *  - `low-tier` — no cached PASS, but `tierFor` (impact.ts) classifies every
 *    changed file as Tier 0 or Tier 1: no executable content, or
 *    instructions/tooling that already earns a code-owner review on its
 *    own. Concludes the job successfully with no engine call, regardless of
 *    `requested` — checked BEFORE the label check below, deliberately: a
 *    docs-only PR that never gets the `review` label must still conclude a
 *    real, auditable success rather than sitting on `not-requested` forever
 *    for a review it was never going to need. The tier and the file-level
 *    reasons are logged (and printed to the job's own stdout by
 *    `runReviewGate`, cli.ts) so the decision is auditable from the check's
 *    own output, not just from reading this file's source.
 *  - `not-requested` — no cached PASS, Tier 2 (a real review is needed), and
 *    this run was not the `review` label (nor a manual `workflow_dispatch`).
 *    Fails the job outright: a `fleet/review` a reader has not yet asked for
 *    is not a passing review, and the old design's mistake was ever treating
 *    "not asked for" as anything other than a fail-closed red check.
 *  - `run-engine` — no cached PASS, Tier 2, and the review WAS requested.
 *    The workflow proceeds through engine install, auth, the smoke test and
 *    the real review exactly as before this file's `if:` removal.
 *
 * `runReviewCi` itself still opens with the identical cache lookup (see its
 * own comment) — so a direct call to it from anywhere else stays correct on
 * its own — at the cost of one redundant lookup on the `run-engine` path
 * once this decision has already been made. That redundancy is cheap and
 * never a correctness risk: both reads hit the same cache with the same key.
 */
export type ReviewGateOutcome =
  | { kind: 'specialist-unmet'; cacheKey: ReviewCacheKey; unmet: string[] }
  | { kind: 'cache-hit'; cacheKey: ReviewCacheKey; verdict: CachedVerdict }
  | { kind: 'low-tier'; cacheKey: ReviewCacheKey; tier: ImpactTier; reasons: string[] }
  | { kind: 'not-requested'; cacheKey: ReviewCacheKey }
  | { kind: 'run-engine'; cacheKey: ReviewCacheKey }

export interface ReviewGateDeps {
  ctx: CiContext
  prDiff(): Promise<string>
  /** The changed-file list this diff touches — `tierFor`'s only input. A
   *  separate read from `prDiff()` rather than derived from its text (see
   *  `ciChangedFiles`'s own comment on why a diff-text scan is not enough). */
  changedFiles(): Promise<string[]>
  cache: ReviewCache
  /** Whether THIS event is the one that asks for a review: the `review`
   *  label being applied, or a manual `workflow_dispatch`. Computed by the
   *  workflow from `github.event_name` / `github.event.label.name` — never
   *  re-derived here, so this function has exactly one job: cache first,
   *  tier second, request third. */
  requested: boolean
  /**
   * Every specialist requested on this PR (a `-reviewer` label) that has NOT
   * passed on this exact diff, as reasons — `specialistRequirement`
   * (specialist.ts), injected rather than imported so this module does not
   * import one that imports it. Required, not optional: an unwired check
   * here would be a specialist FAIL the required gate silently ignores.
   */
  unmetSpecialists(cacheKey: ReviewCacheKey): Promise<string[]>
  log(msg: string): void
}

export async function decideReviewGate(deps: ReviewGateDeps): Promise<ReviewGateOutcome> {
  const diff = await deps.prDiff()
  const cacheKey: ReviewCacheKey = { pr: deps.ctx.pr, diffHash: diffHash(diff) }

  // FIRST, ahead of the cache, the tier and the request (#1092): a requested
  // specialist that has not passed on this diff fails the REQUIRED check, so
  // GitHub itself — not only this fleet — refuses the merge. Ahead of the
  // cache because a generalist PASS must never outrank a specialist's missing
  // or failed one (any FAIL fails); ahead of the tier because a label is an
  // explicit request, which a docs-only diff does not get to ignore; ahead of
  // `run-engine` so an unmet specialist never spends a generalist review.
  const unmet = await deps.unmetSpecialists(cacheKey)
  if (unmet.length > 0) {
    deps.log(`specialist review(s) unmet for pr=${cacheKey.pr}:\n${unmet.map((u) => `  - ${u}`).join('\n')}`)
    return { kind: 'specialist-unmet', cacheKey, unmet }
  }

  // Identical fail-safe direction as `runReviewCi`: a lookup failure and a
  // genuine miss are indistinguishable on purpose, because both mean "this
  // is not yet a known-good diff" — see `artifactReviewCache`'s own doc.
  let cached: CachedVerdict | undefined
  try {
    cached = await deps.cache.lookup(cacheKey)
  } catch (e) {
    deps.log(`review cache lookup threw — treating pr=${cacheKey.pr} as a miss (fail safe): ${e instanceof Error ? e.message : String(e)}`)
    cached = undefined
  }
  if (cached !== undefined) {
    deps.log(`reused verdict for pr=${cacheKey.pr} sha256:${cacheKey.diffHash.slice(0, 12)}… — no engine call`)
    return { kind: 'cache-hit', cacheKey, verdict: cached }
  }

  // Ordered here — after the cache check, before the label/request check —
  // per the operator rule this implements: ceremony should scale with
  // impact. A diff with no reviewable content (Tier 0/1) must conclude a
  // real success on its own, never wait on a human to apply the `review`
  // label for a model review it will never need.
  const changedFiles = await deps.changedFiles()
  const { tier, reasons } = tierFor(changedFiles)
  if (tier < 2) {
    deps.log(`no reviewable content (tier ${tier}) for pr=${cacheKey.pr} — ${reasons.join('; ') || 'no changed files'}`)
    return { kind: 'low-tier', cacheKey, tier, reasons }
  }

  if (!deps.requested) {
    deps.log(
      `review not requested for pr=${cacheKey.pr} sha256:${cacheKey.diffHash.slice(0, 12)}… — ` +
      'add the `review` label to run the non-author review',
    )
    return { kind: 'not-requested', cacheKey }
  }

  return { kind: 'run-engine', cacheKey }
}

/** `undefined` when the workflow did not supply a branch — a CI entry point
 *  with no idea what it is judging must refuse, not guess. */
export function ciContextFromEnv(env: NodeJS.ProcessEnv, repoDir: string): CiContext | undefined {
  const branch = env['FLEET_CI_BRANCH'] ?? ''
  const headDir = env['FLEET_CI_HEAD_DIR'] ?? ''
  const headSha = env['FLEET_CI_HEAD_SHA'] ?? ''
  const baseSha = env['FLEET_CI_BASE_SHA'] ?? ''
  if (branch.length === 0 || headDir.length === 0 || headSha.length === 0 || baseSha.length === 0) return undefined
  return { branch, repoDir, headDir, headSha, baseSha, pr: env['FLEET_CI_PR'] ?? '(unknown)' }
}

/** Read inside the trusted base checkout, over the fetched head object. */
export async function ciDiff(ctx: CiContext): Promise<string> {
  const { stdout } = await execFileAsync(
    'git', ['-C', ctx.repoDir, 'diff', `${ctx.baseSha}...${ctx.headSha}`],
    { maxBuffer: 32 * 1024 * 1024 },
  )
  return stdout
}

/**
 * The changed-file LIST, not the diff text — `decideReviewGate`'s tier check
 * (`tierFor`, impact.ts) needs every touched path, including a binary file's
 * (no `+++`/`---` header a text-diff scan could find). A separate `git
 * diff --name-only` call, matching `verifyMechanical`'s own (verify.ts), is
 * simpler and more robust than parsing `ciDiff`'s unified-diff text for file
 * headers — this is the same trusted base checkout either call runs in, so
 * the extra `git` invocation costs nothing in trust, only one more process.
 */
export async function ciChangedFiles(ctx: CiContext): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'git', ['-C', ctx.repoDir, 'diff', '--name-only', `${ctx.baseSha}...${ctx.headSha}`],
    { maxBuffer: 32 * 1024 * 1024 },
  )
  return changedFilesFrom(stdout)
}
