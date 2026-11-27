import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import {
  isFleetOwnedBranch,
  armAutoMergeWithQueueClearance,
  type ArmAutoMergeDeps,
} from '../../orchestrator/src/automerge.js'
import { KNOPE_RELEASE_BRANCH } from '../../orchestrator/src/roles/release.js'
import { orchestratorSources } from './forgery-rails.js'

describe('isFleetOwnedBranch — scope fence for fleet-initiated writes at PR open', () => {
  it('admits a fleet-dispatched branch', () => {
    expect(isFleetOwnedBranch('fleet/backend/123')).toBe(true)
  })
  it('admits the knope release branch', () => {
    expect(isFleetOwnedBranch(KNOPE_RELEASE_BRANCH)).toBe(true)
  })
  it('refuses a human or ad hoc worker branch', () => {
    expect(isFleetOwnedBranch('my-personal-feature')).toBe(false)
    expect(isFleetOwnedBranch('ll-auto-merge-standard')).toBe(false)
  })
})

/**
 * #2732. Arming at PR open was removed: it armed every fleet PR the instant it
 * opened — before any verdict, and with no notion of merge-queue depth — while
 * the two paths that remain (tick.ts after verify+review; queue-feed, bounded by
 * depth) already reach every PR it did. These rails fail if it comes back, in
 * any shape: the old function, or any arm reached from the dispatch step.
 */
describe('RAIL: nothing arms auto-merge at PR open (#2732)', () => {
  const sources = orchestratorSources()
  const cliSource = sources.find((s) => s.file.endsWith(join('orchestrator', 'src', 'cli.ts')))
  if (cliSource === undefined) throw new Error('cli.ts not found among orchestrator sources')
  const cli = cliSource

  /** The text of one top-level `async function <name>(` in cli.ts, up to its closing brace. */
  function functionBody(text: string, name: string): string {
    const start = text.indexOf(`async function ${name}(`)
    expect(start, `async function ${name} not found in cli.ts`).toBeGreaterThan(-1)
    const end = text.indexOf('\n}\n', start)
    expect(end, `end of ${name} not found`).toBeGreaterThan(start)
    return text.slice(start, end)
  }

  it('realDispatch — the step that discovers the PR — makes no arming call', () => {
    const body = functionBody(cli.text, 'realDispatch')
    expect(body).not.toMatch(/AutoMerge/)
    expect(body).not.toContain('--auto')
    // The live PR-open writes it DOES make are still there: guards against the
    // slice above silently being the wrong function.
    expect(body).toContain('requestReviewAtOpen(')
    expect(body).toContain('ensureIssueLinkWith(')
  })

  it('no orchestrator module defines or exports an at-open arming function', () => {
    for (const { file, text } of sources) {
      expect(text, `${file} names an at-open arming function`).not.toMatch(/AutoMergeAtOpen|armStandardAutoMerge|shouldStandardAutoMerge/)
    }
  })

  it('the arming function is handed to exactly the two bounded owners: the tick and queue-feed', () => {
    // Every reference to `enableAutoMerge` in cli.ts that is not its definition.
    const wired = [...cli.text.matchAll(/^.*\benableAutoMerge\b.*$/gm)]
      .map((m) => m[0].trim())
      .filter((line) => !line.includes('async function enableAutoMerge') && !/^(\/\/|\*|\/\*)/.test(line))
    expect(wired).toEqual([
      'enableAutoMerge,',                                                      // tickDeps
      'const result = await runQueueFeedWith(defaultQueueFeedDeps(REPO_ROOT, enableAutoMerge, log))',
    ])
  })
})

