/**
 * Settings as a plain volunteer (#2115). `GET /settings/transcription` and
 * `GET /recovery-group/:hubId` are admin-gated; asking for them as anyone else is
 * a guaranteed 403 that surfaced as a red error toast on every visit. The client
 * must not make a request the role cannot make, and must not toast about it.
 * A holder of the permission still gets the request.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'

const toasts: string[] = []
const requested: string[] = []
let granted: string[] = []

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: { component: unknown }) => options,
  useNavigate: () => vi.fn(),
  useSearch: () => ({ section: undefined }),
}))
const t = (key: string) => key
const toast = (message: string) => { toasts.push(message) }
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }))
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    transcriptionEnabled: true,
    name: 'Vol',
    spokenLanguages: ['en'],
    callPreference: 'phone',
    refreshProfile: async () => {},
    publicKey: 'pk-me',
    signOut: () => {},
    hasPermission: (p: string) => granted.includes(p) || granted.includes('*'),
  }),
}))
vi.mock('@/lib/toast', () => ({ useToast: () => ({ toast }) }))
vi.mock('@/lib/api/client', async (importActual) => ({
  ...(await importActual<typeof import('./api/client')>()),
  request: vi.fn(async (path: string) => {
    requested.push(path)
    if (path.includes('/settings/transcription')) return { allowUserOptOut: true, enabled: true }
    if (path.includes('/recovery-group/')) return null
    if (path.includes('webrtc-status')) return { available: false, provider: null }
    return []
  }),
}))

import { setActiveHub } from './api'
import { RecoveryStatusSection } from '@/components/recovery-status-section'
import { Route } from '@/routes/settings'

const SettingsPage = (Route as unknown as { component: () => React.JSX.Element }).component

const adminRequests = () =>
  requested.filter(p => p.includes('/settings/transcription') || p.includes('/recovery-group/'))

describe('Settings as a volunteer', () => {
  beforeEach(() => {
    toasts.length = 0
    requested.length = 0
    granted = ['notes:create', 'calls:answer']
    setActiveHub('hub-1')
  })

  afterEach(cleanup)

  it('makes no admin-only request and raises no error toast', async () => {
    render(<><SettingsPage /><RecoveryStatusSection /></>)
    await waitFor(() => expect(requested.some(p => p.includes('webrtc-status'))).toBe(true))
    expect(adminRequests()).toEqual([])
    expect(toasts).toEqual([])
    expect(screen.queryByTestId('recovery-status')).toBeNull()
  })

  it('still reads transcription settings and recovery status when permitted', async () => {
    granted = ['settings:manage-transcription', 'recovery:view']
    render(<><SettingsPage /><RecoveryStatusSection /></>)
    await waitFor(() => {
      expect(requested.some(p => p.includes('/settings/transcription'))).toBe(true)
      expect(requested.some(p => p.includes('/recovery-group/hub-1'))).toBe(true)
    })
  })
})
