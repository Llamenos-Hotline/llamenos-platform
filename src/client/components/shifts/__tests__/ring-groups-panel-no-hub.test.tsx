/**
 * #2478 review: a screen holding hub A's ring groups, then the active hub is
 * cleared. The next load throws `NoActiveHubError` before any request — and the
 * panel used to swallow it and keep hub A's rows on screen, outside any hub.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { setActiveHub } from '@/lib/api/client'

const requested = vi.hoisted(() => ({ paths: [] as string[] }))

vi.mock('@/lib/toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))
vi.mock('@/lib/api/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api/client')>()
  return {
    ...actual,
    request: vi.fn(async (path: string) => {
      requested.paths.push(path)
      if (path === '/hubs/hub-A/ring-groups') {
        return {
          ringGroups: [{ id: 'rg-a', hubId: 'hub-A', encryptedName: 'Northside night crew', memberCount: 3, createdAt: '2026-11-01T00:00:00.000Z' }],
        }
      }
      if (path.endsWith('/users')) return { users: [] }
      throw new Error(`unexpected request ${path}`)
    }),
  }
})

import { RingGroupsPanel } from '../ring-groups-panel'

afterEach(() => {
  cleanup()
  setActiveHub(null)
  requested.paths = []
})

describe('RingGroupsPanel with the active hub cleared', () => {
  it("removes hub A's ring groups and says no hub is selected", async () => {
    setActiveHub('hub-A')
    render(<RingGroupsPanel />)
    await waitFor(() => expect(screen.getAllByTestId('ring-group-card')).toHaveLength(1))
    expect(screen.getByText('Northside night crew')).toBeTruthy()

    act(() => setActiveHub(null))

    await waitFor(() => expect(screen.queryAllByTestId('ring-group-card')).toHaveLength(0))
    expect(screen.queryByText('Northside night crew')).toBeNull()
    expect(screen.getByTestId('no-active-hub')).toBeTruthy()
    // Not the "this hub has no ring groups" claim.
    expect(screen.queryByText('No ring groups')).toBeNull()
    expect(requested.paths.filter(p => p.includes('ring-groups'))).toEqual(['/hubs/hub-A/ring-groups'])
  })

  it('a hub switch never shows the previous hub\'s rows', async () => {
    setActiveHub('hub-A')
    render(<RingGroupsPanel />)
    await waitFor(() => expect(screen.getAllByTestId('ring-group-card')).toHaveLength(1))

    act(() => setActiveHub('hub-B'))

    expect(screen.queryByText('Northside night crew')).toBeNull()
  })
})