describe('armAutoMergeWithQueueClearance — every arm clears a fleet PR for the queue first (#2689)', () => {
  function harness(opts: { headRefName: string; labels?: string[]; labelFails?: boolean; armFails?: boolean }) {
    const calls: string[] = []
    const deps: ArmAutoMergeDeps = {
      readPr: async () => ({ headRefName: opts.headRefName, labels: opts.labels ?? [] }),
      readQueueHistory: async () => ({ last: null, holdClearedAt: undefined }),
      addHoldLabel: async (pr) => { calls.push(`hold ${pr}`) },
      postPrComment: async (pr) => { calls.push(`comment ${pr}`) },
      log: () => {},
      addQueueClearedLabel: async (pr) => {
        calls.push(`label+ ${pr}`)
        if (opts.labelFails) throw new Error('label denied')
      },
      removeQueueClearedLabel: async (pr) => { calls.push(`label- ${pr}`) },
      requestAutoMerge: async (pr) => {
        calls.push(`arm ${pr}`)
        if (opts.armFails) throw new Error('arm refused')
      },
    }
    return { calls, deps }
  }

  it('labels a fleet-dispatched PR BEFORE arming it (the tick-arm case that #2660 missed)', async () => {
    const { calls, deps } = harness({ headRefName: 'fleet/desktop/2114' })
    await armAutoMergeWithQueueClearance('2688', deps)
    expect(calls).toEqual(['label+ 2688', 'arm 2688'])
  })

  it('does not re-apply a label the PR already carries', async () => {
    const { calls, deps } = harness({ headRefName: 'fleet/infra/1', labels: ['queue-cleared'] })
    await armAutoMergeWithQueueClearance('1', deps)
    expect(calls).toEqual(['arm 1'])
  })

  it('does not label a human branch or the knope release branch (the guard does not gate them)', async () => {
    for (const headRefName of ['my-feature', KNOPE_RELEASE_BRANCH]) {
      const { calls, deps } = harness({ headRefName })
      await armAutoMergeWithQueueClearance('5', deps)
      expect(calls, headRefName).toEqual(['arm 5'])
    }
  })

  it('fails closed: a label that cannot be applied means the PR is NOT armed', async () => {
    const { calls, deps } = harness({ headRefName: 'fleet/ios/9', labelFails: true })
    await expect(armAutoMergeWithQueueClearance('9', deps)).rejects.toThrow('label denied')
    expect(calls).toEqual(['label+ 9'])
  })

  it('a URL-form pr reference reaches the merge-queue-history read as a number (2026-11-26 NaN arm failure)', async () => {
    // The worker's status template allows `pr:` as a URL; Number(URL) is NaN,
    // and the GraphQL history read with -F pr=NaN failed, leaving a verified,
    // reviewed PR unarmed (item 3065 / PR #3066). The arming point must
    // normalise before the one call that needs an Int.
    const calls: string[] = []
    const seen: number[] = []
    const deps: ArmAutoMergeDeps = {
      readPr: async () => ({ headRefName: 'fleet/infra/3065', labels: [] }),
      readQueueHistory: async (n) => { seen.push(n); return { last: null, holdClearedAt: undefined } },
      addHoldLabel: async () => {},
      postPrComment: async () => {},
      addQueueClearedLabel: async (p) => { calls.push(`label+ ${p}`) },
      removeQueueClearedLabel: async (p) => { calls.push(`label- ${p}`) },
      requestAutoMerge: async (p) => { calls.push(`arm ${p}`) },
      log: () => {},
    }
    await armAutoMergeWithQueueClearance('https://github.com/Llamenos-Hotline/llamenos-platform/pull/3066', deps)
    expect(seen).toEqual([3066])
    expect(calls).toEqual(['label+ https://github.com/Llamenos-Hotline/llamenos-platform/pull/3066', 'arm https://github.com/Llamenos-Hotline/llamenos-platform/pull/3066'])
  })

  it('hands back a label it added when the arm itself fails, but never one it found', async () => {
    const added = harness({ headRefName: 'fleet/ios/9', armFails: true })
    await expect(armAutoMergeWithQueueClearance('9', added.deps)).rejects.toThrow('arm refused')
    expect(added.calls).toEqual(['label+ 9', 'arm 9', 'label- 9'])

    const found = harness({ headRefName: 'fleet/ios/9', labels: ['queue-cleared'], armFails: true })
    await expect(armAutoMergeWithQueueClearance('9', found.deps)).rejects.toThrow('arm refused')
    expect(found.calls).toEqual(['arm 9'])
  })


  /**
   * The invariant, not one instance of it: the only `gh pr merge --auto` in the
   * orchestrator sits inside cli.ts's `enableAutoMerge`, and that function
   * reaches it only through `armAutoMergeWithQueueClearance`; and the only
   * thing any module is handed as an arming function is that `enableAutoMerge`.
   * A third arm path (a new `gh pr merge --auto`, or a caller handed a different
   * arming function) fails here instead of failing 45 minutes later at the queue
   * head.
   */
  it('RAIL: no code path can arm a PR except through armAutoMergeWithQueueClearance', () => {
    const sources = orchestratorSources()
    const cli = sources.find((s) => s.file.endsWith(join('orchestrator', 'src', 'cli.ts')))
    expect(cli, 'cli.ts not found among orchestrator sources').toBeDefined()
    const text = cli!.text

    const start = text.indexOf('async function enableAutoMerge(')
    expect(start).toBeGreaterThan(-1)
    const end = text.indexOf('\n}\n', start)
    const body = text.slice(start, end)
    expect(body).toContain('armAutoMergeWithQueueClearance(')
    expect(body).toContain("'--auto'")

    for (const { file, text: t } of sources) {
      const occurrences = (t.match(/'--auto'/g) ?? []).length
      if (file === cli!.file) expect(occurrences, 'cli.ts must name --auto exactly once').toBe(1)
      else expect(occurrences, `${file} names '--auto' — an arm site outside enableAutoMerge`).toBe(0)
    }

    // Every place cli.ts hands an arming function to a module must hand it THIS one.
    const wired = [...text.matchAll(/\benableAutoMerge\b(?!\s*\()(?![^\n]*\bfunction\b)/g)]
    expect(wired.length).toBeGreaterThan(0)
    expect(text).not.toMatch(/enableAutoMerge\s*:\s*(?!enableAutoMerge\b)/)
  })
})
