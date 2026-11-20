import { describe, it, expect } from 'vitest'
import {
  MERGE_HOLD_LABEL, MERGE_QUEUE_BOT_LOGIN,
  decideHold, queueHistoryFromTimeline, isHoldTransient, renderHoldComment, recordHold,
  MergeHeldError, holdReason, placeManualHold, renderManualHoldComment,
  HOLD_COMMENT_MARKER, HOLD_UNEXPLAINED_MARKER,
  type QueueHistory, type QueueEvent,
} from '../../orchestrator/src/merge-hold.js'
import {
  armAutoMergeWithQueueClearance, type ArmAutoMergeDeps,
} from '../../orchestrator/src/automerge.js'

const QUEUE_BOT = { type: 'Bot', login: MERGE_QUEUE_BOT_LOGIN } as const
const PERSON = { type: 'User', login: 'rhonda-rodododo' } as const

function ev(kind: QueueEvent['kind'], actor: { type: string; login: string } | null, at: string): QueueEvent {
  return { kind, actorType: actor?.type, actorLogin: actor?.login, at }
}

/**
 * #2788's own timeline, 2026-11-16, as GitHub returned it: queued by the fleet,
 * deliberately dequeued by a supervisor at 09:19:44, re-queued by the feeder at
 * 09:23:03, merged at 10:40. The hold must make the state at 09:19:44 one the
 * feeder refuses to arm.
 */
const AT_THE_DEQUEUE: QueueHistory = { last: ev('removed', PERSON, '2026-11-16T09:19:44Z'), holdClearedAt: undefined }

describe('decideHold — what makes a PR ineligible to arm (#2814)', () => {
  it('a PR carrying the hold label is held, whatever its queue history', () => {
    for (const history of [{ last: null, holdClearedAt: undefined }, AT_THE_DEQUEUE] satisfies QueueHistory[]) {
      expect(decideHold([MERGE_HOLD_LABEL], history)).toEqual({ held: true, source: 'label' })
    }
  })

  it('a dequeue by a person (the #2788 timeline) is held, with who and when', () => {
    expect(decideHold([], AT_THE_DEQUEUE)).toEqual({
      held: true, source: 'dequeue', by: 'rhonda-rodododo', at: '2026-11-16T09:19:44Z',
    })
  })

  it('the merge queue ejecting its own entry is a transient, not a hold', () => {
    expect(decideHold([], { last: ev('removed', QUEUE_BOT, '2026-11-16T10:40:38Z'), holdClearedAt: undefined })).toEqual({ held: false })
  })

  it('any OTHER actor removing the entry is a decision — another bot, an app, a deleted account', () => {
    for (const actor of [{ type: 'Bot', login: 'some-other-app' }, { type: 'User', login: MERGE_QUEUE_BOT_LOGIN }, null]) {
      const d = decideHold([], { last: ev('removed', actor, '2026-11-16T09:19:44Z'), holdClearedAt: undefined })
      expect(d.held, JSON.stringify(actor)).toBe(true)
    }
  })

  it('a hold is released ONLY by removing the hold label after the dequeue', () => {
    expect(decideHold([], { ...AT_THE_DEQUEUE, holdClearedAt: '2026-11-16T09:30:00Z' })).toEqual({ held: false })
    // An unlabel from BEFORE the dequeue says nothing about this dequeue.
    expect(decideHold([], { ...AT_THE_DEQUEUE, holdClearedAt: '2026-11-16T09:00:00Z' }).held).toBe(true)
  })

  it('an entry the queue still holds, or never held, is not held', () => {
    expect(decideHold([], { last: ev('added', PERSON, '2026-11-16T09:23:03Z'), holdClearedAt: undefined })).toEqual({ held: false })
    expect(decideHold([], { last: null, holdClearedAt: undefined })).toEqual({ held: false })
  })

  it('isHoldTransient names exactly the queue bot', () => {
    expect(isHoldTransient(ev('removed', QUEUE_BOT, 'x'))).toBe(true)
    expect(isHoldTransient(ev('removed', PERSON, 'x'))).toBe(false)
  })
})

