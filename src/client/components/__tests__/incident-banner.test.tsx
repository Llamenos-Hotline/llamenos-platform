/**
 * The persistent incident banner (B-INCIDENTS-CLIENTS, operator rule V).
 *
 * The user is a member of hubs A and B and is browsing hub A. The mocked server
 * answers `GET /hubs/:hubId/incidents?open=true` per hub exactly as the real
 * route does: already filtered to the caller's permissions in that hub.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { KIND_HUB_INCIDENT } from '@shared/event-kinds'
import type { HubIncident } from '@protocol/schemas/incidents'
import type { RelayEventHandler } from '@/lib/relay/types'

const subscribed: { hubIds: readonly string[]; kinds: number[]; handler: RelayEventHandler }[] = []
const requested: string[] = []
/** What each hub's incident GET answers for THIS user. */
const serverIncidents = vi.hoisted(() => ({ byHub: {} as Record<string, unknown[]> }))
const setActiveHubCalls = vi.hoisted(() => ({ calls: [] as unknown[] }))

vi.mock('@/lib/relay/hooks', () => ({
  useRelaySubscriptions: (hubIds: readonly string[], kinds: number[], handler: RelayEventHandler) => {
    if (hubIds.length) subscribed.push({ hubIds, kinds, handler })
  },
}))
vi.mock('@/lib/config', () => ({
  useConfig: () => ({
    currentHubId: 'hub-A',
    hubs: [{ id: 'hub-A', name: 'Northside line' }, { id: 'hub-B', name: 'Riverside line' }],
    isMultiHub: true,
  }),
}))
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ publicKey: 'a'.repeat(64) }) }))
vi.mock('@/lib/api/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api/client')>()
  return {
    ...actual,
    setActiveHub: (id: string | null) => {
      setActiveHubCalls.calls.push(id)
      actual.setActiveHub(id)
    },
    request: vi.fn(async (path: string) => {
      requested.push(path)
      const match = /^\/hubs\/([^/]+)\/incidents\?open=true$/.exec(path)
      if (match) return { incidents: serverIncidents.byHub[match[1]] ?? [] }
      return {}
    }),
  }
})

import { IncidentBanner } from '../incident-banner'

function incident(overrides: Partial<HubIncident>): HubIncident {
  return {
    id: 'inc-1',
    hubId: 'hub-A',
    category: 'spam',
    severity: 'notify',
    openedAt: '2026-10-30T09:00:00.000Z',
    lastSignalAt: '2026-10-30T09:05:00.000Z',
    closedAt: null,
    counts: { fail: 12 },
    totalCount: 12,
    peakPerMinute: 4,
    oldestAgeSeconds: null,
    ...overrides,
  }
}

function renderBanner() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <IncidentBanner />
    </QueryClientProvider>,
  )
}

function incidentSubscription() {
  const sub = [...subscribed].reverse().find((s) => s.kinds.includes(KIND_HUB_INCIDENT))
  if (!sub) throw new Error('no KIND_HUB_INCIDENT subscription recorded')
  return sub
}

const incidentGets = (hubId: string) => requested.filter((p) => p === `/hubs/${hubId}/incidents?open=true`).length

beforeEach(() => {
  subscribed.length = 0
  requested.length = 0
  serverIncidents.byHub = {}
  setActiveHubCalls.calls = []
})

afterEach(cleanup)

describe('IncidentBanner', () => {
  it('shows an open incident the server lists for this user, with its category, state and count', async () => {
    serverIncidents.byHub['hub-A'] = [incident({})]
    renderBanner()

    const row = await screen.findByTestId('incident-banner-row')
    expect(row).toHaveProperty('dataset.hubId', 'hub-A')
    expect(row.textContent).toContain('Spam and unwanted calls')
    expect(row.textContent).toContain('Happening now')
    expect(row.textContent).toMatch(/12 events since/)
    // Its own hub is the one being browsed: no hub label.
    expect(screen.queryByTestId('incident-banner-hub')).toBeNull()
  })

  it('renders nothing for a member the server returns no incidents to (no permission for the category)', async () => {
    // The incident exists in hub A, but this user lacks its permission there, so
    // the permission-filtered GET answers an empty list for both hubs.
    renderBanner()

    await waitFor(() => expect(incidentGets('hub-A')).toBe(1))
    await waitFor(() => expect(incidentGets('hub-B')).toBe(1))
    expect(screen.queryByTestId('incident-banner')).toBeNull()
  })

  it('surfaces an incident in a non-active hub, names that hub, and never switches the active hub', async () => {
    serverIncidents.byHub['hub-B'] = [incident({ id: 'inc-B', hubId: 'hub-B', category: 'provider-media', totalCount: 3 })]
    renderBanner()

    const row = await screen.findByTestId('incident-banner-row')
    expect(row).toHaveProperty('dataset.hubId', 'hub-B')
    expect(row.textContent).toContain('Recordings left at the phone provider')
    expect(screen.getByTestId('incident-banner-hub').textContent).toBe('In Riverside line')
    expect(new Set(incidentSubscription().hubIds)).toEqual(new Set(['hub-A', 'hub-B']))
    expect(setActiveHubCalls.calls).toEqual([])
  })

  it('treats KIND_HUB_INCIDENT as a doorbell: exactly one refetch of that hub, nothing rendered from the payload', async () => {
    renderBanner()
    await waitFor(() => expect(incidentGets('hub-B')).toBe(1))
    expect(screen.queryByTestId('incident-banner')).toBeNull()

    serverIncidents.byHub['hub-B'] = [incident({ id: 'inc-B', hubId: 'hub-B', totalCount: 7 })]
    // A payload carrying detail it must never carry: none of it may reach the screen.
    const doorbell = { type: 'hub:incident', incidentId: 'inc-B', state: 'opened', category: 'ban-expiry', totalCount: 999 }
    act(() => incidentSubscription().handler(KIND_HUB_INCIDENT, doorbell, 'hub-B'))

    const row = await screen.findByTestId('incident-banner-row')
    expect(incidentGets('hub-B')).toBe(2)
    expect(incidentGets('hub-A')).toBe(1)
    // What renders is the server's answer (spam, 7), not the payload (ban-expiry, 999).
    expect(row.textContent).toContain('Spam and unwanted calls')
    expect(row.textContent).toMatch(/7 events since/)
    expect(screen.getByTestId('incident-banner').textContent).not.toContain('999')
    expect(screen.getByTestId('incident-banner').textContent).not.toContain('Bans about to expire')
    expect(setActiveHubCalls.calls).toEqual([])
  })

  it('removes the incident only when the server stops listing it (closed doorbell → refetch)', async () => {
    serverIncidents.byHub['hub-A'] = [incident({})]
    renderBanner()
    await screen.findByTestId('incident-banner-row')

    serverIncidents.byHub['hub-A'] = []
    act(() => incidentSubscription().handler(KIND_HUB_INCIDENT, { type: 'hub:incident', incidentId: 'inc-1', state: 'closed' }, 'hub-A'))

    await waitFor(() => expect(screen.queryByTestId('incident-banner')).toBeNull())
    expect(incidentGets('hub-A')).toBe(2)
  })

  it('shows an incident of a category this build does not know under the generic title', async () => {
    serverIncidents.byHub['hub-A'] = [incident({ category: 'routing' })]
    renderBanner()

    const row = await screen.findByTestId('incident-banner-row')
    expect(row.textContent).toContain('Active incidents')
  })
})
