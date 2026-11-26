import { describe, it, expect } from 'vitest'
import {
  digestRunId, extractDigestRunId, planDigestPost, postDigestComment,
  postBlockedPing, postResumedPing,
  ensureDigestIssueWith, type DigestIssueDeps,
  fleetPrsFromRuns, aggregatePrCheckState, resolveFleetPrStates, renderFleetPrsSection,
  renderHumanQueueSection, HUMAN_QUEUE_LABELS,
  DIGEST_ISSUE_TITLE,
} from '../../orchestrator/src/digest-issue.js'
import type { WorkSink, SinkComment } from '../../orchestrator/src/sink.js'
import type { RunRecord } from '../../orchestrator/src/ledger.js'

/** In-memory `WorkSink` fake — records every call so tests can assert on
 *  exactly what was sent, without any real `gh`/network dependency. Mirrors
 *  `GitHubSink`'s numeric-comment-id contract closely enough for
 *  `planDigestPost`'s edit-by-id path to be exercised for real. */
function fakeSink(seed: SinkComment[] = []): WorkSink & { comments: SinkComment[]; nextId: () => string } {
  const comments = [...seed]
  let counter = seed.length
  return {
    comments,
    nextId: () => String(++counter),
    comment: async (_id: string, body: string) => {
      comments.push({ id: String(++counter), body })
    },
    addLabel: async () => {},
    removeLabel: async () => {},
    listComments: async () => comments,
    editComment: async (id: string, body: string) => {
      const existing = comments.find((c) => c.id === id)
      if (existing !== undefined) existing.body = body
    },
  }
}

describe('digestRunId', () => {
  it('is stable across the same UTC calendar day and half (AM)', () => {
    const a = digestRunId(Date.UTC(2026, 8, 15, 1, 0, 0))
    const b = digestRunId(Date.UTC(2026, 8, 15, 11, 59, 0))
    expect(a).toBe(b)
  })

  it('is stable across the same UTC calendar day and half (PM)', () => {
    const a = digestRunId(Date.UTC(2026, 8, 15, 12, 0, 0))
    const b = digestRunId(Date.UTC(2026, 8, 15, 23, 59, 0))
    expect(a).toBe(b)
  })

  it('differs between the AM and PM half of the same day', () => {
    const am = digestRunId(Date.UTC(2026, 8, 15, 7, 0, 0))
    const pm = digestRunId(Date.UTC(2026, 8, 15, 18, 0, 0))
    expect(am).not.toBe(pm)
  })

  it('differs across calendar days', () => {
    const day1 = digestRunId(Date.UTC(2026, 8, 15, 18, 0, 0))
    const day2 = digestRunId(Date.UTC(2026, 8, 16, 18, 0, 0))
    expect(day1).not.toBe(day2)
  })
})

describe('extractDigestRunId', () => {
  it('reads the run id back out of a header this module wrote', () => {
    expect(extractDigestRunId('<!-- llamenos-fleet-digest run=2026-09-15-pm -->\nbody')).toBe('2026-09-15-pm')
  })

  it('is undefined for a comment with no header at all — a human reply, or a BLOCKED/RESUMED ping', () => {
    expect(extractDigestRunId('BLOCKED: something broke')).toBeUndefined()
    expect(extractDigestRunId('just a reply from a human')).toBeUndefined()
  })
})

