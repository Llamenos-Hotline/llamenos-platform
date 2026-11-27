/**
 * #2855: a hub the server says does not exist must leave the membership
 * snapshot at once. Before, a hub deleted elsewhere stayed in `hubs` until the
 * next 5-minute membership refresh, and every poll that walks the member hubs
 * (calls, incidents, the hub-key sync) kept asking about it and getting 404s.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

const hubRow = (id: string, name: string) => ({ id, name })
const server = vi.hoisted(() => ({ hubs: [] as { id: string; name: string }[] }))

// `ConfigProvider` loads the public `/config` on mount through `getConfig`,
// which does not go through `request()` (it is the unauthenticated pre-login
// read, with its own defaults on failure), so it is mocked at the same module
// boundary. Unmocked, it really fetched `localhost:3000` (#3084).
vi.mock('./api/client', async (importActual) => ({
  ...(await importActual<typeof import('./api/client')>()),
  request: vi.fn(async (path: string) => {
    if (path === '/hubs') return { hubs: server.hubs }
    return {}
  }),
  getConfig: vi.fn(async () => ({ hotlineName: 'Test Hotline', hotlineNumber: '' })),
}))

import { getActiveHub, setActiveHub, notifyHubGone } from './api/client'
import { ConfigProvider, useConfig } from './config'

const wrapper = ({ children }: { children: ReactNode }) => <ConfigProvider>{children}</ConfigProvider>

afterEach(() => {
  cleanup()
  setActiveHub(null)
  localStorage.clear()
})

describe('ConfigProvider with a hub deleted elsewhere', () => {
  it('drops it from the snapshot, and re-picks the active hub when it was the one that went', async () => {
    server.hubs = [hubRow('hub-A', 'A'), hubRow('hub-B', 'B')]
    const { result } = renderHook(() => useConfig(), { wrapper })
    await act(() => result.current.refreshMemberHubs())
    await waitFor(() => expect(result.current.hubs.map(h => h.id)).toEqual(['hub-A', 'hub-B']))
    expect(result.current.currentHubId).toBe('hub-A')

    act(() => result.current.dropMemberHub('hub-A'))

    expect(result.current.hubs.map(h => h.id)).toEqual(['hub-B'])
    expect(result.current.currentHubId).toBe('hub-B')
    expect(getActiveHub()).toBe('hub-B')
  })

  it('leaves the active hub alone when a different hub is the one that went', async () => {
    server.hubs = [hubRow('hub-A', 'A'), hubRow('hub-B', 'B')]
    const { result } = renderHook(() => useConfig(), { wrapper })
    await act(() => result.current.refreshMemberHubs())
    await waitFor(() => expect(result.current.hubs).toHaveLength(2))

    act(() => result.current.dropMemberHub('hub-B'))

    expect(result.current.hubs.map(h => h.id)).toEqual(['hub-A'])
    expect(result.current.currentHubId).toBe('hub-A')
  })

  it('ignores a hub that is not in the snapshot', async () => {
    server.hubs = [hubRow('hub-A', 'A')]
    const { result } = renderHook(() => useConfig(), { wrapper })
    await act(() => result.current.refreshMemberHubs())
    await waitFor(() => expect(result.current.hubs).toHaveLength(1))

    act(() => result.current.dropMemberHub('hub-unknown'))

    expect(result.current.hubs.map(h => h.id)).toEqual(['hub-A'])
  })

  it('is wired to the API client: a hub it reports gone leaves the snapshot', async () => {
    server.hubs = [hubRow('hub-A', 'A'), hubRow('hub-B', 'B')]
    const { result } = renderHook(() => useConfig(), { wrapper })
    await act(() => result.current.refreshMemberHubs())
    await waitFor(() => expect(result.current.hubs).toHaveLength(2))

    // `request()` calls this when a hub route answers with the HUB_NOT_FOUND code
    // (api-request.test.ts); the provider is what registered to hear it.
    act(() => notifyHubGone('hub-B'))

    expect(result.current.hubs.map(h => h.id)).toEqual(['hub-A'])
  })
})
