import { describe, it, expect, vi, beforeEach } from 'vitest'

// planner.ts must never import an effectful primitive on its own — this
// suite proves the "no mutation" boundary by mocking every I/O surface the
// rest of the fleet uses and asserting none of it is ever touched, no
// matter what `proposeIssues` is asked to do.
vi.mock('node:child_process', () => ({
  execFile: vi.fn((..._args: unknown[]) => { throw new Error('execFile must never be called by the Planner') }),
  execFileSync: vi.fn(() => { throw new Error('execFileSync must never be called by the Planner') }),
}))
vi.mock('node:fs', () => ({
  writeFileSync: vi.fn(() => { throw new Error('writeFileSync must never be called by the Planner') }),
  appendFileSync: vi.fn(() => { throw new Error('appendFileSync must never be called by the Planner') }),
  mkdirSync: vi.fn(() => { throw new Error('mkdirSync must never be called by the Planner') }),
  rmSync: vi.fn(() => { throw new Error('rmSync must never be called by the Planner') }),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => { throw new Error('readFileSync must never be called by the Planner') }),
}))

import {
  proposeIssues, buildIssueCreateArgs, parseProposals, toProposedIssue, PROPOSAL_HOLD_NOTE,
  titleSimilarity, isNearDuplicate, NEEDS_HUMAN_LABEL, NEAR_DUPLICATE_THRESHOLD,
  type ProposedIssue, type PlannerInput,
} from '../../orchestrator/src/roles/planner.js'
import type { WorkItem } from '../../orchestrator/src/source.js'

function item(id: string, title: string): WorkItem {
  return { id, title, body: 'x'.repeat(250), url: `https://example/${id}`, labels: [] }
}

