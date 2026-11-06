/**
 * Reports with no active hub (#2405, #2478). Reports have no unscoped route (#2395), so
 * with no hub active there is nothing to browse: the page says no hub is selected — not
 * "no reports", which is a claim about a hub — asks the server for nothing, and does not
 * toast a load failure. A page already holding hub A's reports drops them when the
 * active hub is cleared. (Only an operator who can create
 * a hub reaches a page with no hub — `__root` shows everyone else NoHubMembershipScreen.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, cleanup, waitFor } from '@testing-library/react'

const toasts: string[] = []
const HUB_A_REPORT = vi.hoisted(() => ({
  id: 'report-hub-a',
  hubId: 'hub-with-reports',
  channelType: 'web',
  contactIdentifierHash: 'h',
  status: 'waiting',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  lastMessageAt: '2026-11-01T00:00:00.000Z',
  messageCount: 1,
  metadata: { type: 'report', reportTitle: 'Riverside incident' },
}))
const requested: string[] = []

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: { component: unknown }) => options,
}))
// Stable across renders, as the real hooks are: the page's effects depend on `t` and `toast`.
const t = (key: string) => key
const toast = (message: string) => { toasts.push(message) }
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }))
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    hasDeviceKey: true, publicKey: 'pk-me', isAdmin: true, hasPermission: () => true, adminDecryptionPubkey: 'pk-admin',
  }),
}))
vi.mock('@/lib/toast', () => ({ useToast: () => ({ toast }) }))
vi.mock('@/lib/platform', () => ({ encryptMessage: async () => ({ encryptedContent: 'ct', readerEnvelopes: [] }) }))
vi.mock('@/components/ReportForm', () => ({ ReportForm: () => null }))
vi.mock('@/components/FileUpload', () => ({ FileUpload: () => null }))
vi.mock('@/components/ConversationThread', () => ({ ConversationThread: () => null }))
vi.mock('@/lib/api/client', async (importActual) => ({
  ...(await importActual<typeof import('./api/client')>()),
  request: vi.fn(async (path: string) => {
    requested.push(path)
    if (path.startsWith('/hubs/hub-with-reports/reports?')) {
      return { conversations: [HUB_A_REPORT], total: 1 }
    }
    return { conversations: [], total: 0, reportTypes: [] }
  }),
}))

import { setActiveHub } from './api'
import { Route } from '@/routes/reports'

const ReportsPage = (Route as unknown as { component: () => React.JSX.Element }).component

describe('ReportsPage with no active hub', () => {
  beforeEach(() => {
    toasts.length = 0
    requested.length = 0
    setActiveHub(null)
  })

  afterEach(cleanup)

  it('says no hub is selected, without a load error or an unscoped request', async () => {
    render(<ReportsPage />)

    await screen.findByTestId('no-active-hub')
    expect(screen.queryByTestId('empty-state')).toBeNull()
    expect(toasts).toEqual([])
    expect(requested.filter(path => path === '/reports' || path.startsWith('/reports/') || path.startsWith('/reports?'))).toEqual([])
  })

  it('lists the active hub once one is chosen', async () => {
    setActiveHub('hub-A')
    render(<ReportsPage />)

    await screen.findByTestId('empty-state')
    expect(requested).toContain('/hubs/hub-A/reports?')
    expect(toasts).toEqual([])
  })

  it("drops hub A's reports when the active hub is cleared", async () => {
    setActiveHub('hub-with-reports')
    render(<ReportsPage />)
    await waitFor(() => expect(screen.getAllByText('Riverside incident').length).toBeGreaterThan(0))

    act(() => setActiveHub(null))

    await screen.findByTestId('no-active-hub')
    expect(screen.queryByText('Riverside incident')).toBeNull()
    expect(toasts).toEqual([])
  })
})
