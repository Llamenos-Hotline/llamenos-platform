import { describe, it, expect } from 'vitest'
import { buildBrief, renderBrief } from '../../orchestrator/src/brief.js'
import type { Lane } from '../../orchestrator/src/config.js'
import type { WorkItem } from '../../orchestrator/src/source.js'

const lane: Lane = {
  id: 'backend', mode: 'live', cap: 1, engine: 'claude',
  requireLabel: 'agent-dispatchable', vetoLabels: [],
  scope: { owned: ['apps/worker/'], notOwned: ['tests/'] },
}
const item: WorkItem = {
  id: '42', title: 'Fix the thing', body: 'x'.repeat(300),
  url: 'https://github.com/o/r/issues/42', labels: ['agent-dispatchable', 'lane:backend'],
}

// Fix round 2, M2: prior-attempt history (filter-by-item, sort, cap-at-3,
// render) used to be built here AND in memory.ts's augmentBrief — two
// independent implementations of the same thing under two different
// headings. A caller that used both (as cli.ts did) would render the same
// failure history twice, wasting exactly the worker context this brief
// exists to protect. buildBrief no longer takes or renders prior attempts
// at all; memory.ts's augmentBrief is now the sole owner (see
// tests/orchestrator/memory.test.ts for that coverage, including a
// full-path buildBrief -> augmentBrief test asserting the heading and its
// content each render exactly once).
describe('buildBrief', () => {
  it('carries the issue body verbatim as the specification', () => {
    expect(renderBrief(buildBrief(item, lane, 'auto/backend-x'))).toContain(item.body)
  })
  it('names the issue and its url for provenance', () => {
    const b = renderBrief(buildBrief(item, lane, 'auto/backend-x'))
    expect(b).toContain('#42'); expect(b).toContain(item.url)
  })
  it('states the branch the worker must use', () => {
    expect(renderBrief(buildBrief(item, lane, 'auto/backend-x'))).toContain('auto/backend-x')
  })
  it('forbids merging, deploying and sending', () => {
    const b = renderBrief(buildBrief(item, lane, 'auto/backend-x')).toLowerCase()
    expect(b).toMatch(/never merge/); expect(b).toMatch(/never deploy/)
  })
  // #1894 — the prohibition that holds is the one the worker can CHECK. The
  // brief must name the merge queue ban AND the verifiable self-check
  // command, not just ask nicely: "a command to run beats a rule to
  // remember".
  it('forbids enqueueing and hands the worker the command that proves it did not', () => {
    const b = renderBrief(buildBrief(item, lane, 'auto/backend-x'))
    expect(b).toMatch(/never add it to the merge queue/i)
    expect(b).toContain('gh pr view')
    expect(b).toContain('mergeStateStatus')
  })
  it('states the output contract', () => {
    const b = renderBrief(buildBrief(item, lane, 'auto/backend-x'))
    expect(b).toContain('DONE'); expect(b).toContain('BLOCKED')
  })
  it('states the lane owned paths and the one-PR rule', () => {
    const b = renderBrief(buildBrief(item, lane, 'auto/backend-x'))
    expect(b).toContain('apps/worker/')
    expect(b).toMatch(/one pr|one pull request|single pr/i)
  })
  it('tells the worker not to run the full test suite', () => {
    const b = renderBrief(buildBrief(item, lane, 'auto/backend-x')).toLowerCase()
    expect(b).toMatch(/do not run the full test suite|never run the full test suite/)
  })
  it('says nothing about previous attempts — that is memory.ts\'s augmentBrief\'s job alone', () => {
    expect(renderBrief(buildBrief(item, lane, 'auto/backend-x'))).not.toMatch(/previous attempt|prior attempt/i)
  })
  it('returns composable sections rather than one opaque string', () => {
    const brief = buildBrief(item, lane, 'auto/backend-x')
    expect(Array.isArray(brief.sections)).toBe(true)
    expect(brief.sections.length).toBeGreaterThan(0)
    for (const s of brief.sections) {
      expect(typeof s.heading).toBe('string')
      expect(typeof s.body).toBe('string')
    }
  })
})
