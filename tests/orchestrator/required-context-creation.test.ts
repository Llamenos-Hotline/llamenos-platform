import { describe, expect, it } from 'vitest'
import { isRepublishOnlyEvent, REVIEW_RE_EVALUATE_CHECK, REVIEW_GATE_STANDING, REVIEW_REPUBLISH_ACTIONS, reviewGateFailsClosed } from '../../orchestrator/src/ci'
import { parse as parseYaml } from 'yaml'
import { postReviewCheckRun } from '../../orchestrator/src/review-and-merge'
import {
  analyseCarrierUniqueness, analyseForeignCarriers, analyseRequiredContextCreation, concurrencyGroupOn, HEAD_EVENTS, jobNameOn,
  repoWorkflows, RULESET_REQUIRED_CONTEXTS, SAMPLE_HEAD, type Workflow,
} from './required-context-creation'

/**
 * #2806: no path may be gated by a required context that no event on that
 * path will create. See required-context-creation.ts for the model; this
 * suite runs it against the real workflows, then breaks each workflow in the
 * ways that have actually shipped and asserts the guard notices — a guard
 * that has never been seen to fail is not known to work.
 */

const real = repoWorkflows()

/** The real workflows with one file's text rewritten. Asserts the rewrite
 *  actually changed something, so a mutation that silently matches nothing
 *  cannot turn a "the guard fails" case into a vacuous pass. */
function mutate(file: string, from: string | RegExp, to: string): Workflow[] {
  return mutateAll(file, [from, to])
}

/** Several edits to one file; EVERY one must match, or the test is vacuous. */
function mutateAll(file: string, ...edits: Array<readonly [string | RegExp, string]>): Workflow[] {
  if (!real.some((w) => w.file === file)) throw new Error(`no workflow ${file} to mutate`)
  return real.map((w) => {
    if (w.file !== file) return w
    let text = w.text
    for (const [from, to] of edits) {
      const next = text.replace(from, to)
      expect(next, `mutation of ${file} (${String(from)}) matched nothing — the test would pass vacuously`).not.toBe(text)
      text = next
    }
    return { ...w, text }
  })
}

