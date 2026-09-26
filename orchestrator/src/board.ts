import ignore, { type Ignore } from 'ignore'
import { checkHalt } from './killswitch.js'
import { isQuotaHaltReason } from './circuit.js'
import { REPO, gh, ghJson, describeGhFailure } from './gh.js'
import { REVIEW_JOB } from './ci.js'
import { specialistMergeBlockers, describeSpecialistBlockers } from './specialist.js'

/**
 * `llamenos-fleet board` — the deterministic gate decision table.
 *
 * Same principle as `status.ts` (G1, see its own module comment): every fact
 * is derived live from `gh` at read time, nothing is cached, nothing is a
 * label. This module adds two things `status.ts` does not need for a single
 * item: a total classification of EVERY open PR into exactly one action, and
 * the infrastructure-vs-substantive split for a failed `fleet/review`.
 *
 * Split the same way `ci.ts`/`status.ts` are: a pure decision function
 * (`buildBoard`) that takes an already-gathered `BoardFacts` and returns a
 * `BoardView` — this is where the classification tests live, with zero
 * network — and a separate, impure gather step (`fetchBoardFacts`) that
 * turns real `gh` calls into that same `BoardFacts` shape. `board` itself
 * (cli.ts) does nothing but call gather then render; it never labels,
 * approves, merges, or re-runs anything (see the module-level "Read-only"
 * note near `renderBoard`).
 */

// ---------------------------------------------------------------------------
// Facts — exactly what `gh` can answer, nothing inferred yet.
// ---------------------------------------------------------------------------

export type CheckState = 'PASS' | 'FAIL' | 'PENDING'

export type ReviewFailureKind = 'infrastructure' | 'substantive'

/**
 * One GraphQL `CheckRun` or `StatusContext` off a PR's `commits(last:1)`
 * rollup. Today every one of `ci-status`/`fleet/verify`/`fleet/review` is a
 * genuine GitHub Actions job — see `ci.ts`'s own comment ("An Actions job
 * already IS a check run... posting a same-named status on top would be a
 * second copy") — so all three currently surface as `CheckRun`, never
 * `StatusContext`. Both shapes are still fetched and normalized here: a
 * commit status (`StatusContext`) is how an external tool (a third-party CI,
 * a status-API-only GitHub App) would post instead, and a query that only
 * read one shape would silently never see a required context implemented
 * that way — the asymmetry that let the by-hand version of this command trip
 * on `fleet/review` before this command existed. This type carries both so
 * `buildBoard` does not have to care which one any given context turns out
 * to be.
 *
 * `sha` is carried explicitly, not assumed to already equal the PR's head —
 * even though `fetchBoardFacts` always sets it from the SAME `commits(last:1)`
 * node the rollup came from (so in practice it is always the head). The
 * field exists so `buildBoard` can — and does — enforce the head-binding
 * rule ITSELF (see `checksOnHead` below) rather than trusting that whatever
 * gathered these facts already filtered correctly. That is what makes the
 * #862 regression (a `fleet/review` SUCCESS read off a stale SHA) a case
 * `buildBoard`'s own tests can pin down with nothing but a `BoardFacts`
 * literal — no mocked `gh` calls involved.
 */
export interface PrCheckContext {
  name: string
  kind: 'CheckRun' | 'StatusContext'
  sha: string
  state: CheckState
  /** CheckRun only. The workflow run's own `run_attempt` — used to tell "an
   *  infra-failed fleet/review that has not been retried yet" from "already
   *  retried once and still infra-failing" without any state file (see
   *  `classifyReviewFailure`'s own comment). `undefined` for a
   *  `StatusContext`, or when the run could not be resolved. */
  runAttempt?: number
  /** Populated ONLY for a FAILed `fleet/review` CheckRun — the job's own
   *  step list, already classified by `classifyReviewFailure`. Every other
   *  context (passing, pending, or not `fleet/review`) leaves this
   *  `undefined`; `buildBoard` never reads it for anything but a failed
   *  `fleet/review` context, so an unrelated context populating it would be
   *  inert, not misleading. */
  reviewFailureKind?: ReviewFailureKind
}

export interface PrFact {
  number: number
  authorLogin: string
  isDraft: boolean
  createdAt: string
  headRefOid: string
  headRefName: string
  /** The branch the PR merges INTO — the ruleset that gates it is the one
   *  for this branch (see `BoardFacts.gates`). */
  baseRefName: string
  /** GitHub's own verdict on whether the merge button works right now —
   *  `CLEAN` | `UNSTABLE` | `HAS_HOOKS` | `BLOCKED` | `BEHIND` | `DIRTY` |
   *  `UNKNOWN` | `DRAFT`. Read as the final word on MERGE (see
   *  `classifyPr`), never as a substitute for deriving WHY. */
  mergeStateStatus: string
  labels: string[]
  /** `latestOpinionatedReviews(writersOnly: true)` — each writer's latest
   *  APPROVED / CHANGES_REQUESTED / DISMISSED review. Deliberately NOT
   *  `reviewDecision`: under a repository ruleset GitHub reports
   *  `reviewDecision: null` even on a PR the ruleset's code-owner rule is
   *  blocking (verified live 2026-09-25 on #970, which touches the owned
   *  `apps/worker/middleware/`), so it cannot answer "is review satisfied". */
  reviews: PrReview[]
  /** Changed paths, as far as the query's page reached — compare against
   *  `changedFiles` before treating it as the whole diff. */
  files: string[]
  /** GitHub's own count of changed files; `> files.length` means `files` was
   *  truncated and cannot prove the PR touches no code-owned path. */
  changedFiles: number
  /** Every context off `commits(last:1)`'s rollup — CheckRun and
   *  StatusContext both, unfiltered by SHA (see `PrCheckContext.sha`). */
  checks: PrCheckContext[]
}

export interface PrReview { login: string; state: string }

export interface FleetStateFact {
  halted: boolean
  haltReason?: string
  /** `true` for exactly the halt reasons `circuit.ts`'s `quotaBreaker`
   *  produces (`isQuotaHaltReason`) — never for a human-typed halt, a
   *  GitHub `halt`-labelled issue, or the plain consecutive-failures/rate
   *  breakers. */
  isQuotaHalt: boolean
}

