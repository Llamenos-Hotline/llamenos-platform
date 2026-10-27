/**
 * The "Call Ended / Add Note" prompt holds the user's OWN call after it ends — on any
 * member hub, under that call's own hub id — until it is dismissed, written up, or the
 * key locks. It is in-memory feed state: nothing here reads or writes web storage.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { KIND_CALL_UPDATE } from '@shared/event-kinds'
import type { RelayEventHandler } from './relay/types'

const subscribed: { kinds: number[]; handler: RelayEventHandler }[] = []
const refused = new Set<string>()
/** What GET /hubs/hub-B/calls/active answers; emptied to model the call going away. */
const hubBCalls = vi.hoisted(() => ({ list: [] as unknown[] }))
const keys = vi.hoisted(() => ({ unlocked: true }))

vi.mock('./relay/hooks', () => ({
  useRelaySubscriptions: (_hubIds: readonly string[], kinds: number[], handler: RelayEventHandler) => {
    subscribed.push({ kinds, handler })
  },
}))
vi.mock('./config', () => ({
  useConfig: () => ({ currentHubId: 'hub-A', hubs: [{ id: 'hub-A' }, { id: 'hub-B' }], isMultiHub: true }),
}))
vi.mock('./notifications', () => ({ startRinging: vi.fn(), stopRinging: vi.fn() }))
vi.mock('./key-manager', () => ({
  isUnlocked: () => keys.unlocked,
  setOnCall: vi.fn(),
  onLock: () => () => {},
}))
vi.mock('./api/client', async (importActual) => ({
  ...(await importActual<typeof import('./api/client')>()),
  request: vi.fn(async (path: string) => {
    if (refused.has(path)) throw new Error('refused')
    if (path === '/hubs/hub-B/calls/active') return { calls: hubBCalls.list }
    if (path.endsWith('/calls/active')) return { calls: [] }
    return {}
  }),
}))

import { setActiveHub } from './api'
import { CallsProvider, useCalls } from './calls-context'

const ringOnB = {
  callId: 'CA-on-hub-B', hubId: 'hub-B', callerNumber: '[redacted]', startedAt: '2026-01-01T00:00:00Z', status: 'ringing',
}

function lastCallHandler(): RelayEventHandler {
  const sub = [...subscribed].reverse().find(s => s.kinds.includes(KIND_CALL_UPDATE))
  if (!sub) throw new Error('no call subscription recorded')
  return sub.handler
}

async function answered() {
  const hook = renderHook(() => useCalls(), { wrapper: CallsProvider })
  await waitFor(() => expect(hook.result.current.ringingCalls).toHaveLength(1))
  await act(async () => { await hook.result.current.answerCall('CA-on-hub-B') })
  expect(hook.result.current.currentCall).toMatchObject({ id: 'CA-on-hub-B', hubId: 'hub-B' })
  return hook
}

describe('the ended-call hold on the call feed (hub A active, call on hub B)', () => {
  beforeEach(() => {
    subscribed.length = 0
    refused.clear()
    hubBCalls.list = [ringOnB]
    keys.unlocked = true
    setActiveHub('hub-A')
  })

  it('holds nothing before any call', async () => {
    const { result } = renderHook(() => useCalls(), { wrapper: CallsProvider })
    await waitFor(() => expect(result.current.calls).toEqual([]))
    expect(result.current.endedCall).toBeNull()
  })

  it('holds my call under ITS hub (not the active one) once I hang up', async () => {
    const { result } = await answered()
    expect(result.current.endedCall).toBeNull()

    await act(async () => { await result.current.hangupCall('CA-on-hub-B') })

    expect(result.current.currentCall).toBeNull()
    expect(result.current.endedCall).toEqual({ id: 'CA-on-hub-B', hubId: 'hub-B' })
  })

  it('holds my call when the caller hangs up first (relay: completed)', async () => {
    const { result } = await answered()

    await act(async () => {
      lastCallHandler()(KIND_CALL_UPDATE, { type: 'call:update', callId: 'CA-on-hub-B', status: 'completed' }, 'hub-B')
    })

    expect(result.current.currentCall).toBeNull()
    expect(result.current.endedCall).toEqual({ id: 'CA-on-hub-B', hubId: 'hub-B' })
  })

  it('holds my call when it falls out of the poll (missed relay event)', async () => {
    // Capture the 15s poll rather than faking time: waitFor itself needs real timers.
    const polls: Array<() => void> = []
    const realSetInterval = globalThis.setInterval
    const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms?: number) => {
      if (ms === 15_000) { polls.push(fn); return 0 as unknown as ReturnType<typeof setInterval> }
      return realSetInterval(fn, ms)
    }) as typeof setInterval)
    try {
      const { result } = await answered()
      hubBCalls.list = []

      await act(async () => { for (const poll of polls) poll() })

      await waitFor(() => expect(result.current.currentCall).toBeNull())
      expect(result.current.endedCall).toEqual({ id: 'CA-on-hub-B', hubId: 'hub-B' })
    } finally {
      spy.mockRestore()
    }
  })

  it('holds my call when I report it as spam (the call is over)', async () => {
    const { result } = await answered()

    await act(async () => { await result.current.reportSpam('CA-on-hub-B') })

    expect(result.current.endedCall).toEqual({ id: 'CA-on-hub-B', hubId: 'hub-B' })
  })

  it('holds nothing when the answer is refused: no call was had', async () => {
    const { result } = renderHook(() => useCalls(), { wrapper: CallsProvider })
    await waitFor(() => expect(result.current.ringingCalls).toHaveLength(1))
    refused.add('/hubs/hub-B/calls/CA-on-hub-B/answer')

    await act(async () => {
      await expect(result.current.answerCall('CA-on-hub-B')).rejects.toThrow('refused')
    })

    expect(result.current.endedCall).toBeNull()
  })

  it('holds nothing when a refused hang-up leaves the call live', async () => {
    const { result } = await answered()
    refused.add('/hubs/hub-B/calls/CA-on-hub-B/hangup')

    await act(async () => {
      await expect(result.current.hangupCall('CA-on-hub-B')).rejects.toThrow('refused')
    })

    expect(result.current.currentCall).not.toBeNull()
    expect(result.current.endedCall).toBeNull()
  })

  it('does not resurrect a prompt for a call that ended behind the lock screen', async () => {
    const { result } = await answered()
    keys.unlocked = false

    await act(async () => { await result.current.hangupCall('CA-on-hub-B') })

    expect(result.current.currentCall).toBeNull()
    expect(result.current.endedCall).toBeNull()
  })

  it('is released by dismissal, or by a note filed against that call — never by another call\'s', async () => {
    const { result } = await answered()
    await act(async () => { await result.current.hangupCall('CA-on-hub-B') })

    act(() => result.current.dismissEndedCall('CA-some-other-call'))
    expect(result.current.endedCall).not.toBeNull()

    act(() => result.current.dismissEndedCall('CA-on-hub-B'))
    expect(result.current.endedCall).toBeNull()
  })

  it('is released by an unqualified dismissal', async () => {
    const { result } = await answered()
    await act(async () => { await result.current.hangupCall('CA-on-hub-B') })

    act(() => result.current.dismissEndedCall())

    expect(result.current.endedCall).toBeNull()
  })

  it('never touches web storage: the held call is memory only', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const { result } = await answered()
    await act(async () => { await result.current.hangupCall('CA-on-hub-B') })

    expect(result.current.endedCall).not.toBeNull()
    expect(setItem).not.toHaveBeenCalled()
    setItem.mockRestore()
  })
})
