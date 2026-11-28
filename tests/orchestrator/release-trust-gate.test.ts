import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

/**
 * Rail for #3094: no release artifact is built from a commit whose trust
 * snapshot no gate has looked at.
 *
 * `packages/protocol/tools/trust-release.test.ts` recognises two producers of
 * a release, a release PR and a `v*` tag push. ci.yml only ever ran for the
 * first: nothing triggers on a tag, so the tag half of that predicate was
 * written, correct, and never evaluated — and a conditional path nothing
 * triggers reads exactly like a passing one.
 *
 * A `tags: [v*]` trigger in ci.yml is NOT the fix, and this file records why so
 * nobody adds one thinking it would be: the only thing that pushes a release
 * tag is release.yml's `draft` job, with GITHUB_TOKEN, and GitHub starts no
 * workflow for a push made with GITHUB_TOKEN. That trigger would exist, read as
 * a gate, and never fire for a real release, and it would run after the tag
 * already existed. The gate is a step in release.yml's `check` job instead, on
 * the exact merge commit the tag is cut from, before any other job exists.
 *
 * The local publish path (scripts/release/sign-artifacts.sh and
 * promote-release.sh) runs the same `release-check` on its own and is pinned in
 * its own tests; this file pins the CI half.
 */

const RELEASE_YML = join(process.cwd(), '.github', 'workflows', 'release.yml')

interface Step {
  name?: string
  run?: string
  uses?: string
  if?: string
  'continue-on-error'?: boolean | string
}
interface Job {
  needs?: string | string[]
  if?: string
  steps?: Step[]
}
interface Doc {
  jobs: Record<string, Job>
}

const load = (): Doc => parseYaml(readFileSync(RELEASE_YML, 'utf8')) as Doc

const needsOf = (j: Job): string[] => (j.needs === undefined ? [] : Array.isArray(j.needs) ? j.needs : [j.needs])

const TRUST_STEP = /^Release trust check/

/** What is wrong with this workflow's trust gate, or `[]` when nothing is. */
function problems(doc: Doc): string[] {
  const out: string[] = []
  const check = doc.jobs['check']
  if (check === undefined) return ['no `check` job']
  const steps = check.steps ?? []
  const idx = steps.findIndex((s) => TRUST_STEP.test(s.name ?? ''))
  const gate = steps[idx]
  if (gate === undefined) return ['`check` has no "Release trust check" step']
  const run = gate.run ?? ''
  if (!/trust-snapshot-cli\.ts\s+release-check\b/.test(run)) out.push('the step does not run the CLI `release-check`')
  if (!/--candidate\s+"\$MERGE_SHA"/.test(run)) out.push('the step does not judge the merge commit (--candidate "$MERGE_SHA")')
  if (gate.if !== undefined) out.push(`the step is conditional (if: ${gate.if}) — a skip is the default state of a conditional step`)
  if (gate['continue-on-error'] !== undefined && gate['continue-on-error'] !== false) out.push('the step has continue-on-error')
  if (!/\bexit "\$rc"|\bexit 1\b/.test(run) || !/rc=\$\?/.test(run)) out.push('the step does not propagate the CLI exit code')
  if (!/no verdict/.test(run)) out.push('the step does not fail when the CLI printed no verdict (a vacuous pass)')
  const version = steps.findIndex((s) => s.name === 'Read new version from package.json')
  if (version < 0 || idx < version) out.push('the gate must follow the checkout of the merge commit')
  if (check.if === undefined || !/merged == true/.test(check.if)) out.push('`check` lost its merged release-PR guard')

  // Every other job must be downstream of `check`, so none can run (and in
  // particular `draft`, which creates the tag) when the gate refuses.
  const reaches = (name: string, seen = new Set<string>()): boolean => {
    if (name === 'check') return true
    if (seen.has(name)) return false
    seen.add(name)
    const j = doc.jobs[name]
    return j !== undefined && needsOf(j).some((n) => reaches(n, seen))
  }
  for (const [name, j] of Object.entries(doc.jobs)) {
    if (name === 'check') continue
    if (!reaches(name)) out.push(`job "${name}" does not depend on \`check\`, so it can run when the trust gate refuses`)
    // An `always()`/`!cancelled()` job-level `if:` runs even after an upstream failure.
    if (j.if !== undefined && /\balways\(\)|!cancelled\(\)|!failure\(\)/.test(j.if)) {
      out.push(`job "${name}" has a status-function \`if:\` (${j.if}) that can run after \`check\` fails`)
    }
  }
  if (!needsOf(doc.jobs['draft'] ?? {}).includes('check')) out.push('`draft` (which creates the git tag) must need `check` directly')
  return out
}

describe('rail: the release trust gate runs before a tag, a draft or a build exists (#3094)', () => {
  it('release.yml has the gate, correctly shaped, and nothing escapes it', () => {
    expect(problems(load())).toEqual([])
  })

  it('MUTATION: deleting the step is caught', () => {
    const doc = load()
    doc.jobs['check']!.steps = doc.jobs['check']!.steps!.filter((s) => !TRUST_STEP.test(s.name ?? ''))
    expect(problems(doc)).toContain('`check` has no "Release trust check" step')
  })

  it('MUTATION: making the step conditional, tolerant or candidate-less is caught', () => {
    const mutate = (f: (s: Step) => void): string[] => {
      const doc = load()
      f(doc.jobs['check']!.steps!.find((s) => TRUST_STEP.test(s.name ?? ''))!)
      return problems(doc)
    }
    expect(mutate((s) => { s.if = "github.event_name == 'never'" }).join()).toMatch(/conditional/)
    expect(mutate((s) => { s['continue-on-error'] = true }).join()).toMatch(/continue-on-error/)
    expect(mutate((s) => { s.run = (s.run ?? '').replace('--candidate "$MERGE_SHA"', '') }).join()).toMatch(/merge commit/)
    expect(mutate((s) => { s.run = (s.run ?? '').replace(/release-check/g, 'check') }).join()).toMatch(/release-check/)
  })

  it('MUTATION: a job that can run without `check`, or after it fails, is caught', () => {
    const detached = load()
    detached.jobs['build']!.needs = []
    expect(problems(detached).join()).toMatch(/job "build" does not depend on `check`/)

    const tagger = load()
    tagger.jobs['draft']!.needs = ['build']
    expect(problems(tagger).join()).toMatch(/`draft`.*must need `check` directly/)

    const always = load()
    always.jobs['release']!.if = '${{ always() }}'
    expect(problems(always).join()).toMatch(/job "release" has a status-function/)
  })
})
