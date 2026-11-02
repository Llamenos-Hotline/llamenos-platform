/**
 * Reports with no active hub (#2405). Reports have no unscoped route (#2395), so with no
 * hub active there is nothing to browse: the page settles on its empty state, asks the
 * server for nothing, and does not toast a load failure. (Only an operator who can create
 * a hub reaches a page with no hub — `__root` shows everyone else NoHubMembershipScreen.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

const toasts: string[] = []
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

  it('settles on the empty state without a load error or an unscoped request', async () => {
    render(<ReportsPage />)

    await screen.findByTestId('empty-state')
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
})