/**
 * What the base branch's live repository ruleset demands of a PR —
 * `GET /repos/{owner}/{repo}/rules/branches/{branch}`, reduced by
 * `deriveBranchRuleset`. This repo gates `main` with a ruleset and nothing
 * else: `GET .../branches/main/protection` answers 404 "Branch not
 * protected", so anything that learns the required set from classic branch
 * protection learns nothing and falls back to a guess.
 */
export interface BranchRuleset {
  branch: string
  /** Union of every `required_status_checks` rule's contexts, in first-seen order. */
  requiredContexts: string[]
  requireCodeOwnerReview: boolean
  requiredApprovingReviewCount: number
  requireExtraApprovalForUnattributedChanges: boolean
}

/** `ok: false` is "could not learn the ruleset" — never "no rules". A board
 *  that cannot read the required set says so (CANNOT_DECIDE) instead of
 *  substituting one. */
export type RulesetFact = { ok: true; rules: BranchRuleset } | { ok: false; reason: string }

/** One CODEOWNERS line. `owners` are logins/team slugs without the `@`; an
 *  empty list is a line that un-owns what it matches (last match wins). */
export interface CodeOwnerRule { pattern: string; owners: string[] }

export type CodeOwnersFact = { ok: true; rules: CodeOwnerRule[] } | { ok: false; reason: string }

/** Everything about a base branch that gates merges into it. `codeOwners`
 *  is only gathered when the ruleset requires code-owner review, and is
 *  `undefined` otherwise. */
export interface BranchGate {
  ruleset: RulesetFact
  codeOwners?: CodeOwnersFact
}

export interface BoardFacts {
  fleet: FleetStateFact
  prs: PrFact[]
  /** Keyed by base branch name, gathered once per invocation (see
   *  `fetchBoardFactsWith`). A PR whose base has no entry is CANNOT_DECIDE. */
  gates: Record<string, BranchGate>
}

// ---------------------------------------------------------------------------
// Classification — every open PR lands in exactly one of these.
// ---------------------------------------------------------------------------

/**
 * `REVIEW_BLOCKED`: every required check passes but the ruleset's
 * `pull_request` rule does not — a code-owned path with no code-owner
 * approval (including the case where the author is the only owner, and
 * self-approval is impossible), too few approvals, or changes requested.
 *
 * `CANNOT_DECIDE`: the facts the decision needs (the ruleset, or CODEOWNERS
 * when the ruleset requires code-owner review) could not be read. Never
 * collapsed into a guess: a decision table that guesses is worse than one
 * that says it cannot decide.
 */
export type BoardAction =
  | 'MERGE' | 'APPROVE_THEN_MERGE' | 'LABEL_FOR_REVIEW' | 'RERUN_REVIEW'
  | 'NEEDS_FIX' | 'REVIEW_BLOCKED' | 'WAITING' | 'STALE_LABEL' | 'OPERATOR' | 'CANNOT_DECIDE'

export interface BoardRow {
  number: number
  author: string
  action: BoardAction
  headRefOid: string
  /** Names of the required contexts that are actually failing — populated
   *  only for `NEEDS_FIX`; empty for every other action. */
  failingContexts: string[]
  reason: string
}

export interface BoardView {
  fleet: FleetStateFact
  /** Sorted by action (most-actionable first — see `ACTION_ORDER`), then by
   *  PR number within an action. */
  rows: BoardRow[]
}

/** Branch name knope's own release-PR automation uses — never a fleet branch
 *  (`fleet/<lane>/<item>`), so `ci.ts`'s `laneIdFromBranch` already treats it
 *  as unscoped; this module only needs the literal name to recognise it. */
const RELEASE_BRANCH = 'release'

/**
 * GitHub's bot logins are inconsistent across surfaces: the REST API
 * typically reports `dependabot[bot]`/`github-actions[bot]`, but a live
 * `gh api graphql` query against THIS repo's own open PRs (verified
 * 2026-09-19, PR #594 authored by knope's release automation and #626/#630/
 * #831/#832 by Dependabot) shows GraphQL's `PullRequest.author.login`
 * returning the bare `github-actions` / `dependabot` — no `[bot]` suffix, no
 * `app/` prefix. All four shapes are matched, plus the two general
 * suffix/prefix patterns GitHub uses for other bot/App accounts, so a future
 * surface returning yet another format is still caught. Overinclusive on
 * purpose: the only consequence of a false positive here is asking for one
 * extra code-owner approval that `require_extra_approval_for_unattributed_
 * changes` did not actually require, never a false MERGE of unreviewed
 * bot-authored code.
 */
const KNOWN_BOT_LOGINS: ReadonlySet<string> = new Set([
  'dependabot', 'github-actions', 'app/dependabot', 'app/github-actions',
  'dependabot[bot]', 'github-actions[bot]',
])

export function isBotAuthor(login: string): boolean {
  return KNOWN_BOT_LOGINS.has(login) || login.endsWith('[bot]') || login.startsWith('app/')
}

/**
 * Pure. Reduces the raw `rules/branches/{branch}` body to the requirements
 * the board gates on. Every rule that applies to the branch is folded in —
 * `required_status_checks` contexts are UNIONED across rules (two rulesets
 * each requiring different checks means a PR needs all of them), and the
 * `pull_request` requirements take the strictest value any rule sets.
 *
 * Refuses (`ok: false`) rather than returning a thin ruleset when the body
 * is not a rule list, a `required_status_checks` entry is malformed, or no
 * rule requires any status check at all: every one of those means the board
 * does not know what GitHub will demand, and an empty required set would
 * make every PR look mergeable on checks.
 *
 * A required check's `integration_id` (a check that must come from one
 * specific GitHub App) is not modelled — only the context name is matched.
 * `mergeStateStatus` (see `classifyPr`) still refuses MERGE if GitHub
 * disagrees, and so do `require_last_push_approval` and
 * `required_review_thread_resolution`.
 */
