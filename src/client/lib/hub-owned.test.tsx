/**
 * #2478 review: hub-owned rows must never outlive the hub they were loaded in.
 * "I cannot ask" (no active hub) is not "nothing changed" — the view's rows
 * become empty and it is told there is no hub, never left showing the last hub's.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { setActiveHub, getActiveHub, activeHubPath } from '@/lib/api/client'
import { useHubOwned, useHubQuery } from './hub-owned'

afterEach(() => {
  cleanup()
  setActiveHub(null)
})

const EMPTY: string[] = []
const noop = () => {}

/** A load that answers with the hub it was asked in — and throws, as the API does, with none. */
function rowsOfActiveHub(): Promise<string[]> {
  const path = activeHubPath('/calls/history')
  return Promise.resolve([`row-of-${path.split('/')[2]}`])
}

describe('useHubOwned', () => {
  it("clears hub A's rows when the active hub is cleared, and reports no hub", async () => {
    setActiveHub('hub-A')
    const { result } = renderHook(() => useHubOwned(rowsOfActiveHub, { empty: EMPTY, onError: noop }))
    await waitFor(() => expect(result.current.data).toEqual(['row-of-hub-A']))
    expect(result.current.noHub).toBe(false)

    act(() => setActiveHub(null))

    expect(result.current.data).toEqual([])
    expect(result.current.noHub).toBe(true)
    expect(result.current.loading).toBe(false)
  })

  it('a reload with no hub (e.g. a poll after endServerSession) also empties the rows', async () => {
    setActiveHub('hub-A')
    const { result } = renderHook(() => useHubOwned(rowsOfActiveHub, { empty: EMPTY, onError: noop }))
    await waitFor(() => expect(result.current.data).toEqual(['row-of-hub-A']))

    act(() => setActiveHub(null))
    act(() => result.current.reload({ background: true }))

    expect(result.current.data).toEqual([])
  })

  it("never renders hub A's rows once hub B is active, and loads hub B's", async () => {
    setActiveHub('hub-A')
    const { result } = renderHook(() => useHubOwned(rowsOfActiveHub, { empty: EMPTY, onError: noop }))
    await waitFor(() => expect(result.current.data).toEqual(['row-of-hub-A']))

    act(() => setActiveHub('hub-B'))
    expect(result.current.data).not.toContain('row-of-hub-A')

    await waitFor(() => expect(result.current.data).toEqual(['row-of-hub-B']))
  })

  it("drops an answer that arrives after its hub stopped being active", async () => {
    let resolveA: (rows: string[]) => void = () => {}
    const slow = () => {
      activeHubPath('/records')
      return getActiveHub() === 'hub-A' ? new Promise<string[]>(r => { resolveA = r }) : Promise.resolve(['row-of-hub-B'])
    }
    setActiveHub('hub-A')
    const { result } = renderHook(() => useHubOwned(slow, { empty: EMPTY, onError: noop }))

    act(() => setActiveHub(null))
    await act(async () => { resolveA(['row-of-hub-A']) })

    expect(result.current.data).toEqual([])
    expect(result.current.noHub).toBe(true)
  })

  it('a local update is not applied to rows of a hub that is no longer active', async () => {
    setActiveHub('hub-A')
    const { result } = renderHook(() => useHubOwned(rowsOfActiveHub, { empty: EMPTY, onError: noop }))
    await waitFor(() => expect(result.current.data).toEqual(['row-of-hub-A']))

    act(() => setActiveHub(null))
    act(() => result.current.setData(prev => [...prev, 'added']))

    expect(result.current.data).toEqual([])
  })

  it('deployment-level rows (ownedBy platform) need no hub and survive a hub change', async () => {
    const platformRows = () => Promise.resolve(['platform-entry'])
    const { result } = renderHook(() => useHubOwned(platformRows, { empty: EMPTY, onError: noop, ownedBy: 'platform' }))
    await waitFor(() => expect(result.current.data).toEqual(['platform-entry']))
    expect(result.current.noHub).toBe(false)

    act(() => setActiveHub('hub-A'))
    expect(result.current.data).toEqual(['platform-entry'])
  })
})

describe('useHubQuery', () => {
  function wrapper(client: QueryClient) {
    return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }

  it("does not hand the cache's hub A rows to no hub or to hub B", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    setActiveHub('hub-A')
    const { result } = renderHook(
      () => useHubQuery({ queryKey: ['shifts', 'list'] as const, queryFn: rowsOfActiveHub, staleTime: 60_000 }),
      { wrapper: wrapper(client) },
    )
    await waitFor(() => expect(result.current.data).toEqual(['row-of-hub-A']))

    act(() => setActiveHub(null))
    expect(result.current.data).toBeUndefined()
    expect(result.current.noHub).toBe(true)

    act(() => setActiveHub('hub-B'))
    expect(result.current.data).not.toEqual(['row-of-hub-A'])
    await waitFor(() => expect(result.current.data).toEqual(['row-of-hub-B']))
  })
})