describe('every required context is created on every head event, for every path (#2806)', () => {
  it('holds for the workflows as committed', () => {
    const { violations, creators } = analyseRequiredContextCreation(real)
    expect(violations, `required contexts with no creator:\n${violations.join('\n')}`).toEqual([])
    // Non-vacuous: every context was actually found with at least one
    // creator on every head event, not merely "no violation reported".
    expect([...creators.keys()]).toEqual([...RULESET_REQUIRED_CONTEXTS])
    for (const [context, byEvent] of creators) {
      expect(byEvent.size, context).toBe(HEAD_EVENTS.length)
      for (const [event, who] of byEvent) expect(who.length, `${context} on ${event}`).toBeGreaterThan(0)
    }
  })

  it('pins the creators the model found, so a renamed or moved carrier is a visible diff', () => {
    const { creators } = analyseRequiredContextCreation(real)
    const flat = Object.fromEntries([...creators].map(([c, byEvent]) => [c, [...new Set([...byEvent.values()].flat())].sort()]))
    expect(flat).toEqual({
      'ci-status': ['ci.yml#ci-status'],
      gitleaks: ['secret-scan.yml#gitleaks'],
      CodeQL: ['codeql.yml#codeql'],
      'fleet/verify': ['fleet-verify.yml#fleet-verify'],
      'fleet/review': ['fleet-review.yml#fleet-review'],
    })
  })

  // ─── #2805: fleet/review created only on a review request ──────────────
  it('FAILS when fleet/review is created only on review_requested + synchronize — the #2805 shape', () => {
    const broken = mutate('fleet-review.yml', 'types: [opened, synchronize]', 'types: [review_requested, synchronize]')
    const { violations } = analyseRequiredContextCreation(broken)
    expect(violations.join('\n')).toMatch(/`fleet\/review` on pull_request\.opened: nothing creates it/)
  })

  it('does not count review_requested as a creator — it exists only where CODEOWNERS owns a touched path', () => {
    expect(HEAD_EVENTS.map((e) => e.action)).not.toContain('review_requested')
    const broken = mutate('fleet-review.yml', 'types: [opened, synchronize]', 'types: [review_requested]')
    const { violations } = analyseRequiredContextCreation(broken)
    expect(violations.filter((v) => v.startsWith('`fleet/review` on pull_request.')).length).toBe(2)
  })

  // ─── #2799: the release-PR skip on the uploading CodeQL legs ───────────
  it('FAILS when codeql.yml gates its uploading legs off the release PR — the #1817/#2799 shape', () => {
    const broken = mutate(
      'codeql.yml',
      /\n {4}runs-on: ubuntu-latest\n {4}permissions:\n {6}actions: read\n {6}contents: read\n {6}security-events: write\n/,
      "\n    if: github.event_name != 'pull_request' || github.head_ref != 'release'\n" +
        '    runs-on: ubuntu-latest\n    permissions:\n      actions: read\n      contents: read\n      security-events: write\n',
    )
    const { violations } = analyseRequiredContextCreation(broken)
    expect(violations.join('\n')).toMatch(/`CodeQL` \(code-scanning carrier\) on pull_request\.opened: codeql\.yml#analyze uploads it, but job `analyze` has `if: github\.event_name != 'pull_request' \|\| github\.head_ref != 'release'`/)
  })

  it('FAILS when a job the uploading legs need is conditional — the skip propagates', () => {
    const broken = mutate('codeql.yml', /\n {2}analyze:\n/, "\n  gate:\n    if: github.head_ref != 'release'\n    runs-on: ubuntu-latest\n    steps:\n      - run: 'true'\n  analyze:\n    needs: [gate]\n")
    const { violations } = analyseRequiredContextCreation(broken)
    expect(violations.join('\n')).toMatch(/codeql\.yml#analyze uploads it, but job `gate` has `if: github\.head_ref != 'release'`/)
  })

  // ─── path filters: the general form of "depends on what the PR touches" ─
  it('FAILS when a carrier workflow path-filters pull_request', () => {
    const broken = mutate('secret-scan.yml', /\n {2}pull_request:\s*\n/, "\n  pull_request:\n    paths: ['apps/**']\n")
    const { violations } = analyseRequiredContextCreation(broken)
    expect(violations.join('\n')).toMatch(/`gitleaks` on pull_request\.opened: nothing creates it — secret-scan\.yml#gitleaks `pull_request` has a `paths` filter/)
  })

  it('FAILS when a carrier workflow paths-ignores pull_request', () => {
    const broken = mutate('ci.yml', /\n {2}pull_request:\s*\n/, "\n  pull_request:\n    paths-ignore: ['deploy/**']\n")
    const { violations } = analyseRequiredContextCreation(broken)
    expect(violations.join('\n')).toMatch(/`ci-status` on pull_request\.synchronize: nothing creates it — ci\.yml#ci-status `pull_request` has a `paths-ignore` filter/)
  })

  it('FAILS when a carrier stops running on the merge queue', () => {
    const broken = mutate('fleet-verify.yml', /\n {2}merge_group:\n {4}types: \[checks_requested\]\n/, '\n')
    const { violations } = analyseRequiredContextCreation(broken)
    expect(violations).toContain('`fleet/verify` on merge_group.checks_requested: nothing creates it — fleet-verify.yml#fleet-verify does not trigger on `merge_group`')
  })

  it('FAILS when a carrier branch-filters away the protected branch', () => {
    const broken = mutate('codeql.yml', /\n {2}pull_request:\n {4}branches: \[main\]\n/, '\n  pull_request:\n    branches: [develop]\n')
    const { violations } = analyseRequiredContextCreation(broken)
    expect(violations.join('\n')).toMatch(/`CodeQL` on pull_request\.opened: nothing creates it — codeql\.yml#codeql `pull_request` branches \[develop\] exclude `main`/)
  })

  it('FAILS when a carrier job is renamed away from its required context', () => {
    const broken = mutate('secret-scan.yml', /\n {2}gitleaks:\n/, '\n  gitleaks-renamed:\n')
    const { violations } = analyseRequiredContextCreation(broken)
    expect(violations).toContain('`gitleaks`: no workflow job is named `gitleaks`, so nothing ever creates this required context')
  })

  it('FAILS for a required context no workflow names at all', () => {
    const { violations } = analyseRequiredContextCreation(real, [...RULESET_REQUIRED_CONTEXTS, 'fleet/new-gate'])
    expect(violations).toEqual(['`fleet/new-gate`: no workflow job is named `fleet/new-gate`, so nothing ever creates this required context'])
  })

  it('a job-level `if:` on an Actions carrier is NOT absence — a skipped job still creates its check run', () => {
    // ci-status carries `if: always()`; fleet-verify carries an event-name
    // `if:`. Both are carriers. Absence comes from triggers and uploads only.
    const { violations } = analyseRequiredContextCreation(
      mutate('fleet-verify.yml', /\n {4}if: github\.event_name == 'pull_request' \|\| github\.event_name == 'merge_group'\n/, "\n    if: github.event_name == 'merge_group'\n"),
    )
    expect(violations).toEqual([])
  })
})

describe('fleet/review on open and reopen can only republish (#2806)', () => {
  it('the gate treats every head event fleet-review.yml triggers on as republish-only', () => {
    for (const e of HEAD_EVENTS) {
      if (e.event !== 'pull_request') continue
      expect(REVIEW_REPUBLISH_ACTIONS, e.action).toContain(e.action)
      expect(isRepublishOnlyEvent({ eventName: 'pull_request', action: e.action }), e.action).toBe(true)
    }
  })

  it('a review request is still the only pull_request action that can start a review', () => {
    expect(isRepublishOnlyEvent({ eventName: 'pull_request', action: 'review_requested' })).toBe(false)
    expect(isRepublishOnlyEvent({ eventName: 'merge_group', action: 'opened' })).toBe(false)
    expect(isRepublishOnlyEvent({ eventName: 'pull_request', action: 'labeled' })).toBe(false)
  })
})

describe('one carrier per (head, required context) — #2813', () => {
  it('holds for the workflows as committed', () => {
    const { violations, reevaluators, reevaluates } = analyseCarrierUniqueness(real)
    expect(violations, `second carriers:\n${violations.join('\n')}`).toEqual([])
    // Non-vacuous: both gates really do re-evaluate on a review request —
    // from a workflow of their own that calls them (#2815) — so rules 1, 3,
    // 4 and 5 were applied to them rather than skipped.
    expect(reevaluators.get('fleet-review-re-evaluate.yml')).toEqual(['review_requested'])
    expect(reevaluators.get('fleet-verify-re-evaluate.yml')).toEqual(['review_requested'])
    expect(reevaluates.get('fleet-review-re-evaluate.yml')).toEqual(['fleet-review.yml'])
    expect(reevaluates.get('fleet-verify-re-evaluate.yml')).toEqual(['fleet-verify.yml'])
    // …and the carrier workflows themselves no longer re-evaluate at all.
    expect(reevaluators.has('fleet-review.yml')).toBe(false)
    expect(reevaluators.has('fleet-verify.yml')).toBe(false)
    // #2816: …and no carrier workflow runs on a reopen; the guard is the only one that does.
    for (const file of ['ci.yml', 'secret-scan.yml', 'codeql.yml']) expect(reevaluators.has(file), file).toBe(false)
    expect(reevaluators.get('carriers-on-reopen.yml')).toEqual(['reopened'])
  })

  it('a review request names its run apart from the carrier, for both gates', () => {
    for (const [file, job, carrier] of [
      ['fleet-review.yml', 'fleet-review', 'fleet/review'],
      ['fleet-verify.yml', 'fleet-verify', 'fleet/verify'],
    ] as const) {
      const doc = parseYaml(real.find((w) => w.file === file)?.text ?? '') as { jobs: Record<string, { name?: unknown }> }
      const j = doc.jobs[job]
      if (j === undefined) throw new Error(`no ${job} in ${file}`)
      for (const action of ['opened', 'synchronize']) {
        expect(jobNameOn(file, job, j, { event: 'pull_request', action }), `${file} ${action}`).toBe(carrier)
      }
      // #2816: a reopen is a re-evaluation, never a carrier.
      expect(jobNameOn(file, job, j, { event: 'pull_request', action: 'reopened' }), `${file} reopened`).not.toBe(carrier)
      expect(jobNameOn(file, job, j, { event: 'merge_group', action: 'checks_requested' })).toBe(carrier)
      const reeval = jobNameOn(file, job, j, { event: 'pull_request', action: 'review_requested' })
      expect(reeval).not.toBe(carrier)
      expect(RULESET_REQUIRED_CONTEXTS as readonly string[]).not.toContain(reeval)
      expect(reeval.length).toBeGreaterThan(0)
    }
  })

  it('a fleet/review carrier is exactly a republish-only run — re-running one can never call the model', () => {
    const doc = parseYaml(real.find((w) => w.file === 'fleet-review.yml')?.text ?? '') as { jobs: Record<string, { name?: unknown }> }
    const j = doc.jobs['fleet-review']
    if (j === undefined) throw new Error('no fleet-review job')
    for (const action of ['opened', 'reopened', 'synchronize', 'review_requested', 'labeled', 'edited']) {
      const carrier = jobNameOn('fleet-review.yml', 'fleet-review', j, { event: 'pull_request', action }) === 'fleet/review'
      expect(carrier, action).toBe(isRepublishOnlyEvent({ eventName: 'pull_request', action }))
    }
  })

  it('fail-closed is preserved: re-running a carrier for a PR that never earned a review is still red', () => {
    // A carrier is republish-only (above), so its re-run reaches
    // `decideReviewGate`'s republish branch, never `run-engine`. With nothing
    // cached for the tree and no verdict ever earned that branch is
    // `unreviewed` — and every republish outcome that is not a verdict for
    // THIS tree fails the job. Refreshing a carrier therefore cannot turn a
    // refusal green; only a cached verdict for this exact tree can.
    for (const kind of ['unreviewed', 'tree-changed', 'carry-unreadable', 'not-requested'] as const) {
      expect(REVIEW_GATE_STANDING[kind], kind).toBe('no-verdict')
      expect(reviewGateFailsClosed(kind), kind).toBe(true)
    }
  })

  it('every carrier sits in a concurrency group of its own head', () => {
    for (const file of ['fleet-review.yml', 'fleet-verify.yml']) {
      const doc = parseYaml(real.find((w) => w.file === file)?.text ?? '') as Record<string, unknown>
      const carrier = concurrencyGroupOn(file, doc, { event: 'pull_request', action: 'synchronize', headSha: SAMPLE_HEAD })
      expect(carrier, file).toContain(SAMPLE_HEAD)
      expect(concurrencyGroupOn(file, doc, { event: 'pull_request', action: 'review_requested', headSha: SAMPLE_HEAD }), file).not.toBe(carrier)
    }
  })

  // ─── the shapes that actually shipped ─────────────────────────────────
  it('FAILS on the #2811 shape: fleet-review.yml triggered by a review request, its run named `fleet/review`', () => {
    const broken = mutateAll(
      'fleet-review.yml',
      [/\n {4}name: \$\{\{[^\n]*'fleet\/review'[^\n]*\}\}\n/, '\n    name: fleet/review\n'],
      [/types: \[opened, synchronize\]/, 'types: [review_requested, opened, synchronize]'],
    )
    const { violations } = analyseCarrierUniqueness(broken)
    expect(violations.join('\n')).toMatch(/`fleet\/review` on pull_request\.review_requested: fleet-review\.yml#fleet-review carries the required name/)
  })

  it('FAILS on the #2616 shape: fleet-verify.yml triggered by a review request, its run named `fleet/verify`', () => {
    const broken = mutateAll(
      'fleet-verify.yml',
      [/\n {4}name: \$\{\{[^\n]*'fleet\/verify'[^\n]*\}\}\n/, '\n    name: fleet/verify\n'],
      [/types: \[opened, synchronize\]/, 'types: [opened, synchronize, review_requested]'],
    )
    const { violations } = analyseCarrierUniqueness(broken)
    expect(violations.join('\n')).toMatch(/`fleet\/verify` on pull_request\.review_requested: fleet-verify\.yml#fleet-verify carries the required name/)
  })

  // #2815 — the shape this rail first shipped GREEN on: the re-evaluation
  // named apart (`fleet/review/re-evaluate`) but still a run of the
  // carrier's own workflow. Every check read green and `enqueuePullRequest`
  // refused `2 of 5 required status checks are expected`.
  it.each([
    ['fleet-review.yml', /types: \[opened, synchronize\]/, 'types: [review_requested, opened, synchronize]', 'fleet/review'],
    ['fleet-verify.yml', /types: \[opened, synchronize\]/, 'types: [opened, synchronize, review_requested]', 'fleet/verify'],
  ] as const)('FAILS on the #2815 shape: %s re-evaluating in its own suites, even named apart', (file, from, to, context) => {
    const { violations } = analyseCarrierUniqueness(mutateAll(file, [from, to]))
    const text = violations.join('\n')
    expect(text).toContain(`${file} carries \`${context}\` and also runs on pull_request.review_requested`)
    expect(text).toMatch(/admission reads only the newest suite per workflow, so it shadows the carrier \(#2815/)
    // Named apart, so rule 1 alone was satisfied — rule 5 is what catches it.
    expect(text).not.toMatch(/carries the required name/)
  })

  it('FAILS when a re-evaluating caller does not grant the refresh its `actions: write`', () => {
    const broken = mutateAll('fleet-review-re-evaluate.yml', [/\n {6}actions: write\n/, '\n      actions: read\n'])
    const { violations } = analyseCarrierUniqueness(broken)
    expect(violations.join('\n')).toMatch(/fleet-review-re-evaluate\.yml#re-evaluate: calls fleet-review\.yml without granting `actions: write`/)
  })

  it('a re-evaluation is named `<caller job> / <job>`, which can never be a required context', () => {
    for (const [file, job, expected] of [
      ['fleet-review.yml', 'fleet-review', 're-evaluate / fleet/review/re-evaluate'],
      ['fleet-verify.yml', 'fleet-verify', 're-evaluate / fleet/verify/re-evaluate'],
    ] as const) {
      const doc = parseYaml(real.find((w) => w.file === file)?.text ?? '') as { jobs: Record<string, { name?: unknown }> }
      const j = doc.jobs[job]
      if (j === undefined) throw new Error(`no ${job} in ${file}`)
      const full = `re-evaluate / ${jobNameOn(file, job, j, { event: 'pull_request', action: 'review_requested' })}`
      expect(full).toBe(expected)
      if (file === 'fleet-review.yml') expect(full).toBe(REVIEW_RE_EVALUATE_CHECK)
      expect(RULESET_REQUIRED_CONTEXTS as readonly string[]).not.toContain(full)
    }
  })

  it('FAILS on the `cancelled` shape: a carrier sharing its concurrency group with a review request', () => {
    const broken = mutate('fleet-verify.yml', /\n {2}group: \$\{\{[^\n]*\}\}\n/, "\n  group: ${{ github.event_name == 'pull_request' && format('fleet-verify-pr-{0}', github.ref) || format('fleet-verify-mg-{0}', github.sha) }}\n")
    const { violations } = analyseCarrierUniqueness(broken)
    expect(violations.join('\n')).toMatch(/`fleet\/verify` on pull_request\.opened: fleet-verify\.yml's carrier shares concurrency group `fleet-verify-pr-refs\/pull\/4242\/merge` with fleet-verify-re-evaluate\.yml's pull_request\.review_requested on the same head/)
  })

  it('FAILS when a re-evaluating gate groups its carriers by PR rather than by head', () => {
    const broken = mutate('fleet-review.yml', "format('fleet-review-pr-{0}-head-{1}', github.event.pull_request.number, github.event.pull_request.head.sha)", "format('fleet-review-carrier-pr-{0}', github.event.pull_request.number)")
    const { violations } = analyseCarrierUniqueness(broken)
    expect(violations.join('\n')).toMatch(/fleet-review\.yml's carrier shares concurrency group `fleet-review-carrier-pr-4242` with a carrier for another head/)
  })

  it('FAILS when a gate re-evaluates but nothing re-runs its carrier', () => {
    const broken = mutate('fleet-verify.yml', /\/rerun"/g, '/approve"')
    const { violations } = analyseCarrierUniqueness(broken)
    expect(violations.join('\n')).toMatch(/fleet-verify-re-evaluate\.yml#re-evaluate: re-evaluates fleet-verify\.yml on pull_request\.review_requested but fleet-verify\.yml has no job that re-runs the head's carrier in place/)
  })

  it('FAILS when a second workflow carries a required context on a head event', () => {
    const broken = mutate('secret-scan.yml', /\n {2}gitleaks:\n/, '\n  gitleaks:\n    name: ci-status\n')
    const { violations } = analyseCarrierUniqueness(broken)
    expect(violations.join('\n')).toMatch(/`ci-status` on pull_request\.opened: 2 jobs carry it \(ci\.yml#ci-status, secret-scan\.yml#gitleaks\)/)
  })

  it('FAILS when a workflow adds a re-evaluation trigger to a plain carrier', () => {
    const broken = mutate('secret-scan.yml', 'types: [opened, synchronize]', 'types: [opened, synchronize, labeled]')
    const { violations } = analyseCarrierUniqueness(broken)
    expect(violations.join('\n')).toMatch(/`gitleaks` on pull_request\.labeled: secret-scan\.yml#gitleaks carries the required name/)
  })
})

// ─── #2816: reopening a PR on an unchanged head ───────────────────────────
describe('a reopen creates no carrier, and says so when the head has none (#2816)', () => {
  // The shape that shipped: every carrier workflow's bare `pull_request:`
  // meant [opened, synchronize, reopened], so reopening a PR over its
  // unchanged head put a second carrier of all five required contexts on it.
  it.each([
    ['ci.yml', /types: \[opened, synchronize\]/, 'ci-status'],
    ['secret-scan.yml', /types: \[opened, synchronize\]/, 'gitleaks'],
    ['fleet-verify.yml', /types: \[opened, synchronize\]/, 'fleet/verify'],
    ['fleet-review.yml', /types: \[opened, synchronize\]/, 'fleet/review'],
  ] as const)('FAILS when %s triggers on reopened again — a second `%s` carrier on an unchanged head', (file, from, context) => {
    const { violations } = analyseCarrierUniqueness(mutateAll(file, [from, 'types: [opened, synchronize, reopened]']))
    const text = violations.join('\n')
    expect(text).toContain(`${file} carries`)
    expect(text).toContain('pull_request.reopened')
    expect(text).toContain(`\`${context}\``)
  })

  it('FAILS when codeql.yml triggers on reopened again — a second analysis upload, a second `CodeQL` carrier', () => {
    const { violations } = analyseCarrierUniqueness(mutateAll('codeql.yml', [/types: \[opened, synchronize\]/, 'types: [opened, synchronize, reopened]']))
    expect(violations.join('\n')).toMatch(/codeql\.yml carries .*`CodeQL`.* also runs on pull_request\.reopened/)
  })

  it('FAILS when a bare `pull_request:` brings the default `reopened` back', () => {
    const { violations } = analyseCarrierUniqueness(mutateAll('ci.yml', [/\n {2}pull_request:\n {4}types: \[opened, synchronize\]\n/, '\n  pull_request:\n']))
    expect(violations.join('\n')).toMatch(/`ci-status` on pull_request\.reopened: ci\.yml#ci-status carries the required name/)
  })

  it('FAILS when nothing reports a reopened head that has no carrier — it would be BLOCKED with every check green', () => {
    const { violations } = analyseCarrierUniqueness(real.filter((w) => w.file !== 'carriers-on-reopen.yml'))
    expect(violations.join('\n')).toMatch(/pull_request\.reopened: no workflow reports a reopened head that carries no required context/)
  })

  it('FAILS when the guard stops failing — a guard that cannot fail reports nothing', () => {
    const { violations } = analyseCarrierUniqueness(mutateAll('carriers-on-reopen.yml', [/exit 1/g, 'exit 0']))
    expect(violations.join('\n')).toMatch(/no workflow reports a reopened head/)
  })

  it('FAILS when the guard carries a required name itself — it would be a second carrier on the head it guards', () => {
    const { violations } = analyseCarrierUniqueness(mutateAll('carriers-on-reopen.yml', [/name: carriers\/reopened/, 'name: fleet/verify']))
    expect(violations.join('\n')).toMatch(/`fleet\/verify` on pull_request\.reopened: carriers-on-reopen\.yml#carriers-present carries the required name/)
  })

  it('holds for the workflows as committed', () => {
    expect(analyseCarrierUniqueness(real).violations).toEqual([])
  })
})

// ─── #2816: a second APP posting a required name ──────────────────────────
describe('no other app carries a required context (#2816)', () => {
  /** What `review-and-merge` really posts, observed — never a restated list. */
  async function postedNames(): Promise<string[]> {
    const names: string[] = []
    await postReviewCheckRun('a'.repeat(40), 'PASS', 'VERDICT: PASS', 'binding', {
      mintToken: async () => 'ghs_test',
      http: async (req) => {
        names.push(String((JSON.parse(req.body ?? '{}') as { name?: unknown }).name))
        return { status: 201, body: '{"id":1}' }
      },
    })
    return names
  }

  it('holds as committed: the verdict recorder posts under a name the ruleset does not require', async () => {
    expect(analyseForeignCarriers(real, await postedNames())).toEqual([])
  })

  it('FAILS on the shape that shipped: the App posting `fleet/review` itself', async () => {
    const v = analyseForeignCarriers(real, ['fleet/review'])
    expect(v.join('\n')).toMatch(/`fleet\/review`: the GitHub App verdict recorder posts a check run under the required name/)
  })

  it('FAILS on every required name, not only the one that shipped', () => {
    for (const name of RULESET_REQUIRED_CONTEXTS) expect(analyseForeignCarriers(real, [name]), name).toHaveLength(1)
  })

  it('refuses a vacuous pass when the recorder was observed posting nothing', () => {
    expect(analyseForeignCarriers(real, []).join('\n')).toMatch(/refusing a vacuous pass/)
  })

  it.each([
    ['REST', "gh api -X POST repos/$REPO/check-runs -f name=fleet/review -f head_sha=$SHA"],
    ['REST, method first', 'gh api --method POST "repos/$REPO/check-runs" -f name=ci-status'],
    ['a commit status', 'gh api -X POST repos/$REPO/statuses/$SHA -f context=fleet/verify -f state=success'],
    ['github-script', "await github.rest.checks.create({ name: 'CodeQL' })"],
  ])('FAILS when a workflow step posts a check by hand: %s', (_label, run) => {
    const broken = real.map((w) => w.file !== 'secret-scan.yml' ? w : {
      ...w, text: w.text.replace(/\n {4}steps:\n/, `\n    steps:\n      - name: post\n        run: |\n          ${run.replaceAll('\n', '\n          ')}\n`),
    })
    expect(broken.find((w) => w.file === 'secret-scan.yml')?.text).toContain('name: post')
    expect(analyseForeignCarriers(broken, ['fleet/review/recorded']).join('\n')).toMatch(/secret-scan\.yml#gitleaks: creates a check run or commit status by hand/)
  })

  it('FAILS when a workflow uses a third-party checks action', () => {
    const broken = real.map((w) => w.file !== 'secret-scan.yml' ? w : {
      ...w, text: w.text.replace(/\n {4}steps:\n/, '\n    steps:\n      - uses: LouisBrunner/checks-action@v2\n'),
    })
    expect(analyseForeignCarriers(broken, ['fleet/review/recorded']).join('\n')).toMatch(/creates a check run or commit status by hand/)
  })
})