export function deriveBranchRuleset(branch: string, raw: unknown): RulesetFact {
  if (!Array.isArray(raw)) {
    return { ok: false, reason: `rules/branches/${branch} did not return a rule list` }
  }
  if (raw.length === 0) {
    return { ok: false, reason: `no active ruleset applies to ${branch}` }
  }
  const contexts = new Set<string>()
  let requireCodeOwnerReview = false
  let requiredApprovingReviewCount = 0
  let requireExtraApprovalForUnattributedChanges = false

  for (const rule of raw as { type?: unknown; parameters?: Record<string, unknown> }[]) {
    const params = rule.parameters ?? {}
    if (rule.type === 'required_status_checks') {
      const checks = params.required_status_checks
      if (!Array.isArray(checks)) {
        return { ok: false, reason: `a required_status_checks rule on ${branch} carries no check list` }
      }
      for (const check of checks as { context?: unknown }[]) {
        if (typeof check.context !== 'string' || check.context.length === 0) {
          return { ok: false, reason: `a required_status_checks rule on ${branch} has an entry with no context name` }
        }
        contexts.add(check.context)
      }
    } else if (rule.type === 'pull_request') {
      requireCodeOwnerReview ||= params.require_code_owner_review === true
      requireExtraApprovalForUnattributedChanges ||= params.require_extra_approval_for_unattributed_changes === true
      const count = params.required_approving_review_count
      if (typeof count === 'number') requiredApprovingReviewCount = Math.max(requiredApprovingReviewCount, count)
    }
  }

  if (contexts.size === 0) {
    return { ok: false, reason: `the rules for ${branch} require no status checks — refusing to treat an empty required set as "all green"` }
  }
  return {
    ok: true,
    rules: {
      branch,
      requiredContexts: [...contexts],
      requireCodeOwnerReview,
      requiredApprovingReviewCount,
      requireExtraApprovalForUnattributedChanges,
    },
  }
}

/** Pure. CODEOWNERS text → rules, in file order. Comments and blank lines
 *  are dropped; the `@` is stripped from each owner. */
export function parseCodeOwners(text: string): CodeOwnerRule[] {
  const rules: CodeOwnerRule[] = []
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/(^|\s)#.*$/, '').trim()
    if (line.length === 0) continue
    const [pattern, ...owners] = line.split(/\s+/)
    if (pattern === undefined) continue
    rules.push({ pattern, owners: owners.map((o) => o.replace(/^@/, '')) })
  }
  return rules
}

const compiledPatterns = new WeakMap<CodeOwnerRule, Ignore>()

/**
 * Pure. The owners of `path`: the LAST matching rule's owners, the way GitHub
 * resolves CODEOWNERS. Matched with the `ignore` package's gitignore
 * semantics — the same syntax GitHub parses CODEOWNERS with, and the same
 * matcher `tests/orchestrator/codeowners.ts` holds the real file to — never a
 * prefix comparison (`apps/worker/lib/auth` does not own `auth.ts`).
 */
export function codeOwnersOf(rules: CodeOwnerRule[], path: string): string[] {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]
    if (rule === undefined) continue
    let matcher = compiledPatterns.get(rule)
    if (matcher === undefined) {
      matcher = ignore().add(rule.pattern)
      compiledPatterns.set(rule, matcher)
    }
    if (matcher.ignores(path)) return rule.owners
  }
  return []
}

/**
 * THE head-binding rule (see the module docstring and `PrCheckContext.sha`'s
 * own comment): every context this module ever looks at is filtered down to
 * ones bound to the PR's CURRENT `headRefOid` first. A context recorded
 * against any other commit does not exist as far as classification is
 * concerned — it is never "helpfully" reused, which is exactly the #862
 * regression (a `fleet/review` SUCCESS read off a stale SHA very nearly
 * green-lit a merge).
 */
function checksOnHead(pr: PrFact): PrCheckContext[] {
  return pr.checks.filter((c) => c.sha === pr.headRefOid)
}

/** The state of a required context on the head, or `undefined` if nothing
 *  by that name posted. Several same-named contexts (two workflows both
 *  naming a job `CodeQL`) resolve to the WORST of them — a red one is never
 *  hidden behind a green one that happened to be listed first. */
function requiredContextState(onHead: PrCheckContext[], name: string): CheckState | undefined {
  const states = onHead.filter((c) => c.name === name).map((c) => c.state)
  if (states.length === 0) return undefined
  if (states.includes('FAIL')) return 'FAIL'
  if (states.includes('PENDING')) return 'PENDING'
  return 'PASS'
}

/**
 * `fleet-review.yml`'s own step names, verbatim (see the file's own
 * comments): "Resolve the base/head SHAs...", "Checkout the PR BASE
 * (trusted)", "Export the PR head as data", "Setup Bun", "Install
 * dependencies (base lockfile, no install scripts)", "Check the base
 * provides the review gate itself", "Decide whether to run the review
 * engine", "Install the non-author review engine", "Authenticate the review
 * engine", "Smoke-test the review engine", "Check the base provides the
 * gate", "Review", "Cache the verdict, if this run produced a fresh PASS".
 *
 * A failure in the step named exactly "Review" is the model's OWN verdict —
 * substantive, and this classifier must never suggest retrying it: a retry
 * of a real FAIL is not what "an engine that could not run" needs, and
 * treating it as infrastructure would let a genuine problem get silently
 * re-rolled instead of surfaced to a human (see `RERUN_REVIEW`'s own
 * doc comment on `classifyPr` below, and the rail in board.test.ts pinning
 * this exact case).
 *
 * Every other step failing — checkout, dependency install, either
 * "base provides..." bootstrap guard, the engine install/auth/smoke-test —
 * is this fleet's OWN infrastructure breaking before the model ever ran, and
 * is exactly what `RERUN_REVIEW` exists to recover from automatically. A
 * step list with no step literally named "Review" present at all (the job
 * failed before reaching it) falls into this branch for the same reason.
 */
export interface WorkflowStep { name: string; conclusion: string | null }

export function classifyReviewFailure(steps: WorkflowStep[]): ReviewFailureKind {
  const reviewStep = steps.find((s) => s.name === 'Review')
  if (reviewStep !== undefined && reviewStep.conclusion === 'failure') return 'substantive'
  return 'infrastructure'
}

