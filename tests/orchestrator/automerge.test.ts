import { describe, it, expect, vi } from 'vitest'
import {
  shouldStandardAutoMerge,
  isFleetOwnedBranch,
  armStandardAutoMergeAtOpen,
  armAutoMergeWithQueueClearance,
  type ArmAutoMergeDeps,
  EXCLUDE_RELEASE_PR_FROM_STANDARD_AUTO_MERGE,
} from '../../orchestrator/src/automerge.js'
import { KNOPE_RELEASE_BRANCH } from '../../orchestrator/src/roles/release.js'
import { join } from 'node:path'
import { orchestratorSources } from './forgery-rails.js'

describe('EXCLUDE_RELEASE_PR_FROM_STANDARD_AUTO_MERGE — the switch itself', () => {
  it('defaults to OFF: release PRs auto-merge today', () => {
    expect(EXCLUDE_RELEASE_PR_FROM_STANDARD_AUTO_MERGE).toBe(false)
  })
})

describe('isFleetOwnedBranch — scope fence, independent of the release switch', () => {
  it('recognizes a fleet-dispatched branch', () => {
    expect(isFleetOwnedBranch('fleet/backend/123')).toBe(true)
  })

  it('recognizes the knope release branch', () => {
    expect(isFleetOwnedBranch(KNOPE_RELEASE_BRANCH)).toBe(true)
  })

  it('refuses a human or ad hoc branch this module has no business touching', () => {
    expect(isFleetOwnedBranch('my-personal-feature')).toBe(false)
    expect(isFleetOwnedBranch('ll-auto-merge-standard')).toBe(false)
  })
})

describe('shouldStandardAutoMerge — the rail (switch tested in BOTH positions)', () => {
  it('switch OFF (today\'s default): the release PR gets standard auto-merge', () => {
    expect(shouldStandardAutoMerge(KNOPE_RELEASE_BRANCH, false)).toBe(true)
  })

  it('switch OFF: an ordinary fleet branch also gets standard auto-merge', () => {
    expect(shouldStandardAutoMerge('fleet/desktop/742', false)).toBe(true)
  })

  it('switch ON: the release PR does NOT get standard auto-merge', () => {
    expect(shouldStandardAutoMerge(KNOPE_RELEASE_BRANCH, true)).toBe(false)
  })

  it('switch ON: an ordinary fleet branch still gets standard auto-merge', () => {
    expect(shouldStandardAutoMerge('fleet/desktop/742', true)).toBe(true)
  })

  it('a branch outside fleet ownership never gets it, regardless of the switch', () => {
    expect(shouldStandardAutoMerge('some-humans-branch', false)).toBe(false)
    expect(shouldStandardAutoMerge('some-humans-branch', true)).toBe(false)
  })

  it('MUTATION GUARD: a switch that ignores its input fails at least one of the two positions above', () => {
    // A mutant that hardcodes the exclusion check to `false` (i.e. always
    // treats the switch as OFF) still passes every "switch OFF" test above,
    // but must fail this one: with the switch forced ON, the release PR
    // must be excluded.
    const brokenAlwaysOff = (headRefName: string): boolean => shouldStandardAutoMerge(headRefName, false)
    expect(brokenAlwaysOff(KNOPE_RELEASE_BRANCH)).toBe(true) // matches switch-OFF behavior
    // The real function, called with the switch actually ON, must differ
    // from the always-OFF mutant's behavior on the one input that matters:
    expect(shouldStandardAutoMerge(KNOPE_RELEASE_BRANCH, true)).not.toBe(brokenAlwaysOff(KNOPE_RELEASE_BRANCH))

    // Symmetric check: a mutant that hardcodes the switch to always-ON
    // still passes every "switch ON" test above, but must fail this one:
    // with the switch actually OFF, the release PR must be included.
    const brokenAlwaysOn = (headRefName: string): boolean => shouldStandardAutoMerge(headRefName, true)
    expect(brokenAlwaysOn(KNOPE_RELEASE_BRANCH)).toBe(false) // matches switch-ON behavior
    expect(shouldStandardAutoMerge(KNOPE_RELEASE_BRANCH, false)).not.toBe(brokenAlwaysOn(KNOPE_RELEASE_BRANCH))
  })
})

