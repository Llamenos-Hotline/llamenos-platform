import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Lane } from './config.js'
import type { VerifyInput, VerifyReport } from './verify.js'
import { changedFilesFrom } from './verify.js'
import { finalLine, requiredAdditionalReviewers, type SecondOpinionInput, type SecondOpinionResult } from './review.js'
import { diffHash, reviewSetTag, type CachedVerdict, type ReviewCache, type ReviewCacheKey } from './review-cache.js'
import { join } from 'node:path'
import { buildGateTrace } from './trace.js'
import { tierFor, type ImpactTier } from './impact.js'
import { isReviewerLabel, type ReviewerProfile, type ReviewerResolution } from './specialist.js'
import { KNOPE_RELEASE_BRANCH } from './roles/release.js'

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
 * The display name of the mandatory non-author review (`secondOpinion`),
 * which is in every review set and is never a reviewer PROFILE — profiles
 * (specialist.ts) run alongside it, never instead of it.
 */
export const GENERAL_REVIEWER = 'general'

/** One reviewer's verdict as the PR will show it — see `publishReport`. */
export interface ReviewReportEntry {
  reviewer: string
  verdict: 'PASS' | 'FAIL' | 'UNREADABLE'
  /** The reviewer's own text in full, findings included — never just the
   *  one-line `VERDICT:`, which is the whole defect this exists to fix. */
  body: string
}

/**
 * `fleet/review` runs when a review is REQUESTED from this account (#1158).
 * Requesting a review is a real, human-meaningful act that already means
 * "look at this now"; the `review` LABEL it replaces never meant that, which
 * is why release PRs could never satisfy the gate at all (#1114) — nothing
 * labelled them.
 */
export const REVIEW_REQUEST_LOGIN = 'llamenos-auto'

/** The operator's own login. Accepted on the knope release PR, and on any PR
 *  `REVIEW_REQUEST_LOGIN` itself authored — see `reviewTriggerLogins`. */
export const RELEASE_REVIEW_REQUEST_LOGIN = 'rhonda-rodododo'

/**
 * PR authors whose diffs get a real `fleet/review` CHECK but never a model
 * call — it concludes green immediately (`bot-authored` below).
 *
 * Matched on AUTHOR, never on branch name. `dependabot/**` is a convention
 * anyone with push access can imitate, so keying the skip on the branch would
 * hand a free review bypass to any human who names a branch `dependabot/x`.
 * The author of a Dependabot PR is set by GitHub and cannot be spoofed that
 * way.
 *
 * WHY SKIPPING IS DEFENSIBLE HERE, when a review normally is not optional:
 * the reviewer that refused #1273 made the argument itself — a model reading
 * a `bun.lock`/`Cargo.lock`/action-pin diff sees version numbers and hashes,
 * never the code the registry actually publishes. Supply-chain compromises
 * put the payload in the package, not the diff. So the model review buys
 * almost nothing on precisely this class of change, while costing a full
 * review cycle each time Dependabot force-pushes. The checkpoint that does
 * carry weight is a human pressing Merge, and that is untouched:
 * `require_extra_approval_for_unattributed_changes` still applies and
 * dependabot-auto-approve.yml deliberately does not auto-merge.
 */
export const REVIEW_SKIP_AUTHORS: readonly string[] = ['dependabot[bot]', 'dependabot']

export interface ReviewRequestEvent {
  /** `github.event_name`. */
  eventName: string
  /** `github.event.requested_reviewer.login` — `undefined` when the request
   *  named a TEAM (`requested_team`) rather than a user, and on every event
   *  that is not `review_requested`. */
  requestedReviewer: string | undefined
  /** `github.event.requested_team.slug` — set INSTEAD of `requestedReviewer`
   *  when the request named a team. Never a trigger (see `reviewRequestFor`);
   *  carried only so the refusal can say so, rather than a team request
   *  failing with advice that never mentions it. */
  requestedTeam?: string | undefined
  /** `github.event.pull_request.user.login` — the PR's AUTHOR, who can never
   *  be its trigger (see `reviewTriggerLogins`). Absent only narrows: with no
   *  author the stand-in route below stays shut, and a request for
   *  `REVIEW_REQUEST_LOGIN` rests on GitHub's own refusal to request a PR's
   *  author, exactly as it did before the author was known here. */
  prAuthor?: string | undefined
  /** The PR's head branch, for the release-PR exception. */
  branch: string
}

/** GitHub logins are case-insensitive; `undefined` for an absent or blank one. */
function loginOf(raw: string | undefined): string | undefined {
  const login = (raw ?? '').trim().toLowerCase()
  return login.length === 0 ? undefined : login
}