describe('planDigestPost', () => {
  it('creates when there is no prior digest comment at all', () => {
    expect(planDigestPost([], 'run-1')).toEqual({ action: 'create' })
  })

  it('creates when the most recent digest comment has a DIFFERENT run id — a new pass, not a retry', () => {
    const comments = [{ id: '1', body: '<!-- llamenos-fleet-digest run=old -->\nstuff' }]
    expect(planDigestPost(comments, 'new')).toEqual({ action: 'create' })
  })

  it('edits when the most recent digest comment has the SAME run id — a retried pass', () => {
    const comments = [{ id: '7', body: '<!-- llamenos-fleet-digest run=same -->\nstuff' }]
    expect(planDigestPost(comments, 'same')).toEqual({ action: 'edit', commentId: '7' })
  })

  it('ignores a non-digest comment (e.g. a BLOCKED ping or a human reply) posted after the last digest comment', () => {
    const comments = [
      { id: '1', body: '<!-- llamenos-fleet-digest run=same -->\nstuff' },
      { id: '2', body: 'BLOCKED: something broke' },
    ]
    // The BLOCKED ping is NOT a digest comment and must never be the edit
    // target, and must never make a matching-run-id digest comment look
    // "not the most recent digest comment" either.
    expect(planDigestPost(comments, 'same')).toEqual({ action: 'edit', commentId: '1' })
  })

  it('only ever considers the MOST RECENT digest comment as an edit candidate — an older matching run id must not resurrect', () => {
    const comments = [
      { id: '1', body: '<!-- llamenos-fleet-digest run=stale -->\nold pass' },
      { id: '2', body: '<!-- llamenos-fleet-digest run=fresh -->\nnewer pass' },
    ]
    expect(planDigestPost(comments, 'stale')).toEqual({ action: 'create' })
  })
})

describe('postDigestComment', () => {
  it('posts a NEW comment carrying the run-id header on the first call', async () => {
    const sink = fakeSink()
    await postDigestComment(sink, '42', 'run-1', 'the digest body')
    expect(sink.comments).toHaveLength(1)
    expect(sink.comments[0]?.body).toBe('<!-- llamenos-fleet-digest run=run-1 -->\nthe digest body')
  })

  it('idempotency: re-running the SAME pass (same run id) edits the existing comment instead of duplicating', async () => {
    const sink = fakeSink()
    await postDigestComment(sink, '42', 'run-1', 'first render')
    await postDigestComment(sink, '42', 'run-1', 'second render, same pass')
    expect(sink.comments).toHaveLength(1)
    expect(sink.comments[0]?.body).toContain('second render, same pass')
  })

  it('a later pass (different run id) posts a second, separate comment', async () => {
    const sink = fakeSink()
    await postDigestComment(sink, '42', 'run-1', 'first pass')
    await postDigestComment(sink, '42', 'run-2', 'second pass')
    expect(sink.comments).toHaveLength(2)
  })
})

describe('postBlockedPing / postResumedPing', () => {
  it('posts a BLOCKED comment naming the reason and the resume command', async () => {
    const sink = fakeSink()
    await postBlockedPing(sink, '42', 'rate breaker tripped: 9/h exceeds 8', '/path/to/llamenos-fleet resume')
    expect(sink.comments).toHaveLength(1)
    expect(sink.comments[0]?.body).toContain('BLOCKED: rate breaker tripped: 9/h exceeds 8')
    expect(sink.comments[0]?.body).toContain('/path/to/llamenos-fleet resume')
  })

  it('posts a RESUMED comment', async () => {
    const sink = fakeSink()
    await postResumedPing(sink, '42')
    expect(sink.comments).toHaveLength(1)
    expect(sink.comments[0]?.body).toContain('RESUMED')
  })
})

function digestIssueDeps(overrides: Partial<DigestIssueDeps> = {}): DigestIssueDeps & { writes: string[] } {
  const writes: string[] = []
  return {
    writes,
    readCache: () => undefined,
    writeCache: (id: string) => { writes.push(id) },
    findOpenIssueByTitle: async () => undefined,
    createIssue: async () => { throw new Error('createIssue should not be called in this test') },
    pinIssue: async () => { throw new Error('pinIssue should not be called in this test') },
    isOpen: async () => undefined,
    ...overrides,
  }
}