/**
 * `classifyPr`'s own action space is one wider than the public `BoardAction`:
 * `LABEL_FOR_REVIEW_CANDIDATE` marks a PR that passed every cheap check and
 * has no `fleet/review` verdict on its head and no `review` label yet — a
 * CANDIDATE for `LABEL_FOR_REVIEW`, not yet the verdict. `buildBoard` caps
 * how many candidates actually become `LABEL_FOR_REVIEW` to one per
 * invocation (see its own comment), demoting every other candidate to
 * `WAITING`. This internal action never reaches a `BoardRow` — `buildBoard`
 * resolves every one of them before rows are built.
 */
export interface PrClassification {
  action: BoardAction | 'LABEL_FOR_REVIEW_CANDIDATE'
  reason: string
  failingContexts: string[]
}

/**
 * Pure. What the ruleset's `pull_request` rule still demands of this PR, as
 * human-readable blockers — empty means review is satisfied. Approvals are
 * each writer's LATEST opinionated review, the author's own never counted
 * (GitHub never lets a PR author approve their own PR).
 *
 * `needsApprovalOnly` is `true` when every blocker is a missing approval
 * that some OTHER person could give — the distinction between
 * `APPROVE_THEN_MERGE` (a bot PR the operator can approve) and a PR that is
 * stuck regardless (changes requested).
 *
 * Code-owner review is checked per changed path against the base branch's
 * CODEOWNERS: each owned path needs an approval from one of its owners. A
 * team owner (`org/team`) is never assumed satisfied — the board cannot see
 * team membership, so it refuses rather than guesses. A truncated file list
 * cannot prove the PR touches no owned path, so it blocks too.
 */
export function reviewBlockers(
  pr: PrFact, rules: BranchRuleset, codeOwners: CodeOwnerRule[] | undefined,
): { blockers: string[]; needsApprovalOnly: boolean } {
  const blockers: string[] = []
  let needsApprovalOnly = true
  const approvers = new Set(
    pr.reviews.filter((r) => r.state === 'APPROVED' && r.login !== pr.authorLogin).map((r) => r.login),
  )

  const changesRequestedBy = pr.reviews.filter((r) => r.state === 'CHANGES_REQUESTED').map((r) => `@${r.login}`)
  if (changesRequestedBy.length > 0) {
    blockers.push(`changes requested by ${changesRequestedBy.join(', ')}`)
    needsApprovalOnly = false
  }

  if (approvers.size < rules.requiredApprovingReviewCount) {
    blockers.push(`${approvers.size}/${rules.requiredApprovingReviewCount} required approving reviews`)
  }

  if (rules.requireCodeOwnerReview && codeOwners !== undefined) {
    if (pr.changedFiles > pr.files.length) {
      blockers.push(`only ${pr.files.length} of ${pr.changedFiles} changed files were read — cannot prove no code-owned path is touched`)
    }
    const unapproved = pr.files.filter((path) => {
      const owners = codeOwnersOf(codeOwners, path)
      return owners.length > 0 && !owners.some((o) => !o.includes('/') && approvers.has(o))
    })
    if (unapproved.length > 0) {
      const shown = unapproved.slice(0, 3).join(', ') + (unapproved.length > 3 ? ` (+${unapproved.length - 3} more)` : '')
      blockers.push(`code-owner review required (require_code_owner_review) for ${shown}`)
      const onlyOwnerIsAuthor = unapproved.some((path) => {
        const owners = codeOwnersOf(codeOwners, path)
        return owners.every((o) => o === pr.authorLogin)
      })
      if (onlyOwnerIsAuthor) needsApprovalOnly = false
    }
  }

  if (rules.requireExtraApprovalForUnattributedChanges && isBotAuthor(pr.authorLogin) && approvers.size === 0) {
    blockers.push('bot-authored PR needs an approval (require_extra_approval_for_unattributed_changes)')
  }

  return { blockers, needsApprovalOnly }
}

/** `mergeStateStatus` values under which GitHub's merge button works:
 *  `UNSTABLE` is a failing NON-required check, `HAS_HOOKS` is a clean merge
 *  with pre-receive hooks. Every other value refuses MERGE. */
const MERGEABLE_STATES: ReadonlySet<string> = new Set(['CLEAN', 'UNSTABLE', 'HAS_HOOKS'])

function cannotDecide(reason: string): PrClassification {
  return { action: 'CANNOT_DECIDE', reason, failingContexts: [] }
}

/**
 * The one, total function every open PR passes through. Every branch below
 * returns — there is no fallthrough default, so a PR can never silently miss
 * the board the way #862's stale-SHA read did.
 *
 * The required set is `gate.ruleset` — the live ruleset for the PR's base
 * branch — and nothing else. It used to be a hardcoded
 * `['ci-status', 'fleet/verify']`, which is how #961 (`gitleaks=fail`, every
 * hardcoded context green) was classified MERGE and then refused by GitHub.
 */
