import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  reviewIsRequested, reviewRequestFor, reviewRequestEventFromEnv, reviewTriggerLogins,
  reviewNotRequestedAdvice, REVIEW_REQUEST_LOGIN, RELEASE_REVIEW_REQUEST_LOGIN,
  REVIEW_DISPATCH_EVENT,
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

function stepById(id: string): WorkflowStep {
  const wf = parseYaml(readFileSync(FLEET_REVIEW_YML, 'utf8')) as WorkflowDoc
  const step = wf.jobs['fleet-review']?.steps?.find((s) => s.id === id)
  if (step === undefined) throw new Error(`no \`${id}\` step in fleet-review.yml — this rail must not pass vacuously`)
  return step
}

/** The step that resolves WHAT is being judged — and, on the dispatch arm,
 *  refuses a ref that is not the PR's own head branch. */
function gateCtxStep(): WorkflowStep {
  return stepById('ctx')
}

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
  it('the review-gate command reads the event through reviewRequestEventFromEnv, with the live author as the fallback', () => {
    const cli = readFileSync(join(process.cwd(), 'orchestrator', 'src', 'cli.ts'), 'utf8')
    // The third argument is #1471: `workflow_dispatch` carries no PR payload,
    // so without the live read the author is unknown and the advice defaults
    // to `REVIEW_REQUEST_LOGIN` — the author itself, on the PRs that need the
    // dispatch most.
    expect(cli).toContain('reviewRequestEventFromEnv(process.env, ctx.branch, facts?.author)')
    expect(cli).not.toContain("process.env['FLEET_REVIEW_REQUESTED_REVIEWER']")
    // The live read is the one `readPrFacts` already makes for the labels —
    // the author must come out of THAT response, not a second round trip.
    expect(cli).toMatch(/author: data\.user\?\.login/)
  })
})

// ---------------------------------------------------------------------------
// #1471: the dispatch escape hatch, and the dead end that had no exit.
// ---------------------------------------------------------------------------

/**
 * THE BUG, measured on eight PRs (#1372 #1373 #1374 #1375 #1376 #1378 #1382
 * #1184), all authored by `llamenos-auto` with `rhonda-rodododo` already in
 * `reviewRequests`:
 *
 *  1. `review_requested` could not re-fire. GitHub re-adds a CODEOWNER's
 *     review request the instant it is removed, so remove-then-re-add emits
 *     NO event while every command in it reports success.
 *  2. `synchronize` can only republish a verdict already earned for that
 *     exact diff, so on a changed diff it concludes `not-requested`.
 *  3. `workflow_dispatch` was REFUSED by the gate — the event name arrived
 *     empty from a stale head copy of `fleet-review.yml` (the gate runs base
 *     code against head YAML, #1464) and the refusal read "`(no event)` is
 *     not a review request".
 *  4. `review-and-merge` cannot POST a check run with a PAT (403).
 *
 * `fleet/review` is a required context, so all four closed meant eight PRs
 * with no reachable route to a verdict at all.
 *
 * THE INVARIANTS: a dispatch IS a review request and reaches the engine; the
 * event name survives a stale `FLEET_REVIEW_*` block; the login the advice
 * names is never the PR's own author; and advice that cannot work says so.
 */