describe('queueHistoryFromTimeline — GitHub GraphQL nodes reduced', () => {
  it('reads #2788 as GitHub returns it: last event a person\'s removal', () => {
    const nodes = [
      { __typename: 'AddedToMergeQueueEvent', createdAt: '2026-11-16T08:37:59Z', actor: { __typename: 'User', login: 'rhonda-rodododo' } },
      { __typename: 'RemovedFromMergeQueueEvent', createdAt: '2026-11-16T09:19:44Z', actor: { __typename: 'User', login: 'rhonda-rodododo' } },
    ]
    expect(queueHistoryFromTimeline(nodes, false)).toEqual(AT_THE_DEQUEUE)
  })

  it('keeps the newest unlabel of the hold label, ignores other labels', () => {
    const nodes = [
      { __typename: 'RemovedFromMergeQueueEvent', createdAt: '2026-11-16T09:19:44Z', actor: { __typename: 'User', login: 'p' } },
      { __typename: 'UnlabeledEvent', createdAt: '2026-11-16T09:40:00Z', label: { name: 'queue-cleared' } },
      { __typename: 'UnlabeledEvent', createdAt: '2026-11-16T09:30:00Z', label: { name: MERGE_HOLD_LABEL } },
    ]
    expect(queueHistoryFromTimeline(nodes, false)?.holdClearedAt).toBe('2026-11-16T09:30:00Z')
  })

  it('a window with no queue event and earlier pages unread is unreadable, never "never queued"', () => {
    expect(queueHistoryFromTimeline([], true)).toBeUndefined()
    expect(queueHistoryFromTimeline([], false)).toEqual({ last: null, holdClearedAt: undefined })
  })

  it('a malformed node is unreadable, never skipped', () => {
    expect(queueHistoryFromTimeline([{ __typename: 'RemovedFromMergeQueueEvent' }], false)).toBeUndefined()
  })
})

const DEQUEUE_HOLD = { held: true, source: 'dequeue', by: 'rhonda-rodododo', at: '2026-11-16T09:19:44Z' } as const

describe('recordHold — the record lands BEFORE the label, once (#2876)', () => {
  it('a dequeue hold comments who/when and how to release, THEN applies the label', async () => {
    const calls: string[] = []
    await recordHold(2788, DEQUEUE_HOLD, { ...AT_THE_DEQUEUE, holdRecorded: false }, {
      addHoldLabel: async (n) => { calls.push(`label ${n}`) },
      postPrComment: async (n, body) => { calls.push(`comment ${n}: ${body}`) },
      log: () => {},
    })
    expect(calls[0]).toMatch(/^comment 2788: /)
    expect(calls[0]).toMatch(/rhonda-rodododo/)
    expect(calls[0]).toMatch(new RegExp(MERGE_HOLD_LABEL))
    expect(calls[0]).toContain(HOLD_COMMENT_MARKER)
    expect(calls[1]).toBe('label 2788')
  })

  it('RAIL: a comment that cannot be posted means NO label — a hold whose record did not land is not labelled', async () => {
    const calls: string[] = []
    await recordHold(2829, DEQUEUE_HOLD, { ...AT_THE_DEQUEUE, holdRecorded: false }, {
      addHoldLabel: async () => { calls.push('label') },
      postPrComment: async () => { throw new Error('502') },
      log: (m) => { calls.push(m) },
    })
    expect(calls.filter((c) => c === 'label')).toEqual([])
    expect(calls.join('\n')).toMatch(/502/)
  })

  it('a comment that already landed (label failed last pass) is not posted twice', async () => {
    const calls: string[] = []
    await recordHold(1, DEQUEUE_HOLD, { ...AT_THE_DEQUEUE, holdRecorded: true }, {
      addHoldLabel: async () => { calls.push('label') },
      postPrComment: async () => { calls.push('comment') },
      log: () => {},
    })
    expect(calls).toEqual(['label'])
  })

  it('whether a record exists being unknown writes nothing — never a label without proof of its record', async () => {
    const calls: string[] = []
    await recordHold(1, DEQUEUE_HOLD, AT_THE_DEQUEUE, {
      addHoldLabel: async () => { calls.push('label') },
      postPrComment: async () => { calls.push('comment') },
      log: () => {},
    })
    expect(calls).toEqual([])
  })

  it('a label failing after the comment landed is logged, never thrown', async () => {
    const logs: string[] = []
    await recordHold(1, DEQUEUE_HOLD, { ...AT_THE_DEQUEUE, holdRecorded: false }, {
      addHoldLabel: async () => { throw new Error('denied') },
      postPrComment: async () => {},
      log: (m) => { logs.push(m) },
    })
    expect(logs.join('\n')).toMatch(/denied/)
  })

  it('an explained label hold writes nothing — it is already visible and recorded', async () => {
    const calls: string[] = []
    const history: QueueHistory = { last: null, holdClearedAt: undefined, holdRecorded: true }
    await recordHold(1, decideHold([MERGE_HOLD_LABEL], history), history, {
      addHoldLabel: async () => { calls.push('label') },
      postPrComment: async () => { calls.push('comment') },
      log: () => {},
    })
    expect(calls).toEqual([])
  })

  it('the comment and the reason both say how to release it', () => {
    expect(renderHoldComment('p', 't')).toMatch(/remove the `merge-hold` label/i)
    expect(holdReason({ held: true, source: 'label' })).toMatch(MERGE_HOLD_LABEL)
  })
})

