import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  composeReviewSet, decideReviewSet, GENERAL_REVIEWER,
  type ReviewSetDeps,
} from '../../orchestrator/src/ci.js'
import { defaultReviewAndMergeDeps } from '../../orchestrator/src/review-and-merge.js'
import { CRYPTO_SECURITY_REVIEWER_AGENT, type SecondOpinionResult } from '../../orchestrator/src/review.js'
import type { ReviewerResolution } from '../../orchestrator/src/specialist.js'

/**
 * #1637 — `llamenos-fleet review-and-merge <pr>` and the CI gate both
 * produce the SAME required check (`fleet/review`) against the same commit.
 * The command's whole value is that its verdict is as authoritative as the
 * gate's, so the two places they could drift — WHICH reviews a PR needs, and
 * HOW N reviewers compose into one verdict — must each have exactly one
 * implementation.
 *
 * These are equivalence rails, not re-tests of either path: they assert the
 * two callers reach the same function, and that no second copy of either
 * decision exists to drift from.
 */

const resolveOk = (name: string): Promise<ReviewerResolution> =>
  Promise.resolve({ ok: true as const, profile: { agent: name, instructions: `you are ${name}` } })

const deps = (over: Partial<ReviewSetDeps>): ReviewSetDeps => ({
  labels: [], changedFiles: [], description: '', resolve: resolveOk, ...over,
})

/**
 * A sample of PRs spanning every input `decideReviewSet` reads: labels
 * alone, the diff alone, the PR's prose alone, both at once, and neither.
 * The point of the crypto-by-path and crypto-by-prose rows is the one the
 * issue named: a crypto diff gets the crypto review whether or not anybody
 * labelled it.
 */
const SAMPLE: { name: string; input: Partial<ReviewSetDeps>; profiles: string[] }[] = [
  { name: 'a plain orchestrator diff, no labels', input: { changedFiles: ['orchestrator/src/ci.ts'] }, profiles: [] },
  {
    name: 'a crypto diff nobody labelled (#1546\'s shape)',
    input: { changedFiles: ['packages/protocol/schemas/note.ts'] },
    profiles: [CRYPTO_SECURITY_REVIEWER_AGENT],
  },
  {
    name: 'the crypto crate itself',
    input: { changedFiles: ['packages/crypto/src/hpke.rs'] },
    profiles: [CRYPTO_SECURITY_REVIEWER_AGENT],
  },
  {
    name: 'a label asking for a profile on an otherwise ordinary diff',
    input: { labels: [CRYPTO_SECURITY_REVIEWER_AGENT], changedFiles: ['README.md'] },
    profiles: [CRYPTO_SECURITY_REVIEWER_AGENT],
  },
  {
    name: 'both the label and the path',
    input: { labels: [CRYPTO_SECURITY_REVIEWER_AGENT], changedFiles: ['packages/crypto/src/hpke.rs'] },
    profiles: [CRYPTO_SECURITY_REVIEWER_AGENT],
  },
  {
    name: 'labels that are not reviewer requests',
    input: { labels: ['review', 'lane:infra', 'crypto'], changedFiles: ['README.md'] },
    profiles: [],
  },
]

