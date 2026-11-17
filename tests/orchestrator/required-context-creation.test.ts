import { describe, expect, it } from 'vitest'
import { isRepublishOnlyEvent, REVIEW_REPUBLISH_ACTIONS } from '../../orchestrator/src/ci'
import { parse as parseYaml } from 'yaml'
import {
  analyseCarrierUniqueness, analyseRequiredContextCreation, concurrencyGroupOn, HEAD_EVENTS, jobNameOn,
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
  let hit = false
  const out = real.map((w) => {
    if (w.file !== file) return w
    const text = w.text.replace(from, to)
    hit = text !== w.text
    return { ...w, text }
  })
  expect(hit, `mutation of ${file} matched nothing — the test would pass vacuously`).toBe(true)
  return out
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
    const broken = mutate('fleet-review.yml', 'types: [review_requested, opened, reopened, synchronize]', 'types: [review_requested, synchronize]')
    const { violations } = analyseRequiredContextCreation(broken)
    expect(violations.join('\n')).toMatch(/`fleet\/review` on pull_request\.opened: nothing creates it/)
    expect(violations.join('\n')).toMatch(/`fleet\/review` on pull_request\.reopened: nothing creates it/)
  })

  it('does not count review_requested as a creator — it exists only where CODEOWNERS owns a touched path', () => {
    expect(HEAD_EVENTS.map((e) => e.action)).not.toContain('review_requested')
    const broken = mutate('fleet-review.yml', 'types: [review_requested, opened, reopened, synchronize]', 'types: [review_requested]')
    const { violations } = analyseRequiredContextCreation(broken)
    expect(violations.filter((v) => v.startsWith('`fleet/review` on pull_request.')).length).toBe(3)
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
    const { violations, reevaluators } = analyseCarrierUniqueness(real)
    expect(violations, `second carriers:\n${violations.join('\n')}`).toEqual([])
    // Non-vacuous: both gates really do re-evaluate on a review request, so
    // rules 1, 3 and 4 were applied to them rather than skipped.
    expect(reevaluators.get('fleet-review.yml')).toEqual(['review_requested'])
    expect(reevaluators.get('fleet-verify.yml')).toEqual(['review_requested'])
  })

  it('a review request names its run apart from the carrier, for both gates', () => {
    for (const [file, job, carrier] of [
      ['fleet-review.yml', 'fleet-review', 'fleet/review'],
      ['fleet-verify.yml', 'fleet-verify', 'fleet/verify'],
    ] as const) {
      const doc = parseYaml(real.find((w) => w.file === file)?.text ?? '') as { jobs: Record<string, { name?: unknown }> }
      const j = doc.jobs[job]
      if (j === undefined) throw new Error(`no ${job} in ${file}`)
      for (const action of ['opened', 'reopened', 'synchronize']) {
        expect(jobNameOn(file, job, j, { event: 'pull_request', action }), `${file} ${action}`).toBe(carrier)
      }
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

  it('every carrier sits in a concurrency group of its own head', () => {
    for (const file of ['fleet-review.yml', 'fleet-verify.yml']) {
      const doc = parseYaml(real.find((w) => w.file === file)?.text ?? '') as Record<string, unknown>
      const carrier = concurrencyGroupOn(file, doc, { event: 'pull_request', action: 'synchronize', headSha: SAMPLE_HEAD })
      expect(carrier, file).toContain(SAMPLE_HEAD)
      expect(concurrencyGroupOn(file, doc, { event: 'pull_request', action: 'review_requested', headSha: SAMPLE_HEAD }), file).not.toBe(carrier)
    }
  })

  // ─── the shapes that actually shipped ─────────────────────────────────
  it('FAILS on the #2811 shape: fleet/review named `fleet/review` on a review request', () => {
    const broken = mutate('fleet-review.yml', /\n {4}name: \$\{\{[^\n]*'fleet\/review'[^\n]*\}\}\n/, '\n    name: fleet/review\n')
    const { violations } = analyseCarrierUniqueness(broken)
    expect(violations.join('\n')).toMatch(/`fleet\/review` on pull_request\.review_requested: fleet-review\.yml#fleet-review carries the required name/)
  })

  it('FAILS on the #2616 shape: fleet/verify named `fleet/verify` on a review request', () => {
    const broken = mutate('fleet-verify.yml', /\n {4}name: \$\{\{[^\n]*'fleet\/verify'[^\n]*\}\}\n/, '\n    name: fleet/verify\n')
    const { violations } = analyseCarrierUniqueness(broken)
    expect(violations.join('\n')).toMatch(/`fleet\/verify` on pull_request\.review_requested: fleet-verify\.yml#fleet-verify carries the required name/)
  })

  it('FAILS on the `cancelled` shape: a carrier sharing its concurrency group with a review request', () => {
    const broken = mutate('fleet-verify.yml', /\n {2}group: \$\{\{[^\n]*\}\}\n/, "\n  group: ${{ github.event_name == 'pull_request' && format('fleet-verify-pr-{0}', github.ref) || format('fleet-verify-mg-{0}', github.sha) }}\n")
    const { violations } = analyseCarrierUniqueness(broken)
    expect(violations.join('\n')).toMatch(/`fleet\/verify` on pull_request\.opened: fleet-verify\.yml's carrier shares concurrency group `fleet-verify-pr-refs\/pull\/4242\/merge` with pull_request\.review_requested on the same head/)
  })

  it('FAILS when a re-evaluating gate groups its carriers by PR rather than by head', () => {
    const broken = mutate('fleet-review.yml', "format('fleet-review-pr-{0}-head-{1}', github.event.pull_request.number, github.event.pull_request.head.sha)", "format('fleet-review-carrier-pr-{0}', github.event.pull_request.number)")
    const { violations } = analyseCarrierUniqueness(broken)
    expect(violations.join('\n')).toMatch(/fleet-review\.yml's carrier shares concurrency group `fleet-review-carrier-pr-4242` with a carrier for another head/)
  })

  it('FAILS when a gate re-evaluates but nothing re-runs its carrier', () => {
    const broken = mutate('fleet-verify.yml', /\/rerun"/g, '/approve"')
    const { violations } = analyseCarrierUniqueness(broken)
    expect(violations.join('\n')).toMatch(/fleet-verify\.yml: re-evaluates heads on pull_request\.review_requested but has no job that re-runs the head's carrier in place/)
  })

  it('FAILS when a second workflow carries a required context on a head event', () => {
    const broken = mutate('secret-scan.yml', /\n {2}gitleaks:\n/, '\n  gitleaks:\n    name: ci-status\n')
    const { violations } = analyseCarrierUniqueness(broken)
    expect(violations.join('\n')).toMatch(/`ci-status` on pull_request\.opened: 2 jobs carry it \(ci\.yml#ci-status, secret-scan\.yml#gitleaks\)/)
  })

  it('FAILS when a workflow adds a re-evaluation trigger to a plain carrier', () => {
    const broken = mutate('secret-scan.yml', /\n {2}pull_request:\s*\n/, '\n  pull_request:\n    types: [opened, synchronize, reopened, labeled]\n')
    const { violations } = analyseCarrierUniqueness(broken)
    expect(violations.join('\n')).toMatch(/`gitleaks` on pull_request\.labeled: secret-scan\.yml#gitleaks carries the required name/)
  })
})