/**
 * The users a review may be requested from to run `fleet/review` on THIS PR:
 * never empty, and never the PR's own author.
 *
 * `REVIEW_REQUEST_LOGIN` on every PR it did not write. On a PR it DID write,
 * GitHub refuses the request outright (422 "Review cannot be requested from
 * pull request author"), so the operator stands in for it — without that,
 * such a PR had no route to a verdict at all and could never merge (#1232,
 * live on #1183). The knope release PR accepts the operator as well, since
 * they are who actually reads it, whoever the release automation ran as.
 *
 * Deliberately NOT "either login, whenever it is not the author". CODEOWNERS
 * names `rhonda-rodododo` on every high-impact path, so GitHub requests that
 * login automatically when almost any PR opens; accepting it everywhere
 * would start a full model review on every dependabot PR the moment it is
 * opened — the trigger-on-`opened` fleet-review.yml's invariant 2 forbids,
 * re-entering through CODEOWNERS. The operator counts only where the fleet's
 * own identity cannot be asked.
 */
export function reviewTriggerLogins(pr: Pick<ReviewRequestEvent, 'prAuthor' | 'branch'>): [string, ...string[]] {
  const author = loginOf(pr.prAuthor)
  if (author === REVIEW_REQUEST_LOGIN) return [RELEASE_REVIEW_REQUEST_LOGIN]
  if (pr.branch === KNOPE_RELEASE_BRANCH && author !== RELEASE_REVIEW_REQUEST_LOGIN) {
    return [REVIEW_REQUEST_LOGIN, RELEASE_REVIEW_REQUEST_LOGIN]
  }
  return [REVIEW_REQUEST_LOGIN]
}

/** `reviewRequestFor`'s answer: a request, or the reason this event is not one. */
export type ReviewRequestDecision =
  | { requested: true }
  | { requested: false; reason: string }

/**
 * Whether THIS event is the one asking for a review. The only thing that
 * decides it is WHO was asked — never a label, and never a push.
 *
 * Fail closed in both directions this can be got wrong: an unrecognised
 * event name is not a request, and a request naming anyone else (a human
 * colleague, a team, the PR's own author) is not a request either. It is
 * deliberately NOT a job-level `if:` in the workflow: a job instantiated on
 * an event and then skipped by `if:` satisfies branch protection exactly
 * like a green check (#848), so "this review request was not for us" has to
 * become a real, reported conclusion on `fleet/review`, never a skip — and
 * the reason goes with it, so the red check says what to do next.
 *
 * A TEAM is never a trigger. GitHub refuses a request naming the PR's author
 * but accepts one naming a team the author belongs to: on #1183 the
 * operator requested `review-agent-team`, whose only member is
 * `llamenos-auto`, on a PR `llamenos-auto` wrote. Accepting teams would let
 * a PR's author ask itself for its own review.
 */