export function classifyPr(pr: PrFact, gate: BranchGate): PrClassification {
  if (pr.isDraft) {
    return { action: 'OPERATOR', reason: 'draft PR — never auto-actionable', failingContexts: [] }
  }
  if (pr.headRefName === RELEASE_BRANCH && isBotAuthor(pr.authorLogin)) {
    return {
      action: 'OPERATOR',
      reason: 'knope release PR on branch "release" — cutting a release is a human decision, never automated',
      failingContexts: [],
    }
  }

  if (!gate.ruleset.ok) {
    return cannotDecide(`the required set for ${pr.baseRefName} is unknown: ${gate.ruleset.reason}`)
  }
  const rules = gate.ruleset.rules
  let codeOwners: CodeOwnerRule[] | undefined
  if (rules.requireCodeOwnerReview) {
    if (gate.codeOwners === undefined) return cannotDecide(`the ${pr.baseRefName} ruleset requires code-owner review but CODEOWNERS was not read`)
    if (!gate.codeOwners.ok) return cannotDecide(`the ${pr.baseRefName} ruleset requires code-owner review but CODEOWNERS is unreadable: ${gate.codeOwners.reason}`)
    codeOwners = gate.codeOwners.rules
  }

  // Every required context except `fleet/review`, which gets its own richer
  // tree below. `fleet/review` is required by the fleet's own policy even if
  // the ruleset stopped requiring it — the board only ever gets stricter
  // than the ruleset, never looser.
  const onHead = checksOnHead(pr)
  const cheap = rules.requiredContexts
    .filter((name) => name !== REVIEW_JOB)
    .map((name) => ({ name, state: requiredContextState(onHead, name) }))
  const cheapFailing = cheap.filter((c) => c.state === 'FAIL')
  const cheapPendingOrMissing = cheap.filter((c) => c.state === undefined || c.state === 'PENDING')

  if (cheapFailing.length > 0) {
    return {
      action: 'NEEDS_FIX',
      reason: 'required check(s) failed',
      failingContexts: cheapFailing.map((c) => c.name),
    }
  }
  if (cheapPendingOrMissing.length > 0) {
    return {
      action: 'WAITING',
      reason: `required check(s) still in flight or not yet posted on this head: ${cheapPendingOrMissing.map((c) => c.name).join(', ')}`,
      failingContexts: [],
    }
  }

  // #1092: label-driven specialists (`fleet/review/<agent>`) are NOT in the
  // ruleset — a conditionally-posted check cannot be required — so they
  // bind HERE, at the merge decision, ahead of `fleet/review` itself: any
  // FAIL fails (a specialist FAIL outranks a generalist PASS), one still in
  // flight waits, and one requested by label with no check on this head
  // (a push since the label) needs the label re-applied.
  const specialists = specialistMergeBlockers(onHead, pr.labels)
  if (specialists.failing.length > 0) {
    return { action: 'NEEDS_FIX', reason: describeSpecialistBlockers(specialists), failingContexts: specialists.failing }
  }
  if (specialists.pending.length > 0) {
    return { action: 'WAITING', reason: describeSpecialistBlockers(specialists), failingContexts: [] }
  }
  if (specialists.missing.length > 0) {
    return { action: 'STALE_LABEL', reason: describeSpecialistBlockers(specialists), failingContexts: [] }
  }

  // Every cheap context is pass-or-skip on the current head. `fleet/review`
  // gets its own tree from here — ABSENT / PENDING / PASS / FAIL, FAIL split
  // into infrastructure vs substantive.
  const review = onHead.find((c) => c.name === REVIEW_JOB)
  const hasReviewLabel = pr.labels.includes('review')

  if (review === undefined) {
    if (hasReviewLabel) {
      // #862's own shape: the label says "review requested" but there is no
      // verdict bound to THIS head — re-triggering means removing and
      // re-adding the label (see the brief), never inferred as a pending
      // request.
      return {
        action: 'STALE_LABEL',
        reason: 'carries the "review" label but has no fleet/review verdict on the current head — remove and re-add the label to re-trigger',
        failingContexts: [],
      }
    }
    return { action: 'LABEL_FOR_REVIEW_CANDIDATE', reason: 'cheap checks pass; no review requested yet', failingContexts: [] }
  }

  if (review.state === 'PENDING') {
    return { action: 'WAITING', reason: 'fleet/review is in flight on the current head', failingContexts: [] }
  }

  if (review.state === 'PASS') {
    const { blockers, needsApprovalOnly } = reviewBlockers(pr, rules, codeOwners)
    if (blockers.length > 0) {
      if (isBotAuthor(pr.authorLogin) && needsApprovalOnly) {
        return {
          action: 'APPROVE_THEN_MERGE',
          reason: `every required check is green; bot-authored PR needs an approval before GitHub will merge: ${blockers.join('; ')}`,
          failingContexts: [],
        }
      }
      return {
        action: 'REVIEW_BLOCKED',
        reason: `every required check is green, but the ${pr.baseRefName} ruleset's review requirements are not met: ${blockers.join('; ')}`,
        failingContexts: [],
      }
    }
    // Everything the board derives from the ruleset is satisfied. GitHub's
    // own mergeStateStatus is still the last word — it is what `gh pr merge`
    // obeys, and it sees requirements the board does not model.
    if (pr.mergeStateStatus === 'DIRTY') {
      return { action: 'NEEDS_FIX', reason: 'merge conflict with the base branch (mergeStateStatus=DIRTY)', failingContexts: [] }
    }
    if (pr.mergeStateStatus === 'UNKNOWN') {
      return { action: 'WAITING', reason: 'GitHub has not computed mergeability yet (mergeStateStatus=UNKNOWN)', failingContexts: [] }
    }
    if (!MERGEABLE_STATES.has(pr.mergeStateStatus)) {
      return {
        action: 'OPERATOR',
        reason: `every ruleset requirement the board models is met, yet GitHub reports mergeStateStatus=${pr.mergeStateStatus} — a requirement the board does not model; investigate before merging`,
        failingContexts: [],
      }
    }
    return { action: 'MERGE', reason: 'every ruleset-required context is pass-or-skip on the current head and its review requirements are met', failingContexts: [] }
  }

  // review.state === 'FAIL'
  if (review.reviewFailureKind === 'substantive') {
    return {
      action: 'NEEDS_FIX',
      reason: 'fleet/review found a real problem on the current head — never auto-retried',
      failingContexts: [REVIEW_JOB],
    }
  }
  if ((review.runAttempt ?? 1) <= 1) {
    return {
      action: 'RERUN_REVIEW',
      reason: 'fleet/review failed for an infrastructure reason (not the "Review" step itself) and has not been retried yet',
      failingContexts: [],
    }
  }
  return {
    action: 'NEEDS_FIX',
    reason: 'fleet/review failed for an infrastructure reason and was already retried once — needs a human, not another auto-retry',
    failingContexts: [REVIEW_JOB],
  }
}

/** Most-actionable first — see `renderBoard`'s own comment for why this
 *  ordering, not alphabetical or PR-number order, is the default grouping. */
const ACTION_ORDER: readonly BoardAction[] = [
  'CANNOT_DECIDE', 'MERGE', 'APPROVE_THEN_MERGE', 'RERUN_REVIEW', 'NEEDS_FIX',
  'REVIEW_BLOCKED', 'LABEL_FOR_REVIEW', 'STALE_LABEL', 'WAITING', 'OPERATOR',
]

