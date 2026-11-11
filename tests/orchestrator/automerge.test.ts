import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { isFleetOwnedBranch } from '../../orchestrator/src/automerge.js'
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
