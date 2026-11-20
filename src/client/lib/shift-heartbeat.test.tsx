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
/** Hubs the mocked server answers 404 for (not clocked in / already reaped). */
const notClockedIn = new Set<string>()

vi.mock('@/lib/member-hubs', () => ({
  useMemberHubIds: () => hubs,
}))
let hubs = ['hub-A', 'hub-B']

vi.mock('@/lib/api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api')>()
  return {
    ...actual,
    sendHeartbeat: async (hubId: string) => {
      sent.push(hubId)
      if (notClockedIn.has(hubId)) throw new actual.ApiError(404, 'Active shift not found — clock in first')
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
  notClockedIn.clear()
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
  it('beats every member hub at once on mount, then once per interval', async () => {
    renderHook(() => useShiftHeartbeat(true), { wrapper })
    await vi.advanceTimersByTimeAsync(0)
    expect(sent.sort()).toEqual(['hub-A', 'hub-B'])

    sent.length = 0
    await vi.advanceTimersByTimeAsync(ACTIVE_SHIFT_HEARTBEAT_INTERVAL_MS)
    expect(sent.sort()).toEqual(['hub-A', 'hub-B'])
  })

  it('sends nothing when the user cannot clock in', async () => {
    renderHook(() => useShiftHeartbeat(false), { wrapper })
    await vi.advanceTimersByTimeAsync(ACTIVE_SHIFT_HEARTBEAT_INTERVAL_MS * 2)
    expect(sent).toEqual([])
  })

  it('stops beating when it unmounts', async () => {
    const { unmount } = renderHook(() => useShiftHeartbeat(true), { wrapper })
    await vi.advanceTimersByTimeAsync(0)
    unmount()
    sent.length = 0
    await vi.advanceTimersByTimeAsync(ACTIVE_SHIFT_HEARTBEAT_INTERVAL_MS * 3)
    expect(sent).toEqual([])
  })

  it('refreshes the shift status when a hub that was accepting beats stops — the server reaped the clock-in', async () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    renderHook(() => useShiftHeartbeat(true), { wrapper })
    await vi.advanceTimersByTimeAsync(0)
    expect(invalidate).not.toHaveBeenCalled()

    notClockedIn.add('hub-A')
    await vi.advanceTimersByTimeAsync(ACTIVE_SHIFT_HEARTBEAT_INTERVAL_MS)

    expect(invalidate).toHaveBeenCalledWith({ queryKey: shiftKeys.myStatus() })
  })

  it('does not refresh anything for a hub the user was never clocked into', async () => {
    notClockedIn.add('hub-B')
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    renderHook(() => useShiftHeartbeat(true), { wrapper })
    await vi.advanceTimersByTimeAsync(ACTIVE_SHIFT_HEARTBEAT_INTERVAL_MS * 2)
    expect(invalidate).not.toHaveBeenCalled()
  })
})
