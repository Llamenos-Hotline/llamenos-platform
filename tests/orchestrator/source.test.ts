import { describe, it, expect } from 'vitest'
import { toWorkItem, itemsFrom, phaseRank, compareQueueOrder, type RawIssue } from '../../orchestrator/src/source.js'

const RAW = {
  number: 42,
  title: 'Fix the thing',
  body: 'x'.repeat(300),
  url: 'https://github.com/o/r/issues/42',
  state: 'OPEN',
  labels: [{ name: 'agent-dispatchable' }, { name: 'lane:ios' }],
  createdAt: '2026-10-01T00:00:00Z',
}

describe('source', () => {
  it('maps a gh issue onto a WorkItem', () => {
    const item = toWorkItem(RAW)
    expect(item.id).toBe('42')
    expect(item.title).toBe('Fix the thing')
    expect(item.labels).toEqual(['agent-dispatchable', 'lane:ios'])
    expect(item.url).toBe('https://github.com/o/r/issues/42')
  })

  it('tolerates a null body', () => {
    expect(toWorkItem({ ...RAW, body: null }).body).toBe('')
  })

  it('returns undefined — not [] — when the read failed', () => {
    expect(itemsFrom(undefined)).toBeUndefined()
  })

  it('returns an empty array for a genuinely empty backlog', () => {
    expect(itemsFrom([])).toEqual([])
  })
})

describe('phaseRank', () => {
  it('parses the digit run after the prefix', () => {
    expect(phaseRank(['m1-phase:1-data-loss'])).toBe(1)
    expect(phaseRank(['m1-phase:4-real-signals'])).toBe(4)
    expect(phaseRank(['m1-phase:0-queue-health'])).toBe(0)
  })

  it('is undefined for items with no phase label', () => {
    expect(phaseRank(['agent-dispatchable', 'lane:infra'])).toBeUndefined()
    expect(phaseRank([])).toBeUndefined()
  })

  it('ignores labels that merely resemble a phase label', () => {
    expect(phaseRank(['m1-phase:'])).toBeUndefined()
    expect(phaseRank(['m1-phase:next'])).toBeUndefined()
    expect(phaseRank(['other-m1-phase:2-e2ee-readable'])).toBeUndefined()
  })

  it('takes the EARLIER phase when an item carries two', () => {
    expect(phaseRank(['m1-phase:4-real-signals', 'm1-phase:1-data-loss'])).toBe(1)
  })
})

function issue(number: number, createdAt: string, labels: string[] = []): RawIssue {
  return {
    number,
    title: `issue ${number}`,
    body: null,
    url: `https://github.com/o/r/issues/${number}`,
    state: 'OPEN',
    labels: labels.map((name) => ({ name })),
    createdAt,
  }
}

describe('compareQueueOrder — explicit phase-then-age queue order (#1813)', () => {
  it('orders by phase number before age', () => {
    const oldPhase4 = issue(1, '2026-09-01T00:00:00Z', ['m1-phase:4-real-signals'])
    const newPhase1 = issue(2, '2026-10-20T00:00:00Z', ['m1-phase:1-data-loss'])
    expect(compareQueueOrder(newPhase1, oldPhase4)).toBeLessThan(0)
    expect(compareQueueOrder(oldPhase4, newPhase1)).toBeGreaterThan(0)
  })

  it('a phased item always outranks an unphased one, however new the phased item is', () => {
    const newPhased = issue(1, '2026-10-20T00:00:00Z', ['m1-phase:3-calling'])
    const oldUnphased = issue(2, '2026-09-01T00:00:00Z')
    expect(compareQueueOrder(newPhased, oldUnphased)).toBeLessThan(0)
    expect(compareQueueOrder(oldUnphased, newPhased)).toBeGreaterThan(0)
  })

  // The issue's verification scenario, exactly: with newest-first (gh's
  // default) the fresh non-M1 filing displaced the older M1 item; here it
  // must not.
  it('a freshly filed unphased issue never displaces an older item at the head', () => {
    const oldM1 = issue(1, '2026-09-05T00:00:00Z', ['m1-phase:2-e2ee-readable'])
    const freshOther = issue(2, '2026-10-20T00:00:00Z')
    expect([freshOther, oldM1].sort(compareQueueOrder).map((i) => i.number)).toEqual([1, 2])
  })

  it('orders by age within one phase class, oldest first', () => {
    const newer = issue(1, '2026-10-01T00:00:00Z', ['m1-phase:1-data-loss'])
    const older = issue(2, '2026-09-01T00:00:00Z', ['m1-phase:1-data-loss'])
    expect(compareQueueOrder(older, newer)).toBeLessThan(0)
  })

  it('orders unphased items by age, oldest first — never gh\'s newest-first default', () => {
    const newer = issue(1, '2026-10-01T00:00:00Z')
    const older = issue(2, '2026-09-01T00:00:00Z')
    expect(compareQueueOrder(older, newer)).toBeLessThan(0)
    expect(compareQueueOrder(newer, older)).toBeGreaterThan(0)
  })

  it('is a total order: equal keys compare 0 and sort stays stable', () => {
    const a = issue(1, '2026-10-01T00:00:00Z', ['m1-phase:2-e2ee-readable'])
    const b = issue(2, '2026-10-01T00:00:00Z', ['m1-phase:2-e2ee-readable'])
    expect(compareQueueOrder(a, b)).toBe(0)
    expect([a, b].sort(compareQueueOrder).map((i) => i.number)).toEqual([1, 2])
  })

  it('sorts a mixed backlog phase-first, then by age', () => {
    const backlog = [
      issue(1, '2026-10-20T00:00:00Z'),                                        // new, unphased
      issue(2, '2026-10-19T00:00:00Z', ['m1-phase:4-real-signals']),
      issue(3, '2026-09-01T00:00:00Z'),                                        // old, unphased
      issue(4, '2026-10-18T00:00:00Z', ['m1-phase:1-data-loss']),
      issue(5, '2026-09-02T00:00:00Z', ['m1-phase:1-data-loss']),
    ]
    expect(backlog.sort(compareQueueOrder).map((i) => i.number)).toEqual([5, 4, 2, 3, 1])
  })
})