/**
 * #2829: label applied by llamenos-auto seven seconds after a dequeue, and the
 * PR had no comment at all. Nothing recorded who held it or why, the release
 * rule made the holder's intent the only thing that mattered, and it sat
 * approved for ~44 hours.
 */
describe('an unexplained hold is reported as unexplained, and says so on the PR (#2876)', () => {
  const NO_RECORD: QueueHistory = {
    last: ev('removed', { type: 'User', login: 'llamenos-auto' }, '2026-11-18T01:59:46Z'),
    holdClearedAt: '2026-11-17T21:19:13Z',
    holdLabeledAt: '2026-11-18T01:59:48Z',
    holdLabeledBy: 'llamenos-auto',
    holdRecorded: false,
    unexplainedNoted: false,
  }

  it('a label with no hold comment is unexplained; with one it is not', () => {
    const d = decideHold([MERGE_HOLD_LABEL], NO_RECORD)
    expect(d).toMatchObject({ held: true, source: 'label', unexplained: true, labeledBy: 'llamenos-auto', labeledAt: '2026-11-18T01:59:48Z' })
    expect(decideHold([MERGE_HOLD_LABEL], { ...NO_RECORD, holdRecorded: true })).not.toHaveProperty('unexplained')
    // Unknown is not "no comment".
    expect(decideHold([MERGE_HOLD_LABEL], { ...NO_RECORD, holdRecorded: undefined })).not.toHaveProperty('unexplained')
  })

  it('the skip reason names it UNEXPLAINED, who applied it and when, and the two ways out', () => {
    const reason = holdReason(decideHold([MERGE_HOLD_LABEL], NO_RECORD))
    expect(reason).toMatch(/UNEXPLAINED/)
    expect(reason).toMatch(/llamenos-auto at 2026-11-18T01:59:48Z/)
    expect(reason).toMatch(/merge-hold <pr> --reason/)
    expect(reason).toMatch(/remove the label/)
  })

  it('records the gap with one comment, once, and never releases the hold', async () => {
    const calls: string[] = []
    const deps = {
      addHoldLabel: async () => { calls.push('label') },
      postPrComment: async (_n: number, body: string) => { calls.push(body) },
      log: () => {},
    }
    const d = decideHold([MERGE_HOLD_LABEL], NO_RECORD)
    await recordHold(2829, d, NO_RECORD, deps)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain(HOLD_UNEXPLAINED_MARKER)
    expect(calls[0]).not.toContain(HOLD_COMMENT_MARKER)
    expect(calls[0]).toMatch(/@llamenos-auto/)
    await recordHold(2829, d, { ...NO_RECORD, unexplainedNoted: true }, deps)
    expect(calls).toHaveLength(1)
  })

  it('the unexplained note is not an explanation: the hold stays unexplained until a reason is recorded', () => {
    const marked = queueHistoryFromTimeline([], false, { bodies: [`${HOLD_UNEXPLAINED_MARKER}\nUnexplained merge hold.`], complete: true })
    expect(marked).toMatchObject({ holdRecorded: false, unexplainedNoted: true })
  })

  it('a manual hold is explained: reason in the comment, comment BEFORE the label', async () => {
    const calls: string[] = []
    await placeManualHold(2829, 'regression in the claims guard', {
      addHoldLabel: async () => { calls.push('label') },
      postPrComment: async (_n, body) => { calls.push(body) },
    })
    expect(calls[0]).toContain(HOLD_COMMENT_MARKER)
    expect(calls[0]).toContain('regression in the claims guard')
    expect(calls[1]).toBe('label')
    expect(renderManualHoldComment('b')).toMatch(/remove the `merge-hold` label/)
  })

  it('a manual hold with no reason, or whose comment fails, never labels', async () => {
    const calls: string[] = []
    const deps = { addHoldLabel: async () => { calls.push('label') }, postPrComment: async () => { calls.push('comment') } }
    await expect(placeManualHold(1, '  ', deps)).rejects.toThrow(/reason/)
    await expect(placeManualHold(1, 'why', { ...deps, postPrComment: async () => { throw new Error('502') } })).rejects.toThrow(/502/)
    expect(calls).toEqual([])
  })
})

