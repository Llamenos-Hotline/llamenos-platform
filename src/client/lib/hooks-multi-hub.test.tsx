/**
 * Multi-hub routing axiom (#1014): a user in hubs A and B, viewing hub A, must
 * receive, poll and be able to answer calls that belong to hub B.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { KIND_CALL_RING, KIND_MESSAGE_NEW } from '@shared/event-kinds'
import type { RelayEventHandler } from './relay/types'

const subscribed: { hubIds: readonly string[]; kinds: number[]; handler: RelayEventHandler }[] = []
const requested: { path: string; method: string }[] = []
const ringing = vi.hoisted(() => ({ startRinging: vi.fn(), stopRinging: vi.fn() }))

vi.mock('./relay/hooks', () => ({
  useRelaySubscriptions: (hubIds: readonly string[], kinds: number[], handler: RelayEventHandler) => {
    if (hubIds.length) subscribed.push({ hubIds, kinds, handler })
  },
}))
// `useConfig().hubs` is the user's MEMBERSHIP, resolved from the authenticated
// `GET /api/hubs` (#1708). It used to be the public, pre-login `/api/config`
// roster, which is why `hub-public-only` below is modelled as a hub that
// exists on the server and is absent from this set — the shape the hooks must
// never widen to.
vi.mock('./config', () => ({
  useConfig: () => ({ currentHubId: 'hub-A', hubs: [{ id: 'hub-A' }, { id: 'hub-B' }], isMultiHub: true }),
}))
vi.mock('./notifications', () => ringing)
vi.mock('./api/client', async (importActual) => ({
  ...(await importActual<typeof import('./api/client')>()),
  request: vi.fn(async (path: string, options?: RequestInit) => {
    requested.push({ path, method: options?.method ?? 'GET' })
    // The membership endpoint ConfigProvider reads. Not reached from here —
    // these hooks take membership from the mocked context above — but the
    // server-side truth it states is the same: hub-public-only is not the
    // user's, so nothing may subscribe to or poll it.
    if (path === '/hubs') return { hubs: [{ id: 'hub-A' }, { id: 'hub-B' }] }
    if (path === '/hubs/hub-B/calls/active') {
      // Wire shape: the server sends the raw active_calls row, keyed callId (not id)
      return { calls: [{ callId: 'CA-on-hub-B', hubId: 'hub-B', callerNumber: '[redacted]', startedAt: '2026-01-01T00:00:00Z', status: 'ringing' }] }
    }
    if (path.endsWith('/calls/active')) return { calls: [] }
    return {}
  }),
}))

import { setActiveHub } from './api'
import { useCalls, useConversations } from './hooks'

function latest(kindsIncludes: number) {
  const sub = [...subscribed].reverse().find(s => s.kinds.includes(kindsIncludes))
  if (!sub) throw new Error('no subscription recorded')
  return sub
}

describe('useCalls with the user in two hubs and hub A active', () => {
  beforeEach(() => {
    subscribed.length = 0
    requested.length = 0
    ringing.startRinging.mockClear()
    ringing.stopRinging.mockClear()
    setActiveHub('hub-A')
  })

  it('subscribes to call events on every member hub, not only the active one', async () => {
    renderHook(() => useCalls())
    await waitFor(() => expect(new Set(latest(KIND_CALL_RING).hubIds)).toEqual(new Set(['hub-A', 'hub-B'])))
  })

  it('does not subscribe to a hub the user is not a member of', async () => {
    renderHook(() => useCalls())
    await waitFor(() => expect(latest(KIND_CALL_RING).hubIds).toContain('hub-B'))
    // `hub-public-only` is active on the server and not in this user's
    // membership. Subscribing to it would be the inverse of the multi-hub
    // axiom: the app must receive events from every hub the user IS in, and
    // from no other.
    expect(latest(KIND_CALL_RING).hubIds).not.toContain('hub-public-only')
  })

  it('polls active calls on every member hub and tags each call with its hub', async () => {
    const { result } = renderHook(() => useCalls())
    await waitFor(() => expect(result.current.ringingCalls).toHaveLength(1))
    // Membership is resolved before these hooks mount, so both hubs are polled
    // from the first cycle; the set of polled hubs must be exactly the members
    expect([...new Set(requested.filter(r => r.path.endsWith('/calls/active')).map(r => r.path))].sort())
      .toEqual(['/hubs/hub-A/calls/active', '/hubs/hub-B/calls/active'])
    expect(result.current.ringingCalls[0]).toMatchObject({ id: 'CA-on-hub-B', hubId: 'hub-B' })
  })

  it('answers, hangs up and reports spam against the call\'s own hub', async () => {
    const { result } = renderHook(() => useCalls())
    await waitFor(() => expect(result.current.ringingCalls).toHaveLength(1))
    requested.length = 0

    await act(async () => { await result.current.answerCall('CA-on-hub-B') })
    expect(requested).toEqual([{ path: '/hubs/hub-B/calls/CA-on-hub-B/answer', method: 'POST' }])
    expect(result.current.currentCall).toMatchObject({ id: 'CA-on-hub-B', hubId: 'hub-B', status: 'in-progress' })

    requested.length = 0
    await act(async () => { await result.current.reportSpam('CA-on-hub-B') })
    expect(requested).toEqual([{ path: '/hubs/hub-B/calls/CA-on-hub-B/spam', method: 'POST' }])
  })

  it('hangs up against the call\'s own hub', async () => {
    const { result } = renderHook(() => useCalls())
    await waitFor(() => expect(result.current.ringingCalls).toHaveLength(1))
    await act(async () => { await result.current.answerCall('CA-on-hub-B') })
    requested.length = 0
    await act(async () => { await result.current.hangupCall('CA-on-hub-B') })
    expect(requested).toEqual([{ path: '/hubs/hub-B/calls/CA-on-hub-B/hangup', method: 'POST' }])
  })

  it('rings for a call:ring relayed from a non-active hub and remembers its hub', async () => {
    const { result } = renderHook(() => useCalls())
    await waitFor(() => expect(new Set(latest(KIND_CALL_RING).hubIds).has('hub-B')).toBe(true))
    act(() => {
      latest(KIND_CALL_RING).handler(KIND_CALL_RING, { type: 'call:ring', callId: 'CA-relayed', startedAt: '2026-01-01T00:00:01Z' } as never, 'hub-B')
    })
    expect(ringing.startRinging).toHaveBeenCalled()
    expect(result.current.ringingCalls.find(c => c.id === 'CA-relayed')).toMatchObject({ hubId: 'hub-B' })
  })
})

describe('useConversations with the user in two hubs and hub A active', () => {
  beforeEach(() => {
    subscribed.length = 0
    setActiveHub('hub-A')
  })

  it('subscribes to conversation events on every member hub', async () => {
    renderHook(() => useConversations())
    await waitFor(() => expect(new Set(latest(KIND_MESSAGE_NEW).hubIds)).toEqual(new Set(['hub-A', 'hub-B'])))
  })
})
