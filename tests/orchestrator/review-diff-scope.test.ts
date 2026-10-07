/**
 * #1664 — `fleet/review` must distinguish "introduced by this diff" from
 * "visible in this diff".
 *
 * The live failure: PR #1653 was a pure type-rename and `fleet/review`
 * returned `REJECTED:reviewed` for two findings on lines byte-identical at
 * base `68b6b69d` and head `82f6060d` (`CaseManagementViewModel.swift:406`,
 * outside every hunk; `EventsViewModel.swift:271`, a CONTEXT line inside
 * one). The findings were right. The verdict was not actionable: the author's
 * only ways to green were to widen a rename into an E2EE fix or to argue with
 * a required check.
 *
 * What is pinned here, and what is NOT. The verdict is formed by a model
 * reading `DIFF_SCOPE_CONTRACT`, so these tests pin the two things that are
 * code: (1) EVERY reviewer prompt carries the scope contract — a reviewer
 * that never reads the rule cannot follow it, and the one that rejected #1653
 * was a specialist, not the generalist; (2) a reported out-of-scope finding
 * reaches the check's own summary, so a green check cannot read as clean when
 * one exists. There is deliberately NO code path that turns a FAIL into a
 * PASS — see `DIFF_SCOPE_CONTRACT`'s doc comment — and the last test here
 * pins that absence: a FAIL with out-of-scope findings beside it still fails.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  DIFF_SCOPE_CONTRACT, OUT_OF_SCOPE_HEADING, VERIFIER_BRIEF, outOfScopeFindings,
} from '../../orchestrator/src/review.js'
import { buildProfileReviewPrompt } from '../../orchestrator/src/specialist.js'
import { runReviewCi, composeReviewSet, outOfScopeSummary, GENERAL_REVIEWER, type CiContext, type ReviewCiDeps } from '../../orchestrator/src/ci.js'
import type { Lane } from '../../orchestrator/src/config.js'
import type { VerifyReport } from '../../orchestrator/src/verify.js'

const ctx = (over: Partial<CiContext> = {}): CiContext => ({
  branch: 'fleet/ios/1653', repoDir: '/base', headDir: '/tmp/head',
  baseSha: '68b6b69d', headSha: '82f6060d', pr: '1653', ...over,
})

const lane = (): Lane => ({
  id: 'ios', mode: 'off', cap: 1, engine: 'claude',
  requireLabel: 'agent-dispatchable', vetoLabels: ['needs-human'],
  scope: { owned: ['apps/ios/'], notOwned: [] },
})

const passing: VerifyReport = {
  passed: true, reasons: [], changedFiles: ['apps/ios/Sources/ViewModels/EventsViewModel.swift'],
  addedLines: 3, impact: 'low', impactReasons: [], testsRun: ['orchestrator'], testsPassed: true,
  verifiedCommit: '82f6060d',
}

const deps = (over: Partial<ReviewCiDeps> = {}): ReviewCiDeps => ({
  ctx: ctx(),
  apiKey: 'a-key',
  lanes: async () => [lane()],
  verify: vi.fn(async () => passing),
  pathExists: (p: string) => p !== '/tmp/head/.git',
  log: () => {},
  prDiff: vi.fn(async () => 'diff --git a/x b/x'),
  secondOpinion: vi.fn(async () => ({ verdict: 'PASS' as const, text: 'the rename is consistent\nVERDICT: PASS' })),
  reviewSet: async () => ({ ok: true, profiles: [], fromLabels: [], reasons: [] }),
  resolveProfile: vi.fn(async (name: string) => ({ ok: true as const, profile: { agent: name, instructions: `be a ${name}` } })),
  stripExport: vi.fn(async () => {}),
  publishReport: vi.fn(async () => {}),
  profileReview: vi.fn(async () => ({ verdict: 'PASS' as const, text: 'nothing in my scope\nVERDICT: PASS' })),
  ...over,
})

/** The shape #1653's reviewer should have produced: the diff is sound, and
 *  the pre-existing E2EE gap it noticed is reported instead of rejected. */
const PASS_WITH_FINDING = [
  'The rename is mechanical and consistent across every call site.',
  '',
  OUT_OF_SCOPE_HEADING,
  '',
  '- `apps/ios/Sources/ViewModels/EventsViewModel.swift:271` — `readerPubkeys: []` leaves the',
  '  server to add admin pubkeys; identical at the base commit, so this diff did not introduce it.',
  '- `apps/ios/Sources/ViewModels/CaseManagementViewModel.swift:406` — same pattern, also unchanged.',
  '',
  'VERDICT: PASS',
].join('\n')