/**
 * Pure: every fact `buildBoard` needs is already in `facts` — no `gh` call,
 * no filesystem read, no label read. `classifyPr` decides every PR
 * independently; this function's only extra job is the cross-PR
 * `LABEL_FOR_REVIEW` cap (batching review requests correlates with engine
 * smoke failures — see the brief — so at most one PR per invocation ever
 * carries it, chosen as the OLDEST eligible by PR number, never by
 * `createdAt` or list order).
 */
export function buildBoard(facts: BoardFacts): BoardView {
  const classified = facts.prs.map((pr) => {
    const gate: BranchGate = facts.gates[pr.baseRefName]
      ?? { ruleset: { ok: false, reason: `no ruleset was gathered for base branch ${pr.baseRefName}` } }
    return { pr, result: classifyPr(pr, gate) }
  })

  const candidates = classified
    .filter((c) => c.result.action === 'LABEL_FOR_REVIEW_CANDIDATE')
    .sort((a, b) => a.pr.number - b.pr.number)
  const chosenNumber = candidates[0]?.pr.number

  const rows: BoardRow[] = classified.map(({ pr, result }) => {
    if (result.action === 'LABEL_FOR_REVIEW_CANDIDATE') {
      const chosen = pr.number === chosenNumber
      return {
        number: pr.number,
        author: pr.authorLogin,
        headRefOid: pr.headRefOid,
        failingContexts: [],
        action: chosen ? 'LABEL_FOR_REVIEW' : 'WAITING',
        reason: chosen
          ? result.reason
          : `${result.reason} — deferred: only one PR gets labelled for review per invocation (#${chosenNumber} is older)`,
      }
    }
    return {
      number: pr.number,
      author: pr.authorLogin,
      headRefOid: pr.headRefOid,
      action: result.action,
      failingContexts: result.failingContexts,
      reason: result.reason,
    }
  })

  rows.sort((a, b) => ACTION_ORDER.indexOf(a.action) - ACTION_ORDER.indexOf(b.action) || a.number - b.number)

  return { fleet: facts.fleet, rows }
}

// ---------------------------------------------------------------------------
// Rendering — read-only. `board` never labels, approves, merges, or re-runs;
// keeping the observer free of side effects is what makes it safe to run on
// every heartbeat and safe to test (see the module docstring).
// ---------------------------------------------------------------------------

function fleetLine(fleet: FleetStateFact): string {
  if (!fleet.halted) return 'fleet: not halted'
  const classifier = fleet.isQuotaHalt ? 'QUOTA' : 'consecutive-failure (or other)'
  return `fleet: HALTED — ${fleet.haltReason ?? 'unknown reason'} [${classifier}]`
}

/** Default, human-facing table: grouped by action, most-actionable first —
 *  see `ACTION_ORDER`. Never parsed by another program; see `renderBoardPorcelain`. */
export function renderBoard(view: BoardView): string {
  const lines: string[] = [fleetLine(view.fleet), '']

  for (const action of ACTION_ORDER) {
    const rows = view.rows.filter((r) => r.action === action)
    if (rows.length === 0) continue
    lines.push(`## ${action} (${rows.length})`)
    for (const r of rows) {
      const failing = r.failingContexts.length > 0 ? ` [failing: ${r.failingContexts.join(', ')}]` : ''
      lines.push(`- #${r.number} @${r.author} (${r.headRefOid.slice(0, 8)})${failing} — ${r.reason}`)
    }
    lines.push('')
  }

  if (view.rows.length === 0) lines.push('(no open pull requests)')

  return lines.join('\n').trimEnd()
}

/**
 * One unpadded, pipe-delimited row per PR and nothing else — copying
 * `status.sh`'s own `--porcelain` contract exactly, including its lesson:
 * document the field order here, in one place, and never let a caller parse
 * the padded human table instead.
 *
 * Field order: `number|action|author|headRefOid|failingContexts|reason`
 *   - `failingContexts`: comma-joined context names, empty string if none.
 *   - `reason`: any literal `|` in the reason text is replaced with `/` so a
 *     naive `split('|')` by a caller can never be thrown off by it — every
 *     reason string in this module is fleet-authored prose, never
 *     free-form GitHub text, so this never fires in practice; it exists so
 *     that stays true by construction, not by convention.
 *
 * A leading `fleet|<halted:yes/no>|<reason>|<QUOTA|OTHER>` line always comes
 * first, distinguishable by its literal `fleet` first field — the same shape
 * `dstat`'s own porcelain output does not need (it has no fleet-wide state
 * line) but this command does, per the brief.
 */
