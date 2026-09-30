import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  reviewIsRequested, reviewRequestFor, reviewRequestEventFromEnv, reviewTriggerLogins,
  REVIEW_REQUEST_LOGIN, RELEASE_REVIEW_REQUEST_LOGIN,
  type ReviewRequestDecision, type ReviewRequestEvent,
} from '../../orchestrator/src/ci.js'
import { KNOPE_RELEASE_BRANCH } from '../../orchestrator/src/roles/release.js'

/**
 * Rails for WHO may start `fleet/review` (#1232).
 *
 * THE BUG. `fleet/review` is a required context, and it runs only when a
 * review is requested from a recognised login. After #1164 that meant
 * `llamenos-auto` anywhere, or `rhonda-rodododo` on the `release` branch
 * only. A PR `llamenos-auto` itself authored on any other branch therefore
 * had no route at all: GitHub refuses to request a PR's own author (422),
 * the operator was refused off `release`, and a team request carries no
 * `requested_reviewer`. #1183 sat unmergeable with nothing to press.
 *
 * THE INVARIANT, pinned for every author and branch this repo sees: some
 * review request GitHub will accept starts the review, and no request
 * naming the PR's own author — directly or through a team — ever does.
 *
 * Half of this file drives `reviewRequestFor` directly. The other half runs
 * the real chain: the gate step's `env:` from fleet-review.yml, evaluated
 * against `review_requested` payloads shaped like #1183's own events, read
 * by the CLI's own env reader, judged by the CLI's own decision. The pure
 * function alone cannot catch the half of the bug that lives in the
 * workflow — a gate that needs the PR's author is no fix if the workflow
 * never hands the author over.
 */

const AUTO = REVIEW_REQUEST_LOGIN
const OPERATOR = RELEASE_REVIEW_REQUEST_LOGIN

/** Who opens PRs here — the last 300: `rhonda-rodododo` 265, dependabot 23,
 *  `llamenos-auto` 7 (4 of them knope release PRs), github-actions 5 — plus
 *  a colleague, who has not happened yet but will. */
const AUTHORS = [AUTO, OPERATOR, 'dependabot[bot]', 'github-actions[bot]', 'some-colleague']
const BRANCHES = [KNOPE_RELEASE_BRANCH, 'fleet/infra/1', 'll-fix-1124-verify-trigger']
const CELLS = AUTHORS.flatMap((author) => BRANCHES.map((branch) => [author, branch] as const))

/** Every USER a review could be requested from. GitHub refuses exactly one
 *  of them per PR: its author. */
const USERS = [AUTO, OPERATOR, 'some-colleague', 'another-human']
const requestableOn = (author: string): string[] => USERS.filter((u) => u.toLowerCase() !== author.toLowerCase())

const pullRequest = (over: Partial<ReviewRequestEvent>): ReviewRequestEvent => ({
  eventName: 'pull_request', requestedReviewer: undefined, requestedTeam: undefined,
  prAuthor: undefined, branch: 'fleet/infra/1', ...over,
})

describe('rail: every PR has a route to a fleet/review verdict (#1232)', () => {
  it.each(CELLS)('a PR by %s on %s can be sent for review by a request GitHub accepts', (author, branch) => {
    const routes = requestableOn(author).filter((login) =>
      reviewRequestFor(pullRequest({ requestedReviewer: login, prAuthor: author, branch })).requested)
    expect(
      routes,
      `no review request GitHub would accept starts fleet/review on a PR by ${author} on ${branch} — it can never merge`,
    ).not.toEqual([])
  })

  // The live instance, exactly: #1183, `llamenos-auto`'s PR on a feature branch.
  it('#1183: requesting the operator on llamenos-auto\'s feature-branch PR starts the review', () => {
    expect(reviewRequestFor(pullRequest({
      requestedReviewer: OPERATOR, prAuthor: AUTO, branch: 'll-fix-1124-verify-trigger',
    }))).toEqual({ requested: true })
  })

  // The advice a red `not-requested` check prints comes from
  // `reviewTriggerLogins`. It must name exactly the users the gate accepts —
  // a login it names but the gate refuses is #1183's circle again, and one
  // the gate accepts but it never names is a route nobody is told about.
  it.each(CELLS)('on a PR by %s on %s, the logins the check tells you to request are exactly the ones that work', (author, branch) => {
    const accepted = USERS.filter((login) =>
      reviewRequestFor(pullRequest({ requestedReviewer: login, prAuthor: author, branch })).requested)
    expect([...reviewTriggerLogins({ prAuthor: author, branch })].sort()).toEqual([...accepted].sort())
  })

  it('reviewIsRequested is reviewRequestFor\'s own answer, never a second opinion', () => {
    for (const [author, branch] of CELLS) {
      for (const login of [...USERS, undefined]) {
        const e = pullRequest({ requestedReviewer: login, prAuthor: author, branch })
        expect(reviewIsRequested(e), `${login} on ${author}/${branch}`).toBe(reviewRequestFor(e).requested)
      }
    }
  })
})