describe('the diff-scope contract reaches every reviewer', () => {
  it('is in the general reviewer brief', () => {
    expect(VERIFIER_BRIEF).toContain(DIFF_SCOPE_CONTRACT)
  })

  // The reviewer that rejected #1653 was `crypto-security-reviewer`, a
  // PROFILE. A contract the generalist alone reads would not have fixed it.
  it('is in every profile prompt, one shared copy', () => {
    const prompt = buildProfileReviewPrompt(
      { agent: 'crypto-security-reviewer', instructions: 'be a crypto reviewer' },
      '#1653 rename', 'diff --git a/x b/x', ['apps/ios/x.swift'], '/tmp/export',
    )
    expect(prompt).toContain(DIFF_SCOPE_CONTRACT)
  })

  // The two halves of the rule, stated as the test of whether the contract
  // still says what the fix depends on: a defect the diff CAUSES is in scope
  // even on an unchanged line, and a defect the diff merely REVEALS is not.
  it('names the attribution rule in both directions', () => {
    expect(DIFF_SCOPE_CONTRACT).toContain('FAIL for a defect this diff is responsible for')
    expect(DIFF_SCOPE_CONTRACT).toContain('rename that leaves a call site stale')
    expect(DIFF_SCOPE_CONTRACT).toContain('Do NOT fail for a defect that is equally present without this diff')
    expect(DIFF_SCOPE_CONTRACT).toContain(OUT_OF_SCOPE_HEADING)
  })
})

describe('outOfScopeFindings', () => {
  it('is empty when the reviewer reported no section', () => {
    expect(outOfScopeFindings('all good\nVERDICT: PASS')).toEqual([])
  })

  it('reads one entry per bullet, continuations included', () => {
    expect(outOfScopeFindings(PASS_WITH_FINDING)).toEqual([
      '`apps/ios/Sources/ViewModels/EventsViewModel.swift:271` — `readerPubkeys: []` leaves the ' +
      'server to add admin pubkeys; identical at the base commit, so this diff did not introduce it.',
      '`apps/ios/Sources/ViewModels/CaseManagementViewModel.swift:406` — same pattern, also unchanged.',
    ])
  })

  // Tolerant on READING what the brief asks for exactly. A finding dropped
  // because the reviewer wrote `###` or added a colon is the same defect as
  // never asking for the section.
  it.each([
    '### Out-of-scope findings',
    '## Out of scope findings:',
    '## OUT-OF-SCOPE FINDINGS (1)',
  ])('accepts the near-miss heading %s', (heading) => {
    expect(outOfScopeFindings(`x\n\n${heading}\n\n- a.ts:1 — pre-existing\n\nVERDICT: PASS`))
      .toEqual(['a.ts:1 — pre-existing'])
  })

  // Never `[]` for a section that has text in it: ci.ts decides from this
  // list whether a GREEN check must carry findings, so a parse failure here
  // would silently drop the one signal the section exists to carry.
  it('returns an unbulleted section whole rather than losing it', () => {
    expect(outOfScopeFindings(`${OUT_OF_SCOPE_HEADING}\n\nEventsViewModel.swift:271 ships no reader pubkeys.\n`))
      .toEqual(['EventsViewModel.swift:271 ships no reader pubkeys.'])
  })

  it.each([
    ['the next heading', '## Notes\n\n- not a finding\n'],
    ['a horizontal rule', '---\n\n- another reviewer\'s text\n'],
    // The brief puts the verdict line LAST, so an un-terminated section runs
    // to end-of-text and would swallow it into the final finding.
    ['the verdict line', 'VERDICT: PASS\n'],
  ])('stops at %s', (_what, tail) => {
    expect(outOfScopeFindings(`${OUT_OF_SCOPE_HEADING}\n\n- a.ts:1 — pre-existing\n\n${tail}`))
      .toEqual(['a.ts:1 — pre-existing'])
  })
})

describe('outOfScopeSummary', () => {
  it('is undefined when nothing was reported, leaving the check output unchanged', () => {
    expect(outOfScopeSummary([{ reviewer: 'general', findings: [] }])).toBeUndefined()
  })

  it('names the count, every finding, and that they are not grounds for rejection', () => {
    const s = outOfScopeSummary([
      { reviewer: 'general', findings: ['a.ts:1 — pre-existing'] },
      { reviewer: 'crypto-security-reviewer', findings: ['b.ts:2 — pre-existing', 'c.ts:3 — pre-existing'] },
    ])
    expect(s).toContain('3 OUT-OF-SCOPE FINDINGS')
    expect(s).toContain('NOT grounds for rejecting it')
    expect(s).toContain('general: a.ts:1')
    expect(s).toContain('crypto-security-reviewer: b.ts:2')
    expect(s).toContain('crypto-security-reviewer: c.ts:3')
  })
})

