import { describe, it, expect } from 'vitest'
import {
  MERGE_HOLD_LABEL, MERGE_QUEUE_BOT_LOGIN,
  decideHold, queueHistoryFromTimeline, isHoldTransient, renderHoldComment, recordHold,
  MergeHeldError, holdReason,
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

describe('recordHold — the hold is made visible on the PR, once', () => {
  it('a dequeue hold applies the label, then comments who/when and how to release', async () => {
    const calls: string[] = []
    await recordHold(2788, { held: true, source: 'dequeue', by: 'rhonda-rodododo', at: '2026-11-16T09:19:44Z' }, {
      addHoldLabel: async (n) => { calls.push(`label ${n}`) },
      postPrComment: async (n, body) => { calls.push(`comment ${n}: ${body}`) },
      log: () => {},
    })
    expect(calls[0]).toBe('label 2788')
    expect(calls[1]).toMatch(/rhonda-rodododo/)
    expect(calls[1]).toMatch(new RegExp(MERGE_HOLD_LABEL))
  })

  it('no comment when the label could not be applied — no comment per tick', async () => {
    const calls: string[] = []
    await recordHold(1, { held: true, source: 'dequeue', by: 'p', at: 't' }, {
      addHoldLabel: async () => { throw new Error('denied') },
      postPrComment: async () => { calls.push('comment') },
      log: (m) => { calls.push(m) },
    })
    expect(calls.some((c) => c === 'comment')).toBe(false)
    expect(calls.join('\n')).toMatch(/denied/)
  })

  it('a label hold writes nothing — it is already visible', async () => {
    const calls: string[] = []
    await recordHold(1, { held: true, source: 'label' }, {
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
    const { calls, deps } = harness({ history: AT_THE_DEQUEUE })
    await expect(armAutoMergeWithQueueClearance('2788', deps)).rejects.toBeInstanceOf(MergeHeldError)
    expect(calls).not.toContain('arm 2788')
    expect(calls).toEqual(['hold 2788', 'comment 2788'])
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
