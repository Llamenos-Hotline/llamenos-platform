/**
 * The user-visible half of #2110: the Settings dialog says the encrypted keys are
 * removed from this device, so when the vault wipe fails the user must actually be
 * told. `signOut()` switches on error-toast suppression (#2115) *before* the wipe
 * runs, so the failure notice has to survive that suppression — and ordinary error
 * toasts (the in-flight 401 cascade the suppression exists for) must still be dropped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, cleanup, waitFor } from '@testing-library/react'

const wipeKey = vi.fn<() => Promise<void>>()
vi.mock('./key-manager', () => ({ wipeKey: () => wipeKey() }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

import { ToastProvider, useToast, setErrorToastsSuppressed } from './toast'
import { useLogoutAndRemoveKey } from './use-logout-and-remove-key'

// Same observable behaviour as AuthProvider.signOut for the toast layer.
vi.mock('./auth', () => ({
  useAuth: () => ({ signOut: () => setErrorToastsSuppressed(true) }),
}))

let logout: () => Promise<void>
let raise: (message: string) => void

function Probe() {
  const { toast } = useToast()
  logout = useLogoutAndRemoveKey()
  raise = (message) => toast(message, 'error')
  return null
}

describe('Settings log out when the vault wipe fails', () => {
  beforeEach(() => {
    wipeKey.mockReset()
  })
  afterEach(() => {
    setErrorToastsSuppressed(false)
    cleanup()
  })

  it('shows the user a visible error even though sign-out suppresses error toasts', async () => {
    wipeKey.mockRejectedValue(new Error('Failed to delete vault file'))
    render(<ToastProvider><Probe /></ToastProvider>)

    await act(async () => { await logout() })

    const alert = await waitFor(() => screen.getByTestId('toast-error'))
    expect(alert.textContent).toContain('settings.logoutKeyRemovalFailed')
  })

  it('shows nothing when the wipe succeeds', async () => {
    wipeKey.mockResolvedValue(undefined)
    render(<ToastProvider><Probe /></ToastProvider>)

    await act(async () => { await logout() })

    expect(screen.queryByTestId('toast-error')).toBeNull()
  })

  it('keeps suppressing ordinary error toasts after sign-out (the 401 cascade)', async () => {
    wipeKey.mockResolvedValue(undefined)
    render(<ToastProvider><Probe /></ToastProvider>)

    await act(async () => { await logout() })
    act(() => raise('401 from an in-flight poll'))

    expect(screen.queryByTestId('toast-error')).toBeNull()
  })
})
