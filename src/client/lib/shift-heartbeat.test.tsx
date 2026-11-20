/**
 * The desktop heartbeat sender (#1142). The server reaps a clock-in whose heartbeat
 * stops, so what matters is WHERE beats go (every member hub, not the active one),
 * HOW OFTEN, and that the UI hears when a clock-in is lost.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { ACTIVE_SHIFT_HEARTBEAT_INTERVAL_MS } from '@shared/active-shift-liveness'

const sent: string[] = []
/** Hubs whose status the mocked server reports as clocked in. */
const clockedInAt = new Set<string>()
/** Hubs that answer a heartbeat 404 (the clock-in went stale / was cleared). */
const refusesBeats = new Set<string>()
/** Hubs whose status was read, in order. */
const statusReads: string[] = []

vi.mock('@/lib/member-hubs', () => ({
  useMemberHubIds: () => hubs,
}))
let hubs = ['hub-A', 'hub-B']

vi.mock('@/lib/api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api')>()
  return {
    ...actual,
    getMyShiftStatusIn: async (hubId: string) => {
      statusReads.push(hubId)
      return { onShift: false, clockedIn: clockedInAt.has(hubId), clockedInAt: null, currentShift: null, nextShift: null }
    },
    sendHeartbeat: async (hubId: string) => {
      sent.push(hubId)
      if (refusesBeats.has(hubId)) throw new actual.ApiError(404, 'Active shift not found — clock in first')
      return { ok: true }
    },
  }
})

import { sendHeartbeats, useShiftHeartbeat } from './shift-heartbeat'
import { ApiError } from '@/lib/api'
import { shiftKeys } from '@/lib/queries/shifts'

let queryClient: QueryClient
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
)

beforeEach(() => {
  sent.length = 0
  statusReads.length = 0
  clockedInAt.clear()
  refusesBeats.clear()
  hubs = ['hub-A', 'hub-B']
  queryClient = new QueryClient()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('sendHeartbeats', () => {
  it('classifies 404 and 403 as not-clocked-in and leaves other failures out', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const outcomes = await sendHeartbeats(['ok', 'gone', 'forbidden', 'down'], async (hubId) => {
      if (hubId === 'gone') throw new ApiError(404, '')
      if (hubId === 'forbidden') throw new ApiError(403, '')
      if (hubId === 'down') throw new ApiError(503, '')
    })
    expect(Object.fromEntries(outcomes)).toEqual({ ok: 'alive', gone: 'not-clocked-in', forbidden: 'not-clocked-in' })
    // A real failure is reported, not swallowed.
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})

describe('useShiftHeartbeat', () => {
  it('beats only the hubs the server says the user is clocked into — never one with no clock-in', async () => {
    clockedInAt.add('hub-A')
    renderHook(() => useShiftHeartbeat(true), { wrapper })
    await vi.advanceTimersByTimeAsync(0)
    expect(statusReads.sort()).toEqual(['hub-A', 'hub-B'])
    expect(sent).toEqual(['hub-A'])

    sent.length = 0
    await vi.advanceTimersByTimeAsync(ACTIVE_SHIFT_HEARTBEAT_INTERVAL_MS)
    expect(sent).toEqual(['hub-A'])
  })

  it('beats every hub the user is clocked into, whichever hub the UI shows (multi-hub)', async () => {
    clockedInAt.add('hub-A')
    clockedInAt.add('hub-B')
    renderHook(() => useShiftHeartbeat(true), { wrapper })
    await vi.advanceTimersByTimeAsync(0)
    expect(sent.sort()).toEqual(['hub-A', 'hub-B'])
  })

  it('sends nothing, and reads no status, for a user with no clock-in', async () => {
    renderHook(() => useShiftHeartbeat(true), { wrapper })
    await vi.advanceTimersByTimeAsync(ACTIVE_SHIFT_HEARTBEAT_INTERVAL_MS * 3)
    expect(sent).toEqual([])
  })

  it('sends nothing when the user cannot clock in', async () => {
    clockedInAt.add('hub-A')
    renderHook(() => useShiftHeartbeat(false), { wrapper })
    await vi.advanceTimersByTimeAsync(ACTIVE_SHIFT_HEARTBEAT_INTERVAL_MS * 2)
    expect(sent).toEqual([])
    expect(statusReads).toEqual([])
  })

  it('stops beating when it unmounts', async () => {
    clockedInAt.add('hub-A')
    const { unmount } = renderHook(() => useShiftHeartbeat(true), { wrapper })
    await vi.advanceTimersByTimeAsync(0)
    unmount()
    sent.length = 0
    await vi.advanceTimersByTimeAsync(ACTIVE_SHIFT_HEARTBEAT_INTERVAL_MS * 3)
    expect(sent).toEqual([])
  })

  it('stops beating a hub that refuses, and refreshes the shift status — the server reaped the clock-in', async () => {
    clockedInAt.add('hub-A')
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    renderHook(() => useShiftHeartbeat(true), { wrapper })
    await vi.advanceTimersByTimeAsync(0)
    expect(invalidate).not.toHaveBeenCalled()

    // The server reaps the clock-in: the next beat is refused and the status flips.
    refusesBeats.add('hub-A')
    clockedInAt.delete('hub-A')
    sent.length = 0
    await vi.advanceTimersByTimeAsync(ACTIVE_SHIFT_HEARTBEAT_INTERVAL_MS)
    expect(sent).toEqual(['hub-A'])
    expect(invalidate).toHaveBeenCalledWith({ queryKey: shiftKeys.myStatus() })

    // One refusal is final: no more beats, however long the app stays open.
    sent.length = 0
    await vi.advanceTimersByTimeAsync(ACTIVE_SHIFT_HEARTBEAT_INTERVAL_MS * 10)
    expect(sent).toEqual([])
  })

  it('does not keep beating a hub that refuses while the status still says clocked in', async () => {
    clockedInAt.add('hub-A')
    refusesBeats.add('hub-A')
    renderHook(() => useShiftHeartbeat(true), { wrapper })
    await vi.advanceTimersByTimeAsync(ACTIVE_SHIFT_HEARTBEAT_INTERVAL_MS * 10)
    expect(sent).toEqual(['hub-A'])
  })

  it('resumes beating a hub once the user clocks in there again', async () => {
    clockedInAt.add('hub-A')
    refusesBeats.add('hub-A')
    renderHook(() => useShiftHeartbeat(true), { wrapper })
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toEqual(['hub-A'])

    // Reaped: status reports not clocked in, which clears the refusal.
    clockedInAt.delete('hub-A')
    await queryClient.invalidateQueries({ queryKey: shiftKeys.myStatus() })
    await vi.advanceTimersByTimeAsync(0)

    // Clocked in afresh (clock-in invalidates the status) and the server accepts beats again.
    refusesBeats.delete('hub-A')
    clockedInAt.add('hub-A')
    sent.length = 0
    await queryClient.invalidateQueries({ queryKey: shiftKeys.myStatus() })
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toEqual(['hub-A'])
  })
})