describe('armStandardAutoMergeAtOpen — the one production call site', () => {
  it('requests auto-merge for a fresh fleet PR', async () => {
    const enableAutoMerge = vi.fn(async () => {})
    const log = vi.fn()
    await armStandardAutoMergeAtOpen(
      { pr: '123', headRefName: 'fleet/backend/45', branchMismatch: undefined },
      { enableAutoMerge, log },
    )
    expect(enableAutoMerge).toHaveBeenCalledWith('123')
    expect(log.mock.calls.some(([msg]) => /requested standard auto-merge/.test(msg))).toBe(true)
  })

  it('does nothing when there is no PR yet', async () => {
    const enableAutoMerge = vi.fn(async () => {})
    const log = vi.fn()
    await armStandardAutoMergeAtOpen(
      { pr: undefined, headRefName: 'fleet/backend/45', branchMismatch: undefined },
      { enableAutoMerge, log },
    )
    expect(enableAutoMerge).not.toHaveBeenCalled()
  })

  it('never requests auto-merge on a branch-mismatched PR', async () => {
    const enableAutoMerge = vi.fn(async () => {})
    const log = vi.fn()
    await armStandardAutoMergeAtOpen(
      { pr: '123', headRefName: 'fleet/backend/45', branchMismatch: 'some-other-branch' },
      { enableAutoMerge, log },
    )
    expect(enableAutoMerge).not.toHaveBeenCalled()
  })

  it('is best-effort: a throwing enableAutoMerge is caught and logged, never rethrown', async () => {
    const enableAutoMerge = vi.fn(async () => { throw new Error('gh unreachable') })
    const log = vi.fn()
    await expect(
      armStandardAutoMergeAtOpen(
        { pr: '123', headRefName: 'fleet/backend/45', branchMismatch: undefined },
        { enableAutoMerge, log },
      ),
    ).resolves.toBeUndefined()
    expect(log.mock.calls.some(([msg]) => /could not request standard auto-merge/.test(msg))).toBe(true)
  })
})

describe('armAutoMergeWithQueueClearance — every arm clears a fleet PR for the queue first (#2689)', () => {
  function harness(opts: { headRefName: string; labels?: string[]; labelFails?: boolean; armFails?: boolean }) {
    const calls: string[] = []
    const deps: ArmAutoMergeDeps = {
      readPr: async () => ({ headRefName: opts.headRefName, labels: opts.labels ?? [] }),
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

  it('labels a fleet-dispatched PR BEFORE arming it (the arm-at-open case that #2660 missed)', async () => {
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

  it('hands back a label it added when the arm itself fails, but never one it found', async () => {
    const added = harness({ headRefName: 'fleet/ios/9', armFails: true })
    await expect(armAutoMergeWithQueueClearance('9', added.deps)).rejects.toThrow('arm refused')
    expect(added.calls).toEqual(['label+ 9', 'arm 9', 'label- 9'])

    const found = harness({ headRefName: 'fleet/ios/9', labels: ['queue-cleared'], armFails: true })
    await expect(armAutoMergeWithQueueClearance('9', found.deps)).rejects.toThrow('arm refused')
    expect(found.calls).toEqual(['arm 9'])
  })

  it('armStandardAutoMergeAtOpen with the production wiring labels first (end to end through the open path)', async () => {
    const { calls, deps } = harness({ headRefName: 'fleet/desktop/2114' })
    await armStandardAutoMergeAtOpen(
      { pr: '2688', headRefName: 'fleet/desktop/2114', branchMismatch: undefined },
      { enableAutoMerge: (pr) => armAutoMergeWithQueueClearance(pr, deps), log: () => {} },
    )
    expect(calls).toEqual(['label+ 2688', 'arm 2688'])
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