describe('fleet/review with out-of-scope findings', () => {
  // The #1653 case, as it should now conclude: PASS, with the finding on the
  // check rather than swallowed by it.
  it('passes and hoists the findings into the check summary', async () => {
    const d = deps({ secondOpinion: vi.fn(async () => ({ verdict: 'PASS' as const, text: PASS_WITH_FINDING })) })
    const v = await runReviewCi(d)
    expect(v.ok).toBe(true)
    expect(v.result).toBe('pass')
    expect(v.summary).toContain('2 OUT-OF-SCOPE FINDINGS')
    expect(v.summary).toContain('EventsViewModel.swift:271')
    // Above the reviewer's prose, not buried in it: a green check's one
    // remaining action item has to be the first thing read.
    expect(v.summary.indexOf('OUT-OF-SCOPE')).toBeLessThan(v.summary.indexOf('The rename is mechanical'))
  })

  // The full text still reaches the PR comment too. The two channels fail
  // independently: `writeReviewReport` is non-fatal by design, so the check
  // summary is what makes the finding undroppable.
  it('still publishes the reviewer text in full', async () => {
    const d = deps({ secondOpinion: vi.fn(async () => ({ verdict: 'PASS' as const, text: PASS_WITH_FINDING })) })
    await runReviewCi(d)
    expect(d.publishReport).toHaveBeenCalledWith([
      { reviewer: 'general', verdict: 'PASS', body: PASS_WITH_FINDING },
    ])
  })

  it('adds nothing to the summary when no findings were reported', async () => {
    const v = await runReviewCi(deps())
    expect(v.summary).not.toContain('OUT-OF-SCOPE')
    expect(v.summary).toBe('VERDICT: PASS\n\nthe rename is consistent\nVERDICT: PASS')
  })

  // THE GUARD AGAINST BLINDING THE REVIEWER. An out-of-scope section is
  // additive reporting and must never soften a verdict: nothing in this
  // change may turn a FAIL green, which is the `PASS:unearned` defect class
  // the verdict taxonomy exists to keep out.
  it('still FAILS when the verdict is FAIL, findings beside it or not', async () => {
    const text = `the diff drops the admin envelope\n\n${OUT_OF_SCOPE_HEADING}\n\n- a.ts:1 — pre-existing\n\nVERDICT: FAIL — the new code wraps for one recipient`
    const v = await runReviewCi(deps({ secondOpinion: vi.fn(async () => ({ verdict: 'FAIL' as const, text })) }))
    expect(v.ok).toBe(false)
    expect(v.result).toBe('fail')
    expect(v.summary).toContain('1 OUT-OF-SCOPE FINDING')
  })

  // A profile's FAIL fails the set even when the generalist passed — the
  // #1653 shape exactly, now with the profile rejecting something the diff
  // really did introduce.
  it('still FAILS on a profile FAIL beside a passing generalist', async () => {
    const v = await runReviewCi(deps({
      reviewSet: async () => ({ ok: true, profiles: ['crypto-security-reviewer'], fromLabels: [], reasons: [] }),
      profileReview: vi.fn(async () => ({
        verdict: 'FAIL' as const,
        text: 'the renamed envelope drops the admin copy\nVERDICT: FAIL — admin envelope missing',
      })),
    }))
    expect(v.ok).toBe(false)
    expect(v.result).toBe('fail')
  })
})

// `composeReviewSet` is the one composition BOTH producers of the
// `fleet/review` check share — the CI gate above and
// `review-and-merge.ts`'s operator command. Pinned directly so the operator
// path cannot lose the hoist while the gate keeps it.
describe('composeReviewSet carries out-of-scope findings for both producers', () => {
  const settled = (text: string, verdict: 'PASS' | 'FAIL') =>
    [{ status: 'fulfilled' as const, value: { verdict, text } }]

  it('hoists them above the reviewer prose on a PASS', () => {
    const composed = composeReviewSet([GENERAL_REVIEWER], settled(PASS_WITH_FINDING, 'PASS'))
    expect(composed.ok).toBe(true)
    expect(composed.summary).toContain('2 OUT-OF-SCOPE FINDINGS')
    expect(composed.summary.indexOf('OUT-OF-SCOPE')).toBeLessThan(composed.summary.indexOf('The rename is mechanical'))
  })

  it('leaves a clean review\'s summary byte-identical', () => {
    const composed = composeReviewSet([GENERAL_REVIEWER], settled('all good\nVERDICT: PASS', 'PASS'))
    expect(composed.summary).toBe('VERDICT: PASS\n\nall good\nVERDICT: PASS')
  })
})
