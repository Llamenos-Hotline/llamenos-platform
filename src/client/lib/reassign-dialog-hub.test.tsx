/**
 * Multi-hub axiom: the reassign dialog acts on one conversation, so its candidates and
 * their load counts must come from THAT conversation's hub — never the active hub.
 * Offering active-hub volunteers for another hub's caller conversation would let the
 * assignment land outside the hub the caller called.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import type { HubConversation } from './api'

const requested: { path: string; method: string }[] = []
const toasts: { message: string; type?: string }[] = []

const volunteer = (pubkey: string, name: string) => ({
  pubkey, name, active: true, messagingEnabled: true, supportedMessagingChannels: [],
})

// Stable identity, like the real provider's: the dialog's load effect depends on `toast`.
const toastFns = vi.hoisted(() => ({ value: undefined as unknown as { toast: (message: string, type?: string) => void } }))
vi.mock('./toast', () => ({ useToast: () => toastFns.value }))
toastFns.value = { toast: (message, type) => { toasts.push({ message, type }) } }
vi.mock('./api/client', async (importActual) => ({
  ...(await importActual<typeof import('./api/client')>()),
  request: vi.fn(async (path: string, options?: RequestInit) => {
    requested.push({ path, method: options?.method ?? 'GET' })
    if (path === '/hubs/hub-B/users') return { users: [volunteer('pk-B-only', 'Beatriz (hub B)')] }
    if (path === '/hubs/hub-A/users') return { users: [volunteer('pk-A-only', 'Alma (hub A)')] }
    if (path === '/hubs/hub-B/conversations/load') return { loads: { 'pk-B-only': 3 } }
    if (path === '/hubs/hub-A/conversations/load') return { loads: { 'pk-A-only': 9 } }
    if (path === '/hubs/hub-forbidden/users') throw new Error('403 Forbidden')
    if (path === '/hubs/hub-forbidden/conversations/load') return { loads: {} }
    return {}
  }),
}))

import { setActiveHub } from './api'
import { ReassignDialog } from '@/components/ReassignDialog'

const conversationOn = (hubId: string): HubConversation => ({
  id: 'conv-1', hubId, status: 'active', channelType: 'sms', assignedTo: 'pk-current', messageCount: 1,
} as HubConversation)

describe('ReassignDialog with hub A active', () => {
  beforeEach(() => {
    requested.length = 0
    toasts.length = 0
    setActiveHub('hub-A')
  })

  afterEach(cleanup)

  it("offers the members and loads of the conversation's own hub, not the active hub's", async () => {
    render(<ReassignDialog conversation={conversationOn('hub-B')} open onOpenChange={() => {}} />)

    await screen.findByText('Beatriz (hub B)')
    expect(screen.getByText(/^3\s/)).toBeTruthy()
    expect(screen.queryByText('Alma (hub A)')).toBeNull()
    expect(requested.map(r => r.path).sort()).toEqual(['/hubs/hub-B/conversations/load', '/hubs/hub-B/users'])
  })

  it("assigns against the conversation's own hub", async () => {
    render(<ReassignDialog conversation={conversationOn('hub-B')} open onOpenChange={() => {}} />)

    fireEvent.click(await screen.findByText('Beatriz (hub B)'))
    requested.length = 0
    const reassign = screen.getByRole('button', { name: 'Reassign' }) as HTMLButtonElement
    await waitFor(() => expect(reassign.disabled).toBe(false))
    fireEvent.click(reassign)

    await waitFor(() => expect(requested).toEqual([{ path: '/hubs/hub-B/conversations/conv-1', method: 'PATCH' }]))
  })

  it('shows a failure, not "no volunteers available", when the hub\'s members cannot be loaded', async () => {
    render(<ReassignDialog conversation={conversationOn('hub-forbidden')} open onOpenChange={() => {}} />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Failed to load volunteers')
    expect(screen.queryByText('No volunteers available')).toBeNull()
    expect(toasts).toEqual([{ message: 'Failed to load volunteers', type: 'error' }])
    // Nothing from the active hub was substituted
    expect(requested.map(r => r.path)).not.toContain('/hubs/hub-A/users')
  })
})