export function renderBoardPorcelain(view: BoardView): string {
  const lines: string[] = []
  const classifier = view.fleet.isQuotaHalt ? 'QUOTA' : 'OTHER'
  lines.push(['fleet', view.fleet.halted ? 'yes' : 'no', (view.fleet.haltReason ?? '').replace(/\|/g, '/'), classifier].join('|'))
  for (const r of view.rows) {
    lines.push([
      String(r.number), r.action, r.author, r.headRefOid,
      r.failingContexts.join(','), r.reason.replace(/\|/g, '/'),
    ].join('|'))
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Data acquisition — impure. Injected as `BoardFetchDeps` so this half is
// also unit-tested (a fake `graphql`/`jobSteps`), never exercised only by a
// real `gh` call.
// ---------------------------------------------------------------------------

const PR_QUERY = `
query($owner: String!, $repo: String!, $count: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: OPEN, first: $count, orderBy: {field: CREATED_AT, direction: ASC}) {
      nodes {
        number
        author { login }
        isDraft
        createdAt
        headRefOid
        headRefName
        baseRefName
        mergeStateStatus
        labels(first: 50) { nodes { name } }
        changedFiles
        files(first: 100) { nodes { path } }
        latestOpinionatedReviews(first: 50, writersOnly: true) { nodes { author { login } state } }
        commits(last: 1) {
          nodes {
            commit {
              oid
              statusCheckRollup {
                contexts(first: 50) {
                  nodes {
                    __typename
                    ... on CheckRun {
                      name
                      status
                      conclusion
                      checkSuite { workflowRun { databaseId } }
                    }
                    ... on StatusContext {
                      context
                      state
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
`.trim()

interface GqlCheckRunNode {
  __typename: 'CheckRun'
  name: string
  status: string
  conclusion: string | null
  checkSuite?: { workflowRun?: { databaseId: number } | null } | null
}
interface GqlStatusContextNode {
  __typename: 'StatusContext'
  context: string
  state: string
}
type GqlContextNode = GqlCheckRunNode | GqlStatusContextNode

interface GqlPrNode {
  number: number
  author: { login: string } | null
  isDraft: boolean
  createdAt: string
  headRefOid: string
  headRefName: string
  baseRefName: string
  mergeStateStatus: string
  labels: { nodes: { name: string }[] }
  changedFiles: number
  files: { nodes: { path: string }[] } | null
  latestOpinionatedReviews: { nodes: { author: { login: string } | null; state: string }[] } | null
  commits: { nodes: { commit: { oid: string; statusCheckRollup: { contexts: { nodes: GqlContextNode[] } } | null } }[] }
}

interface GqlResponse {
  data?: { repository?: { pullRequests?: { nodes: GqlPrNode[] } } | null } | null
}

/** `CheckRun.status !== 'COMPLETED'` is still running or queued — never
 *  scored pass or fail. `SKIPPED`/`NEUTRAL` both count as pass-or-skip, per
 *  the brief; every other completed conclusion (`FAILURE`, `TIMED_OUT`,
 *  `CANCELLED`, `ACTION_REQUIRED`, `STARTUP_FAILURE`, `STALE`) is a fail. */
export function normalizeCheckRunState(status: string, conclusion: string | null): CheckState {
  if (status !== 'COMPLETED') return 'PENDING'
  if (conclusion === 'SUCCESS' || conclusion === 'SKIPPED' || conclusion === 'NEUTRAL') return 'PASS'
  return 'FAIL'
}

/** `StatusState`: `EXPECTED`/`PENDING` are still running, `SUCCESS` passes,
 *  everything else (`ERROR`, `FAILURE`) fails. */
export function normalizeStatusContextState(state: string): CheckState {
  if (state === 'SUCCESS') return 'PASS'
  if (state === 'PENDING' || state === 'EXPECTED') return 'PENDING'
  return 'FAIL'
}

const BOARD_PR_LIMIT = 50

export interface BoardFetchDeps {
  /** `gh api graphql` for the query above — returns the raw response, or
   *  `undefined` on any failure (matching `ghJson`'s own contract). */
  queryOpenPrs(): Promise<GqlResponse | undefined>
  /** `gh api repos/{REPO}/actions/runs/{runId}/jobs` — only ever called for
   *  a `fleet/review` CheckRun whose conclusion is FAILURE, to classify why.
   *  `undefined` on any failure, which `fetchBoardFacts` treats as
   *  infrastructure (fail toward "worth a retry", never toward silently
   *  blessing a substantive failure as something else — see the module
   *  comment on `classifyReviewFailure`). */
  fetchRunJobs(runId: number): Promise<{ steps: WorkflowStep[]; runAttempt: number } | undefined>
  checkFleetHalt(): Promise<{ halted: boolean; reason?: string }>
  /** `gh api repos/{REPO}/rules/branches/{branch}` — the raw rule list,
   *  every page. THROWS on failure (with the `gh` detail as the message) so
   *  a failed read can never be mistaken for an empty rule list. */
  fetchBranchRules(branch: string): Promise<unknown>
  /** The base branch's CODEOWNERS text, from the first of `.github/`, the
   *  root, and `docs/` that has one — GitHub's own lookup order. `null` when
   *  none exists; THROWS when it could not be read. */
  fetchCodeOwners(branch: string): Promise<string | null>
}

function toCheckState(node: GqlContextNode): { name: string; kind: 'CheckRun' | 'StatusContext'; state: CheckState; workflowRunId?: number } {
  if (node.__typename === 'CheckRun') {
    return {
      name: node.name,
      kind: 'CheckRun',
      state: normalizeCheckRunState(node.status, node.conclusion),
      workflowRunId: node.checkSuite?.workflowRun?.databaseId ?? undefined,
    }
  }
  return { name: node.context, kind: 'StatusContext', state: normalizeStatusContextState(node.state) }
}

/**
 * Turns one `gh api graphql` response plus, for any FAILed `fleet/review`
 * CheckRun found in it, one `gh api .../actions/runs/{id}/jobs` lookup each,
 * into `BoardFacts`. The GraphQL call is the ONE query for all open PRs the
 * brief asks for; the per-run jobs lookup only ever fires for a PR whose
 * `fleet/review` is red, which is expected to be rare.
 */
async function gatherGate(deps: BoardFetchDeps, branch: string): Promise<BranchGate> {
  let ruleset: RulesetFact
  try {
    ruleset = deriveBranchRuleset(branch, await deps.fetchBranchRules(branch))
  } catch (e) {
    return { ruleset: { ok: false, reason: `GET repos/${REPO}/rules/branches/${branch} failed: ${describeError(e)}` } }
  }
  if (!ruleset.ok || !ruleset.rules.requireCodeOwnerReview) return { ruleset }
  try {
    const text = await deps.fetchCodeOwners(branch)
    return { ruleset, codeOwners: { ok: true, rules: text === null ? [] : parseCodeOwners(text) } }
  } catch (e) {
    return { ruleset, codeOwners: { ok: false, reason: `reading CODEOWNERS on ${branch} failed: ${describeError(e)}` } }
  }
}

function describeError(e: unknown): string {
  return e instanceof Error && !('stderr' in e) ? e.message : describeGhFailure(e)
}

export async function fetchBoardFactsWith(deps: BoardFetchDeps): Promise<BoardFacts> {
  const halt = await deps.checkFleetHalt()
  const fleet: FleetStateFact = { halted: halt.halted, haltReason: halt.reason, isQuotaHalt: isQuotaHaltReason(halt.reason) }

  const response = await deps.queryOpenPrs()
  const nodes = response?.data?.repository?.pullRequests?.nodes ?? []

  const prs = await Promise.all(nodes.map(async (node): Promise<PrFact> => {
    const commit = node.commits.nodes[0]?.commit
    const contextNodes = commit?.statusCheckRollup?.contexts.nodes ?? []
    const sha = commit?.oid ?? node.headRefOid

    const checks = await Promise.all(contextNodes.map(async (n): Promise<PrCheckContext> => {
      const base = toCheckState(n)
      const check: PrCheckContext = { name: base.name, kind: base.kind, sha, state: base.state }

      // Only a FAILed fleet/review CheckRun ever needs the infra-vs-
      // substantive split — every other context is inert past this point.
      if (base.kind === 'CheckRun' && base.name === REVIEW_JOB && base.state === 'FAIL' && base.workflowRunId !== undefined) {
        const jobInfo = await deps.fetchRunJobs(base.workflowRunId)
        if (jobInfo === undefined) {
          // Fail-safe toward "worth a retry": an unreadable run is treated
          // the same as an infra failure, never as a substantive one — the
          // same fail-safe direction `review-cache.ts`'s lookup already
          // uses for the identical reason (a read failure must never look
          // like a stronger verdict than it is).
          check.reviewFailureKind = 'infrastructure'
        } else {
          check.reviewFailureKind = classifyReviewFailure(jobInfo.steps)
          check.runAttempt = jobInfo.runAttempt
        }
      }
      return check
    }))

    return {
      number: node.number,
      authorLogin: node.author?.login ?? '(unknown)',
      isDraft: node.isDraft,
      createdAt: node.createdAt,
      headRefOid: node.headRefOid,
      headRefName: node.headRefName,
      baseRefName: node.baseRefName,
      mergeStateStatus: node.mergeStateStatus,
      labels: node.labels.nodes.map((l) => l.name),
      reviews: (node.latestOpinionatedReviews?.nodes ?? [])
        .map((r) => ({ login: r.author?.login ?? '(unknown)', state: r.state })),
      files: (node.files?.nodes ?? []).map((f) => f.path),
      changedFiles: node.changedFiles,
      checks,
    }
  }))

  // One ruleset read (and at most one CODEOWNERS read) per distinct base
  // branch, per invocation — in practice exactly one, for `main`. Held only
  // in this call's locals: the next `board` run re-reads the live ruleset,
  // because a cached ruleset is a claim about GitHub that drifts the moment
  // the operator edits it.
  const bases = [...new Set(prs.map((p) => p.baseRefName))].sort()
  const gates: Record<string, BranchGate> = {}
  for (const branch of bases) gates[branch] = await gatherGate(deps, branch)

  return { fleet, prs, gates }
}

interface ActionsRunJob { name: string; run_attempt: number; steps: { name: string; conclusion: string | null }[] }
interface ActionsJobsResponse { jobs: ActionsRunJob[] }

function defaultBoardFetchDeps(): BoardFetchDeps {
  return {
    queryOpenPrs: async () => {
      const [owner, repoName] = REPO.split('/')
      return ghJson<GqlResponse>([
        'api', 'graphql',
        '-f', `query=${PR_QUERY}`,
        '-f', `owner=${owner ?? ''}`,
        '-f', `repo=${repoName ?? ''}`,
        '-F', `count=${BOARD_PR_LIMIT}`,
      ])
    },
    fetchRunJobs: async (runId) => {
      const data = await ghJson<ActionsJobsResponse>(['api', `repos/${REPO}/actions/runs/${runId}/jobs`])
      const job = data?.jobs[0]
      if (job === undefined) return undefined
      return { steps: job.steps.map((s) => ({ name: s.name, conclusion: s.conclusion })), runAttempt: job.run_attempt }
    },
    checkFleetHalt: checkHalt,
    fetchBranchRules: async (branch) => {
      const pages = JSON.parse(await gh([
        'api', '--paginate', '--slurp', `repos/${REPO}/rules/branches/${encodeURIComponent(branch)}?per_page=100`,
      ])) as unknown
      return Array.isArray(pages) ? pages.flat() : pages
    },
    fetchCodeOwners: async (branch) => {
      const [owner, repoName] = REPO.split('/')
      const out = JSON.parse(await gh([
        'api', 'graphql',
        '-f', `query=${CODEOWNERS_QUERY}`,
        '-f', `owner=${owner ?? ''}`,
        '-f', `repo=${repoName ?? ''}`,
        '-f', `github=${branch}:.github/CODEOWNERS`,
        '-f', `root=${branch}:CODEOWNERS`,
        '-f', `docs=${branch}:docs/CODEOWNERS`,
      ])) as CodeOwnersResponse
      const repo = out.data?.repository
      if (repo === undefined || repo === null) throw new Error(`CODEOWNERS query returned no repository${out.errors ? `: ${JSON.stringify(out.errors)}` : ''}`)
      return repo.github?.text ?? repo.root?.text ?? repo.docs?.text ?? null
    },
  }
}

/** GitHub's CODEOWNERS lookup order — `.github/`, root, `docs/` — as three
 *  aliased blob reads in one query. A missing file is a `null` object, not
 *  an error, which is what lets `fetchCodeOwners` tell "no CODEOWNERS" from
 *  "could not read it". */
const CODEOWNERS_QUERY = `
query($owner: String!, $repo: String!, $github: String!, $root: String!, $docs: String!) {
  repository(owner: $owner, name: $repo) {
    github: object(expression: $github) { ... on Blob { text } }
    root: object(expression: $root) { ... on Blob { text } }
    docs: object(expression: $docs) { ... on Blob { text } }
  }
}
`.trim()

interface CodeOwnersResponse {
  data?: { repository?: { github: { text?: string } | null; root: { text?: string } | null; docs: { text?: string } | null } | null } | null
  errors?: unknown
}

export async function fetchBoardFacts(): Promise<BoardFacts> {
  return fetchBoardFactsWith(defaultBoardFetchDeps())
}

/** Wired into `cli.ts`'s `HANDLERS`. `--porcelain` anywhere in argv selects
 *  the machine-readable form; everything else prints the grouped table. */
export async function runBoard(args: string[]): Promise<number> {
  const facts = await fetchBoardFacts()
  const view = buildBoard(facts)
  const porcelain = args.includes('--porcelain')
  process.stdout.write((porcelain ? renderBoardPorcelain(view) : renderBoard(view)) + '\n')
  return 0
}