describe('ensureDigestIssueWith', () => {
  it('returns the cached id without any network call when it is confirmed still open', async () => {
    const deps = digestIssueDeps({ readCache: () => '10', isOpen: async () => true })
    expect(await ensureDigestIssueWith(deps)).toBe('10')
  })

  it('falls back to a title search when the cached id is closed, then caches the result', async () => {
    const deps = digestIssueDeps({
      readCache: () => '10',
      isOpen: async () => false,
      findOpenIssueByTitle: async (title) => (title === DIGEST_ISSUE_TITLE ? '20' : undefined),
    })
    expect(await ensureDigestIssueWith(deps)).toBe('20')
    expect(deps.writes).toEqual(['20'])
  })

  it('falls back to a title search when there is no cache at all', async () => {
    const deps = digestIssueDeps({ findOpenIssueByTitle: async () => '30' })
    expect(await ensureDigestIssueWith(deps)).toBe('30')
    expect(deps.writes).toEqual(['30'])
  })

  it('creates and pins a new issue, exactly once, only when no cache and no search hit exist', async () => {
    const pinned: string[] = []
    const deps = digestIssueDeps({
      createIssue: async (title) => { expect(title).toBe(DIGEST_ISSUE_TITLE); return '40' },
      pinIssue: async (id) => { pinned.push(id) },
    })
    expect(await ensureDigestIssueWith(deps)).toBe('40')
    expect(pinned).toEqual(['40'])
    expect(deps.writes).toEqual(['40'])
  })

  it('never creates a second issue when one is already findable by title', async () => {
    let created = false
    const deps = digestIssueDeps({
      findOpenIssueByTitle: async () => '50',
      createIssue: async () => { created = true; return '999' },
    })
    await ensureDigestIssueWith(deps)
    expect(created).toBe(false)
  })
})

describe('fleetPrsFromRuns', () => {
  const row = (over: Partial<RunRecord>): RunRecord =>
    ({ ts: 1, runId: 'r', lane: 'backend', itemId: '1', itemName: 'item one', engine: 'claude', outcome: 'SUCCESS', ...over })

  it('drops rows with no PR at all', () => {
    expect(fleetPrsFromRuns([row({ pr: undefined })])).toEqual([])
  })

  it('dedupes multiple rows against the same PR to the most recent one', () => {
    const rows = [
      row({ ts: 1, pr: '10', itemName: 'first attempt name' }),
      row({ ts: 5, pr: '10', itemName: 'later attempt name' }),
    ]
    const result = fleetPrsFromRuns(rows)
    expect(result).toHaveLength(1)
    expect(result[0]?.itemName).toBe('later attempt name')
  })

  it('sorts newest first', () => {
    const rows = [row({ ts: 1, pr: '1' }), row({ ts: 9, pr: '2' }), row({ ts: 5, pr: '3' })]
    expect(fleetPrsFromRuns(rows).map((p) => p.pr)).toEqual(['2', '3', '1'])
  })
})

describe('aggregatePrCheckState', () => {
  it('is unknown for an empty check list — silence is not the same fact as green', () => {
    expect(aggregatePrCheckState([])).toBe('unknown')
  })

  it('is passing when every check completed successfully', () => {
    expect(aggregatePrCheckState([
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { status: 'COMPLETED', conclusion: 'NEUTRAL' },
    ])).toBe('passing')
  })

  it('is pending when any check has not completed yet', () => {
    expect(aggregatePrCheckState([
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { status: 'IN_PROGRESS', conclusion: '' },
    ])).toBe('pending')
  })

  it('is failing when any check failed — even alongside many green ones', () => {
    const checks = [
      ...Array.from({ length: 9 }, () => ({ status: 'COMPLETED', conclusion: 'SUCCESS' })),
      { status: 'COMPLETED', conclusion: 'FAILURE' },
    ]
    expect(aggregatePrCheckState(checks)).toBe('failing')
  })

  it('failing wins over pending when both are present', () => {
    expect(aggregatePrCheckState([
      { status: 'COMPLETED', conclusion: 'FAILURE' },
      { status: 'IN_PROGRESS', conclusion: '' },
    ])).toBe('failing')
  })
})

