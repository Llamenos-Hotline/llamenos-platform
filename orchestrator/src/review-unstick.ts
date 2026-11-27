import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { REPO, gh, describeGhFailure, commitSha } from './gh.js'
import { REVIEW_RERUN_WORKFLOW, laneIdFromBranch } from './ci.js'
import { buildBoard, type BoardFacts } from './board.js'
import { ghLoginResolver, type LoginResolver } from './identity.js'
import { rerunReview, type RerunDeps, type RerunResult, type RerunRun } from './review-rerun.js'

/**
 * A fleet PR whose review never reaches a verdict is stuck for good (#3113).
 *
 * `fleet/review` starts only off a `review_requested` event, and a push never
 * starts one. The request the fleet makes when it opens a PR is consumed by
 * ONE evaluation; when that evaluation ends without a verdict (a host problem,
 * a stale base, an engine quota) nothing the fleet can generate afterwards
 * fires the engine again — the reviewer is a CODEOWNER, GitHub re-adds its
 * request the instant it is removed, and a POST on a pending request emits
 * nothing (#1471). Measured 2026-11-27: four of five fleet PRs, each waiting
 * for a human to run a three-step sequence by hand, with nothing alerting.
 *
 * This pass is the durable owner of that recovery. It reads the board's own
 * classification (`classifyPr`'s REQUEST_REVIEW — a red `fleet/review` that
 * holds no verdict for the head, with nothing evaluating it) and drives
 * `rerunReview`, the one implementation of "request again and CONFIRM A RUN
 * STARTED", with the comment-review recovery switched on.
 *
 * What keeps it from becoming the failure it cures:
 *  - It acts only on a fleet-DISPATCHED branch and a non-draft PR. A PR that
 *    already holds a verdict (green, or a real FAIL) is never classed
 *    REQUEST_REVIEW, so it is never re-reviewed.
 *  - A run of `REVIEW_RERUN_WORKFLOW` that is still queued or running on the
 *    head is the request being evaluated: it is left alone, however long the
 *    review takes (the model review takes minutes, and the carrier reads
 *    `NO-VERDICT:unreviewed` for all of them).
 *  - Each head gets at most `MAX_EVALUATIONS_PER_HEAD` evaluations, counted
 *    from GitHub's own run list (no state file). A head that has spent them
 *    is REPORTED as needing a human, not asked again: a host that keeps
 *    failing would otherwise get a request storm and a pile of CANCELLED
 *    carriers.
 *  - Every action and every refusal is logged with the PR number, so a PR the
 *    pass touched, or declined to touch, never looks idle (rule V).
 *
 * The comment review is submitted as the reviewer the gate accepts for this
 * PR — a COMMENT, never an approval: it asserts nothing about the code and
 * only empties the pending list. The reviewer's credential comes from the
 * operator's own `gh` keyring (`gh auth token -u <login>`), the same place
 * the operator-side `as-rhonda` wrapper reads it, is handed to the child
 * through its environment only, and is identity-checked before any write. A
 * machine that does not hold it reports the PR as stalled and names the
 * missing credential; it never falls back to anything else.
 */

/** Evaluations a head may consume before the pass stops asking and reports. */
export const MAX_EVALUATIONS_PER_HEAD = 3

/**
 * How old a head must be before its missing verdict counts as a stall. A PR
 * opened a moment ago has no `fleet/review` carrier yet, and a head pushed a
 * moment ago is awaiting the tick's own verify-then-refire (#2738): both read
 * as "no verdict, nothing evaluating" and neither is stuck.
 */
export const UNSTICK_GRACE_MS = 10 * 60_000

export type UnstickOutcome =
  | { kind: 'refired'; pr: number; run: RerunRun; viaCommentReview: boolean }
  | { kind: 'in-flight'; pr: number }
  /** Younger than `UNSTICK_GRACE_MS`, or its age could not be read. */
  | { kind: 'too-young'; pr: number }
  | { kind: 'exhausted'; pr: number; evaluations: number }
  | { kind: 'failed'; pr: number; reason: string }

export interface UnstickCandidate {
  number: number
  headSha: string
  reason: string
}

export interface UnstickDeps {
  /** Open, fleet-dispatched, non-draft PRs the board classifies REQUEST_REVIEW. */
  candidates(): Promise<UnstickCandidate[]>
  /** When the head commit was made; `undefined` when it could not be read. */
  headCommittedAt(headSha: string): Promise<Date | undefined>
  now(): Date
  /** Every run of `REVIEW_RERUN_WORKFLOW` on this head (any status). */
  runsOnHead(headSha: string): Promise<RerunRun[]>
  /** Request again and confirm a run started — `rerunReview` over live deps. */
  rerun(pr: number): Promise<RerunResult>
  log(msg: string): void
}

