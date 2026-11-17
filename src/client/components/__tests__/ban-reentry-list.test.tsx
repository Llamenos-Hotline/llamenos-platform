/**
 * #2829: bans that stopped enforcing are shown to the admin until they ban the number again,
 * so a defence that went quiet is never invisible. The list renders each retired ban's
 * non-identifying context, dismisses one only when the server confirms, and says nothing
 * when every ban enforces.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'

const toasts: string[] = []
const t = (key: string) => key
const toast = (message: string) => { toasts.push(message) }
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }))
vi.mock('@/lib/toast', () => ({ useToast: () => ({ toast }) }))

import { BanReentryList } from '../ban-reentry-list'
import type { BanReentry } from '@protocol/schemas'

const reentry = (id: string, reason: string): BanReentry => ({
  id,
  reason,
  bannedBy: 'admin-pubkey',
  bannedAt: '2026-10-01T12:00:00.000Z',
  cause: 'digest-scheme',
  retiredAt: '2026-11-17T12:00:00.000Z',
})

beforeEach(() => { toasts.length = 0 })
afterEach(cleanup)

describe('BanReentryList', () => {
  it('renders nothing when every ban enforces', () => {
    const { container } = render(<BanReentryList reentries={[]} onDismiss={vi.fn()} onDismissed={vi.fn()} />)
    expect(container.innerHTML).toBe('')
  })

  it('announces the retired bans with the admin\'s note for each, as an alert', () => {
    render(<BanReentryList reentries={[reentry('a', 'threats'), reentry('b', 'coordinated spam')]} onDismiss={vi.fn()} onDismissed={vi.fn()} />)
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText('banList.reentryTitle')).toBeTruthy()
    expect(screen.getByText('banList.reentryDescription')).toBeTruthy()
    expect(screen.getAllByTestId('ban-reentry-row').map((row) => row.textContent)).toEqual([
      expect.stringContaining('threats'),
      expect.stringContaining('coordinated spam'),
    ])
  })

  it('dismisses one entry through the server, then reports it dismissed', async () => {
    const onDismiss = vi.fn().mockResolvedValue({ ok: true })
    const onDismissed = vi.fn()
    render(<BanReentryList reentries={[reentry('a', 'threats'), reentry('b', 'spam')]} onDismiss={onDismiss} onDismissed={onDismissed} />)
    fireEvent.click(screen.getAllByTestId('ban-reentry-dismiss-btn')[1]!)
    await waitFor(() => expect(onDismissed).toHaveBeenCalledWith('b'))
    expect(onDismiss).toHaveBeenCalledWith('b')
  })

  it('keeps the entry and says so when the server refuses to dismiss it', async () => {
    const onDismissed = vi.fn()
    render(<BanReentryList reentries={[reentry('a', 'threats')]} onDismiss={vi.fn().mockRejectedValue(new Error('500'))} onDismissed={onDismissed} />)
    fireEvent.click(screen.getByTestId('ban-reentry-dismiss-btn'))
    await waitFor(() => expect(toasts).toEqual(['common.error']))
    expect(onDismissed).not.toHaveBeenCalled()
    expect(screen.getAllByTestId('ban-reentry-row')).toHaveLength(1)
  })
})