export function reviewRequestFor(e: ReviewRequestEvent): ReviewRequestDecision {
  if (e.eventName === 'workflow_dispatch') return { requested: true }
  if (e.eventName !== 'pull_request') {
    return { requested: false, reason: `\`${e.eventName || '(no event)'}\` is not a review request` }
  }
  const login = loginOf(e.requestedReviewer)
  if (login === undefined) {
    const team = (e.requestedTeam ?? '').trim()
    return {
      requested: false,
      reason: team.length === 0
        ? 'this review request named no user'
        : `this review was requested from the team \`${team}\`, and a team is never a trigger — GitHub accepts ` +
          "a team request even when the PR's own author is on that team, so it cannot stand for a non-author review",
    }
  }
  const triggers = reviewTriggerLogins(e)
  if (triggers.includes(login)) return { requested: true }
  return {
    requested: false,
    reason: `\`${login}\` is not a review trigger on this PR (author \`${loginOf(e.prAuthor) ?? 'unknown'}\`, ` +
      `branch \`${e.branch}\`) — only ${triggers.map((t) => `\`${t}\``).join(' or ')} is`,
  }
}

/** `reviewRequestFor`, as the yes/no alone. */
export function reviewIsRequested(e: ReviewRequestEvent): boolean {
  return reviewRequestFor(e).requested
}

/**
 * The raw review-request fields `fleet-review.yml`'s gate step hands over in
 * `env:`, uninterpreted — `reviewRequestFor` judges them. The one reader of
 * those variable names, so the workflow and the gate cannot disagree on one.
 */
export function reviewRequestEventFromEnv(env: NodeJS.ProcessEnv, branch: string): ReviewRequestEvent {
  return {
    eventName: env['FLEET_REVIEW_EVENT_NAME'] ?? '',
    requestedReviewer: env['FLEET_REVIEW_REQUESTED_REVIEWER'],
    requestedTeam: env['FLEET_REVIEW_REQUESTED_TEAM'],
    prAuthor: env['FLEET_REVIEW_PR_AUTHOR'],
    branch,
  }
}

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
  /**
   * The PR's current labels, for `scope:<lane>` grants (#1115). `undefined`
   * means they could not be read — never an empty list standing in for "no
   * labels", because the two must not be confused: unreadable fails CLOSED
   * (no grants apply, the PR is judged on its own lane alone).
   *
   * Optional so every existing caller and test is unaffected; omitting it is
   * exactly equivalent to a PR carrying no grants.
   */
  prLabels?(): Promise<string[] | undefined>
}

export type VerifyCiDeps = CiDeps

export interface ReviewCiDeps extends CiDeps {
  /** `undefined`/empty when the repo secret is not configured. */
  apiKey: string | undefined
  prDiff(): Promise<string>
  secondOpinion(input: SecondOpinionInput): Promise<SecondOpinionResult>
  /**
   * `decideReviewSet`, wired to a LIVE read of the PR — decided HERE, from
   * scratch, never handed in.
   *
   * An earlier revision of #1158 had the gate step resolve the set once and
   * pass it to this one through a `FLEET_REVIEW_PROFILES` env var. That was
   * a fail-open: on a `pull_request` event the workflow file is the PR's
   * OWN copy, so a PR could set that variable to the empty string and the
   * crypto reviewer would silently never run — and the resulting
   * general-only PASS would be recorded as a reusable cache entry for a set
   * nobody approved. Base code decides what to review, or the decision is
   * the defendant's to make.
   */
  reviewSet(changedFiles: readonly string[]): Promise<ReviewSetDecision>
  resolveProfile(name: string): Promise<ReviewerResolution>
  /**
   * `stripReviewerControlFiles` (review.ts) over the export, awaited ONCE
   * before any reviewer starts. Required, not optional: it is a security
   * control, and an unwired one would be a silent fail-open.
   *
   * `secondOpinion` strips the snapshot itself on the CI path, which was
   * enough while it was the only reader. It is not enough now that profiles
   * read the SAME directory concurrently (#1158) — a strip racing a reader
   * is a reader that may see `.claude/`, `AGENTS.md` or a symlink out of the
   * export, which is exactly what the strip exists to prevent. Hoisting it
   * here makes the ordering a fact rather than a timing accident;
   * `secondOpinion`'s own strip then finds nothing left to do.
   */
  stripExport(dir: string): Promise<void>
  /** Runs ONE resolved profile, read-only, against the same export. */
  profileReview(profile: ReviewerProfile, diff: string, changedFiles: readonly string[]): Promise<SecondOpinionResult>
  /**
   * Hands every reviewer's FULL text somewhere the PR itself will show it.
   * Required, not optional, and the reason is a measured failure: two real
   * reviews ran on #1117 and `pulls/1117/reviews` and
   * `issues/1117/comments` were both EMPTY — the gate wrote a check run and
   * a job log and nothing else, so both substantive findings existed only
   * inside Actions logs and had to be dug out with `gh run view --log`.
   * Anyone opening the PR saw a red check with no reason on it. A red check
   * whose reason lives only in a log is not reviewable.
   *
   * This job is read-only by design (it runs a model next to the review
   * key), so it cannot post anything itself: it WRITES the report, and the
   * separate `fleet-review/publish` job — the only thing here with
   * `pull-requests: write` — posts it and only then clears the labels.
   */
  publishReport(entries: readonly ReviewReportEntry[]): Promise<void>
  /**
   * The cache for a given review-set namespace (`reviewSetTag`). Omitted
   * disables caching outright — every call reviews fresh, exactly like
   * before this existed, so every pre-existing test and call site that
   * never heard of a review cache is unaffected.
   */
  cacheFor?(scope: string | undefined): ReviewCache
}

// ---------------------------------------------------------------------------
// The review SET — which reviews `fleet/review` runs for this PR (#1158).
// ---------------------------------------------------------------------------

export type ReviewSetDecision =
  | { ok: true; profiles: string[]; fromLabels: string[]; reasons: string[] }
  | { ok: false; reason: string }

export interface ReviewSetDeps {
  /** The PR's labels, read LIVE. `undefined` means the read FAILED — never
   *  an empty list standing in for "could not look", which is the whole
   *  reason the two are different values. */
  labels: readonly string[] | undefined
  /** Every path the diff touches, from the trusted base checkout. */
  changedFiles: readonly string[]
  /** The PR's title and body, concatenated — the "and from the PR itself"
   *  half of the decision. */
  description: string
  /** `resolveReviewerLabel` against the BASE checkout's agent registry
   *  (specialist.ts), injected rather than imported so this module does not
   *  reach into the filesystem. */
  resolve(name: string): Promise<ReviewerResolution>
}

/**
 * The reviews to run, from the PR's LABELS and from the PR ITSELF.
 *
 * A label ending `-reviewer` names a profile explicitly — the ask, and the
 * thing the job clears once that review has passed. The PR's own content
 * names profiles nobody remembered to ask for: `requiredAdditionalReviewers`
 * (review.ts) puts the crypto reviewer on any crypto diff, by changed path
 * OR by the PR's own prose. Labels are a hint and an override, never the
 * only input — that is the whole point of #1158's second decision.
 *
 * Fail CLOSED, every direction, because the alternative is a PR that looks
 * reviewed and was not: unreadable labels, a malformed `-reviewer` label, an
 * unknown profile, an unreadable agent registry — each REFUSES, and the
 * refusal fails the required check. None of them may become "no review
 * needed".
 *
 * The general non-author review is not in `profiles`: it is mandatory for
 * every diff and is never something a label or a path can add or remove.
 */
export async function decideReviewSet(deps: ReviewSetDeps): Promise<ReviewSetDecision> {
  if (deps.labels === undefined) {
    return {
      ok: false,
      reason: 'the PR\'s labels could not be read, so the reviews it asks for are unknown — ' +
        'refusing to treat an unreadable worklist as an empty one',
    }
  }
  const fromLabels = deps.labels.filter(isReviewerLabel)
  const fromContent = requiredAdditionalReviewers([...deps.changedFiles], deps.description)
  const wanted = [...new Set([...fromLabels, ...fromContent])].sort()

  const reasons: string[] = []
  for (const name of wanted) {
    const resolved = await deps.resolve(name)
    if (!resolved.ok) {
      return {
        ok: false,
        reason: fromLabels.includes(name)
          ? `the "${name}" label asks for a review that cannot be run: ${resolved.reason}`
          : `this PR's own content asks for the "${name}" review, which cannot be run: ${resolved.reason}`,
      }
    }
    const why: string[] = []
    if (fromLabels.includes(name)) why.push('requested by label')
    if (fromContent.includes(name)) why.push('required by the PR\'s own content')
    reasons.push(`${name} (${why.join('; ')})`)
  }
  return { ok: true, profiles: wanted, fromLabels, reasons }
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