/** The candidates the board's own table names, restricted to what this pass may touch. */
export function unstickCandidatesFrom(facts: BoardFacts): UnstickCandidate[] {
  const byNumber = new Map(facts.prs.map((p) => [p.number, p]))
  return buildBoard(facts).rows.flatMap((row) => {
    if (row.action !== 'REQUEST_REVIEW') return []
    const pr = byNumber.get(row.number)
    if (pr === undefined || pr.isDraft || laneIdFromBranch(pr.headRefName) === undefined) return []
    return [{ number: row.number, headSha: row.headRefOid, reason: row.reason }]
  })
}

export async function unstickStalledReviews(deps: UnstickDeps): Promise<UnstickOutcome[]> {
  const outcomes: UnstickOutcome[] = []
  for (const c of await deps.candidates()) {
    const committed = await deps.headCommittedAt(c.headSha)
    if (committed === undefined || deps.now().getTime() - committed.getTime() < UNSTICK_GRACE_MS) {
      deps.log(
        `review-unstick: #${c.number} has no review verdict but ` +
        (committed === undefined ? 'the head\'s age could not be read' : `its head is under ${UNSTICK_GRACE_MS / 60_000} minutes old`) +
        ' — leaving it to the PR-open and new-head requests',
      )
      outcomes.push({ kind: 'too-young', pr: c.number })
      continue
    }
    const runs = await deps.runsOnHead(c.headSha)
    if (runs.some((r) => r.status === 'queued' || r.status === 'in_progress' || r.status === 'waiting' || r.status === 'pending')) {
      deps.log(`review-unstick: #${c.number} ${REVIEW_RERUN_WORKFLOW} is still running on ${c.headSha.slice(0, 12)} — the request is being evaluated; not asking again`)
      outcomes.push({ kind: 'in-flight', pr: c.number })
      continue
    }
    if (runs.length >= MAX_EVALUATIONS_PER_HEAD) {
      deps.log(
        `review-unstick: #${c.number} STALLED — ${runs.length} evaluations of ${c.headSha.slice(0, 12)} ended without a verdict ` +
        `(${c.reason}); not asking again, a human has to look at why the gate keeps failing`,
      )
      outcomes.push({ kind: 'exhausted', pr: c.number, evaluations: runs.length })
      continue
    }
    deps.log(`review-unstick: #${c.number} has no review verdict and nothing evaluating it (${c.reason}) — re-requesting and confirming a run starts`)
    let result: RerunResult
    try {
      result = await deps.rerun(c.number)
    } catch (e) {
      const reason = describeGhFailure(e)
      deps.log(`review-unstick: #${c.number} FAILED — could not complete the re-request: ${reason}`)
      outcomes.push({ kind: 'failed', pr: c.number, reason })
      continue
    }
    if (!result.ok) {
      deps.log(`review-unstick: #${c.number} FAILED — ${result.reason}`)
      outcomes.push({ kind: 'failed', pr: c.number, reason: result.reason })
      continue
    }
    const via = result.viaCommentReview === true
    deps.log(
      `review-unstick: #${c.number} review re-fired${via ? ' via a comment review (the plain request emitted no event)' : ''}; ` +
      `${REVIEW_RERUN_WORKFLOW} run ${result.run.id} started on the head — ${result.run.html_url}`,
    )
    outcomes.push({ kind: 'refired', pr: c.number, run: result.run, viaCommentReview: via })
  }
  return outcomes
}

// ---------------------------------------------------------------------------
// Live wiring — shared by the tick pass and scripts/fleet-rereview.ts
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile)

/** The review body: says what it is, so nobody mistakes it for an assessment. */
export const PROCEDURAL_REVIEW_BODY =
  'procedural: clearing the pending review request so the gate can be asked again (#3113) — not a review of the code'

/** The seams `commentReviewAs` runs through. */
export interface CommentReviewIo {
  /** The stored credential for `login`, or `undefined` when this machine has none. */
  tokenFor(login: string): Promise<string | undefined>
  resolve: LoginResolver
  /** POST the review. The credential travels in the child's environment only. */
  postReview(token: string, pr: number, headSha: string, body: string): Promise<void>
}

/**
 * Submit a COMMENT review on `pr`'s head as `login`. The event is a literal
 * `COMMENT` — the only value this function can send — so no code path through
 * it can approve or request changes. The credential is identity-checked
 * first: a token that resolves to anyone but `login` is refused, because
 * writing as the wrong identity is exactly the failure #2966 describes.
 */
export async function commentReviewAs(io: CommentReviewIo, pr: number, login: string, headSha: string): Promise<void> {
  const token = await io.tokenFor(login)
  if (token === undefined || token === '') {
    throw new Error(
      `no stored credential for ${login} on this machine, so the comment review that clears its pending request ` +
      `cannot be submitted — run \`gh auth login --user ${login}\` in the operator's own shell, or submit it by hand: ` +
      `gh pr review ${pr} --comment --body "${PROCEDURAL_REVIEW_BODY}" (as ${login}), then re-add the request`,
    )
  }
  const who = await io.resolve(token)
  if (who.kind !== 'login') throw new Error(`the stored credential for ${login} could not be resolved (${who.reason}) — refusing to write with it`)
  if (who.login.toLowerCase() !== login.toLowerCase()) {
    throw new Error(`the stored credential for ${login} resolves to ${who.login} — refusing to write as the wrong identity`)
  }
  await io.postReview(token, pr, headSha, PROCEDURAL_REVIEW_BODY)
}