describe('rail: the dispatch escape hatch is a real review trigger (#1471)', () => {
  it('a workflow_dispatch is a review request, with no reviewer login to name', () => {
    expect(reviewRequestFor({
      eventName: REVIEW_DISPATCH_EVENT, requestedReviewer: undefined, requestedTeam: undefined,
      prAuthor: AUTO, branch: 'fleet/desktop/1130',
    })).toEqual({ requested: true })
  })

  // The exact live shape: a head copy of fleet-review.yml predating
  // `FLEET_REVIEW_EVENT_NAME` hands the gate NOTHING, and the runner's own
  // `GITHUB_EVENT_NAME` is the only source that cannot be stale.
  it('a dispatch whose stale head YAML sets no FLEET_REVIEW_* is still recognised, from GITHUB_EVENT_NAME', () => {
    const event = reviewRequestEventFromEnv({ GITHUB_EVENT_NAME: REVIEW_DISPATCH_EVENT }, 'fleet/desktop/1130', AUTO)
    expect(event.eventName).toBe(REVIEW_DISPATCH_EVENT)
    expect(reviewRequestFor(event)).toEqual({ requested: true })
  })

  it('the explicit FLEET_REVIEW_EVENT_NAME still wins — the workflow stays the statement of intent', () => {
    const event = reviewRequestEventFromEnv(
      { FLEET_REVIEW_EVENT_NAME: 'pull_request', FLEET_REVIEW_EVENT_ACTION: 'synchronize', GITHUB_EVENT_NAME: 'pull_request' },
      'fleet/desktop/1130',
    )
    expect(event.eventName).toBe('pull_request')
    expect(reviewRequestFor(event).requested).toBe(false)
  })

  // Fail closed is unchanged: no event name from EITHER source is still a
  // refusal, and the refusal now names the trigger that always works.
  it('no event name from either source is still a refusal, and the reason names the dispatch', () => {
    const event = reviewRequestEventFromEnv({}, 'fleet/desktop/1130', AUTO)
    expect(event.eventName).toBe('')
    const d = reviewRequestFor(event)
    expect(d.requested).toBe(false)
    expect(!d.requested && d.reason).toContain('(no event)')
    expect(!d.requested && d.reason).toContain(REVIEW_DISPATCH_EVENT)
  })

  // Both directions are live in the open-PR set at once, so neither may be
  // assumed: the author resolution must never name the PR's own author.
  it.each([AUTO, OPERATOR, 'dependabot[bot]', 'some-colleague'])(
    'on a dispatch for a PR authored by %s, the login the advice names is never the author',
    (author) => {
      const event = reviewRequestEventFromEnv({ GITHUB_EVENT_NAME: REVIEW_DISPATCH_EVENT }, 'fleet/infra/1', author)
      expect(event.prAuthor).toBe(author)
      for (const ask of reviewTriggerLogins(event)) {
        expect(ask.toLowerCase(), `advice names the PR's own author on a PR by ${author}`).not.toBe(author.toLowerCase())
      }
    },
  )

  it('without the live author a dispatch would name llamenos-auto — which is #1471\'s 422', () => {
    const blind = reviewRequestEventFromEnv({ GITHUB_EVENT_NAME: REVIEW_DISPATCH_EVENT }, 'fleet/desktop/1130')
    expect(reviewTriggerLogins(blind)[0]).toBe(AUTO)
    const resolved = reviewRequestEventFromEnv({ GITHUB_EVENT_NAME: REVIEW_DISPATCH_EVENT }, 'fleet/desktop/1130', AUTO)
    expect(reviewTriggerLogins(resolved)[0]).toBe(OPERATOR)
  })
})

describe('rail: a dispatch cannot publish a verdict onto a commit that is not the PR\'s (#1471)', () => {
  /**
   * A dispatch run's check attaches to `github.sha` — whatever `--ref`
   * resolved to — and NOTHING about `pr_number` constrains that. Now that the
   * dispatch is a real trigger, `--ref main -f pr_number=N` would review N's
   * base-to-main diff and publish the verdict as a `fleet/review` on main's
   * tip, and `--ref another-pr-branch` would hand THAT PR a required green it
   * never earned. The ctx step refuses instead, and this is the rail on that
   * refusal — without it the fix would have opened a fail-open path of its own.
   */
  it('the ctx step compares the dispatched ref against the PR\'s own head branch and exits non-zero', () => {
    const step = gateCtxStep()
    expect(step.env?.['DISPATCH_REF'], 'the ctx step does not receive the dispatched ref').toBe('${{ github.ref_name }}')
    const script = step.run ?? ''
    expect(script).toContain('"$DISPATCH_REF" != "$branch"')
    expect(script).toContain('dispatch-ref-mismatch')
    // The refusal must be a failure, and must sit INSIDE the dispatch arm —
    // a `pull_request` carries no dispatched ref to compare.
    const guardIdx = script.indexOf('dispatch-ref-mismatch')
    const prArmIdx = script.indexOf('base_sha="$PR_EVENT_BASE_SHA"')
    expect(guardIdx).toBeGreaterThan(prArmIdx)
    expect(script.slice(guardIdx, guardIdx + 600)).toContain('exit 1')
  })
})