describe('resolveFleetPrStates', () => {
  it('derives state live per PR via the injected fetch function, never from a label', async () => {
    const prs = [{ pr: '1', itemId: 'a', itemName: 'one' }, { pr: '2', itemId: 'b', itemName: 'two' }]
    const result = await resolveFleetPrStates(prs, async (pr) =>
      pr === '1' ? [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] : [{ status: 'COMPLETED', conclusion: 'FAILURE' }])
    expect(result).toEqual([
      { pr: '1', itemId: 'a', itemName: 'one', state: 'passing' },
      { pr: '2', itemId: 'b', itemName: 'two', state: 'failing' },
    ])
  })

  it('state is undefined — not a guessed default — when the live read itself failed', async () => {
    const result = await resolveFleetPrStates([{ pr: '1', itemId: 'a', itemName: 'one' }], async () => undefined)
    expect(result[0]?.state).toBeUndefined()
  })
})

describe('renderFleetPrsSection', () => {
  it('renders (none) for an empty list', () => {
    expect(renderFleetPrsSection([])).toContain('(none)')
  })

  it('surfaces an unreadable check state distinctly from a passing one', () => {
    const out = renderFleetPrsSection([{ pr: '1', itemId: 'a', itemName: 'one', state: undefined }])
    expect(out).toContain('live read failed')
  })
})

describe('renderHumanQueueSection', () => {
  const NOW = Date.parse('2026-11-25T00:00:00Z')
  const daysAgo = (d: number): string => new Date(NOW - d * 24 * 60 * 60_000).toISOString()
  const q = (number: number, labels: string[], age = 1) => ({ number, title: `issue ${number}`, labels, createdAt: daysAgo(age) })

  it('renders (none) for an empty queue', () => {
    expect(renderHumanQueueSection([], NOW)).toContain('(none)')
  })

  it('lists every item up to the display cap, one per line', () => {
    const issues = Array.from({ length: 5 }, (_, i) => q(i, ['needs-human']))
    const out = renderHumanQueueSection(issues, NOW)
    for (const issue of issues) expect(out).toContain(`#${issue.number}`)
    expect(out).not.toContain('more')
  })

  it('truncates beyond 20 items with an "… and N more" trailer', () => {
    const issues = Array.from({ length: 25 }, (_, i) => q(i, [HUMAN_QUEUE_LABELS[1]], 30 - i))
    const out = renderHumanQueueSection(issues, NOW)
    expect(out).toContain('… and 5 more')
    // Oldest first: the five newest (#20..#24) are the ones not listed.
    expect(out).not.toContain('#24 ')
    expect(out).toContain('#0 ')
  })

  // #1815: the two states ask different things, so they are two groups.
  it('separates proposals awaiting a yes/no from items waiting on an act, and says what each asks', () => {
    const out = renderHumanQueueSection([q(1, ['needs-human']), q(2, ['agent-proposed', 'lane:backend'])], NOW)
    const proposals = out.indexOf('### Proposals')
    const acts = out.indexOf('### Waiting on a person')
    expect(proposals).toBeGreaterThanOrEqual(0)
    expect(acts).toBeGreaterThan(proposals)
    expect(out.indexOf('#2 ')).toBeGreaterThan(proposals)
    expect(out.indexOf('#2 ')).toBeLessThan(acts)
    expect(out.indexOf('#1 ')).toBeGreaterThan(acts)
    expect(out).toContain('add agent-dispatchable')
  })

  it('reports age, oldest first — an item parked for weeks is the finding', () => {
    const out = renderHumanQueueSection([q(10, ['needs-human'], 2), q(11, ['needs-human'], 45)], NOW)
    expect(out).toContain('45d old')
    expect(out.indexOf('#11 ')).toBeLessThan(out.indexOf('#10 '))
  })

  // #2925 / #1716: dispatchable AND vetoed read as claimable.
  it('flags an issue that carries agent-dispatchable and a hold', () => {
    const out = renderHumanQueueSection([q(2925, ['agent-dispatchable', 'needs-human'])], NOW)
    expect(out).toMatch(/#2925 .*also `agent-dispatchable`/)
    expect(renderHumanQueueSection([q(1, ['needs-human'])], NOW)).not.toContain('also `agent-dispatchable`')
  })
})
