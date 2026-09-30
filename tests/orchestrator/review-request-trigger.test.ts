import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  reviewIsRequested, reviewRequestFor, reviewRequestEventFromEnv, reviewTriggerLogins,
  isRepublishOnlyEvent, standingReviewRequest, decideReviewGate,
  REVIEW_REQUEST_LOGIN, RELEASE_REVIEW_REQUEST_LOGIN,
  type ReviewRequestDecision, type ReviewRequestEvent, type ReviewGateOutcome,
} from '../../orchestrator/src/ci.js'
import { diffHash, type CachedVerdict, type ReviewCache } from '../../orchestrator/src/review-cache.js'
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

/** GitHub's evaluation of a context path: a missing property is `null`. */
function contextValue(context: Record<string, unknown>, path: string): unknown {
  let v: unknown = context
  for (const part of path.split('.')) v = v !== null && typeof v === 'object' ? (v as Record<string, unknown>)[part] : undefined
  return v
}

/** GitHub's evaluation of `join(<array path>.*.<field>, ',')` — the one
 *  function the gate's `env:` may use: it hands over a RAW list (the PR's
 *  requested reviewers), and compares nothing. A missing array joins to ''. */
function evaluateJoin(context: Record<string, unknown>, arrayPath: string, field: string): string {
  const arr = contextValue(context, arrayPath)
  if (!Array.isArray(arr)) return ''
  return arr.map((x) => (x !== null && typeof x === 'object' ? (x as Record<string, unknown>)[field] : undefined))
    .filter((x) => x !== undefined && x !== null).map(String).join(',')
}

const JOIN_EXPR = /^join\(\s*([A-Za-z_][\w.]*)\.\*\.([A-Za-z_]\w*)\s*,\s*','\s*\)$/

/** GitHub's evaluation of `${{ <context path> }}` — or of a raw
 *  `${{ join(<path>.*.<field>, ',') }}` — for the gate's event fields: a
 *  missing property is `null`, which `env:` renders as ''. Any other
 *  expression over `github.event*` is refused outright — the rule must never
 *  be re-expressed in YAML (#1213's shim was). */