describe('rail: advice that cannot work says so (#1471)', () => {
  const advice = (over: Partial<Parameters<typeof reviewNotRequestedAdvice>[0]> = {}): string =>
    reviewNotRequestedAdvice({
      pr: '1184', branch: 'fleet/desktop/1130', ask: OPERATOR, isAuthorStandIn: true,
      alreadyRequested: undefined, ...over,
    }).join('\n')

  it('names the login to request when it is not already requested', () => {
    const text = advice({ alreadyRequested: [] })
    expect(text).toContain(`\`${OPERATOR}\``)
    expect(text).toContain('cannot be asked to review it')
  })

  it('refuses to tell you to re-request a login the PR ALREADY has', () => {
    const text = advice({ alreadyRequested: [OPERATOR] })
    expect(text).toContain('ALREADY a requested reviewer')
    expect(text).not.toMatch(/request a review from `rhonda-rodododo` to run/)
    // It points at the EVENTS endpoint, the only honest source: every command
    // in the remove-then-add sequence reports success while nothing fires, and
    // `reviewRequests` cannot tell "just now" from "four days ago".
    expect(text).toContain(`issues/1184/events`)
  })

  // A dispatch runs the real review, but a check suite created by a
  // `workflow_dispatch` on a branch is not associated with the PULL REQUEST,
  // so its `fleet/review` check run never enters the PR's status-check rollup
  // and cannot clear the required context. Measured on #1372/#1378/#1184,
  // whose heads each carry a dispatch SUCCESS while the rollup still shows an
  // older `pull_request` FAILURE. Advice naming it would be a second dead end
  // — which is the exact failure this function exists to stop.
  it('never offers a dispatch as the way to clear the context', () => {
    for (const alreadyRequested of [undefined, [], [OPERATOR], [AUTO]]) {
      for (const isAuthorStandIn of [true, false]) {
        const text = advice({ alreadyRequested, isAuthorStandIn })
        expect(text, `${String(alreadyRequested)}/${String(isAuthorStandIn)}`).not.toMatch(/gh workflow run/)
      }
    }
  })

  it('where it mentions a dispatch at all, it says the check does not reach this PR', () => {
    const text = advice({ alreadyRequested: [OPERATOR] })
    expect(text).toMatch(/workflow_dispatch/)
    expect(text).toMatch(/never enters this PR's status-check rollup/)
    expect(text).toMatch(/cannot clear this context/)
  })

  it('matches the already-requested login case-insensitively, as GitHub does', () => {
    expect(advice({ alreadyRequested: ['Rhonda-Rodododo'] })).toContain('ALREADY a requested reviewer')
  })

  it('an UNREADABLE requested-reviewer list is not an empty one — it never claims the re-request works', () => {
    const text = advice({ alreadyRequested: undefined })
    expect(text).not.toContain('ALREADY a requested reviewer')
    // Nor does it promise the request WILL fire — it cannot rule out the no-op.
    expect(text).toMatch(/whether that request will emit an event is unknown/)
    expect(text).not.toMatch(/so that request will emit an event/)
  })

  it('promises the request will fire only when it has SEEN the login is absent', () => {
    expect(advice({ alreadyRequested: [] })).toMatch(/so that request will emit an event/)
    expect(advice({ alreadyRequested: [AUTO] })).toMatch(/so that request will emit an event/)
    expect(advice({ alreadyRequested: [OPERATOR] })).not.toMatch(/so that request will emit an event/)
    expect(advice({ alreadyRequested: undefined })).not.toMatch(/so that request will emit an event/)
  })

  it('every branch names the login to ask', () => {
    for (const alreadyRequested of [undefined, [], [OPERATOR], [AUTO]]) {
      for (const isAuthorStandIn of [true, false]) {
        const text = advice({ alreadyRequested, isAuthorStandIn })
        expect(text, `${String(alreadyRequested)}/${String(isAuthorStandIn)}`).toContain(`\`${OPERATOR}\``)
      }
    }
  })
})