describe('rail: nobody can start their own review', () => {
  it.each(CELLS)('a request naming the PR\'s own author (%s, on %s) never starts it, in any letter case', (author, branch) => {
    for (const spelling of [author, author.toUpperCase(), ` ${author} `]) {
      expect(reviewRequestFor(pullRequest({ requestedReviewer: spelling, prAuthor: author, branch })).requested).toBe(false)
    }
    expect(reviewTriggerLogins({ prAuthor: author, branch }).map((l) => l.toLowerCase())).not.toContain(author.toLowerCase())
  })

  // GitHub refuses to request a PR's author but accepts a TEAM the author is
  // on. On #1183 the operator requested `review-agent-team`, whose only
  // member is `llamenos-auto` — the PR's own author. A team is therefore
  // never a trigger; what the rail checks is that the refusal SAYS so and
  // names who to ask, instead of the old silent no-op.
  it.each(CELLS)('a TEAM request on a PR by %s on %s never starts it, and the refusal names the team', (author, branch) => {
    const d = reviewRequestFor(pullRequest({ requestedTeam: 'review-agent-team', prAuthor: author, branch }))
    expect(d.requested).toBe(false)
    expect(!d.requested && d.reason).toContain('`review-agent-team`')
    expect(!d.requested && d.reason).toMatch(/team is never a trigger/)
  })
})