function evaluateGateEnv(context: Record<string, unknown>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, raw] of Object.entries(gateStep().env ?? {})) {
    const value = String(raw)
    const inner = /^\$\{\{\s*(.*?)\s*\}\}$/.exec(value)?.[1]
    const path = inner !== undefined && /^[A-Za-z_][\w.]*$/.test(inner) ? inner : undefined
    const joined = inner === undefined ? null : JOIN_EXPR.exec(inner)
    if (path !== undefined) {
      const v = contextValue(context, path)
      env[key] = v === undefined || v === null ? '' : String(v)
    } else if (joined !== null) {
      env[key] = evaluateJoin(context, joined[1] ?? '', joined[2] ?? '')
    } else {
      if (value.includes('github.event')) {
        throw new Error(`${key} is not a single context path (${value}) — the gate step must hand over raw event fields only`)
      }
      env[key] = value
    }
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

// ---------------------------------------------------------------------------
// A push under a STANDING review request. The defect: `llamenos-auto` stays
// in a PR's `requested_reviewers` for good (its verdict is a check, never a
// GitHub review), GitHub emits no `review_requested` for a login already
// requested, and every push that changed the diff concluded `not-requested`
// — red on 15 of 47 open PRs, clearable only by DELETE-then-POST on
// `requested_reviewers` by hand, after every push.
//
// The rule these rails pin, end to end from fleet-review.yml's own `env:`
// and `runs-on:` through the CLI's own reader to the gate's own decision:
//   - a push while a TRIGGER login is still requested reviews a changed diff;
//   - a push with nobody requested, or only a non-trigger, reviews nothing;
//   - an unchanged diff is a cache hit either way — no model call;
//   - whenever the gate may reach the engine, `runs-on` is the review box.
// ---------------------------------------------------------------------------

interface PushPayload extends PrPayload { requested_reviewers: { login: string }[] }

const push = (pr: PrPayload, requested: readonly string[]): PushPayload =>
  ({ ...pr, requested_reviewers: requested.map((login) => ({ login })) })

/** The live shapes this rule was written against. */
const PR_1219 = { number: 1219, user: { login: AUTO }, head: { ref: KNOPE_RELEASE_BRANCH } }
const PR_1184 = { number: 1184, user: { login: AUTO }, head: { ref: 'fleet/desktop/1130' } }

function pushContext(pr: PushPayload): Record<string, unknown> {
  return { github: { event_name: 'pull_request', event: { action: 'synchronize', number: pr.number, pull_request: pr } } }
}

/** The CLI's own reading of one `synchronize` delivery. */
function pushEvent(pr: PushPayload): ReviewRequestEvent {
  return reviewRequestEventFromEnv(evaluateGateEnv(pushContext(pr)), pr.head.ref)
}

/** `fleet-review` job's `runs-on`, evaluated over one payload. Only the
 *  expression's exact current SHAPE is understood — anything else throws,
 *  so a rewrite of `runs-on` must come back through this rail. */
function runsOnFor(context: Record<string, unknown>): 'hosted' | 'review-box' {
  const wf = parseYaml(readFileSync(FLEET_REVIEW_YML, 'utf8')) as { jobs: Record<string, { 'runs-on'?: unknown }> }
  const expr = String(wf.jobs['fleet-review']?.['runs-on'] ?? '')
  const m = /^\$\{\{\s*github\.event\.action == 'synchronize' && join\(\s*([A-Za-z_][\w.]*)\.\*\.([A-Za-z_]\w*)\s*,\s*','\s*\) == '' && fromJSON\('\["ubuntu-latest"\]'\) \|\| fromJSON\('\["self-hosted","fleet-review"\]'\) \}\}$/.exec(expr)
  if (m === null) throw new Error(`fleet-review runs-on has a shape this rail does not evaluate: ${expr}`)
  const action = contextValue(context, 'github.event.action')
  // GitHub's `==` on strings is case-insensitive; '' == '' is the empty list.
  const hosted = String(action ?? '').toLowerCase() === 'synchronize' && evaluateJoin(context, m[1] ?? '', m[2] ?? '') === ''
  return hosted ? 'hosted' : 'review-box'
}

function fakeCache(entry?: { hash: string; verdict: CachedVerdict }): ReviewCache {
  return {
    lookup: async (key) => (entry !== undefined && key.diffHash === entry.hash ? entry.verdict : undefined),
    record: async () => {},
  }
}

/** The gate, over one push, exactly as `runReviewGate` (cli.ts) wires it. */
async function gateFor(event: ReviewRequestEvent, diff: string, cache: ReviewCache): Promise<ReviewGateOutcome> {
  return decideReviewGate({
    ctx: { branch: event.branch, repoDir: '/nonexistent', headDir: '/nonexistent', headSha: 'h', baseSha: 'b', pr: '1' },
    prDiff: async () => diff,
    changedFiles: async () => ['apps/worker/routes/calls.ts'],
    cacheFor: () => cache,
    requested: reviewRequestFor(event).requested,
    republishOnly: isRepublishOnlyEvent(event),
    prAuthor: event.prAuthor,
    reviewSet: async () => ({ ok: true, profiles: [], fromLabels: [], reasons: [] }),
    log: () => {},
  })
}

const CHANGED = 'diff --git a/apps/worker/routes/calls.ts b/apps/worker/routes/calls.ts\n+changed\n'
const EARNED = 'diff --git a/apps/worker/routes/calls.ts b/apps/worker/routes/calls.ts\n+earned\n'

describe('rail: a push reviews a changed diff only while a review is still requested', () => {
  it('the gate step hands the payload\'s requested_reviewers over raw', () => {
    expect(evaluateGateEnv(pushContext(push(FLEET_PR, [AUTO, 'some-colleague'])))['FLEET_REVIEW_STANDING_REVIEWERS'])
      .toBe(`${AUTO},some-colleague`)
    expect(evaluateGateEnv(pushContext(push(FLEET_PR, [])))['FLEET_REVIEW_STANDING_REVIEWERS']).toBe('')
  })

  // The defect, injected: an operator-authored PR with `llamenos-auto`
  // requested days ago, and a push that changed the diff.
  it('a push to a PR with llamenos-auto still requested reviews the changed diff', async () => {
    const event = pushEvent(push(FLEET_PR, [OPERATOR, AUTO].filter((l) => l !== FLEET_PR.user.login)))
    expect(standingReviewRequest(event)).toBe(AUTO)
    expect(reviewRequestFor(event)).toEqual({ requested: true })
    expect(isRepublishOnlyEvent(event)).toBe(false)
    expect((await gateFor(event, CHANGED, fakeCache())).kind).toBe('run-engine')
  })

  it('the same push with NOBODY requested concludes not-requested — no model call, and the reason names whom to ask', async () => {
    const event = pushEvent(push(FLEET_PR, []))
    const d = reviewRequestFor(event)
    expect(d.requested).toBe(false)
    expect(!d.requested && d.reason).toContain(`\`${AUTO}\``)
    expect(isRepublishOnlyEvent(event)).toBe(true)
    expect((await gateFor(event, CHANGED, fakeCache())).kind).toBe('not-requested')
  })

  // An unchanged diff (a rebase main did not touch) must stay free under a
  // standing request: the cache is consulted BEFORE the request, so the
  // standing request never turns a republish into a model call.
  it('a rebase with an unchanged diff under a standing request is a cache hit, never a review', async () => {
    const event = pushEvent(push(FLEET_PR, [AUTO]))
    const cache = fakeCache({ hash: diffHash(EARNED), verdict: { verdict: 'PASS', text: 'VERDICT: PASS (cached)' } })
    expect((await gateFor(event, EARNED, cache)).kind).toBe('cache-hit')
  })

  // Defect 2's live instance: #1219, the knope release PR `llamenos-auto`
  // wrote, with the operator requested (GitHub refuses `llamenos-auto`).
  it('#1219: a knope force-push with the operator still requested reviews the new release diff', async () => {
    const event = pushEvent(push(PR_1219, [OPERATOR]))
    expect(standingReviewRequest(event)).toBe(OPERATOR)
    expect((await gateFor(event, CHANGED, fakeCache())).kind).toBe('run-engine')
  })

  // #1184: `llamenos-auto`'s own fleet PR, and nobody has been asked. Red,
  // and the reason must name the request GitHub WILL accept — never the
  // author itself.
  it('#1184: llamenos-auto\'s PR with nobody requested is red, naming the operator as whom to ask', async () => {
    const event = pushEvent(push(PR_1184, []))
    const d = reviewRequestFor(event)
    expect(d.requested).toBe(false)
    expect(!d.requested && d.reason).toContain(`\`${OPERATOR}\``)
    expect(!d.requested && d.reason).not.toContain(`\`${AUTO}\``)
    expect((await gateFor(event, CHANGED, fakeCache())).kind).toBe('not-requested')
  })

  // CODEOWNERS requests the operator on almost every PR by itself. That is
  // not a request for the fleet's review, so it must never make a push a
  // model call — on a Dependabot PR or a colleague's.
  it.each([
    [DEPENDABOT_PR],
    [{ number: 7, user: { login: 'some-colleague' }, head: { ref: 'feature/x' } }],
  ])('a push under only the CODEOWNERS request for the operator reviews nothing (%#)', async (pr) => {
    const event = pushEvent(push(pr, [OPERATOR]))
    expect(standingReviewRequest(event)).toBeUndefined()
    expect(isRepublishOnlyEvent(event)).toBe(true)
    const d = reviewRequestFor(event)
    expect(!d.requested && d.reason).toMatch(/none of them a trigger here/)
  })

  it('the request is compared case-insensitively, like every other login here', () => {
    expect(standingReviewRequest(pushEvent(push(FLEET_PR, [AUTO.toUpperCase()])))).toBe(AUTO)
  })

  // A standing request is a PUSH-only fact. On a `review_requested` event the
  // event's own reviewer is the whole signal: a request for a colleague must
  // not start the fleet review just because `llamenos-auto` is also listed.
  it('on a review_requested event, a standing request for llamenos-auto does not turn someone else\'s request into ours', () => {
    const env = evaluateGateEnv({
      github: {
        event_name: 'pull_request',
        event: { action: 'review_requested', number: 1, pull_request: push(FLEET_PR, [AUTO, 'some-colleague']), requested_reviewer: { login: 'some-colleague' } },
      },
    })
    const event = reviewRequestEventFromEnv(env, FLEET_PR.head.ref)
    expect(standingReviewRequest(event)).toBeUndefined()
    expect(reviewRequestFor(event).requested).toBe(false)
  })

  // The runner. `run-engine` on a GitHub-hosted runner would have no
  // logged-in `claude`; the box for a push nobody asked about would queue
  // gate-only runs in front of real reviews. Every cell of authors ×
  // branches × requested-reviewer sets: whenever the gate CAN reach the
  // engine, `runs-on` is the box; with nobody requested it is hosted.
  const REQUESTED_SETS: readonly (readonly string[])[] = [[], [AUTO], [OPERATOR], ['some-colleague'], [AUTO, OPERATOR], [OPERATOR, 'some-colleague']]
  it.each(CELLS)('runs-on agrees with the gate on every push to a PR by %s on %s', (author, branch) => {
    const pr = { number: 1, user: { login: author }, head: { ref: branch } }
    for (const requested of REQUESTED_SETS) {
      // GitHub never lists a PR's author among its requested reviewers.
      const payload = push(pr, requested.filter((l) => l.toLowerCase() !== author.toLowerCase()))
      const event = pushEvent(payload)
      const runner = runsOnFor(pushContext(payload))
      if (!isRepublishOnlyEvent(event)) {
        expect(runner, `the gate may review ${JSON.stringify(payload.requested_reviewers)} on a hosted runner`).toBe('review-box')
      }
      if (payload.requested_reviewers.length === 0) {
        expect(runner, 'a push with nobody requested must stay off the review box').toBe('hosted')
        expect(isRepublishOnlyEvent(event)).toBe(true)
      }
    }
  })

  it('every non-push event still runs on the review box', () => {
    for (const action of ['review_requested']) {
      expect(runsOnFor({ github: { event_name: 'pull_request', event: { action, pull_request: push(FLEET_PR, []) } } })).toBe('review-box')
    }
    expect(runsOnFor({ github: { event_name: 'workflow_dispatch', event: {} } })).toBe('review-box')
    expect(runsOnFor({ github: { event_name: 'merge_group', event: { action: 'checks_requested' } } })).toBe('review-box')
  })
})