describe('the review set review-and-merge runs is the review set the gate runs (#1637)', () => {
  it.each(SAMPLE)('$name', async ({ input, profiles }) => {
    // ONE function, called with the facts each path reads from its own
    // source. A divergence could only come from a second implementation —
    // which the source rail below forbids.
    const set = await decideReviewSet(deps(input))
    expect(set.ok).toBe(true)
    expect(set.ok && set.profiles).toEqual(profiles)
  })

  /**
   * The structural half: `decideReviewSet` is DEFINED once and the two
   * producers of `fleet/review` both IMPORT it. A hand-rolled second copy
   * in either path is the failure this rail exists to catch — the gate's
   * review set and this command's diverging is the worst available outcome,
   * because the command's value is that its verdict is as authoritative as
   * the gate's.
   */
  it('is defined in exactly one file, and both producers import it from there', () => {
    const read = (...p: string[]): string => readFileSync(join(process.cwd(), ...p), 'utf8')
    const ci = read('orchestrator', 'src', 'ci.ts')
    expect(ci, 'decideReviewSet must be defined in ci.ts').toMatch(/export async function decideReviewSet\(/)

    for (const f of ['review-and-merge.ts', 'cli.ts']) {
      const text = read('orchestrator', 'src', f)
      expect(text, `${f} must import decideReviewSet rather than re-deriving it`).toContain('decideReviewSet')
      expect(text, `${f} defines a SECOND decideReviewSet`).not.toMatch(/function decideReviewSet\(/)
      expect(text, `${f} re-derives the review set from -reviewer labels itself`)
        .not.toContain('isReviewerLabel')
      expect(text, `${f} re-derives the review set from the diff itself`)
        .not.toContain('requiredAdditionalReviewers')
    }
  })

  it('review-and-merge wires decideReviewSet to a live read of the PR, with the same resolver as CI', () => {
    const text = readFileSync(join(process.cwd(), 'orchestrator', 'src', 'review-and-merge.ts'), 'utf8')
    // Labels AND the PR's own title/body: the content half is what puts the
    // crypto reviewer on an unlabelled crypto diff.
    expect(text).toMatch(/labels,title,body/)
    expect(text, 'the profile resolver must be resolveReviewerLabel against the agent registry')
      .toMatch(/resolveReviewerLabel\(name, join\(repoRoot, AGENT_REGISTRY_DIR\)\)/)
  })

  it('the real deps resolve a reviewer profile the same way the gate does', async () => {
    const real = defaultReviewAndMergeDeps(process.cwd(), () => {})
    const fromCommand = await real.resolveProfile(CRYPTO_SECURITY_REVIEWER_AGENT)
    expect(fromCommand.ok, 'the crypto reviewer must resolve from this checkout\'s .claude/agents').toBe(true)
    expect(fromCommand.ok && fromCommand.profile.agent).toBe(CRYPTO_SECURITY_REVIEWER_AGENT)
  })
})

describe('the composition rule is shared too — ANY FAIL FAILS, once (#1637)', () => {
  const r = (verdict: SecondOpinionResult['verdict'], text = `VERDICT: ${verdict}`): PromiseSettledResult<SecondOpinionResult> =>
    ({ status: 'fulfilled', value: { verdict, text } })

  it('a set of one is PASS only when that one passed', () => {
    expect(composeReviewSet([GENERAL_REVIEWER], [r('PASS')]).verdict).toBe('PASS')
    expect(composeReviewSet([GENERAL_REVIEWER], [r('FAIL')]).verdict).toBe('FAIL')
    expect(composeReviewSet([GENERAL_REVIEWER], [r('UNREADABLE')]).verdict).toBe('UNREADABLE')
  })

  it('a profile FAIL is never outranked by the general reviewer\'s PASS', () => {
    const composed = composeReviewSet([GENERAL_REVIEWER, CRYPTO_SECURITY_REVIEWER_AGENT], [r('PASS'), r('FAIL')])
    expect(composed.ok).toBe(false)
    expect(composed.verdict).toBe('FAIL')
    expect(composed.result).toBe('fail')
  })

  it('an UNREADABLE is a failure, not a missing opinion', () => {
    const composed = composeReviewSet([GENERAL_REVIEWER, CRYPTO_SECURITY_REVIEWER_AGENT], [r('PASS'), r('UNREADABLE')])
    expect(composed.ok).toBe(false)
    expect(composed.verdict).toBe('UNREADABLE')
    expect(composed.result).toBe('unreadable')
  })

  it('a substantive FAIL outranks an UNREADABLE beside it', () => {
    const composed = composeReviewSet(
      [GENERAL_REVIEWER, CRYPTO_SECURITY_REVIEWER_AGENT, 'docs-reviewer'],
      [r('PASS'), r('FAIL'), r('UNREADABLE')],
    )
    expect(composed.verdict).toBe('FAIL')
    expect(composed.result).toBe('fail')
  })

  it('PASS requires EVERY member to pass', () => {
    const composed = composeReviewSet(
      [GENERAL_REVIEWER, CRYPTO_SECURITY_REVIEWER_AGENT], [r('PASS'), r('PASS')],
    )
    expect(composed.ok).toBe(true)
    expect(composed.verdict).toBe('PASS')
    expect(composed.summary, 'a multi-reviewer summary leads with the roll call')
      .toContain(`${CRYPTO_SECURITY_REVIEWER_AGENT}: PASS`)
  })

  it('a rejected reviewer is its own UNREADABLE and never discards the others', () => {
    const composed = composeReviewSet(
      [GENERAL_REVIEWER, CRYPTO_SECURITY_REVIEWER_AGENT],
      [r('PASS'), { status: 'rejected', reason: new Error('kimi exited 1') }],
    )
    expect(composed.results).toHaveLength(2)
    expect(composed.results[0]?.verdict).toBe('PASS')
    expect(composed.results[1]?.verdict).toBe('UNREADABLE')
    expect(composed.results[1]?.headline).toContain('kimi exited 1')
    expect(composed.verdict).toBe('UNREADABLE')
  })

  it('is defined in exactly one file, and both producers import it from there', () => {
    const read = (f: string): string => readFileSync(join(process.cwd(), 'orchestrator', 'src', f), 'utf8')
    expect(read('ci.ts')).toMatch(/export function composeReviewSet\(/)
    const ram = read('review-and-merge.ts')
    expect(ram, 'review-and-merge must compose with the gate\'s own rule').toContain('composeReviewSet(')
    expect(ram, 'a second composition in review-and-merge.ts would be the drift this rail forbids')
      .not.toMatch(/function composeReviewSet\(/)
    // The mechanical shape of ANY FAIL FAILS lives in ci.ts alone.
    expect(ram, 'review-and-merge.ts must not re-derive "every reviewer passed"')
      .not.toMatch(/every\(\(r\) => r\.verdict === 'PASS'\)/)
  })
})

describe('both producers hand the same reviewers the same read-only posture', () => {
  it('review-and-merge runs profiles through buildProfileReviewPrompt, as the gate does', () => {
    const ram = readFileSync(join(process.cwd(), 'orchestrator', 'src', 'review-and-merge.ts'), 'utf8')
    const cli = readFileSync(join(process.cwd(), 'orchestrator', 'src', 'cli.ts'), 'utf8')
    for (const [f, text] of [['review-and-merge.ts', ram], ['cli.ts', cli]] as const) {
      expect(text, `${f} must build a profile's prompt from its agent definition`)
        .toContain('buildProfileReviewPrompt(')
      expect(text, `${f} must give a named profile the high-impact budget`)
        .toContain('HIGH_IMPACT_MAX_TURNS')
    }
  })

  it('every reviewer in review-and-merge goes through invokeVerifierEngine — never a bespoke spawn', () => {
    const ram = readFileSync(join(process.cwd(), 'orchestrator', 'src', 'review-and-merge.ts'), 'utf8')
    expect((ram.match(/invokeVerifierEngine\(/g) ?? []).length,
      'exactly one invocation helper, shared by the general reviewer and every profile').toBe(1)
    expect(ram, 'the reviewer must not be spawned directly from this file').not.toMatch(/execFileAsync\('(claude|kimi)'/)
  })
})