describe('rail: the operator stands in only where llamenos-auto cannot be asked', () => {
  // CODEOWNERS names `rhonda-rodododo` on every high-impact path, so GitHub
  // requests that login by itself when almost any PR opens. Accepting it on
  // every PR it did not write would start a model review on every
  // dependabot PR at the moment it is opened — fleet-review.yml's invariant
  // 2 ("never trigger on `opened`") re-entering through CODEOWNERS.
  it.each([
    ['dependabot[bot]', 'dependabot/github_actions/actions/checkout-7'],
    ['github-actions[bot]', 'fleet/infra/1'],
    ['some-colleague', 'feature/x'],
  ])('the CODEOWNERS request for the operator on a PR by %s (%s) does not start a review', (author, branch) => {
    const d = reviewRequestFor(pullRequest({ requestedReviewer: OPERATOR, prAuthor: author, branch }))
    expect(d.requested).toBe(false)
    expect(!d.requested && d.reason).toContain(`only \`${AUTO}\` is`)
  })

  it('an unknown author only ever narrows: the stand-in route stays shut without one', () => {
    expect(reviewRequestFor(pullRequest({ requestedReviewer: OPERATOR, branch: 'fleet/infra/1' })).requested).toBe(false)
    expect(reviewRequestFor(pullRequest({ requestedReviewer: OPERATOR, prAuthor: '', branch: 'fleet/infra/1' })).requested).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The workflow half: fleet-review.yml's gate `env:` → the CLI's own reader →
// the CLI's own decision, against payloads shaped like #1183's events.
// ---------------------------------------------------------------------------

interface WorkflowStep { id?: string; env?: Record<string, unknown>; run?: string }
interface WorkflowDoc { jobs: Record<string, { steps?: WorkflowStep[] }> }

const FLEET_REVIEW_YML = join(process.cwd(), '.github', 'workflows', 'fleet-review.yml')

function gateStep(): WorkflowStep {
  const wf = parseYaml(readFileSync(FLEET_REVIEW_YML, 'utf8')) as WorkflowDoc
  const step = wf.jobs['fleet-review']?.steps?.find((s) => s.id === 'gate')
  if (step?.env === undefined) throw new Error('no `gate` step with an env: block in fleet-review.yml — this rail must not pass vacuously')
  return step
}

/** GitHub's evaluation of `${{ <context path> }}` for the gate's event
 *  fields: a missing property is `null`, which `env:` renders as ''. Any
 *  other expression over `github.event*` is refused outright — the rule must
 *  never be re-expressed in YAML (#1213's shim was). */
function evaluateGateEnv(context: Record<string, unknown>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, raw] of Object.entries(gateStep().env ?? {})) {
    const value = String(raw)
    const path = /^\$\{\{\s*([A-Za-z_][\w.]*)\s*\}\}$/.exec(value)?.[1]
    if (path === undefined) {
      if (value.includes('github.event')) {
        throw new Error(`${key} is not a single context path (${value}) — the gate step must hand over raw event fields only`)
      }
      env[key] = value
      continue
    }
    let v: unknown = context
    for (const part of path.split('.')) v = v !== null && typeof v === 'object' ? (v as Record<string, unknown>)[part] : undefined
    env[key] = v === undefined || v === null ? '' : String(v)
  }
  return env
}

interface PrPayload { number: number; user: { login: string }; head: { ref: string } }
const PR_1183: PrPayload = { number: 1183, user: { login: AUTO }, head: { ref: 'll-fix-1124-verify-trigger' } }
const FLEET_PR: PrPayload = { number: 1230, user: { login: OPERATOR }, head: { ref: 'fleet/infra/1230' } }
const DEPENDABOT_PR: PrPayload = { number: 946, user: { login: 'dependabot[bot]' }, head: { ref: 'dependabot/docker/deploy/docker/node-24' } }

/** Judge one `review_requested` delivery exactly as the gate step would. */
function judge(pr: PrPayload, requested: { requested_reviewer: { login: string } } | { requested_team: { name: string; slug: string } }): ReviewRequestDecision {
  const env = evaluateGateEnv({
    github: { event_name: 'pull_request', event: { action: 'review_requested', number: pr.number, pull_request: pr, ...requested } },
  })
  return reviewRequestFor(reviewRequestEventFromEnv(env, pr.head.ref))
}

describe('rail: the workflow hands the gate what it needs to decide (#1232)', () => {
  it('#1183: the operator\'s request on llamenos-auto\'s PR starts the review', () => {
    expect(judge(PR_1183, { requested_reviewer: { login: OPERATOR } })).toEqual({ requested: true })
  })

  it('#1183: the team request is refused, naming the team — never silently', () => {
    const d = judge(PR_1183, { requested_team: { name: 'Review agent team', slug: 'review-agent-team' } })
    expect(d.requested).toBe(false)
    expect(!d.requested && d.reason).toContain('`review-agent-team`')
  })

  it('an operator-authored fleet PR is still started by requesting llamenos-auto', () => {
    expect(judge(FLEET_PR, { requested_reviewer: { login: AUTO } })).toEqual({ requested: true })
  })

  it('a dependabot PR is not started by the CODEOWNERS request for the operator', () => {
    expect(judge(DEPENDABOT_PR, { requested_reviewer: { login: OPERATOR } }).requested).toBe(false)
    expect(judge(DEPENDABOT_PR, { requested_reviewer: { login: AUTO } })).toEqual({ requested: true })
  })

  it('no expression in fleet-review.yml names a trigger login — the rule lives in ci.ts only', () => {
    const body = readFileSync(FLEET_REVIEW_YML, 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n')
    for (const [expr] of body.matchAll(/\$\{\{[^}]*\}\}/g)) {
      expect(expr.toLowerCase(), expr).not.toContain(AUTO)
      expect(expr.toLowerCase(), expr).not.toContain(OPERATOR)
    }
  })

  // The chain above proves the YAML and ci.ts agree; this pins the one line
  // of glue between them, so the CLI cannot drift back to reading the
  // variables itself and bypass the reader tested here.
  it('the review-gate command reads the event through reviewRequestEventFromEnv', () => {
    const cli = readFileSync(join(process.cwd(), 'orchestrator', 'src', 'cli.ts'), 'utf8')
    expect(cli).toContain('reviewRequestEventFromEnv(process.env, ctx.branch)')
    expect(cli).not.toContain("process.env['FLEET_REVIEW_REQUESTED_REVIEWER']")
  })
})