/** `gh auth token -u <login>` against the keyring, bypassing the per-repo shim's account map. */
export function defaultCommentReviewIo(): CommentReviewIo {
  return {
    async tokenFor(login) {
      const env: NodeJS.ProcessEnv = { ...process.env, GH_PER_REPO_ACTIVE: '1' }
      delete env['GH_TOKEN']
      try {
        const { stdout } = await execFileAsync('gh', ['auth', 'token', '-u', login], { env, timeout: 20_000 })
        const t = stdout.trim()
        return t === '' ? undefined : t
      } catch {
        return undefined
      }
    },
    resolve: ghLoginResolver(),
    async postReview(token, pr, headSha, body) {
      const env: NodeJS.ProcessEnv = { ...process.env, GH_PER_REPO_ACTIVE: '1', GH_TOKEN: token }
      try {
        await execFileAsync(
          'gh',
          ['api', '-X', 'POST', `repos/${REPO}/pulls/${pr}/reviews`, '-f', 'event=COMMENT', '-f', `commit_id=${headSha}`, '-f', `body=${body}`, '--silent'],
          { env, timeout: 30_000 },
        )
      } catch (e) {
        // Whatever gh printed, never the token: it is in `env`, not argv, but a
        // failure message is the one place it could still be echoed.
        throw new Error(describeGhFailure(e).split(token).join('[redacted]'))
      }
    },
  }
}

/** The live `RerunDeps`, with the comment-review recovery wired. */
export function liveRerunDeps(log: (msg: string) => void, io: CommentReviewIo = defaultCommentReviewIo()): RerunDeps {
  return {
    async readPr(pr) {
      const j = JSON.parse(await gh(['pr', 'view', String(pr), '-R', REPO, '--json', 'number,headRefOid,headRefName,author,reviewRequests'])) as {
        number: number; headRefOid: string; headRefName: string; author: { login: string }
        reviewRequests: Array<{ login?: string }>
      }
      return {
        number: j.number, headSha: j.headRefOid, branch: j.headRefName, author: j.author.login,
        requestedReviewers: j.reviewRequests.flatMap((r) => (r.login === undefined ? [] : [r.login])),
      }
    },
    async reviewRequestEvents(pr, login) {
      const out = await gh([
        'api', '--paginate', `repos/${REPO}/issues/${pr}/events?per_page=100`, '--jq',
        `.[] | select(.event=="review_requested" and (.requested_reviewer.login|ascii_downcase)=="${login.toLowerCase()}") | .created_at`,
      ])
      return out.split('\n').filter((l) => l.length > 0)
    },
    async removeReviewer(pr, login) {
      await gh(['api', '-X', 'DELETE', `repos/${REPO}/pulls/${pr}/requested_reviewers`, '-f', `reviewers[]=${login}`, '--silent'])
    },
    async addReviewer(pr, login) {
      await gh(['api', '-X', 'POST', `repos/${REPO}/pulls/${pr}/requested_reviewers`, '-f', `reviewers[]=${login}`, '--silent'])
    },
    rerunRuns: (headSha) => runsOnHead(headSha),
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    commentReviewAs: (pr, login, headSha) => commentReviewAs(io, pr, login, headSha),
    log,
  }
}

/** Runs of `REVIEW_RERUN_WORKFLOW` on a head, newest first. */
export async function runsOnHead(headSha: string): Promise<RerunRun[]> {
  const out = await gh([
    'api', `repos/${REPO}/actions/workflows/${REVIEW_RERUN_WORKFLOW}/runs?event=pull_request&head_sha=${headSha}&per_page=100`,
    '--jq', '.workflow_runs',
  ])
  return JSON.parse(out) as RerunRun[]
}

export function defaultUnstickDeps(
  log: (msg: string) => void,
  fetchFacts: () => Promise<BoardFacts>,
): UnstickDeps {
  const rerunDeps = liveRerunDeps(log)
  return {
    candidates: async () => unstickCandidatesFrom(await fetchFacts()),
    async headCommittedAt(headSha) {
      try {
        const out = (await gh(['api', `repos/${REPO}/commits/${commitSha(headSha)}`, '--jq', '.commit.committer.date'])).trim()
        const t = Date.parse(out)
        return Number.isNaN(t) ? undefined : new Date(t)
      } catch {
        return undefined
      }
    },
    now: () => new Date(),
    runsOnHead,
    rerun: (pr) => rerunReview(rerunDeps, pr),
    log,
  }
}