const baseInput = (overrides: Partial<PlannerInput> = {}): PlannerInput => ({
  goalDocument: 'Ship GA.',
  openBacklog: [],
  recentRuns: [],
  invoke: vi.fn(async () => '[]'),
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('proposeIssues — the write boundary', () => {
  it('returns data, never performs any mutation, even given a full backlog and history', async () => {
    const invoke = vi.fn(async () => JSON.stringify([
      { title: 'Add rate limiting', body: 'body', lane: 'backend', effort: 'medium' },
    ]))
    const result = await proposeIssues(baseInput({ invoke }))
    expect(result).toEqual([{ title: 'Add rate limiting', body: 'body', lane: 'backend', effort: 'medium' }])
    // The mocked fs/child_process modules above throw the instant they are
    // called at all — reaching this line without a thrown error already
    // proves no mutation happened. Assert it explicitly too.
    const cp = await import('node:child_process')
    const fs = await import('node:fs')
    expect(cp.execFile).not.toHaveBeenCalled()
    expect(cp.execFileSync).not.toHaveBeenCalled()
    expect(fs.writeFileSync).not.toHaveBeenCalled()
    expect(fs.appendFileSync).not.toHaveBeenCalled()
  })

  it('calls only the injected invoke callback, nothing else', async () => {
    const invoke = vi.fn(async () => '[]')
    await proposeIssues(baseInput({ invoke }))
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('drops unparseable model output instead of throwing', async () => {
    const result = await proposeIssues(baseInput({ invoke: async () => 'not json at all' }))
    expect(result).toEqual([])
  })

  it('drops individually malformed entries without discarding valid siblings', async () => {
    const invoke = async () => JSON.stringify([
      { title: 'Valid one', body: 'b', lane: 'backend', effort: 'low' },
      { title: 'Missing lane', body: 'b' },
      { title: 'Bad lane', body: 'b', lane: 'not-a-lane', effort: 'low' },
    ])
    const result = await proposeIssues(baseInput({ invoke }))
    expect(result).toHaveLength(1)
    expect(result[0]?.title).toBe('Valid one')
  })
})

describe('needs-human is structurally unavoidable', () => {
  const issue: ProposedIssue = { title: 'Some title', body: 'Some body', lane: 'backend', effort: 'medium' }

  it('is present in the argv built for gh issue create', () => {
    const args = buildIssueCreateArgs(issue)
    const labelIdx = args.indexOf('--label')
    expect(labelIdx).toBeGreaterThanOrEqual(0)
    const labels = (args[labelIdx + 1] ?? '').split(',')
    expect(labels).toContain(NEEDS_HUMAN_LABEL)
  })

  it('is present even when the caller supplies no labels of its own — there is no parameter to omit it through', () => {
    // buildIssueCreateArgs takes no labels parameter at all: this test
    // documents that fact by construction. Every call, with every possible
    // ProposedIssue, produces the label — there is no "forgot to pass
    // labels" path because there is no labels argument to forget.
    const argsA = buildIssueCreateArgs({ ...issue, lane: 'ios', effort: 'max' })
    const argsB = buildIssueCreateArgs({ ...issue, lane: 'android', effort: 'low', dependsOn: ['1', '2'] })
    for (const args of [argsA, argsB]) {
      const labelIdx = args.indexOf('--label')
      const labels = (args[labelIdx + 1] ?? '').split(',')
      expect(labels).toContain(NEEDS_HUMAN_LABEL)
    }
  })

  it('mutation guard: a label list built without needs-human would fail this exact assertion', () => {
    // Directly pins the property, not the absence of a string: the label
    // must be a MEMBER of the parsed label array, not merely substring-
    // present somewhere in the argv (which a title or body containing the
    // literal text "needs-human" could satisfy without the label being
    // real).
    const args = buildIssueCreateArgs(issue)
    const labelIdx = args.indexOf('--label')
    const labels = (args[labelIdx + 1] ?? '').split(',')
    expect(labels.filter((l) => l === NEEDS_HUMAN_LABEL)).toHaveLength(1)
  })
})

describe('near-duplicate detection', () => {
  const ORIGINAL = 'Fix flaky iOS badge count test'
  const REWORDED = 'iOS badge count test is flaky, fix it'
  const UNRELATED = 'Add Signal reaction retry queue'

  it('flags a title that is a near-duplicate of an open issue', () => {
    const backlog = [item('1', ORIGINAL)]
    expect(isNearDuplicate(REWORDED, backlog)).toBe(true)
  })

  it('does not flag an unrelated title', () => {
    const backlog = [item('1', ORIGINAL)]
    expect(isNearDuplicate(UNRELATED, backlog)).toBe(false)
  })

  it('titleSimilarity is symmetric and bounded in [0, 1]', () => {
    const s1 = titleSimilarity(ORIGINAL, REWORDED)
    const s2 = titleSimilarity(REWORDED, ORIGINAL)
    expect(s1).toBe(s2)
    expect(s1).toBeGreaterThanOrEqual(0)
    expect(s1).toBeLessThanOrEqual(1)
    expect(s1).toBeGreaterThanOrEqual(NEAR_DUPLICATE_THRESHOLD)
  })

  it('proposeIssues drops a proposal that near-duplicates the open backlog', async () => {
    const backlog = [item('42', ORIGINAL)]
    const invoke = async () => JSON.stringify([
      { title: REWORDED, body: 'b'.repeat(10), lane: 'ios', effort: 'low' },
      { title: UNRELATED, body: 'b'.repeat(10), lane: 'backend', effort: 'low' },
    ])
    const result = await proposeIssues(baseInput({ invoke, openBacklog: backlog }))
    expect(result).toHaveLength(1)
    expect(result[0]?.title).toBe(UNRELATED)
  })
})

describe('parseProposals', () => {
  it('extracts a JSON array embedded in prose or a markdown fence', () => {
    const raw = 'Sure, here you go:\n```json\n[{"a":1}]\n```\nHope that helps.'
    expect(parseProposals(raw)).toEqual([{ a: 1 }])
  })

  it('returns undefined for non-array JSON', () => {
    expect(parseProposals('{"a":1}')).toBeUndefined()
  })
})

describe('toProposedIssue', () => {
  it('rejects an unrecognized effort level', () => {
    expect(toProposedIssue({ title: 't', body: 'b', lane: 'backend', effort: 'ultra' })).toBeUndefined()
  })

  it('rejects a dependsOn array with non-string entries', () => {
    expect(toProposedIssue({ title: 't', body: 'b', lane: 'backend', effort: 'low', dependsOn: [1, 2] })).toBeUndefined()
  })

  it('accepts a well-formed proposal with dependsOn', () => {
    expect(toProposedIssue({ title: 't', body: 'b', lane: 'shared', effort: 'xhigh', dependsOn: ['9'] }))
      .toEqual({ title: 't', body: 'b', lane: 'shared', effort: 'xhigh', dependsOn: ['9'] })
  })
})

describe('needs-human says which act a human must take (#1815)', () => {
  it('the created issue body names the act: accept or reject the agent proposal', () => {
    const args = buildIssueCreateArgs({ title: 'T', body: 'B', lane: 'backend', effort: 'low' })
    const body = args[args.indexOf('--body') + 1] ?? ''
    expect(body.startsWith('B')).toBe(true)
    expect(body).toContain(PROPOSAL_HOLD_NOTE)
    expect(PROPOSAL_HOLD_NOTE).toContain('accept or reject the proposal')
  })
})