describe('queueHistoryFromTimeline — the hold record', () => {
  const nodes = [
    { __typename: 'RemovedFromMergeQueueEvent', createdAt: '2026-11-18T01:59:46Z', actor: { __typename: 'User', login: 'llamenos-auto' } },
    { __typename: 'LabeledEvent', createdAt: '2026-11-18T01:59:48Z', actor: { __typename: 'User', login: 'llamenos-auto' }, label: { name: MERGE_HOLD_LABEL } },
    { __typename: 'LabeledEvent', createdAt: '2026-11-18T02:00:00Z', actor: { __typename: 'User', login: 'x' }, label: { name: 'queue-cleared' } },
  ]

  it('reads who applied the hold label and ignores other labels', () => {
    expect(queueHistoryFromTimeline(nodes, false)).toMatchObject({ holdLabeledBy: 'llamenos-auto', holdLabeledAt: '2026-11-18T01:59:48Z' })
  })

  it('a marker comment records the hold; none in a COMPLETE window is "no record"; none in a partial window is unknown', () => {
    const rec = (bodies: string[], complete: boolean) => queueHistoryFromTimeline(nodes, false, { bodies, complete })?.holdRecorded
    expect(rec([`x ${HOLD_COMMENT_MARKER}`], true)).toBe(true)
    expect(rec([`x ${HOLD_COMMENT_MARKER}`], false)).toBe(true)
    expect(rec(['unrelated'], true)).toBe(false)
    expect(rec(['unrelated'], false)).toBeUndefined()
  })
})

/**
 * THE GUARD. The single arming point (`armAutoMergeWithQueueClearance`, behind
 * cli.ts's `enableAutoMerge`, which both the tick and queue-feed reach GitHub
 * through) must refuse a held PR. Before #2814 it read only head + labels and
 * armed #2788 three minutes after a supervisor dequeued it.
 */
describe('RAIL: the arming point refuses a held PR (#2814)', () => {
  function harness(opts: { labels?: string[]; history: QueueHistory | undefined }) {
    const calls: string[] = []
    const deps: ArmAutoMergeDeps = {
      readPr: async () => ({ headRefName: 'fleet/roles/2780', labels: opts.labels ?? [] }),
      readQueueHistory: async () => opts.history,
      addQueueClearedLabel: async (pr) => { calls.push(`label+ ${pr}`) },
      removeQueueClearedLabel: async (pr) => { calls.push(`label- ${pr}`) },
      addHoldLabel: async (pr) => { calls.push(`hold ${pr}`) },
      postPrComment: async (pr) => { calls.push(`comment ${pr}`) },
      requestAutoMerge: async (pr) => { calls.push(`arm ${pr}`) },
      log: () => {},
    }
    return { calls, deps }
  }

  it('#2788 at 09:19:44 — dequeued by a person — is NOT re-armed; the hold is recorded instead', async () => {
    const { calls, deps } = harness({ history: { ...AT_THE_DEQUEUE, holdRecorded: false } })
    await expect(armAutoMergeWithQueueClearance('2788', deps)).rejects.toBeInstanceOf(MergeHeldError)
    expect(calls).not.toContain('arm 2788')
    // The record first, then the label (#2876).
    expect(calls).toEqual(['comment 2788', 'hold 2788'])
  })

  it('a labelled hold is NOT armed, and nothing is written', async () => {
    const { calls, deps } = harness({ labels: [MERGE_HOLD_LABEL], history: { last: null, holdClearedAt: undefined } })
    await expect(armAutoMergeWithQueueClearance('2788', deps)).rejects.toBeInstanceOf(MergeHeldError)
    expect(calls).toEqual([])
  })

  it('an unreadable queue history is NOT armed — "could not ask" is never "nobody dequeued it"', async () => {
    const { calls, deps } = harness({ history: undefined })
    await expect(armAutoMergeWithQueueClearance('2788', deps)).rejects.toThrow(/history could not be read/)
    expect(calls).toEqual([])
  })

  it('released (label removed after the dequeue), or ejected by the queue itself — armed as before', async () => {
    for (const history of [
      { ...AT_THE_DEQUEUE, holdClearedAt: '2026-11-16T09:30:00Z' },
      { last: ev('removed', QUEUE_BOT, '2026-11-16T09:19:44Z'), holdClearedAt: undefined },
    ] satisfies QueueHistory[]) {
      const { calls, deps } = harness({ history })
      await armAutoMergeWithQueueClearance('2788', deps)
      expect(calls).toEqual(['label+ 2788', 'arm 2788'])
    }
  })
})