/** The prefix a label must carry to grant a lane's scope to a PR (#1115). */
export const SCOPE_GRANT_PREFIX = 'scope:'

/**
 * The lanes a PR has been granted beyond its own, read from its
 * `scope:<lane>` labels.
 *
 * Fails closed in every direction that matters: labels that cannot be read
 * yield no grants; a label naming something that is not a real lane is
 * ignored rather than treated as a wildcard; and the PR's own lane is never
 * duplicated into the list. Anything unrecognised is logged, because a
 * silently-dropped grant looks identical to a gate that ignored the operator.
 */
async function resolveGrantedLanes(deps: CiDeps, own: Lane): Promise<Lane[]> {
  const labels = await deps.prLabels?.()
  if (labels === undefined) return []
  const requested = labels
    .filter((l) => l.startsWith(SCOPE_GRANT_PREFIX))
    .map((l) => l.slice(SCOPE_GRANT_PREFIX.length).trim())
  if (requested.length === 0) return []
  const all = await deps.lanes()
  const granted: Lane[] = []
  for (const id of requested) {
    if (id === own.id) continue
    const lane = all.find((l) => l.id === id)
    if (lane === undefined) {
      deps.log(`ignoring ${SCOPE_GRANT_PREFIX}${id}: not a known lane (${all.map((l) => l.id).join(', ')})`)
      continue
    }
    // An `off` lane, or one whose fragment is missing or unparseable, has an
    // empty owned list. Honouring such a grant would make the PR unrestricted
    // — the grant would fail OPEN, which is the opposite of the contract.
    if (lane.scope.owned.length === 0) {
      deps.log(`ignoring ${SCOPE_GRANT_PREFIX}${id}: lane "${id}" has no owned paths, so it grants nothing`)
      continue
    }
    if (!granted.some((g) => g.id === lane.id)) granted.push(lane)
  }
  if (granted.length > 0) deps.log(`scope grants in force: ${granted.map((g) => g.id).join(', ')}`)
  return granted
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
  const grantedLanes = await resolveGrantedLanes(deps, lane)

  const gate = await deps.verify({ ...rangeFor(deps.ctx), lane, grantedLanes, skipTests: true })
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
  const withTests = await deps.verify({ ...rangeFor(deps.ctx), lane, grantedLanes, testDir: deps.ctx.headDir })
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
 * `fleet/review` — the non-author review of EVERY pull request, produced on
 * the runner against the exact head commit from a `.git`-less snapshot the
 * reviewers only ever READ.
 *
 * One job, one check, N reviews (#1158). The general non-author review
 * (`secondOpinion`) is mandatory and always runs; every reviewer PROFILE in
 * this run's review set (`decideReviewSet`) runs CONCURRENTLY WITH it, in
 * this same job and against the same export — never as its own GitHub job
 * and never as its own required-looking check. Composition rule, unchanged
 * from the per-specialist design it replaces: ANY FAIL FAILS, and an
 * UNREADABLE is a FAIL, so a profile's verdict can never be outranked by
 * the general reviewer's PASS.
 *
 * Concurrency is `Promise.allSettled`, deliberately: one reviewer throwing
 * must not discard the verdicts of the others, and a thrown reviewer is
 * recorded as UNREADABLE for itself rather than as an opaque job crash.
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

  const report = await deps.verify({
    ...rangeFor(deps.ctx),
    lane,
    grantedLanes: await resolveGrantedLanes(deps, lane),
    skipTests: true,
  })
  if (!report.passed) {
    return {
      ok: false,
      summary: `no review requested: ${report.reasons.join('; ') || 'mechanical verification failed'}`,
    }
  }

  // Decided HERE, in base code, from the PR's live labels and its own
  // content — never taken from the workflow step that invoked this process
  // (see `reviewSet`). The gate step decides the same thing separately, to
  // choose whether to spend a review at all; neither trusts the other.
  // Fails CLOSED both times.
  const set = await deps.reviewSet(report.changedFiles)
  if (!set.ok) return { ok: false, summary: `review set refused: ${set.reason}` }
  const profiles: ReviewerProfile[] = []
  for (const name of set.profiles) {
    const resolved = await deps.resolveProfile(name)
    if (!resolved.ok) return { ok: false, summary: `review set refused: ${resolved.reason}` }
    profiles.push(resolved.profile)
  }

  const diff = await deps.prDiff()

  // Exactly one review per PR per DIFF CONTENT per REVIEW SET. Keyed by a
  // hash of the diff itself (`review-cache.ts`), never the head SHA, so a
  // rebase that only replays the PR onto a newer `main` still hits;
  // namespaced by `reviewSetTag` so a PASS produced by the general reviewer
  // alone can never be re-published as one that also included a profile
  // that never ran.
  //
  // A lookup failure and a genuine cache miss are DELIBERATELY the same
  // thing here — `cached === undefined` — because both mean "run the
  // engine": see `artifactReviewCache`'s use of `ghJson`, which already
  // returns `undefined` rather than throwing. The `try` below exists only
  // because the cache is an injected interface, not `ghJson` itself, and
  // a future or test implementation of it could still throw; the fail-safe
  // direction must hold even then.
  const cacheKey: ReviewCacheKey = { pr: deps.ctx.pr, diffHash: diffHash(diff) }
  const exactScope = reviewSetTag(profiles.map((p) => p.agent))
  const cache = deps.cacheFor?.(exactScope)
  if (cache !== undefined) {
    let cached: CachedVerdict | undefined
    try {
      cached = await cache.lookup(cacheKey)
    } catch (e) {
      deps.log(`review cache lookup threw — running the engine (fail safe): ${e instanceof Error ? e.message : String(e)}`)
      cached = undefined
    }
    if (cached !== undefined) {
      deps.log(
        `review cache hit (${cached.verdict}) for PR ${deps.ctx.pr} ` +
        `(sha256:${cacheKey.diffHash.slice(0, 12)}…) — re-publishing instead of invoking the engine`,
      )
      // Re-published verdicts still reach the PR: a cached result must read
      // as a review, not as a bare status (see `publishReport`).
      await deps.publishReport([{ reviewer: GENERAL_REVIEWER, verdict: cached.verdict, body: cached.text }])
      return { ok: cached.verdict === 'PASS', summary: cached.text }
    }
  }

  // ONCE, and before any reviewer starts — see `stripExport`'s doc comment
  // for why this may not be left to `secondOpinion` now that the export has
  // concurrent readers. A strip that cannot run at all fails the check:
  // handing a reviewer an unstripped tree is not a review worth having.
  try {
    await deps.stripExport(deps.ctx.headDir)
  } catch (e) {
    return {
      ok: false,
      summary: 'review unavailable: could not strip agent configuration from the PR head export — ' +
        `refusing to hand any reviewer an unstripped tree: ${e instanceof Error ? e.message : String(e)}`,
    }
  }

  // The batch. `snapshotDir`, never `worktree`: the export already exists,
  // so this job runs no git and creates nothing. Zero execution of the
  // judged commit's code anywhere in this job — which is what lets it hold
  // the key, and what every reviewer in this batch inherits.
  const names = [GENERAL_REVIEWER, ...profiles.map((p) => p.agent)]
  const settled = await Promise.allSettled([
    deps.secondOpinion({ authorEngine: lane.engine, pr: deps.ctx.pr, snapshotDir: deps.ctx.headDir, diff, report }),
    ...profiles.map((p) => deps.profileReview(p, diff, report.changedFiles)),
  ])

  const results = settled.map((s, i) => {
    const name = names[i] as string
    // The general reviewer says "review unavailable"/"review misconfigured",
    // exactly as it did before this job learned to batch — that wording is
    // what an operator scans a red check for. A profile says its own name.
    const who = name === GENERAL_REVIEWER ? 'review' : name
    if (s.status === 'rejected') {
      const detail = s.reason instanceof Error ? s.reason.message : String(s.reason)
      return { name, verdict: 'UNREADABLE' as const, headline: `${who} unavailable: ${detail}`, text: detail }
    }
    const r = s.value
    // UNREADABLE and FAIL both fail, but they are different facts and the
    // summary says which: "the reviewer could not be run" is not "the
    // reviewer found a problem". Within UNREADABLE, `failureKind` draws one
    // more distinction: `'engine-misconfigured'` (a `--model`/engine id the
    // reviewer refuses outright) is a MISCONFIGURATION — a defect retrying
    // will never fix — not an AVAILABILITY problem, which is what
    // "unavailable" implies to a human reading the check. #866 hit exactly
    // this: the engine was reachable and ran, and still produced an opaque
    // `review unavailable: {"name":"UnknownError",...}` for what was,
    // underneath, a bad model id — the wrong diagnostic sent whoever read
    // it looking for an outage that was never happening.
    const unreadablePrefix = r.failureKind === 'engine-misconfigured' ? `${who} misconfigured` : `${who} unavailable`
    const headline = r.verdict === 'UNREADABLE'
      ? `${unreadablePrefix}: ${verdictSummary(r.text)}`
      : verdictSummary(r.text)
    return { name, verdict: r.verdict, headline, text: r.text }
  })

  const ok = results.every((r) => r.verdict === 'PASS')
  // A set of exactly one is the general reviewer on its own — the ordinary
  // case — and its summary is spelled EXACTLY as it was before this job
  // learned to batch, so the common check output did not change shape for a
  // feature most PRs never use. More than one gets a roll-call line first
  // (which reviewer said what, scannable without scrolling) and then every
  // reviewer's full text under its own heading.
  const summary = results.length === 1
    ? `${(results[0] as { headline: string }).headline}\n\n${(results[0] as { text: string }).text}`
    : `${results.length} reviews — ${results.map((r) => `${r.name}: ${r.verdict}`).join(', ')}\n\n` +
      results.map((r) => `### ${r.name}\n\n${r.headline}\n\n${r.text}`).join('\n\n---\n\n')
  const verdict: CiVerdict = { ok, summary }

  // Only a FRESH, SUBSTANTIVE verdict this process itself just produced is
  // ever recorded — never a cache hit being re-published (that would just
  // re-upload the identical artifact for no benefit), and never one where
  // ANY member of the set came back UNREADABLE.
  //
  // That last condition is the whole safety property of caching FAILs
  // (#1158). A parsed PASS/FAIL means every reviewer looked and decided; an
  // UNREADABLE means at least one could not look at all — a bad model id,
  // an outage, exhausted quota, a response with no verdict line. Pinning
  // that to a diff hash would hold the PR red until someone pushed a commit,
  // for a reason that had already gone away. One UNREADABLE poisons the
  // whole record, not just its own reviewer's: the set's composed verdict is
  // not a judgement of the diff if part of it never ran.
  const substantive = results.every((r) => r.verdict !== 'UNREADABLE')
  if (substantive && deps.cacheFor !== undefined) {
    // Recorded under the exact review set AND under the
    // general-reviewer-only namespace. Both directions are load-bearing,
    // and both exist because the review set for one diff CHANGES between
    // runs — this job clears the labels it acted on, and a human can add or
    // remove one at any time.
    //
    //   - A PASS: "every member of a SUPERSET passed" implies "every member
    //     of any subset passed", and the general reviewer is in every set,
    //     so this is sound proof for a later, smaller set. Without it the
    //     very next invocation after a label clear computes a smaller set,
    //     the namespace shifts, the lookup misses, and a review request
    //     aimed at somebody else turns an already-green, fully-reviewed PR
    //     red on `not-requested`.
    //   - A FAIL: NOT sound in the same way — the failure may have been the
    //     profile's, and a general-only run might legitimately pass. It is
    //     recorded anyway, deliberately, because the alternative is worse
    //     and is a fail-OPEN: a reviewer FAILS on diff D, somebody removes
    //     the label, the namespace shrinks, the FAIL is orphaned, and D
    //     goes GREEN with the defect still in it. A substantive FAIL is a
    //     fact about the DIFF; removing a label does not un-find a defect.
    //     The cost is a diff that stays red until it is actually changed,
    //     which is the direction a merge gate is supposed to err in.
    const scopes: (string | undefined)[] = exactScope === undefined ? [undefined] : [exactScope, undefined]
    for (const scope of scopes) {
      try {
        await deps.cacheFor(scope).record(cacheKey, { verdict: verdict.ok ? 'PASS' : 'FAIL', text: verdict.summary })
      } catch (e) {
        deps.log(`review cache record failed (non-fatal — this run's own verdict still stands): ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  await deps.publishReport(results.map((r) => ({ reviewer: r.name, verdict: r.verdict, body: r.text })))

  return verdict
}

/**
 * What `fleet-review.yml`'s "Decide whether to run the review engine" step
 * calls, before installing anything. The job carries NO job-level `if:` at
 * all and always reaches a real conclusion (#848: a job instantiated on an
 * event and then skipped by `if:` satisfies branch protection exactly like a
 * green check); this function is the whole decision, and its outcome becomes
 * that step's exit code:
 *
 *  - `review-set-unresolved` — checked FIRST, ahead of everything: the
 *    PR's labels could not be read, or a review the PR asks for (by label
 *    or by its own content) does not resolve to a known agent. FAILS the
 *    job. First because every later branch would otherwise be deciding
 *    against a review set it does not actually know, and "we could not work
 *    out what to review" must never become "nothing needed reviewing".
 *  - `cache-hit` — a prior SUBSTANTIVE verdict exists for this exact diff
 *    AND this exact review set (`reviewSetTag`). No model call either way:
 *    a cached PASS concludes the job successfully, a cached FAIL concludes
 *    it red with the original verdict restated (#1158 — a rebase that does
 *    not change the diff must not re-spend a review to reach the same
 *    conclusion; 10 and 8 runs on two failing PRs in one 12-hour window).
 *    Reached regardless of who the review was requested from, which is what
 *    makes a second review request on an already-reviewed PR cheap and
 *    non-destructive instead of a wasted re-review or (the old bug) a
 *    silently-satisfied skip. Namespacing by the review set is what stops a
 *    general-reviewer-only PASS from standing in for a set that also
 *    includes a profile that never ran. An UNREADABLE is never cached, so an
 *    infrastructure failure is always retried.
 *  - `low-tier` — no cached PASS, no reviewer profile in the set, and `tierFor`
 *    (impact.ts) classifies every changed file as Tier 0 or Tier 1: no
 *    executable content, or instructions/tooling that already earns a
 *    code-owner review on its own. Concludes the job successfully with no
 *    model call, regardless of `requested` — checked BEFORE the request
 *    check below, deliberately: a
 *    docs-only PR must conclude a real, auditable success rather than sit
 *    red forever waiting on a review it was never going to need. The tier
 *    and the file-level reasons are logged (and printed to the job's own
 *    stdout by `runReviewGate`, cli.ts) so the decision is auditable from
 *    the check's own output, not just from reading this file's source.
 *  - `not-requested` — no cached PASS, Tier 2 (a real review is needed), and
 *    this event did not ask us for one: the review was requested from
 *    somebody else, from a team, or this is not a review-request event at
 *    all (`reviewRequestFor`). Fails the job outright. A `fleet/review`
 *    nobody has asked for is not a passing review, and the old design's
 *    mistake was ever treating "not asked for" as anything other than a
 *    fail-closed red check.
 *  - `run-engine` — no cached PASS, Tier 2, and the review WAS requested of
 *    us. Carries the resolved review set (`profiles`) into `review-ci`, and
 *    the labels to clear once it passes (`clearLabels`).
 *
 * `runReviewCi` itself resolves the same set and opens with the identical
 * cache lookup — so a direct call to it from anywhere else stays correct on
 * its own — at the cost of one redundant lookup on the `run-engine` path.
 * That redundancy is cheap and never a correctness risk: both reads hit the
 * same cache with the same key and the same namespace.
 */
export type ReviewGateOutcome =
  | { kind: 'review-set-unresolved'; cacheKey: ReviewCacheKey; reason: string }
  | { kind: 'cache-hit'; cacheKey: ReviewCacheKey; verdict: CachedVerdict; profiles: string[] }
  | { kind: 'low-tier'; cacheKey: ReviewCacheKey; tier: ImpactTier; reasons: string[] }
  | { kind: 'bot-authored'; cacheKey: ReviewCacheKey; author: string; reason: string }
  | { kind: 'not-requested'; cacheKey: ReviewCacheKey }
  | { kind: 'run-engine'; cacheKey: ReviewCacheKey; profiles: string[]; clearLabels: string[] }

export interface ReviewGateDeps {
  ctx: CiContext
  prDiff(): Promise<string>
  /** The changed-file list this diff touches — `tierFor`'s input, and half
   *  of `decideReviewSet`'s. A separate read from `prDiff()` rather than
   *  derived from its text (see `ciChangedFiles`'s own comment on why a
   *  diff-text scan is not enough). */
  changedFiles(): Promise<string[]>
  /** The cache for one review-set namespace — the namespace is not known
   *  until the set has been decided, which is why this is a factory. */
  cacheFor(scope: string | undefined): ReviewCache
  /**
   * Whether THIS event asked US for a review — `reviewRequestFor` over the
   * workflow's own event fields. Computed by the caller so this function has
   * exactly one job: set first, cache second, tier third, request fourth.
   */
  requested: boolean
  /** The PR's author login — `FLEET_REVIEW_PR_AUTHOR`, the same field
   *  `reviewRequestFor` already consumes. Present so the gate can recognise
   *  an automated dependency PR by IDENTITY rather than by branch name. */
  prAuthor?: string | undefined
  /** `decideReviewSet` with its live PR read already wired — injected so
   *  this function needs no `gh` and no filesystem of its own. */
  reviewSet(changedFiles: readonly string[]): Promise<ReviewSetDecision>
  log(msg: string): void
}

export async function decideReviewGate(deps: ReviewGateDeps): Promise<ReviewGateOutcome> {
  const diff = await deps.prDiff()
  const cacheKey: ReviewCacheKey = { pr: deps.ctx.pr, diffHash: diffHash(diff) }
  const changedFiles = await deps.changedFiles()

  // FIRST, ahead of the cache, the tier and the request: work out WHAT this
  // PR is asking to have reviewed. Fail closed — an unanswerable review set
  // is a red check, never an empty one.
  const set = await deps.reviewSet(changedFiles)
  if (!set.ok) {
    deps.log(`review set unresolved for pr=${cacheKey.pr}: ${set.reason}`)
    return { kind: 'review-set-unresolved', cacheKey, reason: set.reason }
  }
  deps.log(set.profiles.length === 0
    ? `review set for pr=${cacheKey.pr}: ${GENERAL_REVIEWER} only`
    : `review set for pr=${cacheKey.pr}: ${GENERAL_REVIEWER}, ${set.reasons.join(', ')}`)

  // Identical fail-safe direction as `runReviewCi`: a lookup failure and a
  // genuine miss are indistinguishable on purpose, because both mean "this
  // is not yet a known-good diff" — see `artifactReviewCache`'s own doc.
  const cache = deps.cacheFor(reviewSetTag(set.profiles))
  let cached: CachedVerdict | undefined
  try {
    cached = await cache.lookup(cacheKey)
  } catch (e) {
    deps.log(`review cache lookup threw — treating pr=${cacheKey.pr} as a miss (fail safe): ${e instanceof Error ? e.message : String(e)}`)
    cached = undefined
  }
  if (cached !== undefined) {
    deps.log(`reused ${cached.verdict} verdict for pr=${cacheKey.pr} sha256:${cacheKey.diffHash.slice(0, 12)}… — no engine call`)
    return { kind: 'cache-hit', cacheKey, verdict: cached, profiles: set.profiles }
  }

  // Automated dependency PRs: a real check, concluded green, with no model
  // call — placed AFTER the review-set resolution above so that a profile
  // somebody deliberately put on the PR still wins, exactly as it outranks
  // the tier heuristic below. An unlabelled Dependabot bump skips; one a
  // human labelled `review:crypto` does not.
  //
  // This exists because the review was not merely expensive on these PRs, it
  // was unreachable: `fleet-review.yml` fires only on `review_requested`, and
  // Dependabot force-pushes on every rebase. The push orphans the verdict,
  // GitHub emits no new event because the reviewer is ALREADY requested, and
  // the required `fleet/review` context stays absent forever. Six bumps sat
  // unmergeable for a day in exactly that state, each showing an "active"
  // review that could never complete.
  const skipAuthor = loginOf(deps.prAuthor)
  if (skipAuthor !== undefined && set.profiles.length === 0 &&
      REVIEW_SKIP_AUTHORS.some((a) => a.toLowerCase() === skipAuthor)) {
    const reason = `authored by ${skipAuthor} — automated dependency update, no model review`
    deps.log(`pr=${cacheKey.pr} ${reason} (a human still merges it)`)
    return { kind: 'bot-authored', cacheKey, author: skipAuthor, reason }
  }

  // Ordered here — after the cache check, before the request check — per
  // the operator rule this implements: ceremony should scale with impact. A
  // diff with no reviewable content (Tier 0/1) must conclude a real success
  // on its own, never wait on someone to request a model review it will
  // never need.
  //
  // ANY profile in the set overrides that, whichever input put it there. A
  // label is somebody deciding this particular diff needs a particular pair
  // of eyes; a content-derived profile is the PR's own paths or prose
  // saying the same thing. Neither may be dropped by a tier heuristic
  // WITHOUT A WORD, which is what a `low-tier` green would be — and the
  // operator's rule is explicit: a PR that is plainly a crypto change gets
  // the crypto review whether or not anyone remembered the label.
  const { tier, reasons } = tierFor(changedFiles)
  if (tier < 2 && set.profiles.length > 0) {
    deps.log(
      `pr=${cacheKey.pr} is tier ${tier}, but ${set.profiles.join(', ')} is in its review set — ` +
      'a named reviewer outranks the tier',
    )
  }
  if (tier < 2 && set.profiles.length === 0) {
    deps.log(`no reviewable content (tier ${tier}) for pr=${cacheKey.pr} — ${reasons.join('; ') || 'no changed files'}`)
    return { kind: 'low-tier', cacheKey, tier, reasons }
  }

  if (!deps.requested) {
    // Whom to ask instead depends on who wrote the PR (`reviewTriggerLogins`)
    // — the caller has the event and says so; naming one fixed login here
    // told #1183's author to request itself (#1232).
    deps.log(`review not requested for pr=${cacheKey.pr} sha256:${cacheKey.diffHash.slice(0, 12)}… — no engine call`)
    return { kind: 'not-requested', cacheKey }
  }

  return { kind: 'run-engine', cacheKey, profiles: set.profiles, clearLabels: set.fromLabels }
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
